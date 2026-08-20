use crate::db::Database;
use crate::git::GitManager;
use crate::protocol::{is_supported, Event, Request, Response, MAX_FRAME_SIZE, PROTOCOL_VERSION};
use crate::pty::{PtyManager, PtyOutputSubscription};
use crate::shell_integration::ShellEvent;
use crate::terminal_session::{
    TerminalInteractionMode, TerminalSession, TerminalSessionRegistry, TerminalTransition,
};
use crate::workspace::WorkspaceManager;
use anyhow::{anyhow, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::ErrorKind;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{watch, Mutex};
use tracing::{error, info, warn};

fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            output.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                while let Some(code) = chars.next() {
                    if code.is_ascii_alphabetic() || code == '@' || code == '~' {
                        break;
                    }
                }
            }
            Some(']') => {
                let mut previous_escape = false;
                while let Some(code) = chars.next() {
                    if code == '\u{7}' || (previous_escape && code == '\\') {
                        break;
                    }
                    previous_escape = code == '\u{1b}';
                }
            }
            Some(_) | None => {}
        }
    }
    output
}

fn clean_agent_response(bytes: &[u8], prompt: &str, marker: &str) -> String {
    let text = strip_ansi(&String::from_utf8_lossy(bytes));
    text.replace(prompt, "")
        .lines()
        .filter(|line| line.trim() != marker)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn agent_completion_contract(message: &str, request_id: &str) -> (String, String) {
    let marker = format!("<ORCHESTRA_DONE:{request_id}>");
    // Never place the complete marker in the injected prompt. Many terminals
    // echo input, and matching that echo would report completion before the
    // agent processed anything. The peer is instead asked to concatenate the
    // three literal pieces into the acknowledgement line.
    let prompt = format!(
        "{message}\n\nWhen you have completed this request, print one line by concatenating these three literal parts: <ORCHESTRA_DONE: + {request_id} + >"
    );
    (prompt, marker)
}

fn terminal_state_hint(snapshot: &[u8]) -> &'static str {
    // This is deliberately a hint, never proof that a TUI consumed input.
    // PTYs do not expose semantic application state, so clients must inspect
    // the current tail before and after each action.
    let tail = strip_ansi(&String::from_utf8_lossy(snapshot));
    let lower = tail.to_ascii_lowercase();
    if lower.contains("allow") && (lower.contains("permission") || lower.contains("access"))
        || lower.contains("do you trust")
        || lower.contains("yes") && lower.contains("no")
    {
        "permission_prompt"
    } else if lower.contains("thinking")
        || lower.contains("working")
        || lower.contains("generating")
    {
        "agent_busy"
    } else if tail.trim_end().ends_with('$')
        || tail.trim_end().ends_with('%')
        || tail.trim_end().ends_with('#')
    {
        "shell"
    } else {
        "unknown"
    }
}

struct PendingRequest {
    source_session_id: String,
    cancel: watch::Sender<bool>,
}

type RequestRegistry = Arc<Mutex<HashMap<String, PendingRequest>>>;
type SubscriptionRegistry = Arc<Mutex<HashMap<String, (String, tokio::task::JoinHandle<()>)>>>;

/// Removes only the pathname created by this exact listener. A replacement
/// daemon may bind the same path after this listener closes, so path equality
/// alone is not enough during shutdown.
#[derive(Debug)]
struct SocketOwnership {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl Drop for SocketOwnership {
    fn drop(&mut self) {
        let Ok(metadata) = std::fs::symlink_metadata(&self.path) else {
            return;
        };
        if metadata.file_type().is_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Bind the control socket without ever unlinking a live daemon. A pathname is
/// considered stale only when it is a socket owned by this uid, a connection
/// is explicitly refused, and its device/inode still match immediately before
/// removal. Timeouts and ambiguous I/O failures are treated as conflicts.
async fn bind_control_socket(socket_path: &Path) -> Result<(UnixListener, SocketOwnership)> {
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    if let Ok(initial) = std::fs::symlink_metadata(socket_path) {
        if !initial.file_type().is_socket() {
            return Err(anyhow!(
                "INSTANCE_CONFLICT: control socket path exists and is not a socket: {}",
                socket_path.display()
            ));
        }
        if initial.uid() != nix::unistd::Uid::current().as_raw() {
            return Err(anyhow!(
                "INSTANCE_CONFLICT: control socket is owned by another user: {}",
                socket_path.display()
            ));
        }

        match tokio::time::timeout(Duration::from_millis(500), UnixStream::connect(socket_path))
            .await
        {
            Ok(Ok(stream)) => {
                drop(stream);
                return Err(anyhow!(
                    "INSTANCE_CONFLICT: an Orchestra core already owns {}",
                    socket_path.display()
                ));
            }
            Ok(Err(error)) if error.kind() == ErrorKind::ConnectionRefused => {
                let current = std::fs::symlink_metadata(socket_path).map_err(|error| {
                    anyhow!(
                        "SOCKET_STALE: socket changed while checking {}: {error}",
                        socket_path.display()
                    )
                })?;
                if !current.file_type().is_socket()
                    || current.dev() != initial.dev()
                    || current.ino() != initial.ino()
                    || current.uid() != initial.uid()
                {
                    return Err(anyhow!(
                        "INSTANCE_CONFLICT: control socket changed during stale recovery: {}",
                        socket_path.display()
                    ));
                }
                std::fs::remove_file(socket_path).map_err(|error| {
                    anyhow!(
                        "SOCKET_STALE: could not remove refused socket {}: {error}",
                        socket_path.display()
                    )
                })?;
            }
            Ok(Err(error)) if error.kind() == ErrorKind::NotFound => {
                // Another contender removed a stale pathname. The atomic bind
                // below decides ownership; EADDRINUSE remains a clear conflict.
            }
            Ok(Err(error)) => {
                return Err(anyhow!(
                    "INSTANCE_CONFLICT: cannot prove socket {} is stale: {error}",
                    socket_path.display()
                ));
            }
            Err(_) => {
                return Err(anyhow!(
                    "INSTANCE_CONFLICT: timed out probing live socket {}",
                    socket_path.display()
                ));
            }
        }
    }

    let listener = UnixListener::bind(socket_path).map_err(|error| {
        anyhow!(
            "INSTANCE_CONFLICT: could not claim control socket {}: {error}",
            socket_path.display()
        )
    })?;
    let metadata = std::fs::symlink_metadata(socket_path)?;
    let ownership = SocketOwnership {
        path: socket_path.to_path_buf(),
        device: metadata.dev(),
        inode: metadata.ino(),
    };
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, ownership))
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

pub struct SocketServer {
    db: Arc<Database>,
    pty: PtyManager,
    terminal_sessions: TerminalSessionRegistry,
}

impl SocketServer {
    pub fn new(
        db: Arc<Database>,
        pty: PtyManager,
        terminal_sessions: TerminalSessionRegistry,
    ) -> Self {
        Self {
            db,
            pty,
            terminal_sessions,
        }
    }

    pub async fn start(&self, socket_path: PathBuf) -> Result<()> {
        self.run_until(socket_path, shutdown_signal()).await
    }

    async fn run_until<F>(&self, socket_path: PathBuf, shutdown: F) -> Result<()>
    where
        F: std::future::Future<Output = ()>,
    {
        let (listener, _ownership) = bind_control_socket(&socket_path).await?;
        info!(
            "Orchestra Rust Daemon listening on unix socket: {:?}",
            socket_path
        );
        let requests: RequestRegistry = Arc::new(Mutex::new(HashMap::new()));
        tokio::pin!(shutdown);

        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = &mut shutdown => return Ok(()),
            };
            match accepted {
                Ok((stream, _)) => {
                    if stream.peer_cred().ok().map(|cred| cred.uid())
                        != Some(nix::unistd::Uid::current().as_raw())
                    {
                        error!("Rejected Unix socket client with a different UID");
                        continue;
                    }
                    let db = self.db.clone();
                    let pty = self.pty.clone();
                    let terminal_sessions = self.terminal_sessions.clone();
                    let requests = requests.clone();
                    tokio::spawn(async move {
                        if let Err(e) =
                            Self::handle_client(stream, db, pty, terminal_sessions, requests).await
                        {
                            error!("Client connection error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    error!("Unix listener accept error: {}", e);
                }
            }
        }
    }

    async fn handle_client(
        stream: UnixStream,
        db: Arc<Database>,
        pty: PtyManager,
        terminal_sessions: TerminalSessionRegistry,
        requests: RequestRegistry,
    ) -> Result<()> {
        let (mut reader, writer) = stream.into_split();
        let writer_arc = Arc::new(Mutex::new(writer));
        let client_token = uuid::Uuid::new_v4().to_string();
        let subscriptions: SubscriptionRegistry = Arc::new(Mutex::new(HashMap::new()));
        // PTY input and resize are ordered terminal operations. Other IPC
        // requests may remain concurrent, but these operations must not race
        // and reorder keystrokes or apply an older resize after a newer one.
        let terminal_io_lock = Arc::new(Mutex::new(()));
        let mut rate_window = Instant::now();
        let mut request_count = 0u32;

        loop {
            let mut len_bytes = [0u8; 4];
            if reader.read_exact(&mut len_bytes).await.is_err() {
                break; // Client disconnected
            }
            let len = u32::from_be_bytes(len_bytes) as usize;
            if len == 0 || len > MAX_FRAME_SIZE {
                error!("Invalid Orchestra IPC frame length: {}", len);
                break;
            }
            let mut buf = vec![0u8; len];
            if reader.read_exact(&mut buf).await.is_err() {
                break;
            }

            let request: Request = match serde_json::from_slice(&buf) {
                Ok(v) => v,
                Err(e) => {
                    error!("JSON parse error: {}", e);
                    continue;
                }
            };

            let req_id = request.request_id.clone();
            let msg_type = request.message_type;
            let payload = request.payload;

            if rate_window.elapsed().as_secs() >= 1 {
                rate_window = Instant::now();
                request_count = 0;
            }
            request_count = request_count.saturating_add(1);
            if request_count > 240 {
                if let Some(rid) = req_id {
                    Self::send_json(
                        &writer_arc,
                        json!({
                            "protocolVersion": PROTOCOL_VERSION,
                            "requestId": rid,
                            "ok": false,
                            "error": "IPC rate limit exceeded"
                        }),
                    )
                    .await?;
                }
                continue;
            }

            let request_version = request.protocol_version;
            if !is_supported(request_version) {
                if let Some(rid) = req_id {
                    Self::send_json(&writer_arc, json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": rid,
                        "ok": false,
                        "error": format!("Unsupported protocol version {}; expected {}", request_version, PROTOCOL_VERSION)
                    })).await?;
                }
                continue;
            }

            if msg_type != "system.hello"
                && payload["clientToken"].as_str() != Some(client_token.as_str())
            {
                if let Some(rid) = req_id {
                    Self::send_json(
                        &writer_arc,
                        json!({
                            "protocolVersion": PROTOCOL_VERSION,
                            "requestId": rid,
                            "ok": false,
                            "error": "CLIENT_AUTH_INVALID: call system.hello on this connection first"
                        }),
                    )
                    .await?;
                }
                continue;
            }

            let db_clone = db.clone();
            let pty_clone = pty.clone();
            let terminal_sessions_clone = terminal_sessions.clone();
            let writer_clone = writer_arc.clone();
            let requests_clone = requests.clone();
            let subscriptions_clone = subscriptions.clone();
            let client_token_clone = client_token.clone();
            let terminal_io_lock_clone = terminal_io_lock.clone();

            tokio::spawn(async move {
                let res = Self::dispatch(
                    &msg_type,
                    payload,
                    db_clone,
                    pty_clone,
                    terminal_sessions_clone,
                    writer_clone.clone(),
                    &client_token_clone,
                    requests_clone,
                    subscriptions_clone,
                    terminal_io_lock_clone,
                )
                .await;

                if let Some(rid) = req_id {
                    let response = match res {
                        Ok(val) => serde_json::to_value(Response {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: &rid,
                            ok: true,
                            result: Some(val),
                            error: None,
                        }),
                        Err(err) => serde_json::to_value(Response {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: &rid,
                            ok: false,
                            result: None,
                            error: Some(err.to_string()),
                        }),
                    };
                    if let Ok(response) = response {
                        let _ = Self::send_json(&writer_clone, response).await;
                    }
                }
            });
        }
        let mut active_subscriptions = subscriptions.lock().await;
        for (_, (_, subscription)) in active_subscriptions.drain() {
            subscription.abort();
        }
        Ok(())
    }

    async fn send_json(
        writer: &Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
        val: Value,
    ) -> Result<()> {
        let bytes = serde_json::to_vec(&val)?;
        if bytes.len() > MAX_FRAME_SIZE {
            return Err(anyhow::anyhow!("Response exceeds the protocol frame limit"));
        }
        let len = (bytes.len() as u32).to_be_bytes();
        let mut lock = writer.lock().await;
        lock.write_all(&len).await?;
        lock.write_all(&bytes).await?;
        lock.flush().await?;
        Ok(())
    }

