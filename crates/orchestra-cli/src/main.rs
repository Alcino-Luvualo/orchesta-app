use anyhow::Result;
use base64::Engine;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

const PROTOCOL_VERSION: u32 = 2;
const MAX_FRAME_SIZE: usize = 8 * 1024 * 1024;
const MAX_PORTAL_FRAME_SIZE: usize = 16 * 1024 * 1024;

fn redact_secret(value: &str) -> String {
    redact_secret_value(value, std::env::var("ORCHESTRA_TOKEN").ok().as_deref())
}

fn redact_secret_value(value: &str, token: Option<&str>) -> String {
    match token.filter(|token| !token.is_empty()) {
        Some(token) => value.replace(token, "[redacted]"),
        None => value.to_string(),
    }
}

fn safe_daemon_error(prefix: &str, value: Option<&str>) -> String {
    format!(
        "{prefix}: {}",
        redact_secret(value.unwrap_or("unknown error"))
    )
}

fn configured_socket_path(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn orchestra_socket_path() -> PathBuf {
    configured_socket_path("ORCHESTRA_SOCKET")
        .or_else(|| {
            std::env::var("XDG_RUNTIME_DIR")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|runtime| {
                    PathBuf::from(runtime)
                        .join("orchestra")
                        .join("orchestra.sock")
                })
        })
        .unwrap_or_else(|| PathBuf::from("/tmp/orchestra.sock"))
}

/// This mirrors Electron's getPortalControlSocketPath exactly: resolve the
/// daemon endpoint first, then replace the final .sock suffix. A shared
/// dirname-level /tmp/portal.sock is unsafe when multiple Orchestra instances
/// are open.
fn derived_portal_socket_path(core_path: PathBuf) -> PathBuf {
    let absolute = if core_path.is_absolute() {
        core_path
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(&core_path))
            .unwrap_or(core_path)
    };
    let value = absolute.to_string_lossy();
    value
        .strip_suffix(".sock")
        .map(|prefix| PathBuf::from(format!("{prefix}.portal.sock")))
        .unwrap_or_else(|| PathBuf::from(format!("{value}.portal.sock")))
}

fn portal_socket_path() -> PathBuf {
    configured_socket_path("ORCHESTRA_PORTAL_SOCKET")
        .unwrap_or_else(|| derived_portal_socket_path(orchestra_socket_path()))
}

fn redact_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, child)| {
                    let normalized = key.to_ascii_lowercase();
                    let redacted = normalized == "token"
                        || normalized.ends_with("token")
                        || normalized == "password"
                        || normalized == "secret"
                        || normalized == "auth";
                    (
                        key.clone(),
                        if redacted {
                            Value::String("[redacted]".to_string())
                        } else {
                            redact_value(child)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        other => other.clone(),
    }
}

fn encode_frame(payload: &[u8], max_size: usize, label: &str) -> Result<Vec<u8>> {
    if payload.is_empty() || payload.len() > max_size || payload.len() > u32::MAX as usize {
        anyhow::bail!("{label} exceeds the protocol frame limit");
    }
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

async fn write_frame(
    stream: &mut UnixStream,
    payload: &[u8],
    max_size: usize,
    label: &str,
) -> Result<()> {
    let frame = encode_frame(payload, max_size, label)?;
    stream.write_all(&frame).await?;
    stream.flush().await?;
    Ok(())
}

async fn read_frame(stream: &mut UnixStream, max_size: usize, label: &str) -> Result<Vec<u8>> {
    let mut len_bytes = [0u8; 4];
    stream.read_exact(&mut len_bytes).await?;
    let length = u32::from_be_bytes(len_bytes) as usize;
    if length == 0 || length > max_size {
        anyhow::bail!("Invalid {label} frame length");
    }
    let mut payload = vec![0u8; length];
    stream.read_exact(&mut payload).await?;
    Ok(payload)
}

fn terminal_auth_from_env() -> Result<(String, String)> {
    let session_id = std::env::var("ORCHESTRA_SESSION_ID")
        .map_err(|_| anyhow::anyhow!("This command must run inside an Orchestra terminal"))?;
    let token = std::env::var("ORCHESTRA_TOKEN").map_err(|_| {
        anyhow::anyhow!("Missing ORCHESTRA_TOKEN; restart the terminal from Orchestra")
    })?;
    terminal_auth_values(Some(&session_id), Some(&token))
}

fn terminal_auth_values(session_id: Option<&str>, token: Option<&str>) -> Result<(String, String)> {
    let session_id = session_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("This command must run inside an Orchestra terminal"))?;
    let token = token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("Missing ORCHESTRA_TOKEN; restart the terminal from Orchestra")
        })?;
    Ok((session_id.to_string(), token.to_string()))
}

