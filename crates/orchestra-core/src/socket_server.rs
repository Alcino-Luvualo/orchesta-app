use crate::db::Database;
use crate::git::GitManager;
use crate::pty::PtyManager;
use crate::workspace::WorkspaceManager;
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tracing::{error, info};

const MAX_FRAME_SIZE: usize = 8 * 1024 * 1024;

pub struct SocketServer {
    db: Arc<Database>,
    pty: PtyManager,
}

impl SocketServer {
    pub fn new(db: Arc<Database>, pty: PtyManager) -> Self {
        Self { db, pty }
    }

    pub async fn start(&self, socket_path: PathBuf) -> Result<()> {
        if socket_path.exists() {
            let _ = std::fs::remove_file(&socket_path);
        }
        if let Some(parent) = socket_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let listener = UnixListener::bind(&socket_path)?;
        info!("Orchestra Rust Daemon listening on unix socket: {:?}", socket_path);

        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let db = self.db.clone();
                    let pty = self.pty.clone();
                    tokio::spawn(async move {
                        if let Err(e) = Self::handle_client(stream, db, pty).await {
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

    async fn handle_client(stream: UnixStream, db: Arc<Database>, pty: PtyManager) -> Result<()> {
        let (mut reader, writer) = stream.into_split();
        let writer_arc = Arc::new(Mutex::new(writer));

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

            let msg: Value = match serde_json::from_slice(&buf) {
                Ok(v) => v,
                Err(e) => {
                    error!("JSON parse error: {}", e);
                    continue;
                }
            };

            let req_id = msg["requestId"].as_str().map(|s| s.to_string());
            let msg_type = msg["type"].as_str().unwrap_or("").to_string();
            let payload = msg["payload"].clone();

            let db_clone = db.clone();
            let pty_clone = pty.clone();
            let writer_clone = writer_arc.clone();

            let res = Self::dispatch(&msg_type, payload, db_clone, pty_clone, writer_clone.clone()).await;

            if let Some(rid) = req_id {
                let response = match res {
                    Ok(val) => json!({
                        "protocolVersion": 1,
                        "requestId": rid,
                        "ok": true,
                        "result": val,
                    }),
                    Err(err) => json!({
                        "protocolVersion": 1,
                        "requestId": rid,
                        "ok": false,
                        "error": err.to_string(),
                    }),
                };
                Self::send_json(&writer_arc, response).await?;
            }
        }
        Ok(())
    }

    async fn send_json(
        writer: &Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
        val: Value,
    ) -> Result<()> {
        let bytes = serde_json::to_vec(&val)?;
        let len = (bytes.len() as u32).to_be_bytes();
        let mut lock = writer.lock().await;
        lock.write_all(&len).await?;
        lock.write_all(&bytes).await?;
        lock.flush().await?;
        Ok(())
    }

    async fn dispatch(
        msg_type: &str,
        payload: Value,
        db: Arc<Database>,
        pty: PtyManager,
        writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    ) -> Result<Value> {
        match msg_type {
            "system.hello" => Ok(json!({
                "protocolVersion": 1,
                "daemonVersion": env!("CARGO_PKG_VERSION"),
                "capabilities": ["terminal.spawn", "terminal.input", "terminal.resize", "terminal.kill"]
            })),

            "agent.list" => {
                let sessions = pty.list_sessions();
                let agents = sessions
                    .into_iter()
                    .map(|session_id| {
                        let connections = db.connected_nodes(&session_id).unwrap_or_default();
                        json!({
                            "sessionId": session_id,
                            "connections": connections,
                            "status": "running"
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!(agents))
            }
            "connection.list" => {
                let session_id = payload["sessionId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token = payload["token"].as_str().ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                if !pty.authorizes(session_id, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                Ok(json!(db.connected_nodes(session_id)?))
            }
            "note.read" => {
                let session_id = payload["sessionId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token = payload["token"].as_str().ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let note_id = payload["noteId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing noteId"))?;
                if !pty.authorizes(session_id, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                if !db.has_connection_permission(session_id, note_id, "read")? {
                    return Err(anyhow::anyhow!("The note connection does not grant read permission"));
                }
                Ok(json!({ "id": note_id, "content": pty.read_note(session_id, note_id)? }))
            }
            "note.write" => {
                let session_id = payload["sessionId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token = payload["token"].as_str().ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let note_id = payload["noteId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing noteId"))?;
                let content = payload["content"].as_str().ok_or_else(|| anyhow::anyhow!("Missing content"))?;
                if !pty.authorizes(session_id, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                if !db.has_connection_permission(session_id, note_id, "write")? {
                    return Err(anyhow::anyhow!("The note connection does not grant write permission"));
                }
                pty.write_note(session_id, note_id, content)?;
                Ok(json!({ "success": true, "id": note_id }))
            }
            "note.append" => {
                let session_id = payload["sessionId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing sessionId"))?;
                let token = payload["token"].as_str().ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let note_id = payload["noteId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing noteId"))?;
                let content = payload["content"].as_str().ok_or_else(|| anyhow::anyhow!("Missing content"))?;
                if !pty.authorizes(session_id, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                if !db.has_connection_permission(session_id, note_id, "write")? {
                    return Err(anyhow::anyhow!("The note connection does not grant write permission"));
                }
                let mut existing = pty.read_note(session_id, note_id)?;
                existing.push_str(content);
                pty.write_note(session_id, note_id, &existing)?;
                Ok(json!({ "success": true, "id": note_id }))
            }

            "agent.message.send" => {
                let source = payload["sessionId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing source sessionId"))?;
                let token = payload["token"].as_str().ok_or_else(|| anyhow::anyhow!("Missing terminal token"))?;
                let target = payload["agent"].as_str().ok_or_else(|| anyhow::anyhow!("Missing target terminal"))?;
                let message = payload["message"].as_str().ok_or_else(|| anyhow::anyhow!("Missing message"))?;

                if !pty.authorizes(source, token) {
                    return Err(anyhow::anyhow!("Unauthorized terminal request"));
                }
                if !db.nodes_are_connected(source, target)? {
                    return Err(anyhow::anyhow!("The terminal is not connected to that agent"));
                }
                if !db.has_connection_permission(source, target, "send_prompt")? {
                    return Err(anyhow::anyhow!("The terminal connection does not grant send_prompt permission"));
                }
                if !pty.list_sessions().iter().any(|id| id == target) {
                    return Err(anyhow::anyhow!("Target terminal is not running"));
                }

                pty.send_prompt(target, message)?;
                Ok(json!({
                    "delivered": true,
                    "fromSessionId": source,
                    "toSessionId": target
                }))
            }

            // Workspaces
            "workspace.list" => Ok(json!(db.get_workspaces()?)),
            "workspace.save" => {
                let id = payload["id"].as_str().unwrap_or("");
                let name = payload["name"].as_str().unwrap_or("");
                let path = payload["path"].as_str().unwrap_or("");
                db.save_workspace(id, name, path)?;
                Ok(json!({ "success": true }))
            }
            "workspace.tree" => {
                let path = payload["path"].as_str().unwrap_or("./");
                let depth = payload["depth"].as_u64().unwrap_or(4) as usize;
                WorkspaceManager::read_dir_tree(path, depth)
            }
            "workspace.read_file" => {
                let path = payload["path"].as_str().unwrap_or("");
                let content = WorkspaceManager::read_file(path)?;
                Ok(json!({ "content": content }))
            }
            "workspace.write_file" => {
                let path = payload["path"].as_str().unwrap_or("");
                let content = payload["content"].as_str().unwrap_or("");
                WorkspaceManager::write_file(path, content)?;
                Ok(json!({ "success": true }))
            }
            "workspace.search" => {
                let path = payload["path"].as_str().unwrap_or("./");
                let query = payload["query"].as_str().unwrap_or("");
                let results = WorkspaceManager::search_files(path, query)?;
                Ok(json!({ "results": results }))
            }

            // Canvas
            "canvas.node.list" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                Ok(json!(db.get_canvas_nodes(ws_id)?))
            }
            "canvas.node.save" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                db.save_canvas_node(ws_id, &payload["node"])?;
                Ok(json!({ "success": true }))
            }
            "canvas.node.delete" => {
                let node_id = payload["id"].as_str().unwrap_or("");
                db.delete_canvas_node(node_id)?;
                Ok(json!({ "success": true }))
            }
            "canvas.edge.list" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                Ok(json!(db.get_canvas_edges(ws_id)?))
            }
            "canvas.edge.save" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                db.save_canvas_edge(ws_id, &payload["edge"])?;
                Ok(json!({ "success": true }))
            }
            "canvas.edge.delete" => {
                let edge_id = payload["id"].as_str().unwrap_or("");
                db.delete_canvas_edge(edge_id)?;
                Ok(json!({ "success": true }))
            }

            // PTY Terminals
            "terminal.spawn" => {
                let session_id = payload["sessionId"].as_str().unwrap_or("").to_string();
                let cwd = payload["cwd"].as_str().map(|s| s.to_string());
                let cols = payload["cols"].as_u64().unwrap_or(80) as u16;
                let rows = payload["rows"].as_u64().unwrap_or(24) as u16;

                let env_vars: Option<HashMap<String, String>> = payload["env"].as_object().map(|obj| {
                    obj.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()
                });

                let mut rx = pty.spawn_terminal(session_id.clone(), cwd, cols, rows, env_vars)?;

                // Stream terminal output events back to client
                let writer_tx = writer.clone();
                let sess_id_event = session_id.clone();
                tokio::spawn(async move {
                    while let Ok(data) = rx.recv().await {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let event = json!({
                            "protocolVersion": 1,
                            "eventId": format!("evt_{}", uuid::Uuid::new_v4()),
                            "type": "terminal.output",
                            "payload": {
                                "sessionId": sess_id_event,
                                "data": text
                            }
                        });
                        if Self::send_json(&writer_tx, event).await.is_err() {
                            break;
                        }
                    }
                });

                Ok(json!({ "sessionId": session_id, "status": "started" }))
            }
            "terminal.input" => {
                let session_id = payload["sessionId"].as_str().unwrap_or("");
                let text = payload["data"].as_str().unwrap_or("");
                pty.write_input(session_id, text.as_bytes())?;
                Ok(json!({ "success": true }))
            }
            "terminal.resize" => {
                let session_id = payload["sessionId"].as_str().unwrap_or("");
                let cols = payload["cols"].as_u64().unwrap_or(80) as u16;
                let rows = payload["rows"].as_u64().unwrap_or(24) as u16;
                pty.resize(session_id, cols, rows)?;
                Ok(json!({ "success": true }))
            }
            "terminal.kill" => {
                let session_id = payload["sessionId"].as_str().unwrap_or("");
                pty.kill(session_id)?;
                Ok(json!({ "success": true }))
            }

            // Git
            "git.status" => {
                let path = payload["path"].as_str().unwrap_or("./");
                GitManager::get_status(path)
            }
            "git.diff" => {
                let path = payload["path"].as_str().unwrap_or("./");
                let file = payload["file"].as_str();
                let diff = GitManager::get_diff(path, file)?;
                Ok(json!({ "diff": diff }))
            }
            "git.log" => {
                let path = payload["path"].as_str().unwrap_or("./");
                let limit = payload["limit"].as_u64().unwrap_or(30) as usize;
                let commits = GitManager::get_log(path, limit)?;
                Ok(json!({ "commits": commits }))
            }
            "git.stage" => {
                let path = payload["path"].as_str().unwrap_or("./");
                let file = payload["file"].as_str().unwrap_or(".");
                GitManager::stage_file(path, file)?;
                Ok(json!({ "success": true }))
            }
            "git.commit" => {
                let path = payload["path"].as_str().unwrap_or("./");
                let msg = payload["message"].as_str().unwrap_or("commit");
                GitManager::commit(path, msg)?;
                Ok(json!({ "success": true }))
            }
            "git.create_floor" => {
                let path = payload["path"].as_str().unwrap_or("./");
                let name = payload["name"].as_str().unwrap_or("floor-1");
                let branch = payload["branch"].as_str().unwrap_or("feature/floor-1");
                let worktree_dir = GitManager::create_floor_worktree(path, name, branch)?;
                Ok(json!({ "worktreeDir": worktree_dir }))
            }

            // Roles
            "roles.list" => Ok(json!(db.get_roles()?)),
            "roles.save" => {
                db.save_role(&payload["role"])?;
                Ok(json!({ "success": true }))
            }

            // Routines
            "routines.list" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                Ok(json!(db.get_routines(ws_id)?))
            }
            "routines.save" => {
                let ws_id = payload["workspaceId"].as_str().unwrap_or("default");
                db.save_routine(ws_id, &payload["routine"])?;
                Ok(json!({ "success": true }))
            }

            _ => Err(anyhow::anyhow!("Unknown message type: {}", msg_type)),
        }
    }
}