    fn terminal_view_id(client_token: &str, session_id: &str) -> String {
        format!("{client_token}:{session_id}")
    }

    fn terminal_state_payload(session: &TerminalSession, view_id: Option<&str>) -> Value {
        json!({
            "sessionId": session.id,
            "mode": session.interaction_mode,
            "process": session.process,
            "session": session,
            "view": view_id.and_then(|id| session.views.get(id)),
        })
    }

    async fn emit_terminal_state(
        writer: &Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
        terminal_sessions: &TerminalSessionRegistry,
        session_id: &str,
        view_id: Option<&str>,
    ) {
        let Some(session) = terminal_sessions.snapshot(session_id) else {
            return;
        };
        let event = Event {
            protocol_version: PROTOCOL_VERSION,
            event_id: format!("evt_{}", uuid::Uuid::new_v4()),
            event_type: "terminal.state".to_string(),
            payload: Self::terminal_state_payload(&session, view_id),
        };
        if let Ok(value) = serde_json::to_value(event) {
            let _ = Self::send_json(writer, value).await;
        }
    }

    fn require_terminal_auth(pty: &PtyManager, payload: &Value) -> Result<String> {
        let session_id = payload["sessionId"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("AUTH_MISSING: missing sessionId"))?;
        let token = payload["token"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("AUTH_MISSING: missing terminal token"))?;
        if pty.token_for(session_id).is_none() {
            return Err(anyhow::anyhow!(
                "SESSION_NOT_REGISTERED: terminal is not running"
            ));
        }
        if !pty.authorizes(session_id, token) {
            return Err(anyhow::anyhow!(
                "AUTH_INVALID: terminal token does not match this live session"
            ));
        }
        Ok(session_id.to_string())
    }

    fn workspace_root(payload: &Value, db: &Database) -> Result<String> {
        if let Some(workspace_id) = payload["workspaceId"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            let root = db
                .get_workspace_path(workspace_id)?
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Workspace not found"))?;
            if let Some(requested_root) = payload["workspaceRoot"]
                .as_str()
                .filter(|value| !value.is_empty())
            {
                let canonical_requested = WorkspaceManager::canonical_root(requested_root)?;
                let canonical_registered = WorkspaceManager::canonical_root(&root)?;
                if canonical_requested != canonical_registered {
                    return Err(anyhow::anyhow!(
                        "workspaceRoot does not match the registered workspace"
                    ));
                }
            }
            return Ok(root);
        }
        if let Some(root) = payload["workspaceRoot"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            return Ok(root.to_string());
        }
        Err(anyhow::anyhow!(
            "Missing workspaceRoot; select a workspace before accessing files"
        ))
    }

    fn workspace_path(payload: &Value, db: &Database, allow_missing: bool) -> Result<PathBuf> {
        let root = Self::workspace_root(payload, db)?;
        let requested = payload["path"].as_str().unwrap_or(".");
        WorkspaceManager::secure_path(&root, requested, allow_missing)
    }

