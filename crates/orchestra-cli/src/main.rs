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
    /// Send a prompt/message to an agent
    Send {
        agent: String,
        message: String,
    },
    /// Read a sticky note
    NoteRead {
        title: String,
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

    let socket_path = std::env::var("XDG_RUNTIME_DIR")
        .map(|r| PathBuf::from(r).join("orchestra").join("orchestra.sock"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/orchestra.sock"));

    if !socket_path.exists() {
        println!("Error: Orchestra daemon is not running (socket not found at {:?})", socket_path);
        std::process::exit(1);
    }

    let mut stream = UnixStream::connect(&socket_path).await?;
    let req_id = format!("cli_{}", uuid::Uuid::new_v4());

    let (type_name, payload) = match cli.command {
        Commands::Agents => ("roles.list", json!({})),
        Commands::Send { agent, message } => (
            "agent.message.send",
            json!({ "agent": agent, "message": message }),
        ),
        Commands::NoteRead { title } => ("note.read", json!({ "title": title })),
        Commands::NoteAppend { title, content } => (
            "note.append",
            json!({ "title": title, "content": content }),
        ),
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

    if matches!(cli.command, Commands::Doctor) {
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