fn terminal_key_data(key: &str) -> Result<&'static str> {
    match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => Ok("\r"),
        "tab" => Ok("\t"),
        "esc" | "escape" => Ok("\u{1b}"),
        "up" => Ok("\u{1b}[A"),
        "down" => Ok("\u{1b}[B"),
        "right" => Ok("\u{1b}[C"),
        "left" => Ok("\u{1b}[D"),
        "ctrl-c" | "control-c" => Ok("\u{3}"),
        // Kitty/Ghostty CSI-u encodings let a TUI distinguish an editing
        // newline from submit. Keep these as explicit key names so callers do
        // not have to smuggle escape sequences through a text argument.
        "shift-enter" | "shift-return" => Ok("\u{1b}[13;2u"),
        "ctrl-enter" | "control-enter" | "ctrl-return" | "control-return" => {
            Ok("\u{1b}[13;5u")
        }
        "ctrl-shift-enter" | "control-shift-enter" => Ok("\u{1b}[13;6u"),
        _ => anyhow::bail!("Unsupported key; use enter, shift-enter, ctrl-enter, tab, esc, up, down, left, right or ctrl-c"),
    }
}

fn authenticated_payload(
    mut payload: Value,
    session_id: &str,
    token: &str,
    client_token: Option<&str>,
) -> Value {
    payload["sessionId"] = Value::String(session_id.to_string());
    payload["token"] = Value::String(token.to_string());
    if let Some(client_token) = client_token {
        payload["clientToken"] = Value::String(client_token.to_string());
    }
    payload
}

fn agent_send_payload(session_id: &str, token: &str, agent: &str, message: &str) -> Value {
    authenticated_payload(
        json!({ "agent": agent, "message": message }),
        session_id,
        token,
        None,
    )
}

fn agent_ask_payload(
    session_id: &str,
    token: &str,
    agent: &str,
    message: &str,
    wait: bool,
    timeout_secs: u64,
    request_id: &str,
) -> Value {
    authenticated_payload(
        json!({
            "agent": agent,
            "message": message,
            "wait": wait,
            "timeoutSecs": timeout_secs,
            "requestId": request_id
        }),
        session_id,
        token,
        None,
    )
}

#[derive(Parser)]
#[command(name = "orchestra")]
#[command(about = "Orchestra CLI for workspace control and agent communication", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List registered agents and terminals
    Agents,
    /// Show only the nodes connected to this terminal
    Connections,
    /// Send a prompt/message to a connected agent
    Send { agent: String, message: String },
    /// Send a request and optionally wait for the target agent's explicit completion marker
    Ask {
        agent: String,
        message: String,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 90)]
        timeout_secs: u64,
    },
    /// Request cancellation of a running agent request
    Cancel {
        #[arg(long)]
        request_id: String,
    },
    /// Show locally recorded agent request history
    #[command(name = "request-history", visible_alias = "requests")]
    RequestHistory {
        #[arg(long, default_value_t = 50)]
        limit: u64,
    },
    /// Read a sticky note
    #[command(name = "note-read")]
    NoteRead { note_id: String },
    /// Replace the full content of a sticky note
    #[command(name = "note-write")]
    NoteWrite { note_id: String, content: String },
    /// Append content to a sticky note
    #[command(name = "note-append")]
    NoteAppend { note_id: String, content: String },
    /// Create or edit a sticky note through the authenticated canvas bridge
    #[command(name = "note")]
    Note {
        #[command(subcommand)]
        command: NoteCommands,
    },
    /// Inspect registered workspaces and their floors
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommands,
    },
    /// Read/search files inside the selected workspace root
    Files {
        #[command(subcommand)]
        command: FilesCommands,
    },
    /// Status of Orchestra core daemon
    Status,
    /// Verify the terminal-to-daemon bridge and report its capabilities
    Doctor,
    /// Inspect and control connected interactive terminals safely
    Terminal {
        #[command(subcommand)]
        command: TerminalCommands,
    },
    /// Control the live Electron Browser Portals
    #[command(name = "browser", visible_alias = "portal")]
    Portal {
        #[command(subcommand)]
        command: PortalCommands,
    },
}

#[derive(Subcommand)]
enum NoteCommands {
    /// Create a note beside this terminal and connect it with note permissions
    Create {
        #[arg(long, default_value = "Nota do Orchestra")]
        title: String,
        #[arg(long, default_value = "")]
        content: String,
        #[arg(long, default_value = "#fff2a8")]
        color: String,
    },
    /// Read a connected sticky note
    Read { note_id: String },
    /// Replace the full content of a connected sticky note
    Write { note_id: String, content: String },
    /// Append content to a connected sticky note
    Append { note_id: String, content: String },
}

#[derive(Subcommand)]
enum TerminalCommands {
    /// Read the current scrollback tail before taking any action
    Screen {
        id: String,
        #[arg(long)]
        plain: bool,
    },
    /// Write text without pressing Enter
    Type { id: String, text: String },
    /// Send one special key: enter, shift-enter, ctrl-enter, ctrl-shift-enter, tab, esc, up, down, left, right, ctrl-c
    Key { id: String, key: String },
    /// Wait until the visible screen contains a pattern
    WaitFor {
        id: String,
        pattern: String,
        #[arg(long, default_value_t = 30)]
        timeout_secs: u64,
    },
    /// Create a canvas-visible terminal beside this terminal and optionally connect it
    Spawn {
        #[arg(long, default_value = ".")]
        cwd: String,
        #[arg(long)]
        command: Option<String>,
        #[arg(long)]
        connect_to: Option<String>,
        #[arg(long)]
        title: Option<String>,
    },
}