    fn stream_terminal_output(
        writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
        mut subscription: PtyOutputSubscription,
        session_id: String,
        subscription_id: String,
        pty: PtyManager,
        terminal_sessions: TerminalSessionRegistry,
        subscriptions: SubscriptionRegistry,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut process_output_closed = false;
            loop {
                let Some(mut output) = subscription.recv().await else {
                    process_output_closed = true;
                    break;
                };
                if output.data.is_empty() {
                    for event in output.events.drain(..) {
                        Self::apply_shell_event(&writer, &terminal_sessions, &session_id, event)
                            .await;
                    }
                    continue;
                }
                let mut shell_events = output.events;
                // Coalesce chunks that are already queued before crossing the
                // daemon socket. This reduces IPC/frame overhead while
                // retaining bounded, lossless backpressure on the PTY reader.
                while output.data.len() < 64 * 1024 {
                    match subscription.try_recv() {
                        Some(next) if next.events.is_empty() => {
                            output.data.extend_from_slice(&next.data);
                        }
                        Some(mut next) => {
                            shell_events.append(&mut next.events);
                            if !next.data.is_empty() {
                                output.data.extend_from_slice(&next.data);
                            }
                            break;
                        }
                        None => break,
                    }
                }
                let event = match serde_json::to_value(Event {
                    protocol_version: PROTOCOL_VERSION,
                    event_id: format!("evt_{}", uuid::Uuid::new_v4()),
                    event_type: "terminal.output".to_string(),
                    payload: json!({
                        "sessionId": session_id.clone(),
                        "encoding": "base64",
                        "data": base64::engine::general_purpose::STANDARD.encode(output.data)
                    }),
                }) {
                    Ok(event) => event,
                    Err(_) => break,
                };
                if Self::send_json(&writer, event).await.is_err() {
                    break;
                }
                for event in shell_events {
                    Self::apply_shell_event(&writer, &terminal_sessions, &session_id, event).await;
                }
            }
            if process_output_closed {
                let exit_code = pty.exit_code(&session_id).flatten();
                if let Ok(session) = terminal_sessions.process_exited(&session_id, exit_code) {
                    let exit_event = json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "eventId": format!("evt_{}", uuid::Uuid::new_v4()),
                        "type": "terminal.exit",
                        "payload": {
                            "sessionId": session_id,
                            "exitCode": exit_code,
                            "mode": session.interaction_mode,
                            "processStatus": session.process.status
                        }
                    });
                    let _ = Self::send_json(&writer, exit_event).await;
                    Self::emit_terminal_state(&writer, &terminal_sessions, &session_id, None).await;
                }
            }
            let mut active_subscriptions = subscriptions.lock().await;
            if active_subscriptions
                .get(&session_id)
                .is_some_and(|(active_id, _)| active_id == &subscription_id)
            {
                active_subscriptions.remove(&session_id);
            }
        })
    }

    async fn apply_shell_event(
        writer: &Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
        terminal_sessions: &TerminalSessionRegistry,
        session_id: &str,
        event: ShellEvent,
    ) {
        let transition = match event {
            ShellEvent::PromptReady => crate::terminal_session::TerminalTransition::PromptReady,
            ShellEvent::CommandStarted => {
                crate::terminal_session::TerminalTransition::CommandStarted
            }
            ShellEvent::CommandFinished { exit_code } => {
                crate::terminal_session::TerminalTransition::CommandFinished { exit_code }
            }
            ShellEvent::CwdChanged { cwd } => {
                crate::terminal_session::TerminalTransition::CwdChanged { cwd }
            }
        };
        if terminal_sessions.transition(session_id, transition).is_ok() {
            Self::emit_terminal_state(writer, terminal_sessions, session_id, None).await;
        }
    }

    async fn emit_agent_status(
        writer: &Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
        request_id: &str,
        source: &str,
        target: &str,
        status: &str,
    ) {
        let event = Event {
            protocol_version: PROTOCOL_VERSION,
            event_id: format!("evt_{}", uuid::Uuid::new_v4()),
            event_type: "agent.request.progress".to_string(),
            payload: json!({
                "requestId": request_id,
                "sourceSessionId": source,
                "targetSessionId": target,
                "status": status
            }),
        };
        if let Ok(value) = serde_json::to_value(event) {
            let _ = Self::send_json(writer, value).await;
        }
    }

    async fn dispatch(
        msg_type: &str,
        payload: Value,
        db: Arc<Database>,
        pty: PtyManager,
        terminal_sessions: TerminalSessionRegistry,
        writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
        client_token: &str,
        requests: RequestRegistry,
        subscriptions: SubscriptionRegistry,
        terminal_io_lock: Arc<Mutex<()>>,
    ) -> Result<Value> {
        match msg_type {
            "system.hello" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "daemonVersion": env!("CARGO_PKG_VERSION"),
                "daemonHash": option_env!("ORCHESTRA_DAEMON_HASH").unwrap_or("development"),
                "clientToken": client_token,
                "capabilities": ["terminal.spawn", "terminal.attach", "terminal.detach", "terminal.state", "terminal.input", "terminal.execute", "terminal.complete", "terminal.resize", "terminal.kill", "terminal.screen", "terminal.control", "agent.request.cancel", "agent.request.progress", "portal.authorize", "portal.open", "workspace", "workspace.tree", "workspace.read_file", "workspace.search", "git", "git.refs", "git.branches", "git.stash", "canvas", "canvas.node.context", "notes", "notes.create", "environments", "environment.exec", "settings", "audit"]
            })),

            "agent.list" => {
                let source = Self::require_terminal_auth(&pty, &payload)?;
                let sessions = pty.list_sessions();
                let agents = sessions
                    .into_iter()
                    .map(|session_id| {
                        let connections = db.connected_nodes(&session_id).unwrap_or_default();
                        json!({
                            "sessionId": session_id,
                            "connections": connections,
                            "status": "running",
                            "reachable": true,
                            "authenticatedSource": source
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!(agents))
            }
            "connection.list" => {
                let session_id = Self::require_terminal_auth(&pty, &payload)?;
                let live_sessions = pty.list_sessions().into_iter().collect::<BTreeSet<_>>();
                let mut connections = db.connected_nodes(&session_id)?;
                for connection in &mut connections {
                    let terminal_peer = connection["targetKind"].as_str() == Some("terminal");
                    let reachable = !terminal_peer
                        || connection["nodeId"]
                            .as_str()
                            .is_some_and(|peer| live_sessions.contains(peer));
                    connection["reachable"] = json!(reachable);
                    connection["status"] = json!(if reachable { "running" } else { "stale" });
                }
                Ok(json!(connections))
            }
            "note.create" => {
                let source = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing source sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                if !pty.authorizes(source, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                let context = db.canvas_node_context(source)?.ok_or_else(|| {
                    anyhow::anyhow!("The source terminal is not represented on a canvas")
                })?;
                if context["kind"].as_str() != Some("terminal") {
                    return Err(anyhow::anyhow!(
                        "Only a canvas terminal can create a connected note"
                    ));
                }
                let workspace_id = context["workspaceId"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| anyhow::anyhow!("Canvas terminal has no workspace"))?;
                if !db.workspace_exists(workspace_id)? {
                    return Err(anyhow::anyhow!("Workspace not found"));
                }
                let title = payload["title"]
                    .as_str()
                    .unwrap_or("Nota do Orchestra")
                    .trim();
                if title.is_empty() || title.len() > 240 {
                    return Err(anyhow::anyhow!("Note title must contain 1-240 characters"));
                }
                let content = payload["content"].as_str().unwrap_or("");
                if content.len() > 1 * 1024 * 1024 || content.contains('\0') {
                    return Err(anyhow::anyhow!(
                        "Note content exceeds 1 MiB or contains NUL"
                    ));
                }
                let color = payload["color"].as_str().unwrap_or("#fff2a8").trim();
                let valid_color = matches!(color.len(), 4 | 7 | 9)
                    && color.starts_with('#')
                    && color[1..]
                        .chars()
                        .all(|character| character.is_ascii_hexdigit());
                if !valid_color {
                    return Err(anyhow::anyhow!(
                        "Note color must be a #RGB, #RRGGBB or #RRGGBBAA value"
                    ));
                }

                let note_id = format!("note_{}", uuid::Uuid::new_v4().simple());
                let width = 280.0;
                let height = 230.0;
                let source_x = context["x"].as_f64().unwrap_or(0.0);
                let source_y = context["y"].as_f64().unwrap_or(0.0);
                let source_width = context["width"].as_f64().unwrap_or(520.0);
                let base_x = source_x + source_width + 96.0;
                let floor_id = context["floorId"].as_str();
                let existing_nodes = db.get_canvas_nodes_for_floor(workspace_id, floor_id)?;
                let (x, y) = (0..64)
                    .map(|slot| (base_x + slot as f64 * (width + 24.0), source_y))
                    .find(|&(candidate_x, candidate_y)| {
                        !existing_nodes.iter().any(|node| {
                            let node_x = node["x"].as_f64().unwrap_or(0.0);
                            let node_y = node["y"].as_f64().unwrap_or(0.0);
                            let node_width = node["width"].as_f64().unwrap_or(300.0);
                            let node_height = node["height"].as_f64().unwrap_or(200.0);
                            candidate_x + width + 14.0 > node_x
                                && candidate_x < node_x + node_width + 14.0
                                && candidate_y + height + 14.0 > node_y
                                && candidate_y < node_y + node_height + 14.0
                        })
                    })
                    .unwrap_or((base_x, source_y));
                let node = json!({
                    "id": note_id,
                    "floorId": context["floorId"],
                    "kind": "note",
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height,
                    "z_index": 1,
                    "locked": false,
                    "collapsed": false,
                    "properties": {
                        "title": title,
                        "content": content,
                        "color": color
                    }
                });
                let edge_id = format!("e_{}_{}", source, node["id"].as_str().unwrap_or_default());
                let edge = json!({
                    "id": edge_id,
                    "floorId": context["floorId"],
                    "source": source,
                    "target": node["id"],
                    "label": "connected",
                    "permissions": ["read", "write", "append"]
                });
                db.save_canvas_node(workspace_id, &node)?;
                if let Err(error) = db.save_canvas_edge(workspace_id, &edge) {
                    let _ = db.delete_canvas_edge_for_workspace(workspace_id, &edge_id);
                    let _ = db.delete_canvas_node_for_workspace(workspace_id, &note_id);
                    return Err(error);
                }
                if let Err(error) = pty.create_note(source, &note_id, content) {
                    let _ = db.delete_canvas_edge_for_workspace(workspace_id, &edge_id);
                    let _ = db.delete_canvas_node_for_workspace(workspace_id, &note_id);
                    return Err(error);
                }
                if let Err(error) = db.record_audit(
                    source,
                    "note.create",
                    &note_id,
                    &json!({ "workspaceId": workspace_id, "sourceSessionId": source, "edgeId": edge_id }),
                ) {
                    // The node, edge and canonical note file are already
                    // committed. Do not report a false failure after a
                    // successful create merely because audit persistence is
                    // temporarily unavailable.
                    warn!("Could not record note.create audit for {note_id}: {error}");
                }
                Ok(json!({
                    "success": true,
                    "noteId": note_id,
                    "node": node,
                    "edge": edge,
                    "connectedTo": source,
                    "permissions": ["read", "write", "append"]
                }))
            }
            "note.read" => {
                let session_id = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let note_id = payload["noteId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing noteId"))?;
                if !pty.authorizes(session_id, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                let permission_report = db.connection_permission_report(session_id, note_id)?;
                if !permission_report["permissions"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|value| value.as_str() == Some("read")))
                {
                    return Err(anyhow::anyhow!(
                        "The note connection does not grant read permission (source={session_id}, target={note_id}, report={permission_report})"
                    ));
                }
                Ok(json!({ "id": note_id, "content": pty.read_note(session_id, note_id)? }))
            }
            "note.write" => {
                let session_id = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let note_id = payload["noteId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing noteId"))?;
                let content = payload["content"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing content"))?;
                if !pty.authorizes(session_id, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                let permission_report = db.connection_permission_report(session_id, note_id)?;
                if !permission_report["permissions"]
                    .as_array()
                    .is_some_and(|values| {
                        values.iter().any(|value| value.as_str() == Some("write"))
                    })
                {
                    return Err(anyhow::anyhow!(
                        "The note connection does not grant write permission (source={session_id}, target={note_id}, report={permission_report})"
                    ));
                }
                // Keep note writes ordered with appends. Without this guard,
                // two authenticated agents can both read the same version and
                // the later atomic rename silently drops one writer's edit.
                let _note_io_guard = terminal_io_lock.lock().await;
                pty.write_note(session_id, note_id, content)?;
                Ok(json!({ "success": true, "id": note_id }))
            }
            "note.append" => {
                let session_id = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let note_id = payload["noteId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing noteId"))?;
                let content = payload["content"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing content"))?;
                if !pty.authorizes(session_id, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                let permission_report = db.connection_permission_report(session_id, note_id)?;
                let allows_append =
                    permission_report["permissions"]
                        .as_array()
                        .is_some_and(|values| {
                            values.iter().any(|value| {
                                matches!(value.as_str(), Some("append") | Some("write"))
                            })
                        });
                if !allows_append {
                    return Err(anyhow::anyhow!(
                        "The note connection does not grant append permission (source={session_id}, target={note_id}, report={permission_report})"
                    ));
                }
                let _note_io_guard = terminal_io_lock.lock().await;
                let mut existing = pty.read_note(session_id, note_id)?;
                existing.push_str(content);
                pty.write_note(session_id, note_id, &existing)?;
                Ok(json!({ "success": true, "id": note_id }))
            }

            "agent.ask" => {
                let source = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing source sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let target = payload["agent"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing target terminal"))?;
                let message = payload["message"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing message"))?;
                if message.len() > 256 * 1024 {
                    return Err(anyhow::anyhow!("Agent message exceeds 256 KiB"));
                }
                let wait = payload["wait"].as_bool().unwrap_or(false);
                let timeout_secs = payload["timeoutSecs"].as_u64().unwrap_or(90).clamp(1, 600);

                if !pty.authorizes(source, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                if !db.nodes_are_connected(source, target)? {
                    let report = db.connection_permission_report(source, target)?;
                    return Err(anyhow::anyhow!(
                        "The terminal is not connected to that agent (source={source}, target={target}, report={report})"
                    ));
                }
                if !db.has_connection_permission(source, target, "send_prompt")? {
                    let report = db.connection_permission_report(source, target)?;
                    return Err(anyhow::anyhow!(
                        "The terminal connection does not grant send_prompt permission (source={source}, target={target}, report={report})"
                    ));
                }
                if wait && !db.has_connection_permission(source, target, "receive_response")? {
                    let report = db.connection_permission_report(source, target)?;
                    return Err(anyhow::anyhow!(
                        "The terminal connection does not grant receive_response permission (source={source}, target={target}, report={report})"
                    ));
                }
                if !pty.list_sessions().iter().any(|id| id == target) {
                    return Err(anyhow::anyhow!("Target terminal is not running"));
                }

                let request_id = payload["requestId"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty() && value.len() <= 128)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("ask_{}", uuid::Uuid::new_v4()));
                let (cancel_sender, mut cancel_receiver) = watch::channel(false);
                let mut request_registry = requests.lock().await;
                if request_registry.contains_key(&request_id) {
                    return Err(anyhow::anyhow!(
                        "An agent request with this id is already running"
                    ));
                }
                request_registry.insert(
                    request_id.clone(),
                    PendingRequest {
                        source_session_id: source.to_string(),
                        cancel: cancel_sender,
                    },
                );
                drop(request_registry);
                db.record_agent_request(&request_id, source, target, "ask", "queued", wait)?;
                Self::emit_agent_status(&writer, &request_id, source, target, "queued").await;
                let (prompt, done_marker) = agent_completion_contract(message, &request_id);
                let mut output = if wait {
                    Some(pty.subscribe(target).ok_or_else(|| {
                        anyhow::anyhow!("Could not subscribe to target terminal output")
                    })?)
                } else {
                    None
                };

                let send_result = {
                    let _terminal_io_guard = terminal_io_lock.lock().await;
                    pty.send_prompt(target, &prompt)
                };
                if let Err(error) = send_result {
                    requests.lock().await.remove(&request_id);
                    db.record_agent_request(&request_id, source, target, "ask", "failed", wait)?;
                    return Err(error);
                }
                db.record_agent_request(&request_id, source, target, "ask", "pty_written", wait)?;
                Self::emit_agent_status(&writer, &request_id, source, target, "pty_written").await;

                if let Some(receiver) = output.as_mut() {
                    Self::emit_agent_status(
                        &writer,
                        &request_id,
                        source,
                        target,
                        "awaiting_completion",
                    )
                    .await;
                    let deadline =
                        tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
                    let mut response = Vec::<u8>::new();

                    loop {
                        let remaining =
                            deadline.saturating_duration_since(tokio::time::Instant::now());
                        if remaining.is_zero() {
                            requests.lock().await.remove(&request_id);
                            db.record_agent_request(
                                &request_id,
                                source,
                                target,
                                "ask",
                                "timed_out",
                                wait,
                            )?;
                            Self::emit_agent_status(
                                &writer,
                                &request_id,
                                source,
                                target,
                                "timed_out",
                            )
                            .await;
                            return Ok(json!({
                                "requestId": request_id,
                                "status": "timed_out",
                                "response": clean_agent_response(&response, &prompt, &done_marker),
                                "marker": done_marker,
                                "ptyWritten": true,
                                "delivered": false,
                                "agentAcknowledged": false,
                                "completed": false,
                                "unverified": true
                            }));
                        }

                        let receive = tokio::time::timeout(remaining, receiver.recv());
                        tokio::select! {
                            cancellation = cancel_receiver.changed() => {
                                if cancellation.is_ok() && *cancel_receiver.borrow() {
                                    requests.lock().await.remove(&request_id);
                                    db.record_agent_request(&request_id, source, target, "ask", "cancelled", wait)?;
                                    Self::emit_agent_status(&writer, &request_id, source, target, "cancelled").await;
                                    return Ok(json!({
                                        "requestId": request_id,
                                        "status": "cancelled",
                                        "response": clean_agent_response(&response, &prompt, &done_marker),
                                        "marker": done_marker,
                                        "ptyWritten": true,
                                        "delivered": false,
                                        "agentAcknowledged": false,
                                        "completed": false,
                                        "unverified": true
                                    }));
                                }
                            }
                            result = receive => match result {
                            Ok(Some(output)) => {
                                response.extend_from_slice(&output.data);
                                if response.len() > 1_000_000 {
                                    requests.lock().await.remove(&request_id);
                                    db.record_agent_request(&request_id, source, target, "ask", "failed", wait)?;
                                    return Err(anyhow::anyhow!("Agent response exceeded 1 MiB"));
                                }
                                let response_text = strip_ansi(&String::from_utf8_lossy(&response));
                                let marker_on_own_line = response_text
                                    .lines()
                                    .any(|line| line.trim() == done_marker);
                                if marker_on_own_line {
                                    requests.lock().await.remove(&request_id);
                                    db.record_agent_request(
                                        &request_id,
                                        source,
                                        target,
                                        "ask",
                                        "completed",
                                        wait,
                                    )?;
                                    Self::emit_agent_status(&writer, &request_id, source, target, "completed").await;
                                    let clean_response = clean_agent_response(&response, &prompt, &done_marker);
                                    return Ok(json!({
                                        "requestId": request_id,
                                        "status": "completed",
                                        "response": clean_response,
                                        "ptyWritten": true,
                                        "delivered": true,
                                        "agentAcknowledged": true,
                                        "completed": true,
                                        "unverified": false
                                    }));
                                }
                            }
                            Ok(None) => {
                                requests.lock().await.remove(&request_id);
                                db.record_agent_request(&request_id, source, target, "ask", "failed", wait)?;
                                return Err(anyhow::anyhow!(
                                    "Target terminal output stream closed"
                                ));
                            }
                            Err(_) => {
                                requests.lock().await.remove(&request_id);
                                db.record_agent_request(
                                    &request_id,
                                    source,
                                    target,
                                    "ask",
                                    "timed_out",
                                    wait,
                                )?;
                                return Ok(json!({
                                    "requestId": request_id,
                                    "status": "timed_out",
                                    "response": strip_ansi(&String::from_utf8_lossy(&response)).trim(),
                                    "marker": done_marker,
                                    "ptyWritten": true,
                                    "delivered": false,
                                    "agentAcknowledged": false,
                                    "completed": false,
                                    "unverified": true
                                }));
                            }
                            }
                        }
                    }
                }

                requests.lock().await.remove(&request_id);
                Self::emit_agent_status(&writer, &request_id, source, target, "unverified").await;
                Ok(json!({
                    "requestId": request_id,
                    "status": "unverified",
                    "ptyWritten": true,
                    "delivered": false,
                    "agentAcknowledged": false,
                    "completed": false,
                    "unverified": true,
                    "fromSessionId": source,
                    "toSessionId": target
                }))
            }

            "agent.request-audit.list" => {
                let session_id = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                if !pty.authorizes(session_id, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                let limit = payload["limit"].as_u64().unwrap_or(50).clamp(1, 250) as usize;
                Ok(json!(
                    db.list_agent_request_audit_for_source(session_id, limit)?
                ))
            }

            "agent.request.cancel" => {
                let source = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing source sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let request_id = payload["requestId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing requestId"))?;
                if !pty.authorizes(source, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                let registry = requests.lock().await;
                let pending = registry
                    .get(request_id)
                    .ok_or_else(|| anyhow::anyhow!("Request is no longer running"))?;
                if pending.source_session_id != source {
                    return Err(anyhow::anyhow!("Request belongs to another terminal"));
                }
                pending
                    .cancel
                    .send(true)
                    .map_err(|_| anyhow::anyhow!("Request is no longer running"))?;
                Ok(json!({ "requestId": request_id, "status": "cancellation_requested" }))
            }

            "agent.message.send" => {
                let source = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing source sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let target = payload["agent"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing target terminal"))?;
                let message = payload["message"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing message"))?;

                if message.len() > 256 * 1024 {
                    return Err(anyhow::anyhow!("Agent message exceeds 256 KiB"));
                }

                if !pty.authorizes(source, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                if !db.nodes_are_connected(source, target)? {
                    let report = db.connection_permission_report(source, target)?;
                    return Err(anyhow::anyhow!(
                        "The terminal is not connected to that agent (source={source}, target={target}, report={report})"
                    ));
                }
                if !db.has_connection_permission(source, target, "send_prompt")? {
                    let report = db.connection_permission_report(source, target)?;
                    return Err(anyhow::anyhow!(
                        "The terminal connection does not grant send_prompt permission (source={source}, target={target}, report={report})"
                    ));
                }
                if !pty.list_sessions().iter().any(|id| id == target) {
                    return Err(anyhow::anyhow!("Target terminal is not running"));
                }

                pty.send_prompt(target, message)?;
                Ok(json!({
                    "status": "unverified",
                    "ptyWritten": true,
                    "delivered": false,
                    "agentAcknowledged": false,
                    "completed": false,
                    "unverified": true,
                    "fromSessionId": source,
                    "toSessionId": target
                }))
            }

            "portal.authorize" => {
                let source = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing source sessionId"))?;
                let token = payload["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let portal_id = payload["portalId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing portal id"))?;
                let permission = payload["permission"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing portal permission"))?;
                if !pty.authorizes(source, token) {
                    return Err(anyhow::anyhow!("Unauthorized portal request"));
                }
                if !matches!(
                    permission,
                    "inspect" | "navigate" | "control" | "screenshot"
                ) {
                    return Err(anyhow::anyhow!("Invalid portal permission"));
                }
                let permission_report = db.connection_permission_report(source, portal_id)?;
                if !permission_report["permissions"]
                    .as_array()
                    .is_some_and(|values| {
                        values
                            .iter()
                            .any(|value| value.as_str() == Some(permission))
                    })
                {
                    return Err(anyhow::anyhow!(
                        "The terminal connection does not grant {permission} permission (source={source}, target={portal_id}, report={permission_report})"
                    ));
                }
                Ok(json!({ "allowed": true, "portalId": portal_id, "permission": permission }))
            }

            // Workspaces
            "workspace.list" => Ok(json!(db.get_workspaces()?)),
            "workspace.save" => {
                let id = payload["id"].as_str().unwrap_or("");
                let name = payload["name"].as_str().unwrap_or("");
                let path = payload["path"].as_str().unwrap_or("");
                if id.trim().is_empty() || name.trim().is_empty() {
                    return Err(anyhow::anyhow!("Workspace id and name are required"));
                }
                let canonical = WorkspaceManager::canonical_root(path)?;
                db.save_workspace(id, name, &canonical.to_string_lossy())?;
                db.record_audit(
                    "ipc-client",
                    "workspace.save",
                    id,
                    &json!({ "path": canonical }),
                )?;
                Ok(json!({ "success": true, "path": canonical }))
            }
            "workspace.floor.list" => {
                let workspace_id = payload["workspaceId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing workspaceId"))?;
                Ok(json!(db.get_floors(workspace_id)?))
            }
            "workspace.floor.save" => {
                let workspace_id = payload["workspaceId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing workspaceId"))?;
                let floor = &payload["floor"];
                let floor_path = floor["path"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing floor path"))?;
                let root = db
                    .get_workspace_path(workspace_id)?
                    .ok_or_else(|| anyhow::anyhow!("Workspace not found"))?;
                let canonical = WorkspaceManager::secure_path(&root, floor_path, false)?;
                let mut floor = floor.clone();
                floor["path"] = json!(canonical);
                db.save_floor(workspace_id, &floor)?;
                Ok(json!({ "success": true }))
            }
            "workspace.floor.delete" => {
                let workspace_id = payload["workspaceId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing workspaceId"))?;
                let floor_id = payload["floorId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing floorId"))?;
                let floor = db
                    .get_floors(workspace_id)?
                    .into_iter()
                    .find(|floor| floor["id"].as_str() == Some(floor_id))
                    .ok_or_else(|| anyhow::anyhow!("Floor not found"))?;
                if floor["isLanding"].as_bool().unwrap_or(false) {
                    return Err(anyhow::anyhow!("The landing floor cannot be deleted"));
                }
                let root = db
                    .get_workspace_path(workspace_id)?
                    .ok_or_else(|| anyhow::anyhow!("Workspace not found"))?;
                let worktree = WorkspaceManager::secure_path(
                    &root,
                    floor["path"].as_str().unwrap_or_default(),
                    false,
                )?;
                GitManager::remove_worktree(&root, &worktree.to_string_lossy())?;
                db.delete_floor(workspace_id, floor_id)?;
                db.record_audit(
                    "ipc-client",
                    "floor.delete",
                    floor_id,
                    &json!({ "workspaceId": workspace_id, "path": worktree }),
                )?;
                Ok(json!({ "success": true }))
            }
            "workspace.tree" => {
                let depth = payload["depth"].as_u64().unwrap_or(4) as usize;
                let path = Self::workspace_path(&payload, &db, false)?;
                WorkspaceManager::read_dir_tree(&path.to_string_lossy(), depth.min(12))
            }
            "workspace.read_file" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                if !path.is_file() {
                    return Err(anyhow::anyhow!("Path is not a file"));
                }
                let content = WorkspaceManager::read_file(&path.to_string_lossy())?;
                Ok(json!({ "content": content }))
            }
            "workspace.write_file" => {
                let path = Self::workspace_path(&payload, &db, true)?;
                let content = payload["content"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing file content"))?;
                WorkspaceManager::write_file(&path.to_string_lossy(), content)?;
                db.record_audit(
                    "ipc-client",
                    "file.write",
                    &path.to_string_lossy(),
                    &json!({ "bytes": content.len() }),
                )?;
                Ok(json!({ "success": true }))
            }
            "workspace.create_file" => {
                let path = Self::workspace_path(&payload, &db, true)?;
                WorkspaceManager::create_file(&path.to_string_lossy())?;
                db.record_audit(
                    "ipc-client",
                    "file.create",
                    &path.to_string_lossy(),
                    &json!({}),
                )?;
                Ok(json!({ "success": true, "path": path }))
            }
            "workspace.create_directory" => {
                let path = Self::workspace_path(&payload, &db, true)?;
                WorkspaceManager::create_directory(&path.to_string_lossy())?;
                db.record_audit(
                    "ipc-client",
                    "directory.create",
                    &path.to_string_lossy(),
                    &json!({}),
                )?;
                Ok(json!({ "success": true, "path": path }))
            }
            "workspace.rename" => {
                let source = Self::workspace_path(&payload, &db, false)?;
                let target_value = payload["targetPath"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing targetPath"))?;
                let root = Self::workspace_root(&payload, &db)?;
                let target = WorkspaceManager::secure_path(&root, target_value, true)?;
                WorkspaceManager::rename(&source.to_string_lossy(), &target.to_string_lossy())?;
                db.record_audit(
                    "ipc-client",
                    "file.rename",
                    &source.to_string_lossy(),
                    &json!({ "target": target }),
                )?;
                Ok(json!({ "success": true, "path": target }))
            }
            "workspace.delete" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let root = WorkspaceManager::canonical_root(&Self::workspace_root(&payload, &db)?)?;
                if path == root {
                    return Err(anyhow::anyhow!("Cannot delete the workspace root"));
                }
                WorkspaceManager::delete(&path.to_string_lossy())?;
                db.record_audit(
                    "ipc-client",
                    "file.delete",
                    &path.to_string_lossy(),
                    &json!({}),
                )?;
                Ok(json!({ "success": true }))
            }
            "workspace.search" => {
                let query = payload["query"].as_str().unwrap_or("");
                let path = Self::workspace_path(&payload, &db, false)?;
                let results = if payload["content"].as_bool().unwrap_or(false) {
                    WorkspaceManager::search_content(&path.to_string_lossy(), query)?
                } else {
                    WorkspaceManager::search_files(&path.to_string_lossy(), query)?
                };
                Ok(json!({ "results": results }))
            }
            "workspace.diagnostics" => {
                let root = Self::workspace_root(&payload, &db)?;
                let file = payload["file"].as_str().unwrap_or("");
                let extension = file
                    .rsplit('.')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let (program, args): (&str, Vec<String>) = if matches!(extension.as_str(), "rs") {
                    (
                        "cargo",
                        vec![
                            "check".to_string(),
                            "--message-format=json".to_string(),
                            "--quiet".to_string(),
                        ],
                    )
                } else if matches!(extension.as_str(), "ts" | "tsx" | "js" | "jsx" | "json") {
                    (
                        "npx",
                        vec![
                            "tsc".to_string(),
                            "--noEmit".to_string(),
                            "--pretty".to_string(),
                            "false".to_string(),
                            "--noErrorTruncation".to_string(),
                        ],
                    )
                } else {
                    return Ok(json!({ "available": false, "diagnostics": [] }));
                };
                let output = Command::new(program).args(args).current_dir(&root).output();
                let Ok(output) = output else {
                    return Ok(json!({ "available": false, "diagnostics": [] }));
                };
                let combined = format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                let mut diagnostics = Vec::new();
                if program == "cargo" {
                    for line in combined.lines() {
                        let Ok(value) = serde_json::from_str::<Value>(line) else {
                            continue;
                        };
                        if value["reason"] != "compiler-message" {
                            continue;
                        }
                        let message = &value["message"];
                        let level = message["level"].as_str().unwrap_or("error");
                        if level != "error" && level != "warning" {
                            continue;
                        }
                        let span = message["spans"].as_array().and_then(|spans| spans.first());
                        let span_file = span
                            .and_then(|span| span["file_name"].as_str())
                            .unwrap_or("");
                        if !file.is_empty() && !span_file.ends_with(file) {
                            continue;
                        }
                        diagnostics.push(json!({
                            "severity": level,
                            "message": message["message"].as_str().unwrap_or("compiler diagnostic"),
                            "file": span_file,
                            "line": span.and_then(|span| span["line_start"].as_u64()).unwrap_or(1),
                            "column": span.and_then(|span| span["column_start"].as_u64()).unwrap_or(1)
                        }));
                    }
                } else {
                    for line in combined.lines() {
                        let parts = line.splitn(4, ':').collect::<Vec<_>>();
                        if parts.len() < 4
                            || (!line.contains(" error TS") && !line.contains(" warning TS"))
                        {
                            continue;
                        }
                        let line_number = parts
                            .get(1)
                            .and_then(|value| value.parse::<u64>().ok())
                            .unwrap_or(1);
                        let column = parts
                            .get(2)
                            .and_then(|value| value.parse::<u64>().ok())
                            .unwrap_or(1);
                        let message = parts[3].trim().to_string();
                        diagnostics.push(json!({ "severity": if line.contains(" warning TS") { "warning" } else { "error" }, "message": message, "file": parts[0], "line": line_number, "column": column }));
                    }
                }
                diagnostics.truncate(200);
                Ok(
                    json!({ "available": true, "ok": output.status.success(), "diagnostics": diagnostics }),
                )
            }

            // Canvas
            "canvas.node.context" => {
                let source = Self::require_terminal_auth(&pty, &payload)?;
                db.canvas_node_context(&source)?
                    .ok_or_else(|| anyhow::anyhow!("The terminal is not represented on a canvas"))
            }
            "canvas.node.list" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                let floor_id = payload["floorId"].as_str();
                Ok(json!(db.get_canvas_nodes_for_floor(ws_id, floor_id)?))
            }
            "canvas.node.save" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                if !db.workspace_exists(ws_id)? {
                    return Err(anyhow::anyhow!("Workspace not found"));
                }
                let mut node = payload["node"].clone();
                if let Some(object) = node.as_object_mut() {
                    if !object.contains_key("floorId") {
                        object.insert("floorId".to_string(), payload["floorId"].clone());
                    }
                }
                db.save_canvas_node(ws_id, &node)?;
                Ok(json!({ "success": true }))
            }
            "canvas.node.delete" => {
                if payload["workspaceId"].as_str().unwrap_or("").is_empty() {
                    return Err(anyhow::anyhow!("Missing workspaceId"));
                }
                let node_id = payload["id"].as_str().unwrap_or("");
                db.delete_canvas_node_for_workspace(
                    payload["workspaceId"].as_str().unwrap(),
                    node_id,
                )?;
                db.record_audit(
                    "ipc-client",
                    "canvas.node.delete",
                    node_id,
                    &json!({ "workspaceId": payload["workspaceId"] }),
                )?;
                Ok(json!({ "success": true }))
            }
            "canvas.edge.list" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                let floor_id = payload["floorId"].as_str();
                Ok(json!(db.get_canvas_edges_for_floor(ws_id, floor_id)?))
            }
            "canvas.edge.save" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                if !db.workspace_exists(ws_id)? {
                    return Err(anyhow::anyhow!("Workspace not found"));
                }
                let mut edge = payload["edge"].clone();
                if let Some(object) = edge.as_object_mut() {
                    if !object.contains_key("floorId") {
                        object.insert("floorId".to_string(), payload["floorId"].clone());
                    }
                }
                db.save_canvas_edge(ws_id, &edge)?;
                Ok(json!({ "success": true }))
            }
            "canvas.edge.delete" => {
                if payload["workspaceId"].as_str().unwrap_or("").is_empty() {
                    return Err(anyhow::anyhow!("Missing workspaceId"));
                }
                let edge_id = payload["id"].as_str().unwrap_or("");
                db.delete_canvas_edge_for_workspace(
                    payload["workspaceId"].as_str().unwrap(),
                    edge_id,
                )?;
                db.record_audit(
                    "ipc-client",
                    "canvas.edge.delete",
                    edge_id,
                    &json!({ "workspaceId": payload["workspaceId"] }),
                )?;
                Ok(json!({ "success": true }))
            }
            "canvas.viewport.get" => {
                let ws_id = payload["workspaceId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing workspaceId"))?;
                let floor_id = payload["floorId"].as_str();
                Ok(json!(db.get_canvas_viewport(ws_id, floor_id)?))
            }
            "canvas.viewport.save" => {
                let ws_id = payload["workspaceId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing workspaceId"))?;
                let floor_id = payload["floorId"].as_str();
                db.save_canvas_viewport(ws_id, floor_id, &payload["viewport"])?;
                Ok(json!({ "success": true }))
            }

            // PTY Terminals
            "terminal.attach" => {
                let session_id = payload["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token_valid = payload["token"]
                    .as_str()
                    .is_some_and(|token| pty.authorizes(session_id, token));
                let client_valid = payload["clientToken"].as_str() == Some(client_token);
                if !token_valid && !client_valid {
                    return Err(anyhow::anyhow!("Unauthorized terminal attach"));
                }
                // Probe the real PTY before mutating the logical session
                // registry. Persisted canvas nodes commonly outlive the
                // daemon that owned their PTY; registering a missing session
                // here would make the renderer's recovery spawn fail with
                // "terminal session is already running".
                let terminal_token = pty
                    .token_for(session_id)
                    .ok_or_else(|| anyhow::anyhow!("Terminal is not running"))?;
                let snapshot = pty.snapshot(session_id)?;
                terminal_sessions.ensure(
                    session_id.to_string(),
                    pty.process_id(session_id),
                    None,
                )?;
                let view_id = Self::terminal_view_id(client_token, session_id);
                let terminal_session = terminal_sessions.attach(
                    session_id,
                    view_id.clone(),
                    client_token.to_string(),
                )?;
                if let Some(receiver) = pty.subscribe(session_id) {
                    let subscription_id = uuid::Uuid::new_v4().to_string();
                    let subscription = Self::stream_terminal_output(
                        writer.clone(),
                        receiver,
                        session_id.to_string(),
                        subscription_id.clone(),
                        pty.clone(),
                        terminal_sessions.clone(),
                        subscriptions.clone(),
                    );
                    if let Some(previous) = subscriptions
                        .lock()
                        .await
                        .insert(session_id.to_string(), (subscription_id, subscription))
                    {
                        previous.1.abort();
                    }
                }
                Ok(json!({
                    "sessionId": session_id,
                    "status": "running",
                    "encoding": "base64",
                    "scrollback": base64::engine::general_purpose::STANDARD.encode(snapshot),
                    "token": terminal_token,
                    "state": Self::terminal_state_payload(&terminal_session, Some(&view_id))
                }))
            }
            "terminal.state" => {
                let session_id = Self::require_terminal_auth(&pty, &payload)?;
                let view_id = Self::terminal_view_id(client_token, &session_id);
                let session = terminal_sessions.snapshot(&session_id).ok_or_else(|| {
                    anyhow!("SESSION_NOT_REGISTERED: logical terminal session is missing")
                })?;
                Ok(Self::terminal_state_payload(&session, Some(&view_id)))
            }
            "terminal.detach" => {
                let session_id = Self::require_terminal_auth(&pty, &payload)?;
                let view_id = Self::terminal_view_id(client_token, &session_id);
                let terminal_session = terminal_sessions.detach(&session_id, &view_id).ok();
                if let Some((_, subscription)) = subscriptions.lock().await.remove(&session_id) {
                    subscription.abort();
                }
                Ok(
                    json!({ "sessionId": session_id, "status": "detached", "state": terminal_session.map(|session| Self::terminal_state_payload(&session, Some(&view_id))) }),
                )
            }
            "terminal.spawn.visible" => {
                let source = Self::require_terminal_auth(&pty, &payload)?;
                let connect_to = payload["connectTo"]
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let connection_requested = connect_to.is_some();
                if connect_to.is_some_and(|target| target != "self") {
                    return Err(anyhow::anyhow!(
                        "VALIDATION_UNSUPPORTED_CONNECT_TARGET: --connect-to currently accepts only 'self'"
                    ));
                }
                let context = db.canvas_node_context(&source)?.ok_or_else(|| {
                    anyhow::anyhow!("The source terminal is not represented on a canvas")
                })?;
                let workspace_id = context["workspaceId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Canvas terminal has no workspace"))?;
                let workspace_root = db
                    .get_workspace_path(workspace_id)?
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("Workspace path is not configured"))?;
                let session_id = format!("term_{}", uuid::Uuid::new_v4().simple());
                let requested_cwd = payload["cwd"].as_str().unwrap_or(".");
                let cwd = WorkspaceManager::secure_path(&workspace_root, requested_cwd, false)?
                    .to_string_lossy()
                    .to_string();
                let cols = payload["cols"].as_u64().unwrap_or(100).clamp(20, 500) as u16;
                let rows = payload["rows"].as_u64().unwrap_or(30).clamp(4, 200) as u16;
                let command = payload["command"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string);
                let (receiver, terminal_token) = pty.spawn_terminal(
                    session_id.clone(),
                    Some(cwd.clone()),
                    cols,
                    rows,
                    None,
                    command,
                )?;
                match terminal_sessions.create(
                    session_id.clone(),
                    pty.process_id(&session_id),
                    Some(cwd.clone()),
                ) {
                    Ok(_) => {}
                    Err(error) => {
                        let _ = pty.kill(&session_id);
                        return Err(error);
                    }
                };
                let view_id = Self::terminal_view_id(client_token, &session_id);
                let terminal_session = match terminal_sessions.attach(
                    &session_id,
                    view_id.clone(),
                    client_token.to_string(),
                ) {
                    Ok(session) => session,
                    Err(error) => {
                        let _ = pty.kill(&session_id);
                        return Err(error);
                    }
                };
                let width = 720.0;
                let height = 460.0;
                let node = json!({
                    "id": session_id,
                    "floorId": context["floorId"],
                    "kind": "terminal",
                    "x": context["x"].as_f64().unwrap_or(0.0) + context["width"].as_f64().unwrap_or(520.0) + 96.0,
                    "y": context["y"].as_f64().unwrap_or(0.0),
                    "width": width,
                    "height": height,
                    "z_index": 1,
                    "locked": false,
                    "collapsed": false,
                    "properties": {
                        "title": payload["title"].as_str().unwrap_or("Terminal conectado"),
                        "agent": payload["agent"].as_str().unwrap_or("Orchestra Terminal"),
                        "cwd": cwd,
                        "command": payload["command"].as_str().unwrap_or(""),
                        "status": "running"
                    }
                });
                if let Err(error) = db.save_canvas_node(workspace_id, &node) {
                    let _ = pty.kill(&session_id);
                    return Err(error);
                }
                let permissions = ["send_prompt", "receive_response", "share_context"];
                let edge_id = connection_requested
                    .then(|| format!("e_{}_{}", source, node["id"].as_str().unwrap_or_default()));
                if let Some(edge_id) = edge_id.as_deref() {
                    if let Err(error) = db.save_canvas_edge(
                        workspace_id,
                        &json!({
                            "id": edge_id,
                            "floorId": context["floorId"],
                            "source": source,
                            "target": node["id"],
                            "label": "connected",
                            "permissions": permissions
                        }),
                    ) {
                        // The node is persisted before its cable because the
                        // edge validator needs both endpoints to exist. If
                        // the second half fails (bad floor, DB contention,
                        // malformed permissions), roll the node back as well
                        // as the live PTY. Otherwise a failed CLI/skill
                        // request leaves a visible orphan that can later be
                        // mistaken for a connected agent.
                        let _ = db.delete_canvas_node_for_workspace(
                            workspace_id,
                            node["id"].as_str().unwrap_or_default(),
                        );
                        let _ = pty.kill(&session_id);
                        return Err(error);
                    }
                }
                let subscription_id = uuid::Uuid::new_v4().to_string();
                let subscription = Self::stream_terminal_output(
                    writer.clone(),
                    receiver,
                    session_id.clone(),
                    subscription_id.clone(),
                    pty.clone(),
                    terminal_sessions.clone(),
                    subscriptions.clone(),
                );
                if let Some(previous) = subscriptions
                    .lock()
                    .await
                    .insert(session_id.clone(), (subscription_id, subscription))
                {
                    previous.1.abort();
                }
                Self::emit_terminal_state(&writer, &terminal_sessions, &session_id, Some(&view_id))
                    .await;
                Ok(json!({
                    "sessionId": session_id,
                    "token": terminal_token,
                    "visible": true,
                    "terminalCreated": true,
                    "connectionRequested": connection_requested,
                    "connectionCreated": edge_id.is_some(),
                    "edgeId": edge_id,
                    "permissions": if connection_requested { permissions.as_slice() } else { &[] },
                    "refreshRequired": false,
                    "state": Self::terminal_state_payload(&terminal_session, Some(&view_id))
                }))
            }
            "terminal.spawn" => {
                let session_id = payload["sessionId"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if session_id.is_empty() {
                    return Err(anyhow::anyhow!("Missing sessionId"));
                }
                let cwd = if let Some(root) = payload["workspaceRoot"].as_str() {
                    let requested = payload["cwd"].as_str().unwrap_or(".");
                    Some(
                        WorkspaceManager::secure_path(root, requested, false)?
                            .to_string_lossy()
                            .to_string(),
                    )
                } else {
                    payload["cwd"].as_str().map(|s| s.to_string())
                };
                let cols = payload["cols"].as_u64().unwrap_or(80).clamp(20, 500) as u16;
                let rows = payload["rows"].as_u64().unwrap_or(24).clamp(4, 200) as u16;

                let env_vars: Option<HashMap<String, String>> =
                    payload["env"].as_object().map(|obj| {
                        obj.iter()
                            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                            .collect()
                    });

                let command_line = payload["command"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .filter(|value| *value != "zsh" && *value != "bash")
                    .map(str::to_string);

                let session_cwd = cwd.clone();
                let (receiver, terminal_token) = pty.spawn_terminal(
                    session_id.clone(),
                    cwd,
                    cols,
                    rows,
                    env_vars,
                    command_line,
                )?;
                let view_id = Self::terminal_view_id(client_token, &session_id);
                match terminal_sessions.create(
                    session_id.clone(),
                    pty.process_id(&session_id),
                    session_cwd,
                ) {
                    Ok(_) => {}
                    Err(error) => {
                        let _ = pty.kill(&session_id);
                        return Err(error);
                    }
                };
                let terminal_session = match terminal_sessions.attach(
                    &session_id,
                    view_id.clone(),
                    client_token.to_string(),
                ) {
                    Ok(session) => session,
                    Err(error) => {
                        let _ = pty.kill(&session_id);
                        return Err(error);
                    }
                };

                let subscription_id = uuid::Uuid::new_v4().to_string();
                let subscription = Self::stream_terminal_output(
                    writer.clone(),
                    receiver,
                    session_id.clone(),
                    subscription_id.clone(),
                    pty.clone(),
                    terminal_sessions.clone(),
                    subscriptions.clone(),
                );
                if let Some(previous) = subscriptions
                    .lock()
                    .await
                    .insert(session_id.clone(), (subscription_id, subscription))
                {
                    previous.1.abort();
                }
                Self::emit_terminal_state(&writer, &terminal_sessions, &session_id, Some(&view_id))
                    .await;

                Ok(
                    json!({ "sessionId": session_id, "token": terminal_token, "status": "started", "protocolVersion": PROTOCOL_VERSION, "state": Self::terminal_state_payload(&terminal_session, Some(&view_id)) }),
                )
            }
            "terminal.input" => {
                let session_id = Self::require_terminal_auth(&pty, &payload)?;
                let data = if let Some(encoded) = payload["dataBase64"].as_str() {
                    base64::engine::general_purpose::STANDARD.decode(encoded)?
                } else {
                    payload["data"].as_str().unwrap_or("").as_bytes().to_vec()
                };
                if data.len() > 1 * 1024 * 1024 {
                    return Err(anyhow::anyhow!("Terminal input exceeds 1 MiB"));
                }
                let _terminal_io_guard = terminal_io_lock.lock().await;
                pty.write_input(&session_id, &data)?;
                Ok(json!({ "success": true }))
            }
            "terminal.execute" => {
                let session_id = Self::require_terminal_auth(&pty, &payload)?;
                let command = payload["data"].as_str().unwrap_or("");
                if command.len() > 1 * 1024 * 1024 || command.contains('\0') {
                    return Err(anyhow::anyhow!(
                        "Terminal command exceeds the execution limit"
                    ));
                }
                let current = terminal_sessions
                    .snapshot(&session_id)
                    .ok_or_else(|| anyhow::anyhow!("Terminal session is not registered"))?;
                if current.interaction_mode != TerminalInteractionMode::ShellPrompt {
                    return Err(anyhow::anyhow!(
                        "Rich command execution requires a confirmed shell prompt"
                    ));
                }
                let _terminal_io_guard = terminal_io_lock.lock().await;
                terminal_sessions
                    .transition(&session_id, TerminalTransition::RichCommandStarted)?;
                Self::emit_terminal_state(&writer, &terminal_sessions, &session_id, None).await;
                // A single-line command can use the shell's normal readline
                // path, which produces one native echo. Bracketed paste is
                // required for embedded newlines so the shell receives the
                // complete editor document as one handoff.
                let handoff = if command.contains('\n') {
                    format!("\x1b[200~{command}\x1b[201~\r")
                } else {
                    format!("{command}\r")
                };
                if let Err(error) = pty.write_input(&session_id, handoff.as_bytes()) {
                    let _ = terminal_sessions
                        .transition(&session_id, TerminalTransition::RichCommandFailed);
                    Self::emit_terminal_state(&writer, &terminal_sessions, &session_id, None).await;
                    return Err(error);
                }
                Ok(json!({ "success": true, "bytes": handoff.len() }))
            }
            "terminal.complete" => {
                let session_id = Self::require_terminal_auth(&pty, &payload)?;
                let session = terminal_sessions
                    .snapshot(&session_id)
                    .ok_or_else(|| anyhow::anyhow!("Terminal session is not registered"))?;
                let cwd = payload["cwd"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .or_else(|| session.cwd.clone().map(PathBuf::from))
                    .unwrap_or_else(|| {
                        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                    });
                let value = payload["value"].as_str().unwrap_or("");
                let kind = payload["kind"].as_str().unwrap_or("path");
                let mut items = Vec::new();
                match kind {
                    "path" => {
                        let (directory, prefix) = if value.ends_with('/') {
                            (PathBuf::from(value), String::new())
                        } else {
                            let value_path = PathBuf::from(value);
                            (
                                value_path
                                    .parent()
                                    .unwrap_or_else(|| std::path::Path::new("."))
                                    .to_path_buf(),
                                value_path
                                    .file_name()
                                    .and_then(|name| name.to_str())
                                    .unwrap_or("")
                                    .to_string(),
                            )
                        };
                        let directory = if directory.is_absolute() {
                            directory
                        } else {
                            cwd.join(directory)
                        };
                        if let Ok(entries) = std::fs::read_dir(directory) {
                            for entry in entries.flatten() {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if !name.starts_with(&prefix)
                                    || (!prefix.starts_with('.') && name.starts_with('.'))
                                {
                                    continue;
                                }
                                let is_directory = entry
                                    .file_type()
                                    .map(|file_type| file_type.is_dir())
                                    .unwrap_or(false);
                                items.push(json!({
                                    "label": format!("{}{}", name, if is_directory { "/" } else { "" }),
                                    "type": if is_directory { "folder" } else { "file" },
                                    "detail": if is_directory { "directory" } else { "file" }
                                }));
                            }
                        }
                    }
                    "executable" => {
                        let mut names = BTreeSet::new();
                        for directory in std::env::var_os("PATH")
                            .unwrap_or_default()
                            .to_string_lossy()
                            .split(':')
                        {
                            let directory = PathBuf::from(directory);
                            let Ok(entries) = std::fs::read_dir(directory) else {
                                continue;
                            };
                            for entry in entries.flatten() {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if name.starts_with(value)
                                    && entry
                                        .file_type()
                                        .map(|file_type| file_type.is_file())
                                        .unwrap_or(false)
                                {
                                    names.insert(name);
                                }
                            }
                        }
                        items.extend(names.into_iter().take(200).map(|name| {
                            json!({
                                "label": name,
                                "type": "keyword",
                                "detail": "executable"
                            })
                        }));
                    }
                    "git" => {
                        if let Ok(output) = Command::new("git")
                            .args(["branch", "--format=%(refname:short)"])
                            .current_dir(&cwd)
                            .output()
                        {
                            items.extend(
                                String::from_utf8_lossy(&output.stdout)
                                    .lines()
                                    .filter(|line| line.starts_with(value))
                                    .map(|line| {
                                        json!({
                                            "label": line,
                                            "type": "text",
                                            "detail": "git branch"
                                        })
                                    }),
                            );
                        }
                    }
                    "npm" | "pnpm" | "yarn" | "bun" => {
                        if let Ok(raw) = std::fs::read_to_string(cwd.join("package.json")) {
                            if let Ok(package) = serde_json::from_str::<Value>(&raw) {
                                if let Some(scripts) = package["scripts"].as_object() {
                                    items.extend(
                                        scripts.keys().filter(|name| name.starts_with(value)).map(
                                            |name| {
                                                json!({
                                                    "label": name,
                                                    "type": "function",
                                                    "detail": format!("{} script", kind)
                                                })
                                            },
                                        ),
                                    );
                                }
                            }
                        }
                    }
                    _ => {}
                }
                Ok(json!({ "items": items }))
            }
            "terminal.screen" => {
                let source = Self::require_terminal_auth(&pty, &payload)?;
                let target = payload["targetSessionId"].as_str().unwrap_or(&source);
                if target != source
                    && !db.has_connection_permission(&source, target, "receive_response")?
                {
                    let report = db.connection_permission_report(&source, target)?;
                    return Err(anyhow::anyhow!(
                        "The terminal connection does not grant receive_response permission (source={source}, target={target}, report={report})"
                    ));
                }
                let snapshot = pty.snapshot(target)?;
                let plain = strip_ansi(&String::from_utf8_lossy(&snapshot));
                let tail = plain
                    .chars()
                    .rev()
                    .take(12_000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>();
                Ok(json!({
                    "sessionId": target,
                    "stateHint": terminal_state_hint(&snapshot),
                    "encoding": "base64",
                    "scrollback": base64::engine::general_purpose::STANDARD.encode(snapshot),
                    "plainTail": tail,
                    "semanticDelivery": "unknown"
                }))
            }
            "terminal.control" => {
                let source = Self::require_terminal_auth(&pty, &payload)?;
                let target = payload["targetSessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing targetSessionId"))?;
                if target != source
                    && !db.has_connection_permission(&source, target, "send_prompt")?
                {
                    let report = db.connection_permission_report(&source, target)?;
                    return Err(anyhow::anyhow!(
                        "The terminal connection does not grant send_prompt permission (source={source}, target={target}, report={report})"
                    ));
                }
                let data = if let Some(encoded) = payload["dataBase64"].as_str() {
                    base64::engine::general_purpose::STANDARD.decode(encoded)?
                } else {
                    payload["data"].as_str().unwrap_or("").as_bytes().to_vec()
                };
                if data.is_empty() || data.len() > 64 * 1024 {
                    return Err(anyhow::anyhow!(
                        "Terminal control input is invalid or too large"
                    ));
                }
                let _terminal_io_guard = terminal_io_lock.lock().await;
                pty.write_input(target, &data)?;
                Ok(json!({
                    "status": "unverified",
                    "ptyWritten": true,
                    "delivered": false,
                    "agentAcknowledged": false,
                    "completed": false,
                    "unverified": true,
                    "semanticDelivery": "unverified",
                    "fromSessionId": source,
                    "toSessionId": target
                }))
            }
            "terminal.resize" => {
                let session_id = Self::require_terminal_auth(&pty, &payload)?;
                let cols = payload["cols"].as_u64().unwrap_or(80).clamp(20, 500) as u16;
                let rows = payload["rows"].as_u64().unwrap_or(24).clamp(4, 200) as u16;
                let _terminal_io_guard = terminal_io_lock.lock().await;
                pty.resize(&session_id, cols, rows)?;
                Ok(json!({ "success": true }))
            }
            "terminal.kill" => {
                let session_id = Self::require_terminal_auth(&pty, &payload)?;
                let _terminal_io_guard = terminal_io_lock.lock().await;
                if let Some((_, subscription)) = subscriptions.lock().await.remove(&session_id) {
                    subscription.abort();
                }
                pty.kill(&session_id)?;
                let terminal_session = terminal_sessions
                    .process_exited(&session_id, None)
                    .or_else(|_| terminal_sessions.mark_disconnected(&session_id))
                    .ok();
                if terminal_session.is_some() {
                    Self::emit_terminal_state(
                        &writer,
                        &terminal_sessions,
                        &session_id,
                        Some(&Self::terminal_view_id(client_token, &session_id)),
                    )
                    .await;
                }
                db.record_audit("terminal", "terminal.kill", &session_id, &json!({}))?;
                Ok(json!({ "success": true }))
            }

            // Git
            "git.status" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                GitManager::get_status(&path.to_string_lossy())
            }
            "git.diff" => {
                let root = Self::workspace_root(&payload, &db)?;
                let path = WorkspaceManager::canonical_root(&root)?;
                let file = payload["file"].as_str();
                let safe_file = file
                    .map(|file| WorkspaceManager::secure_path(&root, file, false))
                    .transpose()?;
                let safe_file_string = safe_file
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string());
                let diff =
                    GitManager::get_diff(&path.to_string_lossy(), safe_file_string.as_deref())?;
                Ok(json!({ "diff": diff }))
            }
            "git.diff.staged" => {
                let root = Self::workspace_root(&payload, &db)?;
                let path = WorkspaceManager::canonical_root(&root)?;
                let file = payload["file"].as_str();
                let safe_file = file
                    .map(|file| WorkspaceManager::secure_path(&root, file, false))
                    .transpose()?;
                let safe_file_string = safe_file
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string());
                Ok(
                    json!({ "diff": GitManager::get_staged_diff(&path.to_string_lossy(), safe_file_string.as_deref())? }),
                )
            }
            "git.log" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let limit = payload["limit"].as_u64().unwrap_or(30).clamp(1, 500) as usize;
                let commits = GitManager::get_log(&path.to_string_lossy(), limit)?;
                Ok(json!({ "commits": commits }))
            }
            "git.stage" => {
                let root = Self::workspace_root(&payload, &db)?;
                let repo = WorkspaceManager::canonical_root(&root)?;
                let file = payload["file"].as_str().unwrap_or(".");
                let safe_file = WorkspaceManager::secure_path(&root, file, false)?;
                let relative = safe_file.strip_prefix(&repo).unwrap_or(&safe_file);
                GitManager::stage_file(&repo.to_string_lossy(), &relative.to_string_lossy())?;
                db.record_audit(
                    "ipc-client",
                    "git.stage",
                    &relative.to_string_lossy(),
                    &json!({ "workspaceRoot": repo }),
                )?;
                Ok(json!({ "success": true }))
            }
            "git.unstage" => {
                let root = Self::workspace_root(&payload, &db)?;
                let repo = WorkspaceManager::canonical_root(&root)?;
                let file = payload["file"].as_str().unwrap_or(".");
                let safe_file = WorkspaceManager::secure_path(&root, file, false)?;
                let relative = safe_file.strip_prefix(&repo).unwrap_or(&safe_file);
                GitManager::unstage_file(&repo.to_string_lossy(), &relative.to_string_lossy())?;
                db.record_audit(
                    "ipc-client",
                    "git.unstage",
                    &relative.to_string_lossy(),
                    &json!({ "workspaceRoot": repo }),
                )?;
                Ok(json!({ "success": true }))
            }
            "git.commit" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let msg = payload["message"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Commit message is required"))?;
                let amend = payload["amend"].as_bool().unwrap_or(false);
                let sign = payload["sign"].as_bool().unwrap_or(false);
                if amend || sign {
                    GitManager::commit_with_options(&path.to_string_lossy(), msg, amend, sign)?;
                } else {
                    GitManager::commit(&path.to_string_lossy(), msg)?;
                }
                db.record_audit(
                    "ipc-client",
                    "git.commit",
                    &path.to_string_lossy(),
                    &json!({ "message": msg }),
                )?;
                Ok(json!({ "success": true }))
            }
            "git.refs" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                GitManager::refs(&path.to_string_lossy())
            }
            "git.blame" => {
                let root = Self::workspace_root(&payload, &db)?;
                let file = payload["file"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing file"))?;
                let safe_file = WorkspaceManager::secure_path(&root, file, false)?;
                Ok(json!({ "lines": GitManager::blame(&root, &safe_file.to_string_lossy())? }))
            }
            "git.stash.list" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                Ok(json!({ "stashes": GitManager::stash_list(&path.to_string_lossy())? }))
            }
            "git.stash.push" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                GitManager::stash_push(
                    &path.to_string_lossy(),
                    payload["message"].as_str(),
                    payload["includeUntracked"].as_bool().unwrap_or(false),
                )?;
                db.record_audit(
                    "ipc-client",
                    "git.stash.push",
                    &path.to_string_lossy(),
                    &payload,
                )?;
                Ok(json!({ "success": true }))
            }
            "git.stash.apply" | "git.stash.pop" | "git.stash.drop" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let action = msg_type.strip_prefix("git.stash.").unwrap_or_default();
                let name = payload["name"].as_str().unwrap_or("stash@{0}");
                GitManager::stash_action(&path.to_string_lossy(), action, name)?;
                db.record_audit("ipc-client", msg_type, name, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.branch.list" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                Ok(json!({ "branches": GitManager::branch_list(&path.to_string_lossy())? }))
            }
            "git.branch.create" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let name = payload["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing branch name"))?;
                GitManager::branch_create(
                    &path.to_string_lossy(),
                    name,
                    payload["startPoint"].as_str(),
                    payload["checkout"].as_bool().unwrap_or(false),
                )?;
                db.record_audit("ipc-client", "git.branch.create", name, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.branch.checkout" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let name = payload["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing branch name"))?;
                GitManager::branch_checkout(&path.to_string_lossy(), name)?;
                db.record_audit("ipc-client", "git.branch.checkout", name, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.branch.rename" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let old = payload["oldName"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing old branch name"))?;
                let new = payload["newName"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing new branch name"))?;
                GitManager::branch_rename(&path.to_string_lossy(), old, new)?;
                db.record_audit("ipc-client", "git.branch.rename", old, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.branch.delete" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let name = payload["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing branch name"))?;
                GitManager::branch_delete(
                    &path.to_string_lossy(),
                    name,
                    payload["force"].as_bool().unwrap_or(false),
                    payload["confirm"].as_bool().unwrap_or(false),
                )?;
                db.record_audit("ipc-client", "git.branch.delete", name, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.tag.create" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let name = payload["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing tag name"))?;
                GitManager::tag(
                    &path.to_string_lossy(),
                    name,
                    payload["target"].as_str(),
                    payload["message"].as_str(),
                )?;
                db.record_audit("ipc-client", "git.tag.create", name, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.tag.delete" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let name = payload["name"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing tag name"))?;
                GitManager::tag_delete(
                    &path.to_string_lossy(),
                    name,
                    payload["confirm"].as_bool().unwrap_or(false),
                )?;
                db.record_audit("ipc-client", "git.tag.delete", name, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.remote.fetch" | "git.remote.pull" | "git.remote.push" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let operation = msg_type.strip_prefix("git.remote.").unwrap_or_default();
                let remote = payload["remote"].as_str();
                GitManager::remote_operation(
                    &path.to_string_lossy(),
                    operation,
                    remote,
                    payload["branch"].as_str(),
                    payload["force"].as_bool().unwrap_or(false),
                    payload["confirm"].as_bool().unwrap_or(false),
                )?;
                db.record_audit("ipc-client", msg_type, remote.unwrap_or("origin"), &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.merge" | "git.rebase" | "git.cherry-pick" | "git.revert" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let operation = msg_type.strip_prefix("git.").unwrap_or_default();
                let target = payload["target"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing history target"))?;
                GitManager::history_operation(
                    &path.to_string_lossy(),
                    operation,
                    target,
                    payload["confirm"].as_bool().unwrap_or(false),
                )?;
                db.record_audit("ipc-client", msg_type, target, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.operation.abort" | "git.operation.continue" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let kind = payload["kind"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing operation kind"))?;
                let operation = format!(
                    "{kind}-{}",
                    msg_type.strip_prefix("git.operation.").unwrap_or_default()
                );
                GitManager::operation_control(&path.to_string_lossy(), &operation)?;
                db.record_audit("ipc-client", msg_type, kind, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.reset" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let target = payload["target"].as_str().unwrap_or("HEAD");
                let mode = payload["mode"].as_str().unwrap_or("mixed");
                GitManager::reset(
                    &path.to_string_lossy(),
                    target,
                    mode,
                    payload["confirm"].as_bool().unwrap_or(false),
                )?;
                db.record_audit("ipc-client", "git.reset", target, &payload)?;
                Ok(json!({ "success": true }))
            }
            "git.create_floor" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                let name = payload["name"].as_str().unwrap_or("floor-1");
                let branch = payload["branch"].as_str().unwrap_or("feature/floor-1");
                let worktree_dir =
                    GitManager::create_floor_worktree(&path.to_string_lossy(), name, branch)?;
                Ok(json!({ "worktreeDir": worktree_dir }))
            }
            "git.worktrees" => {
                let path = Self::workspace_path(&payload, &db, false)?;
                Ok(json!({ "worktrees": GitManager::list_worktrees(&path.to_string_lossy())? }))
            }

            // Roles
            "roles.list" => Ok(json!(db.get_roles()?)),
            "roles.save" => {
                db.save_role(&payload["role"])?;
                Ok(json!({ "success": true }))
            }
            "roles.apply" => {
                let role_id = payload["roleId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing roleId"))?;
                if !role_id.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '_' || character == '-'
                }) {
                    return Err(anyhow::anyhow!("Invalid roleId"));
                }
                let role = db
                    .get_roles()?
                    .into_iter()
                    .find(|role| role["id"].as_str() == Some(role_id))
                    .ok_or_else(|| anyhow::anyhow!("Role not found"))?;
                let root = Self::workspace_root(&payload, &db)?;
                let orchestra_dir = WorkspaceManager::secure_path(&root, ".orchestra", true)?;
                let roles_dir = orchestra_dir.join("roles");
                std::fs::create_dir_all(&roles_dir)?;
                let relative = format!(".orchestra/roles/{role_id}.md");
                let role_path = WorkspaceManager::secure_path(&root, &relative, true)?;
                let permissions = role["permissions"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                let content = format!(
                    "# {}\n\n{}\n\n## Orchestra permissions\n{}\n",
                    role["name"].as_str().unwrap_or("Role"),
                    role["instructions"].as_str().unwrap_or_default(),
                    permissions
                );
                WorkspaceManager::write_file(&role_path.to_string_lossy(), &content)?;
                // Keep a conventional instruction file beside the role
                // registry so CLIs that do not know Orchestra's metadata can
                // still load the generated role safely.
                let agents_path =
                    WorkspaceManager::secure_path(&root, ".orchestra/AGENTS.md", true)?;
                WorkspaceManager::write_file(&agents_path.to_string_lossy(), &content)?;
                db.record_audit(
                    "ipc-client",
                    "role.apply",
                    role_id,
                    &json!({ "path": role_path }),
                )?;
                Ok(json!({ "success": true, "path": role_path, "agentsPath": agents_path }))
            }
            "roles.delete" => {
                let id = payload["id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing role id"))?;
                db.delete_role(id)?;
                db.record_audit("ipc-client", "role.delete", id, &json!({}))?;
                Ok(json!({ "success": true }))
            }

            "environments.list" => Ok(json!(db.get_environments()?)),
            "environments.save" => {
                db.save_environment(&payload["environment"])?;
                let id = payload["environment"]["id"].as_str().unwrap_or("unknown");
                db.record_audit(
                    "ipc-client",
                    "environment.save",
                    id,
                    &payload["environment"],
                )?;
                Ok(json!({ "success": true }))
            }
            "environments.delete" => {
                let id = payload["id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing environment id"))?;
                db.delete_environment(id)?;
                db.record_audit("ipc-client", "environment.delete", id, &json!({}))?;
                Ok(json!({ "success": true }))
            }
            "environment.probe" => {
                let kind = payload["kind"].as_str().unwrap_or("local");
                let endpoint = payload["endpoint"].as_str().unwrap_or("");
                let (available, detail) = match kind {
                    "local" => (true, "local host".to_string()),
                    "docker" | "podman" => {
                        let output = Command::new(kind)
                            .args(["version", "--format", "{{.Server.Version}}"])
                            .output();
                        match output {
                            Ok(output) if output.status.success() => (
                                true,
                                String::from_utf8_lossy(&output.stdout).trim().to_string(),
                            ),
                            Ok(output) => (
                                false,
                                String::from_utf8_lossy(&output.stderr).trim().to_string(),
                            ),
                            Err(error) => (false, error.to_string()),
                        }
                    }
                    "ssh" => {
                        if endpoint.trim().is_empty() {
                            (false, "SSH endpoint required".to_string())
                        } else {
                            let output = Command::new("ssh").args(["-G", endpoint]).output();
                            match output {
                                Ok(output) if output.status.success() => {
                                    (true, "SSH configuration valid".to_string())
                                }
                                Ok(output) => (
                                    false,
                                    String::from_utf8_lossy(&output.stderr).trim().to_string(),
                                ),
                                Err(error) => (false, error.to_string()),
                            }
                        }
                    }
                    _ => (false, format!("Unsupported environment kind: {kind}")),
                };
                Ok(json!({ "available": available, "detail": detail }))
            }
            "environment.exec" => {
                let argv = payload["argv"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("argv must be an array"))?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_string)
                            .ok_or_else(|| anyhow::anyhow!("argv entries must be strings"))
                    })
                    .collect::<Result<Vec<_>>>()?;
                if argv.is_empty()
                    || argv.len() > 64
                    || argv.iter().any(|value| {
                        value.len() > 16 * 1024 || value.chars().any(|character| character == '\0')
                    })
                {
                    return Err(anyhow::anyhow!("Invalid environment command"));
                }
                let environment_id = payload["environmentId"].as_str();
                let environment = if let Some(id) = environment_id {
                    db.get_environment(id)?
                        .ok_or_else(|| anyhow::anyhow!("Environment not found"))?
                } else {
                    json!({ "kind": payload["kind"].as_str().unwrap_or("local"), "config": payload["config"].clone() })
                };
                let kind = environment["kind"].as_str().unwrap_or("local");
                let config = environment["config"].clone();
                let mut command = argv.clone();
                let program = match kind {
                    "local" => command.remove(0),
                    "docker" | "podman" => {
                        let container = config["container"]
                            .as_str()
                            .or_else(|| config["endpoint"].as_str())
                            .filter(|value| !value.trim().is_empty())
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "Container environment requires a container endpoint"
                                )
                            })?;
                        if container.starts_with('-')
                            || container.chars().any(|character| {
                                character.is_control() || character.is_whitespace()
                            })
                        {
                            return Err(anyhow::anyhow!("Invalid container endpoint"));
                        }
                        let runtime = kind.to_string();
                        let mut args = vec!["exec".to_string(), container.to_string()];
                        args.extend(command);
                        command = args;
                        runtime
                    }
                    "ssh" => {
                        let endpoint = config["endpoint"]
                            .as_str()
                            .filter(|value| !value.trim().is_empty())
                            .ok_or_else(|| {
                                anyhow::anyhow!("SSH environment requires an endpoint")
                            })?;
                        if endpoint.starts_with('-')
                            || endpoint.chars().any(|character| {
                                character.is_control() || character.is_whitespace()
                            })
                        {
                            return Err(anyhow::anyhow!("Invalid SSH endpoint"));
                        }
                        let mut args = vec![
                            "-o".to_string(),
                            "BatchMode=yes".to_string(),
                            "-o".to_string(),
                            "StrictHostKeyChecking=yes".to_string(),
                            endpoint.to_string(),
                            "--".to_string(),
                        ];
                        args.extend(command);
                        command = args;
                        "ssh".to_string()
                    }
                    _ => return Err(anyhow::anyhow!("Unsupported environment kind: {kind}")),
                };
                let timeout_ms = payload["timeoutMs"]
                    .as_u64()
                    .unwrap_or(30_000)
                    .clamp(100, 300_000);
                let mut child = Command::new(program)
                    .args(command)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()?;
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
                let timed_out = loop {
                    if child.try_wait()?.is_some() {
                        break false;
                    }
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        break true;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                };
                let output = child.wait_with_output()?;
                Ok(json!({
                    "exitCode": output.status.code(),
                    "timedOut": timed_out,
                    "stdout": String::from_utf8_lossy(&output.stdout),
                    "stderr": String::from_utf8_lossy(&output.stderr)
                }))
            }
            "settings.get" => {
                let key = payload["key"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing setting key"))?;
                Ok(json!(db.get_setting(key)?))
            }
            "settings.save" => {
                let key = payload["key"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing setting key"))?;
                db.save_setting(key, &payload["value"])?;
                Ok(json!({ "success": true }))
            }
            "system.paths" => {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                let runtime =
                    std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".to_string());
                let config =
                    std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{home}/.config"));
                let data = std::env::var("XDG_DATA_HOME")
                    .unwrap_or_else(|_| format!("{home}/.local/share"));
                Ok(json!({
                    "config": format!("{config}/orchestra"),
                    "data": format!("{data}/orchestra"),
                    "runtime": format!("{runtime}/orchestra"),
                    "socket": format!("{runtime}/orchestra/orchestra.sock"),
                    "database": db.path()
                }))
            }

            _ => Err(anyhow::anyhow!("Unknown message type: {}", msg_type)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener as StdUnixListener;
    use tokio::sync::oneshot;

    fn test_socket(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "orchestra-{label}-{}.sock",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[tokio::test]
    async fn normal_shutdown_and_restart_reuses_the_same_socket() {
        let path = test_socket("restart");
        let (listener, ownership) = bind_control_socket(&path).await.expect("first bind");
        let mode = std::fs::symlink_metadata(&path)
            .expect("socket metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);

        drop(listener);
        drop(ownership);
        assert!(!path.exists(), "owned socket should be removed on shutdown");

        let (listener, ownership) = bind_control_socket(&path).await.expect("restart bind");
        drop(listener);
        drop(ownership);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn refused_stale_socket_is_recovered() {
        let path = test_socket("stale");
        let stale = StdUnixListener::bind(&path).expect("create stale socket");
        drop(stale);
        assert!(path.exists());

        let (listener, ownership) = bind_control_socket(&path)
            .await
            .expect("recover stale socket");
        assert!(UnixStream::connect(&path).await.is_ok());
        drop(listener);
        drop(ownership);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn second_core_fails_without_replacing_the_live_socket() {
        let path = test_socket("conflict");
        let (first_listener, first_ownership) =
            bind_control_socket(&path).await.expect("first core binds");
        let before = std::fs::symlink_metadata(&path).expect("first socket metadata");

        let error = bind_control_socket(&path)
            .await
            .expect_err("second core must fail")
            .to_string();
        assert!(error.starts_with("INSTANCE_CONFLICT:"), "{error}");
        let after = std::fs::symlink_metadata(&path).expect("live socket remains");
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert!(UnixStream::connect(&path).await.is_ok());

        drop(first_listener);
        drop(first_ownership);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn shutdown_does_not_unlink_a_replacement_socket() {
        let path = test_socket("replacement");
        let (listener, ownership) = bind_control_socket(&path).await.expect("owned bind");
        drop(listener);
        std::fs::remove_file(&path).expect("simulate external stale recovery");
        let replacement = StdUnixListener::bind(&path).expect("replacement bind");

        drop(ownership);
        assert!(path.exists(), "old owner must preserve replacement inode");

        drop(replacement);
        std::fs::remove_file(path).expect("remove replacement socket");
    }

    async fn request(stream: &mut UnixStream, message_type: &str, payload: Value) -> Value {
        let request_id = format!("test_{}", uuid::Uuid::new_v4().simple());
        let bytes = serde_json::to_vec(&json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "type": message_type,
            "payload": payload
        }))
        .expect("serialize request");
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .await
            .expect("write request length");
        stream.write_all(&bytes).await.expect("write request");

        loop {
            let mut length = [0u8; 4];
            stream
                .read_exact(&mut length)
                .await
                .expect("read response length");
            let mut response = vec![0u8; u32::from_be_bytes(length) as usize];
            stream
                .read_exact(&mut response)
                .await
                .expect("read response");
            let response: Value = serde_json::from_slice(&response).expect("parse response");
            if response["requestId"].as_str() == Some(request_id.as_str()) {
                return response;
            }
        }
    }

    async fn connect_when_ready(path: &Path) -> UnixStream {
        for _ in 0..100 {
            if let Ok(stream) = UnixStream::connect(path).await {
                return stream;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("server did not bind {}", path.display());
    }

    #[tokio::test]
    async fn authenticated_health_operations_agree_and_reject_bad_tokens() {
        let socket_path = test_socket("auth-health");
        let database_path = socket_path.with_extension("db");
        let workspace_root = std::env::temp_dir().join(format!(
            "orchestra-spawn-workspace-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&workspace_root).expect("test workspace");
        let session_id = format!("term_{}", uuid::Uuid::new_v4().simple());
        let database = Arc::new(Database::new(&database_path).expect("test database"));
        database
            .save_workspace("ws", "Test workspace", &workspace_root.to_string_lossy())
            .expect("save workspace");
        database
            .save_canvas_node(
                "ws",
                &json!({
                    "id": session_id,
                    "floorId": null,
                    "kind": "terminal",
                    "x": 10,
                    "y": 20,
                    "width": 520,
                    "height": 360,
                    "properties": { "title": "Coordinator" }
                }),
            )
            .expect("save source canvas node");
        let server = Arc::new(SocketServer::new(
            database.clone(),
            PtyManager::new(),
            TerminalSessionRegistry::new(),
        ));
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server_task = {
            let server = server.clone();
            let socket_path = socket_path.clone();
            tokio::spawn(async move {
                server
                    .run_until(socket_path, async {
                        let _ = shutdown_rx.await;
                    })
                    .await
            })
        };

        let mut stream = connect_when_ready(&socket_path).await;
        let hello = request(&mut stream, "system.hello", json!({})).await;
        assert_eq!(hello["ok"], true);
        let client_token = hello["result"]["clientToken"]
            .as_str()
            .expect("client token")
            .to_string();

        let spawn = request(
            &mut stream,
            "terminal.spawn",
            json!({
                "clientToken": client_token,
                "sessionId": session_id,
                "cwd": workspace_root,
                "command": "cat"
            }),
        )
        .await;
        assert_eq!(spawn["ok"], true, "{spawn}");
        let terminal_token = spawn["result"]["token"]
            .as_str()
            .expect("terminal token")
            .to_string();
        let auth = || {
            json!({
                "clientToken": client_token,
                "sessionId": session_id,
                "token": terminal_token
            })
        };

        let state = request(&mut stream, "terminal.state", auth()).await;
        assert_eq!(state["ok"], true, "{state}");
        assert_eq!(state["result"]["sessionId"], session_id);

        let connections = request(&mut stream, "connection.list", auth()).await;
        assert_eq!(connections["ok"], true, "{connections}");
        assert!(connections["result"].is_array());

        let agents = request(&mut stream, "agent.list", auth()).await;
        assert_eq!(agents["ok"], true, "{agents}");
        assert!(agents["result"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["sessionId"] == session_id)));

        let invalid = request(
            &mut stream,
            "terminal.state",
            json!({
                "clientToken": client_token,
                "sessionId": session_id,
                "token": "invalid-token"
            }),
        )
        .await;
        assert_eq!(invalid["ok"], false);
        assert!(invalid["error"]
            .as_str()
            .is_some_and(|error| error.starts_with("AUTH_INVALID:")));

        let stale = request(
            &mut stream,
            "terminal.state",
            json!({
                "clientToken": client_token,
                "sessionId": "missing-session",
                "token": "invalid-token"
            }),
        )
        .await;
        assert_eq!(stale["ok"], false);
        assert!(stale["error"]
            .as_str()
            .is_some_and(|error| error.starts_with("SESSION_NOT_REGISTERED:")));

        let unsupported = request(
            &mut stream,
            "terminal.spawn.visible",
            json!({
                "clientToken": client_token,
                "sessionId": session_id,
                "token": terminal_token,
                "cwd": ".",
                "connectTo": "arbitrary-terminal"
            }),
        )
        .await;
        assert_eq!(unsupported["ok"], false, "{unsupported}");
        assert!(unsupported["error"]
            .as_str()
            .is_some_and(|error| error.starts_with("VALIDATION_UNSUPPORTED_CONNECT_TARGET:")));
        let agents_after_rejection = request(&mut stream, "agent.list", auth()).await;
        assert_eq!(
            agents_after_rejection["result"]
                .as_array()
                .expect("agents")
                .len(),
            1,
            "unsupported target must not create an orphan terminal"
        );

        let connected_spawn = request(
            &mut stream,
            "terminal.spawn.visible",
            json!({
                "clientToken": client_token,
                "sessionId": session_id,
                "token": terminal_token,
                "cwd": ".",
                "command": "while IFS= read -r line; do case \"$line\" in *ask_completed*) break;; esac; done; printf '\\n<ORCHESTRA_DONE:ask_completed>\\n'; sleep 5",
                "connectTo": "self"
            }),
        )
        .await;
        assert_eq!(connected_spawn["ok"], true, "{connected_spawn}");
        assert_eq!(connected_spawn["result"]["terminalCreated"], true);
        assert_eq!(connected_spawn["result"]["connectionCreated"], true);
        assert!(connected_spawn["result"]["edgeId"].is_string());
        assert_eq!(
            connected_spawn["result"]["permissions"],
            json!(["send_prompt", "receive_response", "share_context"])
        );
        let target_session = connected_spawn["result"]["sessionId"]
            .as_str()
            .expect("spawned session id")
            .to_string();
        let target_token = connected_spawn["result"]["token"]
            .as_str()
            .expect("spawned terminal token")
            .to_string();

        let connected = request(&mut stream, "connection.list", auth()).await;
        assert_eq!(connected["ok"], true, "{connected}");
        let edges = connected["result"].as_array().expect("connections");
        assert_eq!(edges.len(), 1, "self spawn must create exactly one edge");
        assert_eq!(edges[0]["nodeId"], target_session);
        assert_eq!(edges[0]["reachable"], true);

        let sent = request(
            &mut stream,
            "agent.message.send",
            json!({
                "clientToken": client_token,
                "sessionId": session_id,
                "token": terminal_token,
                "agent": target_session,
                "message": "hello"
            }),
        )
        .await;
        assert_eq!(sent["result"]["ptyWritten"], true, "{sent}");
        assert_eq!(sent["result"]["delivered"], false, "{sent}");
        assert_eq!(sent["result"]["unverified"], true, "{sent}");

        let completed = request(
            &mut stream,
            "agent.ask",
            json!({
                "clientToken": client_token,
                "sessionId": session_id,
                "token": terminal_token,
                "agent": target_session,
                "message": "complete the fixture",
                "requestId": "ask_completed",
                "wait": true,
                "timeoutSecs": 2
            }),
        )
        .await;
        assert_eq!(completed["result"]["status"], "completed", "{completed}");
        assert_eq!(completed["result"]["agentAcknowledged"], true);
        assert_eq!(completed["result"]["completed"], true);
        assert_eq!(completed["result"]["unverified"], false);

        let timed_out = request(
            &mut stream,
            "agent.ask",
            json!({
                "clientToken": client_token,
                "sessionId": session_id,
                "token": terminal_token,
                "agent": target_session,
                "message": "do not acknowledge this fixture",
                "requestId": "ask_timeout",
                "wait": true,
                "timeoutSecs": 1
            }),
        )
        .await;
        assert_eq!(timed_out["result"]["status"], "timed_out", "{timed_out}");
        assert_eq!(timed_out["result"]["ptyWritten"], true);
        assert_eq!(timed_out["result"]["completed"], false);
        assert_eq!(timed_out["result"]["unverified"], true);

        let target_killed = request(
            &mut stream,
            "terminal.kill",
            json!({
                "clientToken": client_token,
                "sessionId": target_session,
                "token": target_token
            }),
        )
        .await;
        assert_eq!(target_killed["ok"], true, "{target_killed}");
        let stale_connection = request(&mut stream, "connection.list", auth()).await;
        assert_eq!(stale_connection["result"][0]["reachable"], false);
        assert_eq!(stale_connection["result"][0]["status"], "stale");
        let pruned_agents = request(&mut stream, "agent.list", auth()).await;
        assert!(!pruned_agents["result"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["sessionId"] == target_session)));

        let killed = request(&mut stream, "terminal.kill", auth()).await;
        assert_eq!(killed["ok"], true, "{killed}");
        drop(stream);
        shutdown_tx.send(()).expect("request shutdown");
        server_task
            .await
            .expect("server task")
            .expect("server shutdown");
        assert!(!socket_path.exists());

        let _ = std::fs::remove_file(&database_path);
        let _ = std::fs::remove_file(database_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(database_path.with_extension("db-shm"));
        let _ = std::fs::remove_dir_all(workspace_root);
    }

    #[test]
    fn completion_marker_is_not_present_in_the_injected_prompt() {
        let (prompt, marker) = agent_completion_contract("Do the work", "ask_123");
        assert_eq!(marker, "<ORCHESTRA_DONE:ask_123>");
        assert!(!prompt.contains(&marker));
        assert!(prompt.contains("<ORCHESTRA_DONE:"));
        assert!(prompt.contains("ask_123"));
    }
}
