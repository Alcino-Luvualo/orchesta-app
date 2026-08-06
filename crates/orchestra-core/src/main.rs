use anyhow::Result;
use db::Database;
use pty::PtyManager;
use socket_server::SocketServer;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::info;

mod db;
mod git;
mod pty;
mod socket_server;
mod workspace;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    info!("Starting Orchestra Core Daemon...");

    // Compute DB path under XDG data dir or fallback
    let db_dir = dirs::data_local_dir()
        .map(|d| d.join("orchestra"))
        .unwrap_or_else(|| PathBuf::from("./data"));
    std::fs::create_dir_all(&db_dir)?;

    let db_path = db_dir.join("orchestra.db");
    let database = Arc::new(Database::new(&db_path)?);
    let pty_manager = PtyManager::new();

    // Compute socket path under XDG runtime dir or fallback
    let socket_path = std::env::var("XDG_RUNTIME_DIR")
        .map(|r| PathBuf::from(r).join("orchestra").join("orchestra.sock"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/orchestra.sock"));

    let server = SocketServer::new(database, pty_manager);
    server.start(socket_path).await?;

    Ok(())
}