#[derive(Subcommand)]
enum WorkspaceCommands {
    /// List workspaces, or inspect one workspace by id
    Open { id: Option<String> },
    /// Return a compact workspace snapshot with tree and git metadata
    Snapshot {
        #[arg(long)]
        workspace_id: Option<String>,
        #[arg(default_value = ".")]
        path: String,
        #[arg(long, default_value_t = 4)]
        depth: u64,
    },
}

#[derive(Subcommand)]
enum FilesCommands {
    /// Print a directory tree
    Tree {
        #[arg(long)]
        workspace_id: Option<String>,
        #[arg(default_value = ".")]
        path: String,
        #[arg(long, default_value_t = 6)]
        depth: u64,
    },
    /// Read a file
    Read {
        #[arg(long)]
        workspace_id: Option<String>,
        path: String,
    },
    /// Search file names or file contents
    Search {
        query: String,
        #[arg(long)]
        workspace_id: Option<String>,
        #[arg(long)]
        content: bool,
        #[arg(default_value = ".")]
        path: String,
    },
}

#[derive(Subcommand)]
enum PortalCommands {
    /// Open a visible browser portal and attach it to this terminal
    Open {
        url: String,
        #[arg(long)]
        portal_id: Option<String>,
        #[arg(long, default_value = "self")]
        connect_to: String,
    },
    /// List live portals owned by the desktop process
    List,
    /// Inspect the current URL, title, text and links
    Inspect { id: String },
    /// Navigate a portal to a URL or search query
    Navigate { id: String, url: String },
    /// Click a DOM element using a CSS selector
    Click {
        id: String,
        #[arg(long)]
        selector: String,
    },
    /// Press a browser key (for example Enter, Escape or ArrowDown)
    Press {
        id: String,
        key: String,
        /// Optionally focus the matching editable/control element first.
        #[arg(long)]
        selector: Option<String>,
    },
    /// Scroll the browser page or a selected scroll container by pixel deltas.
    /// Positive delta-y moves down; positive delta-x moves right.
    Scroll {
        id: String,
        #[arg(
            long = "delta-x",
            alias = "x",
            allow_hyphen_values = true,
            default_value_t = 0.0
        )]
        delta_x: f64,
        #[arg(
            long = "delta-y",
            alias = "y",
            allow_hyphen_values = true,
            default_value_t = 0.0
        )]
        delta_y: f64,
        /// Optionally scroll the matching element instead of the page.
        #[arg(long)]
        selector: Option<String>,
    },
    /// Wait for a browser state to settle, or until a selector/text appears.
    Wait {
        id: String,
        /// Wait for this selector to become available/visible.
        #[arg(long)]
        selector: Option<String>,
        /// Wait for this visible text to appear.
        #[arg(long)]
        text: Option<String>,
        /// Maximum wait in milliseconds (also used as a plain delay when no
        /// selector/text is supplied).
        #[arg(long, default_value_t = 1000)]
        timeout_ms: u64,
    },
    /// Type into an input or editable element
    Type {
        id: String,
        #[arg(long)]
        selector: String,
        #[arg(long)]
        text: String,
    },
    /// Capture a portal screenshot, optionally writing PNG bytes to a file
    Screenshot {
        id: String,
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Read recent console messages captured by the portal
    Console { id: String },
}

async fn request(stream: &mut UnixStream, message_type: &str, payload: Value) -> Result<Value> {
    let request_id = format!("cli_{}", uuid::Uuid::new_v4());
    let req = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "type": message_type,
        "payload": payload
    });
    let bytes = serde_json::to_vec(&req)?;
    write_frame(stream, &bytes, MAX_FRAME_SIZE, "Request").await?;
    // The daemon can emit progress/state events on the same connection before
    // the request handler writes its response (for example terminal.spawn and
    // agent.ask). Read until this request's response instead of interpreting
    // the first event as an error.
    loop {
        let resp_buf = read_frame(stream, MAX_FRAME_SIZE, "response").await?;
        let resp: Value = serde_json::from_slice(&resp_buf)?;
        if resp["requestId"].as_str() != Some(request_id.as_str()) {
            continue;
        }
        if resp["ok"].as_bool() != Some(true) {
            anyhow::bail!(
                "{}",
                safe_daemon_error(
                    "Orchestra daemon rejected the request",
                    resp["error"].as_str()
                )
            );
        }
        return Ok(resp["result"].clone());
    }
}

#[cfg(test)]
fn is_matching_response(value: &Value, request_id: &str) -> bool {
    value["requestId"].as_str() == Some(request_id) && value["ok"].is_boolean()
}

async fn portal_request(
    stream: &mut UnixStream,
    request_id: &str,
    message_type: &str,
    token: Option<&str>,
    payload: Value,
) -> Result<Value> {
    let req = json!({
        "requestId": request_id,
        "type": message_type,
        "token": token,
        "payload": payload
    });
    let bytes = serde_json::to_vec(&req)?;
    write_frame(stream, &bytes, MAX_PORTAL_FRAME_SIZE, "Portal request").await?;
    let response_buf = read_frame(stream, MAX_PORTAL_FRAME_SIZE, "portal response").await?;
    let response: Value = serde_json::from_slice(&response_buf)?;
    if response["ok"].as_bool() != Some(true) {
        anyhow::bail!(
            "{}",
            safe_daemon_error("Portal rejected the request", response["error"].as_str())
        );
    }
    Ok(response["result"].clone())
}

