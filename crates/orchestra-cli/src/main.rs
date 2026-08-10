use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

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
    Send {
        agent: String,
        message: String,
    },
    /// Send a request and optionally wait for the target agent's explicit completion marker
    Ask {
        agent: String,
        message: String,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 90)]
        timeout_secs: u64,
    },
    /// Read a sticky note
    NoteRead {
        title: String,
    },
    /// Replace the full content of a sticky note
    NoteWrite {
        title: String,
        content: String,
    },
    /// Append content to a sticky note
    NoteAppend {
        title: String,
        content: String,
    },
    /// Status of Orchestra core daemon
    Status,
    /// Verify the terminal-to-daemon bridge and report its capabilities
    Doctor,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let socket_path = std::env::var("ORCHESTRA_SOCKET")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("XDG_RUNTIME_DIR")
                .map(|r| PathBuf::from(r).join("orchestra").join("orchestra.sock"))
        })
        .unwrap_or_else(|_| PathBuf::from("/tmp/orchestra.sock"));

    if !socket_path.exists() {
        println!("Error: Orchestra daemon is not running (socket not found at {:?})", socket_path);
        std::process::exit(1);
    }

    let mut stream = UnixStream::connect(&socket_path).await?;
    let req_id = format!("cli_{}", uuid::Uuid::new_v4());

    let is_doctor = matches!(&cli.command, Commands::Doctor);
    let session_id = std::env::var("ORCHESTRA_SESSION_ID").ok();
    let token = std::env::var("ORCHESTRA_TOKEN").ok();
    let terminal_auth = || -> Result<(String, String)> {
        Ok((
            session_id.clone().ok_or_else(|| anyhow::anyhow!("This command must run inside an Orchestra terminal"))?,
            token.clone().ok_or_else(|| anyhow::anyhow!("Missing ORCHESTRA_TOKEN; restart the terminal from Orchestra"))?,
        ))
    };

    let (type_name, payload) = match cli.command {
        Commands::Agents => ("agent.list", json!({})),
        Commands::Connections => {
            let (session_id, token) = terminal_auth()?;
            ("connection.list", json!({ "sessionId": session_id, "token": token }))
        }
        Commands::Send { agent, message } => {
            let (session_id, token) = terminal_auth()?;
            (
                "agent.message.send",
                json!({ "sessionId": session_id, "token": token, "agent": agent, "message": message }),
            )
        },
        Commands::Ask { agent, message, wait, timeout_secs } => {
            let (session_id, token) = terminal_auth()?;
            (
                "agent.ask",
                json!({
                    "sessionId": session_id,
                    "token": token,
                    "agent": agent,
                    "message": message,
                    "wait": wait,
                    "timeoutSecs": timeout_secs
                }),
            )
        },
        Commands::NoteRead { title } => {
            let (session_id, token) = terminal_auth()?;
            ("note.read", json!({ "sessionId": session_id, "token": token, "noteId": title }))
        }
        Commands::NoteWrite { title, content } => {
            let (session_id, token) = terminal_auth()?;
            (
                "note.write",
                json!({ "sessionId": session_id, "token": token, "noteId": title, "content": content }),
            )
        }
        Commands::NoteAppend { title, content } => {
            let (session_id, token) = terminal_auth()?;
            (
                "note.append",
                json!({ "sessionId": session_id, "token": token, "noteId": title, "content": content }),
            )
        },
        Commands::Status | Commands::Doctor => ("system.hello", json!({})),
    };

    let req = json!({
        "protocolVersion": 1,
        "requestId": req_id,
        "type": type_name,
        "payload": payload
    });

    let bytes = serde_json::to_vec(&req)?;
    let len = (bytes.len() as u32).to_be_bytes();
    stream.write_all(&len).await?;
    stream.write_all(&bytes).await?;
    stream.flush().await?;

    let mut len_bytes = [0u8; 4];
    stream.read_exact(&mut len_bytes).await?;
    let resp_len = u32::from_be_bytes(len_bytes) as usize;
    let mut resp_buf = vec![0u8; resp_len];
    stream.read_exact(&mut resp_buf).await?;

    let resp: Value = serde_json::from_slice(&resp_buf)?;
    if resp["ok"].as_bool() != Some(true) {
        anyhow::bail!(
            "Orchestra daemon rejected the request: {}",
            resp["error"].as_str().unwrap_or("unknown error")
        );
    }

    if is_doctor {
        let context_dir = std::env::var("ORCHESTRA_CONTEXT_DIR").ok();
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "daemon": resp["result"],
                "terminalSessionId": std::env::var("ORCHESTRA_SESSION_ID").ok(),
                "contextDir": context_dir,
                "contextDirExists": context_dir.as_ref().is_some_and(|dir| std::path::Path::new(dir).is_dir())
            }))?
        );
    } else {
        println!("{}", serde_json::to_string_pretty(&resp["result"]).unwrap_or_default());
    }

    Ok(())
}
