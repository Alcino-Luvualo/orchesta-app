use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::thread;
use tokio::sync::broadcast;
use tracing::{error, info};

pub struct PtySession {
    pub id: String,
    token: String,
    context_dir: PathBuf,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub output_tx: broadcast::Sender<Vec<u8>>,
}

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

fn resolve_working_dir(cwd: Option<&str>) -> Result<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let raw = cwd.unwrap_or(&home);
    let expanded = if raw == "~" {
        PathBuf::from(&home)
    } else if let Some(rest) = raw.strip_prefix("~/") {
        PathBuf::from(&home).join(rest)
    } else {
        PathBuf::from(raw)
    };

    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()?.join(expanded)
    };

    Ok(std::fs::canonicalize(&absolute).unwrap_or(absolute))
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn_terminal(
        &self,
        session_id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        env_vars: Option<HashMap<String, String>>,
    ) -> Result<broadcast::Receiver<Vec<u8>>> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = if std::path::Path::new("/usr/bin/zsh").exists() {
            "/usr/bin/zsh".to_string()
        } else if std::path::Path::new("/bin/zsh").exists() {
            "/bin/zsh".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        };

        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        
        // Inject Orchestra environment variables
        let token = uuid::Uuid::new_v4().to_string();
        cmd.env("ORCHESTRA_SESSION_ID", &session_id);
        cmd.env("ORCHESTRA_TERMINAL_ID", &session_id);
        cmd.env("ORCHESTRA_TOKEN", &token);
        cmd.env("ORCHESTRA", "1");
        let socket_path = std::env::var("XDG_RUNTIME_DIR")
            .map(|dir| format!("{}/orchestra/orchestra.sock", dir))
            .unwrap_or_else(|_| "/tmp/orchestra.sock".to_string());
        cmd.env("ORCHESTRA_SOCKET", socket_path);

        let working_dir = resolve_working_dir(cwd.as_deref())?;
        let context_dir = working_dir.join(".orchestra").join("terminals").join(&session_id);
        std::fs::create_dir_all(&context_dir)?;
        cmd.env("ORCHESTRA_CONTEXT_DIR", &context_dir);
        cmd.env("ORCHESTRA_WORKSPACE_DIR", &working_dir);

        if let Some(vars) = env_vars {
            for (key, val) in vars {
                cmd.env(&key, &val);
            }
        }

        cmd.cwd(&working_dir);


        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let (tx, rx) = broadcast::channel(512);
        let tx_clone = tx.clone();
        let session_id_clone = session_id.clone();

        // Background reader thread for PTY output
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF / Shell exited
                    Ok(n) => {
                        let _ = tx_clone.send(buf[..n].to_vec());
                    }
                    Err(e) => {
                        error!("PTY read error for {}: {}", session_id_clone, e);
                        break;
                    }
                }
            }
            info!("PTY session {} closed", session_id_clone);
            let _ = child;
        });

        let master_arc = Arc::new(Mutex::new(pair.master));
        let writer_arc = Arc::new(Mutex::new(writer));

        let session = PtySession {
            id: session_id.clone(),
            token,
            context_dir: context_dir.clone(),
            writer: writer_arc,
            master: master_arc,
            output_tx: tx,
        };

        self.sessions.lock().unwrap().insert(session_id.clone(), session);
        info!("Spawned PTY session {}", session_id);
        Ok(rx)
    }

    pub fn write_input(&self, session_id: &str, data: &[u8]) -> Result<()> {
        let lock = self.sessions.lock().unwrap();
        if let Some(session) = lock.get(session_id) {
            let mut writer = session.writer.lock().unwrap();
            writer.write_all(data)?;
            writer.flush()?;
        }
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let lock = self.sessions.lock().unwrap();
        if let Some(session) = lock.get(session_id) {
            let master = session.master.lock().unwrap();
            master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        }
        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> Result<()> {
        let mut lock = self.sessions.lock().unwrap();
        if let Some(_session) = lock.remove(session_id) {
            info!("Killed PTY session {}", session_id);
        }
        Ok(())
    }

    pub fn subscribe(&self, session_id: &str) -> Option<broadcast::Receiver<Vec<u8>>> {
        let lock = self.sessions.lock().unwrap();
        lock.get(session_id).map(|s| s.output_tx.subscribe())
    }

    pub fn list_sessions(&self) -> Vec<String> {
        let lock = self.sessions.lock().unwrap();
        lock.keys().cloned().collect()
    }

    pub fn authorizes(&self, session_id: &str, token: &str) -> bool {
        let lock = self.sessions.lock().unwrap();
        lock.get(session_id).is_some_and(|session| session.token == token)
    }

    pub fn send_prompt(&self, session_id: &str, prompt: &str) -> Result<()> {
        let pasted = format!("\x1b[200~{}\x1b[201~\r", prompt);
        self.write_input(session_id, pasted.as_bytes())
    }

    fn connected_note_path(&self, session_id: &str, note_id: &str) -> Result<PathBuf> {
        let lock = self.sessions.lock().unwrap();
        let session = lock
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Terminal is not running"))?;
        let raw = std::fs::read_to_string(session.context_dir.join("context.json"))?;
        let context: serde_json::Value = serde_json::from_str(&raw)?;
        let is_connected = context["connectedNotes"]
            .as_array()
            .is_some_and(|notes| notes.iter().any(|note| note["id"].as_str() == Some(note_id)));
        if !is_connected {
            return Err(anyhow::anyhow!("That note is not connected to this terminal"));
        }

        let orchestra_dir = session.context_dir.parent().and_then(|dir| dir.parent())
            .ok_or_else(|| anyhow::anyhow!("Invalid Orchestra context directory"))?;
        Ok(orchestra_dir.join("notes").join(format!("{}.md", note_id)))
    }

    pub fn read_note(&self, session_id: &str, note_id: &str) -> Result<String> {
        std::fs::read_to_string(self.connected_note_path(session_id, note_id)?).map_err(Into::into)
    }

    pub fn write_note(&self, session_id: &str, note_id: &str, content: &str) -> Result<()> {
        let note_path = self.connected_note_path(session_id, note_id)?;
        std::fs::write(note_path, content)?;
        Ok(())
    }
}