fn workspace_payload(workspace_id: Option<&str>, path: &str) -> Result<Value> {
    let mut payload = json!({ "path": path });
    if let Some(id) = workspace_id.filter(|value| !value.trim().is_empty()) {
        payload["workspaceId"] = json!(id);
    } else if let Ok(root) = std::env::var("ORCHESTRA_WORKSPACE_DIR") {
        if root.trim().is_empty() {
            anyhow::bail!("Select a workspace or run inside an Orchestra workspace terminal")
        }
        payload["workspaceRoot"] = json!(root);
    } else {
        anyhow::bail!(
            "Select a workspace with --workspace-id or run inside an Orchestra workspace terminal"
        )
    }
    Ok(payload)
}

/// Convert the public browser command into the small control-protocol
/// envelope. Keeping this mapping pure makes the CLI surface testable without
/// opening a Unix socket or requiring a running Electron process.
fn portal_command_parts(command: PortalCommands) -> (&'static str, Value, Option<PathBuf>) {
    match command {
        PortalCommands::Open {
            url,
            portal_id,
            connect_to,
        } => (
            "portal.open",
            json!({ "url": url, "portalId": portal_id, "connectTo": connect_to }),
            None,
        ),
        PortalCommands::List => ("portal.list", json!({}), None),
        PortalCommands::Inspect { id } => ("portal.inspect", json!({ "portalId": id }), None),
        PortalCommands::Navigate { id, url } => (
            "portal.navigate",
            json!({ "portalId": id, "url": url }),
            None,
        ),
        PortalCommands::Click { id, selector } => (
            "portal.click",
            json!({ "portalId": id, "selector": selector }),
            None,
        ),
        PortalCommands::Press { id, key, selector } => (
            "portal.press",
            json!({ "portalId": id, "key": key, "selector": selector }),
            None,
        ),
        PortalCommands::Scroll {
            id,
            delta_x,
            delta_y,
            selector,
        } => (
            "portal.scroll",
            json!({
                "portalId": id,
                "deltaX": delta_x,
                "deltaY": delta_y,
                "selector": selector
            }),
            None,
        ),
        PortalCommands::Wait {
            id,
            selector,
            text,
            timeout_ms,
        } => (
            "portal.wait",
            json!({
                "portalId": id,
                "selector": selector,
                "text": text,
                "timeoutMs": timeout_ms.clamp(1, 300_000)
            }),
            None,
        ),
        PortalCommands::Type { id, selector, text } => (
            "portal.type",
            json!({ "portalId": id, "selector": selector, "text": text }),
            None,
        ),
        PortalCommands::Screenshot { id, output } => {
            ("portal.screenshot", json!({ "portalId": id }), output)
        }
        PortalCommands::Console { id } => ("portal.console", json!({ "portalId": id }), None),
    }
}

async fn run_portal_command(command: PortalCommands) -> Result<()> {
    let socket_path = portal_socket_path();
    if !socket_path.exists() {
        anyhow::bail!(
            "Orchestra desktop portal bridge is unavailable: socket not found at {:?}. Start Orchestra Desktop or set ORCHESTRA_PORTAL_SOCKET to its instance socket.",
            socket_path
        );
    }
    let mut stream = UnixStream::connect(&socket_path)
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "Could not connect to Orchestra portal socket {:?}: {error}. Start the matching Orchestra Desktop instance or set ORCHESTRA_PORTAL_SOCKET explicitly.",
                socket_path
            )
        })?;
    let hello = portal_request(
        &mut stream,
        "portal_cli_hello",
        "portal.hello",
        None,
        json!({}),
    )
    .await?;
    let token = hello["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Portal control did not return a token"))?
        .to_string();
    let (message_type, payload, output_file) = portal_command_parts(command);
    if message_type == "portal.open" && payload["connectTo"].as_str() != Some("self") {
        anyhow::bail!("portal open currently supports only --connect-to self")
    }
    let mut payload = payload;
    if message_type != "portal.ensure" {
        payload["sessionId"] = Value::String(
            std::env::var("ORCHESTRA_SESSION_ID")
                .map_err(|_| anyhow::anyhow!("Portal control requires ORCHESTRA_SESSION_ID"))?,
        );
        payload["authToken"] = Value::String(
            std::env::var("ORCHESTRA_TOKEN")
                .map_err(|_| anyhow::anyhow!("Portal control requires ORCHESTRA_TOKEN"))?,
        );
    }
    let result = portal_request(
        &mut stream,
        &format!("portal_cli_{}", uuid::Uuid::new_v4()),
        message_type,
        Some(&token),
        payload,
    )
    .await?;
    if message_type == "portal.wait"
        && (result["ok"].as_bool() == Some(false) || result["timedOut"].as_bool() == Some(true))
    {
        anyhow::bail!("Portal wait timed out before the requested condition was met")
    }
    if let Some(output) = output_file {
        let data_url = result["data"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Portal did not return a screenshot"))?;
        let encoded = data_url
            .strip_prefix("data:image/png;base64,")
            .ok_or_else(|| anyhow::anyhow!("Unsupported screenshot encoding"))?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
        std::fs::write(&output, bytes)?;
        println!("{}", output.display());
    } else {
        println!("{}", serde_json::to_string_pretty(&redact_value(&result))?);
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let command = match cli.command {
        Commands::Portal { command } => return run_portal_command(command).await,
        command => command,
    };

    let socket_path = orchestra_socket_path();

    if !socket_path.exists() {
        anyhow::bail!(
            "DAEMON_MISSING: Orchestra socket was not found at {:?}. Start Orchestra Desktop or set ORCHESTRA_SOCKET to the matching instance socket.",
            socket_path
        );
    }

    let mut stream = UnixStream::connect(&socket_path)
        .await
        .map_err(|error| {
            let category = if error.kind() == ErrorKind::ConnectionRefused {
                "SOCKET_STALE"
            } else {
                "DAEMON_UNAVAILABLE"
            };
            anyhow::anyhow!(
                "{category}: could not connect to Orchestra daemon socket {:?}: {error}. Start the matching Orchestra Desktop instance or set ORCHESTRA_SOCKET explicitly.",
                socket_path
            )
        })?;

    let is_doctor = matches!(&command, Commands::Doctor);
    let is_status = matches!(&command, Commands::Status);
    let terminal_auth = || -> Result<(String, String)> { terminal_auth_from_env() };

    let hello = request(&mut stream, "system.hello", json!({})).await?;
    let client_token = hello["clientToken"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Daemon did not return a client token"))?
        .to_string();

    if is_status {
        let mut safe_hello = hello.clone();
        if let Some(object) = safe_hello.as_object_mut() {
            object.remove("clientToken");
        }
        println!("{}", serde_json::to_string_pretty(&safe_hello)?);
        return Ok(());
    }

    if is_doctor {
        let (session_id, token) = terminal_auth()?;
        let authenticated = |payload| {
            authenticated_payload(payload, &session_id, &token, Some(client_token.as_str()))
        };
        let state = request(&mut stream, "terminal.state", authenticated(json!({}))).await?;
        let connections = request(&mut stream, "connection.list", authenticated(json!({}))).await?;
        let agents = request(&mut stream, "agent.list", authenticated(json!({}))).await?;
        let agent_listed = agents.as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["sessionId"].as_str() == Some(session_id.as_str()))
        });
        if !agent_listed {
            anyhow::bail!(
                "SESSION_NOT_REGISTERED: authenticated terminal is absent from agent.list"
            );
        }
        let mut safe_hello = hello.clone();
        if let Some(object) = safe_hello.as_object_mut() {
            object.remove("clientToken");
        }
        let context_dir = std::env::var("ORCHESTRA_CONTEXT_DIR").ok();
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "daemon": safe_hello,
                "authentication": "valid",
                "terminalSessionId": session_id,
                "sessionRegistered": true,
                "agentListed": agent_listed,
                "terminalState": state,
                "connections": connections,
                "contextDir": context_dir,
                "contextDirExists": context_dir.as_ref().is_some_and(|dir| std::path::Path::new(dir).is_dir())
            }))?
        );
        return Ok(());
    }

    if let Commands::Terminal { command } = &command {
        let (source_session_id, source_token) = terminal_auth()?;
        let request_terminal = |message_type: &str, mut payload: Value| {
            payload["sessionId"] = Value::String(source_session_id.clone());
            payload["token"] = Value::String(source_token.clone());
            payload["clientToken"] = Value::String(client_token.clone());
            (message_type.to_string(), payload)
        };
        match command {
            TerminalCommands::Screen { id, plain } => {
                let (message_type, payload) =
                    request_terminal("terminal.screen", json!({ "targetSessionId": id }));
                let result = request(&mut stream, &message_type, payload).await?;
                if *plain {
                    println!("{}", result["plainTail"].as_str().unwrap_or_default());
                } else {
                    println!("{}", serde_json::to_string_pretty(&redact_value(&result))?);
                }
            }
            TerminalCommands::Type { id, text } => {
                let (message_type, payload) = request_terminal(
                    "terminal.control",
                    json!({ "targetSessionId": id, "data": text }),
                );
                let result = request(&mut stream, &message_type, payload).await?;
                println!("{}", serde_json::to_string_pretty(&redact_value(&result))?);
            }
            TerminalCommands::Key { id, key } => {
                let data = terminal_key_data(key)?;
                let (message_type, payload) = request_terminal(
                    "terminal.control",
                    json!({ "targetSessionId": id, "data": data }),
                );
                let result = request(&mut stream, &message_type, payload).await?;
                println!("{}", serde_json::to_string_pretty(&redact_value(&result))?);
            }
            TerminalCommands::WaitFor {
                id,
                pattern,
                timeout_secs,
            } => {
                let deadline = tokio::time::Instant::now()
                    + std::time::Duration::from_secs((*timeout_secs).clamp(1, 300));
                loop {
                    let (message_type, payload) =
                        request_terminal("terminal.screen", json!({ "targetSessionId": id }));
                    let result = request(&mut stream, &message_type, payload).await?;
                    if result["plainTail"]
                        .as_str()
                        .is_some_and(|screen| screen.contains(pattern.as_str()))
                    {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(
                                &json!({ "matched": true, "stateHint": result["stateHint"], "semanticDelivery": "unknown" })
                            )?
                        );
                        break;
                    }
                    if tokio::time::Instant::now() >= deadline {
                        anyhow::bail!("Timed out waiting for pattern; inspect with `orchestra terminal screen {id} --plain`");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
            TerminalCommands::Spawn {
                cwd,
                command,
                connect_to,
                title,
            } => {
                let (message_type, payload) = request_terminal(
                    "terminal.spawn.visible",
                    json!({
                        "cwd": cwd,
                        "command": command,
                        "connectTo": connect_to,
                        "title": title
                    }),
                );
                let result = request(&mut stream, &message_type, payload).await?;
                println!("{}", serde_json::to_string_pretty(&redact_value(&result))?);
            }
        }
        return Ok(());
    }

    let (type_name, mut payload) = match command {
        Commands::Agents => {
            let (session_id, token) = terminal_auth()?;
            (
                "agent.list",
                json!({ "sessionId": session_id, "token": token }),
            )
        }
        Commands::Connections => {
            let (session_id, token) = terminal_auth()?;
            (
                "connection.list",
                json!({ "sessionId": session_id, "token": token }),
            )
        }
        Commands::Send { agent, message } => {
            let (session_id, token) = terminal_auth()?;
            (
                "agent.message.send",
                agent_send_payload(&session_id, &token, &agent, &message),
            )
        }
        Commands::Ask {
            agent,
            message,
            wait,
            timeout_secs,
        } => {
            let (session_id, token) = terminal_auth()?;
            let request_id = format!("ask_cli_{}", uuid::Uuid::new_v4());
            (
                "agent.ask",
                agent_ask_payload(
                    &session_id,
                    &token,
                    &agent,
                    &message,
                    wait,
                    timeout_secs,
                    &request_id,
                ),
            )
        }
        Commands::Cancel { request_id } => {
            let (session_id, token) = terminal_auth()?;
            (
                "agent.request.cancel",
                json!({ "sessionId": session_id, "token": token, "requestId": request_id }),
            )
        }
        Commands::RequestHistory { limit } => {
            let (session_id, token) = terminal_auth()?;
            (
                "agent.request-audit.list",
                json!({ "sessionId": session_id, "token": token, "limit": limit }),
            )
        }
        Commands::Note { command } => {
            let (session_id, token) = terminal_auth()?;
            let (message_type, note_payload) = match command {
                NoteCommands::Create {
                    title,
                    content,
                    color,
                } => (
                    "note.create",
                    json!({ "sessionId": session_id, "token": token, "title": title, "content": content, "color": color }),
                ),
                NoteCommands::Read { note_id } => (
                    "note.read",
                    json!({ "sessionId": session_id, "token": token, "noteId": note_id }),
                ),
                NoteCommands::Write { note_id, content } => (
                    "note.write",
                    json!({ "sessionId": session_id, "token": token, "noteId": note_id, "content": content }),
                ),
                NoteCommands::Append { note_id, content } => (
                    "note.append",
                    json!({ "sessionId": session_id, "token": token, "noteId": note_id, "content": content }),
                ),
            };
            (message_type, note_payload)
        }
        Commands::NoteRead { note_id } => {
            let (session_id, token) = terminal_auth()?;
            (
                "note.read",
                json!({ "sessionId": session_id, "token": token, "noteId": note_id }),
            )
        }
        Commands::NoteWrite { note_id, content } => {
            let (session_id, token) = terminal_auth()?;
            (
                "note.write",
                json!({ "sessionId": session_id, "token": token, "noteId": note_id, "content": content }),
            )
        }
        Commands::NoteAppend { note_id, content } => {
            let (session_id, token) = terminal_auth()?;
            (
                "note.append",
                json!({ "sessionId": session_id, "token": token, "noteId": note_id, "content": content }),
            )
        }
        Commands::Workspace { command } => {
            let (session_id, token) = terminal_auth()?;
            match command {
                WorkspaceCommands::Open { id } => {
                    let result = request(
                        &mut stream,
                        "workspace.list",
                        json!({ "clientToken": client_token }),
                    )
                    .await?;
                    if let Some(id) = id {
                        let selected = result
                            .as_array()
                            .and_then(|items| {
                                items
                                    .iter()
                                    .find(|item| item["id"].as_str() == Some(id.as_str()))
                            })
                            .cloned()
                            .unwrap_or(Value::Null);
                        if selected.is_null() {
                            anyhow::bail!("Workspace not found: {id}");
                        }
                        let floors = request(
                            &mut stream,
                            "workspace.floor.list",
                            json!({ "workspaceId": id, "clientToken": client_token }),
                        )
                        .await?;
                        let nodes = request(
                            &mut stream,
                            "canvas.node.list",
                            json!({ "workspaceId": id, "clientToken": client_token }),
                        )
                        .await?;
                        let edges = request(
                            &mut stream,
                            "canvas.edge.list",
                            json!({ "workspaceId": id, "clientToken": client_token }),
                        )
                        .await?;
                        println!(
                            "{}",
                            serde_json::to_string_pretty(
                                &json!({ "workspace": selected, "floors": floors, "nodes": nodes, "edges": edges })
                            )?
                        );
                    } else {
                        println!("{}", serde_json::to_string_pretty(&redact_value(&result))?);
                    }
                    return Ok(());
                }
                WorkspaceCommands::Snapshot {
                    workspace_id,
                    path,
                    depth,
                } => {
                    let mut base = workspace_payload(workspace_id.as_deref(), &path)?;
                    base["depth"] = json!(depth.clamp(1, 12));
                    base["sessionId"] = json!(session_id);
                    base["token"] = json!(token);
                    let tree = request(&mut stream, "workspace.tree", base.clone()).await?;
                    if let Some(object) = base.as_object_mut() {
                        object.remove("sessionId");
                        object.remove("token");
                        object.remove("clientToken");
                    }
                    let snapshot = json!({ "workspace": base, "tree": redact_value(&tree) });
                    println!("{}", serde_json::to_string_pretty(&snapshot)?);
                    return Ok(());
                }
            }
        }
        Commands::Files { command } => {
            let (session_id, token) = terminal_auth()?;
            let (message_type, mut file_payload) = match command {
                FilesCommands::Tree {
                    workspace_id,
                    path,
                    depth,
                } => {
                    let mut payload = workspace_payload(workspace_id.as_deref(), &path)?;
                    payload["depth"] = json!(depth.clamp(1, 12));
                    ("workspace.tree", payload)
                }
                FilesCommands::Read { workspace_id, path } => (
                    "workspace.read_file",
                    workspace_payload(workspace_id.as_deref(), &path)?,
                ),
                FilesCommands::Search {
                    query,
                    workspace_id,
                    content,
                    path,
                } => {
                    let mut payload = workspace_payload(workspace_id.as_deref(), &path)?;
                    payload["query"] = json!(query);
                    payload["content"] = json!(content);
                    ("workspace.search", payload)
                }
            };
            file_payload["sessionId"] = json!(session_id);
            file_payload["token"] = json!(token);
            file_payload["clientToken"] = Value::String(client_token);
            let result = request(&mut stream, message_type, file_payload).await?;
            if message_type == "workspace.read_file" {
                println!("{}", result["content"].as_str().unwrap_or_default());
            } else {
                println!("{}", serde_json::to_string_pretty(&redact_value(&result))?);
            }
            return Ok(());
        }
        Commands::Status
        | Commands::Doctor
        | Commands::Portal { .. }
        | Commands::Terminal { .. } => unreachable!(),
    };

    payload["clientToken"] = Value::String(client_token);
    let result = request(&mut stream, type_name, payload).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&redact_value(&result)).unwrap_or_default()
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_uses_big_endian_length_and_rejects_invalid_sizes() {
        let frame = encode_frame(b"hello", MAX_FRAME_SIZE, "Request").expect("frame should encode");
        assert_eq!(&frame[..4], &5u32.to_be_bytes());
        assert_eq!(&frame[4..], b"hello");
        assert!(encode_frame(&[], MAX_FRAME_SIZE, "Request").is_err());
        assert!(encode_frame(b"123456", 5, "Request").is_err());
    }

    #[test]
    fn terminal_auth_requires_non_empty_session_and_token() {
        assert_eq!(
            terminal_auth_values(Some("session"), Some("secret")).unwrap(),
            ("session".to_string(), "secret".to_string())
        );
        assert!(terminal_auth_values(None, Some("secret")).is_err());
        assert!(terminal_auth_values(Some("session"), Some(" ")).is_err());
        let error = terminal_auth_values(Some("session"), None)
            .expect_err("missing token should fail")
            .to_string();
        assert!(!error.contains("secret"));
    }

    #[test]
    fn key_and_command_payload_mappings_are_stable() {
        assert_eq!(terminal_key_data("return").unwrap(), "\r");
        assert_eq!(terminal_key_data("ctrl-c").unwrap(), "\u{3}");
        assert_eq!(terminal_key_data("shift-enter").unwrap(), "\u{1b}[13;2u");
        assert_eq!(terminal_key_data("ctrl-enter").unwrap(), "\u{1b}[13;5u");
        assert!(terminal_key_data("home").is_err());

        let payload = agent_send_payload("source", "secret", "target", "hello");
        assert_eq!(payload["sessionId"], "source");
        assert_eq!(payload["token"], "secret");
        assert_eq!(payload["agent"], "target");
        assert_eq!(payload["message"], "hello");

        let ask = agent_ask_payload("source", "secret", "target", "hello", true, 30, "ask_1");
        assert_eq!(ask["wait"], true);
        assert_eq!(ask["timeoutSecs"], 30);
        assert_eq!(ask["requestId"], "ask_1");
    }

    #[test]
    fn portal_socket_is_derived_from_the_selected_core_instance() {
        assert_eq!(
            derived_portal_socket_path(PathBuf::from("/tmp/orchesta-a.sock")),
            PathBuf::from("/tmp/orchesta-a.portal.sock")
        );
        assert_eq!(
            derived_portal_socket_path(PathBuf::from("/tmp/orchesta-b")),
            PathBuf::from("/tmp/orchesta-b.portal.sock")
        );
    }

    #[test]
    fn browser_control_commands_parse_and_map_to_protocol_payloads() {
        let cli = Cli::try_parse_from([
            "orchestra",
            "browser",
            "press",
            "portal-1",
            "Enter",
            "--selector",
            "#search",
        ])
        .expect("browser press should parse");
        let Commands::Portal { command } = cli.command else {
            panic!("expected browser command")
        };
        let (message, payload, output) = portal_command_parts(command);
        assert_eq!(message, "portal.press");
        assert_eq!(payload["portalId"], "portal-1");
        assert_eq!(payload["key"], "Enter");
        assert_eq!(payload["selector"], "#search");
        assert!(output.is_none());

        let cli = Cli::try_parse_from([
            "orchestra",
            "browser",
            "scroll",
            "portal-1",
            "--x",
            "24",
            "--delta-y",
            "-480",
        ])
        .expect("browser scroll should parse");
        let Commands::Portal { command } = cli.command else {
            panic!("expected browser command")
        };
        let (message, payload, _) = portal_command_parts(command);
        assert_eq!(message, "portal.scroll");
        assert_eq!(payload["deltaX"], 24.0);
        assert_eq!(payload["deltaY"], -480.0);
        assert!(payload["selector"].is_null());

        let cli = Cli::try_parse_from([
            "orchestra",
            "browser",
            "wait",
            "portal-1",
            "--text",
            "Results",
            "--timeout-ms",
            "999999",
        ])
        .expect("browser wait should parse");
        let Commands::Portal { command } = cli.command else {
            panic!("expected browser command")
        };
        let (message, payload, _) = portal_command_parts(command);
        assert_eq!(message, "portal.wait");
        assert_eq!(payload["text"], "Results");
        assert_eq!(payload["timeoutMs"], 300_000);
    }

    #[test]
    fn daemon_errors_redact_the_terminal_token() {
        let error = safe_daemon_error(
            "Orchestra daemon rejected the request",
            Some("permission denied for token=super-secret"),
        );
        // The process environment is not modified by this test; exercise the
        // pure redactor that backs the runtime path instead.
        assert_eq!(
            redact_secret_value(&error, Some("super-secret")),
            "Orchestra daemon rejected the request: permission denied for token=[redacted]"
        );
    }

    #[test]
    fn cli_output_redacts_auth_fields_recursively() {
        let value = json!({
            "token": "terminal-secret",
            "nested": {"clientToken": "client-secret", "message": "safe"},
            "items": [{"authToken": "portal-secret"}]
        });
        let redacted = redact_value(&value);
        assert_eq!(redacted["token"], "[redacted]");
        assert_eq!(redacted["nested"]["clientToken"], "[redacted]");
        assert_eq!(redacted["nested"]["message"], "safe");
        assert_eq!(redacted["items"][0]["authToken"], "[redacted]");
    }

    #[test]
    fn cli_ignores_unrelated_events_until_its_response() {
        let event = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "eventId": "evt_1",
            "type": "terminal.state",
            "payload": {"sessionId": "term_1"}
        });
        let response = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": "cli_1",
            "ok": true,
            "result": {"success": true}
        });
        assert!(!is_matching_response(&event, "cli_1"));
        assert!(is_matching_response(&response, "cli_1"));
    }

    #[tokio::test]
    async fn request_handles_state_events_before_response() {
        use tokio::net::UnixListener;

        let socket_path = std::env::temp_dir().join(format!(
            "orchestra-cli-request-test-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let listener = UnixListener::bind(&socket_path).expect("bind test socket");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept test client");
            let request_bytes = read_frame(&mut stream, MAX_FRAME_SIZE, "request")
                .await
                .expect("read request");
            let request: Value = serde_json::from_slice(&request_bytes).expect("decode request");
            let request_id = request["requestId"].as_str().expect("request id");
            let event = json!({
                "protocolVersion": PROTOCOL_VERSION,
                "eventId": "evt_test",
                "type": "terminal.state",
                "payload": {"sessionId": "term_test"}
            });
            let event_bytes = serde_json::to_vec(&event).expect("encode event");
            write_frame(&mut stream, &event_bytes, MAX_FRAME_SIZE, "event")
                .await
                .expect("write event");
            let response = json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": true,
                "result": {"success": true}
            });
            let response_bytes = serde_json::to_vec(&response).expect("encode response");
            write_frame(&mut stream, &response_bytes, MAX_FRAME_SIZE, "response")
                .await
                .expect("write response");
        });

        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("connect test client");
        let result = request(&mut client, "terminal.spawn", json!({}))
            .await
            .expect("request should skip event and receive response");
        assert_eq!(result["success"], true);
        server.await.expect("server task");
        let _ = std::fs::remove_file(socket_path);
    }
}
