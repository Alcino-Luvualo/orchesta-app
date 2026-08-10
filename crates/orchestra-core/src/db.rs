use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;
use tracing::info;

pub struct Database {
    conn_path: String,
}

impl Database {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn_path = path.as_ref().to_string_lossy().to_string();
        let db = Self { conn_path };
        db.init_tables()?;
        Ok(db)
    }

    fn get_conn(&self) -> Result<Connection> {
        let conn = Connection::open(&self.conn_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        Ok(conn)
    }

    fn init_tables(&self) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                active_floor_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS floors (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                name TEXT NOT NULL,
                branch TEXT NOT NULL,
                path TEXT NOT NULL,
                is_landing INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS canvas_nodes (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                floor_id TEXT,
                kind TEXT NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                width REAL NOT NULL,
                height REAL NOT NULL,
                z_index INTEGER DEFAULT 1,
                locked INTEGER DEFAULT 0,
                collapsed INTEGER DEFAULT 0,
                properties_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS canvas_edges (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                floor_id TEXT,
                source_id TEXT NOT NULL,
                source_port TEXT,
                target_id TEXT NOT NULL,
                target_port TEXT,
                label TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS connection_permissions (
                edge_id TEXT PRIMARY KEY,
                permissions_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(edge_id) REFERENCES canvas_edges(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                path TEXT,
                color TEXT DEFAULT '#fff4a8',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS roles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                color TEXT NOT NULL,
                icon TEXT NOT NULL,
                instructions TEXT NOT NULL,
                permissions_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                provider TEXT NOT NULL,
                role_id TEXT,
                model TEXT NOT NULL,
                environment_id TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS routines (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                name TEXT NOT NULL,
                schedule_cron TEXT NOT NULL,
                target_agent TEXT NOT NULL,
                prompt TEXT NOT NULL,
                active INTEGER DEFAULT 1,
                last_run TEXT,
                next_run TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS environments (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                config_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                time TEXT NOT NULL,
                unread INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS agent_request_audit (
                id TEXT PRIMARY KEY,
                source_session_id TEXT NOT NULL,
                target_session_id TEXT NOT NULL,
                request_kind TEXT NOT NULL,
                status TEXT NOT NULL,
                waited INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                completed_at TEXT
            );
            ",
        )?;

        // Insert default roles if empty
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM roles", [], |r| r.get(0))?;
        if count == 0 {
            Self::seed_default_roles(&conn)?;
        }

        info!("Database initialized successfully at {}", self.conn_path);
        Ok(())
    }

    fn seed_default_roles(conn: &Connection) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let default_roles = vec![
            ("role_lead", "Lead Developer", "Coordenador técnico de projeto e decisões de arquitetura", "#c8f169", "terminal", "Es o desenvolvedor principal da equipa. Analisa o contexto e toma decisoes de arquitetura.", "[\"read\", \"write\", \"execute\", \"git\"]"),
            ("role_frontend", "Frontend Architect", "Especialista em React, CSS e UX", "#74a7f5", "layout", "Es o especialista de frontend. Garante fidelidade visual e UX excelente.", "[\"read\", \"write\"]"),
            ("role_backend", "Backend & Core Engineer", "Especialista Rust, PTY, APIs e SQLite", "#purple", "cpu", "Es o engenheiro de backend. Foca em performance, seguranca e sistemas.", "[\"read\", \"write\", \"execute\"]"),
            ("role_reviewer", "Code Reviewer", "Garante qualidade de codigo, testes e padroes", "#warn", "shield-check", "Revê o código minuciosamente e aponta melhorias e testes em falta.", "[\"read\"]")
        ];

        for (id, name, desc, color, icon, instructions, perms) in default_roles {
            conn.execute(
                "INSERT INTO roles (id, name, description, color, icon, instructions, permissions_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![id, name, desc, color, icon, instructions, perms, now],
            )?;
        }
        Ok(())
    }

    // Workspaces
    pub fn get_workspaces(&self) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare("SELECT id, name, path, active_floor_id, created_at, updated_at FROM workspaces ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "path": row.get::<_, String>(2)?,
                "active_floor_id": row.get::<_, Option<String>>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
            }))
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn save_workspace(&self, id: &str, name: &str, path: &str) -> Result<()> {
        let conn = self.get_conn()?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO workspaces (id, name, path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name=?2, path=?3, updated_at=?4",
            params![id, name, path, now],
        )?;
        Ok(())
    }

    // Canvas Nodes
    pub fn get_canvas_nodes(&self, workspace_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare("SELECT id, kind, x, y, width, height, z_index, locked, collapsed, properties_json FROM canvas_nodes WHERE workspace_id = ?1")?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            let props_str: String = row.get(9)?;
            let props: serde_json::Value = serde_json::from_str(&props_str).unwrap_or(serde_json::json!({}));
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "x": row.get::<_, f64>(2)?,
                "y": row.get::<_, f64>(3)?,
                "width": row.get::<_, f64>(4)?,
                "height": row.get::<_, f64>(5)?,
                "z_index": row.get::<_, i64>(6)?,
                "locked": row.get::<_, i64>(7)? == 1,
                "collapsed": row.get::<_, i64>(8)? == 1,
                "properties": props
            }))
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn save_canvas_node(&self, workspace_id: &str, node: &serde_json::Value) -> Result<()> {
        let conn = self.get_conn()?;
        let now = chrono::Utc::now().to_rfc3339();
        let id = node["id"].as_str().ok_or_else(|| anyhow::anyhow!("Missing node id"))?;
        let kind = node["kind"].as_str().unwrap_or("text");
        let x = node["x"].as_f64().unwrap_or(0.0);
        let y = node["y"].as_f64().unwrap_or(0.0);
        let width = node["width"].as_f64().unwrap_or(300.0);
        let height = node["height"].as_f64().unwrap_or(200.0);
        let z_index = node["z_index"].as_i64().unwrap_or(1);
        let locked = if node["locked"].as_bool().unwrap_or(false) { 1 } else { 0 };
        let collapsed = if node["collapsed"].as_bool().unwrap_or(false) { 1 } else { 0 };
        let props_str = serde_json::to_string(&node["properties"]).unwrap_or_else(|_| "{}".to_string());

        conn.execute(
            "INSERT OR IGNORE INTO workspaces (id, name, path, created_at, updated_at) VALUES (?1, ?1, '', ?2, ?2)",
            params![workspace_id, now],
        )?;

        conn.execute(
            "INSERT INTO canvas_nodes (id, workspace_id, kind, x, y, width, height, z_index, locked, collapsed, properties_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
             ON CONFLICT(id) DO UPDATE SET kind=?3, x=?4, y=?5, width=?6, height=?7, z_index=?8, locked=?9, collapsed=?10, properties_json=?11, updated_at=?12",
            params![id, workspace_id, kind, x, y, width, height, z_index, locked, collapsed, props_str, now],
        )?;
        Ok(())
    }

    pub fn delete_canvas_node(&self, node_id: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute("DELETE FROM canvas_nodes WHERE id = ?1", params![node_id])?;
        conn.execute("DELETE FROM canvas_edges WHERE source_id = ?1 OR target_id = ?1", params![node_id])?;
        Ok(())
    }

    // Canvas Edges
    pub fn get_canvas_edges(&self, workspace_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.source_id, e.source_port, e.target_id, e.target_port, e.label,
                    p.permissions_json
             FROM canvas_edges e
             LEFT JOIN connection_permissions p ON p.edge_id = e.id
             WHERE e.workspace_id = ?1"
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "source": row.get::<_, String>(1)?,
                "sourcePort": row.get::<_, Option<String>>(2)?,
                "target": row.get::<_, String>(3)?,
                "targetPort": row.get::<_, Option<String>>(4)?,
                "label": row.get::<_, Option<String>>(5)?,
                "permissions": row.get::<_, Option<String>>(6)?
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .unwrap_or_else(|| serde_json::json!(["read", "write", "send_prompt", "receive_response", "control", "share_context"])),
            }))
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn save_canvas_edge(&self, workspace_id: &str, edge: &serde_json::Value) -> Result<()> {
        let conn = self.get_conn()?;
        let now = chrono::Utc::now().to_rfc3339();
        let id = edge["id"].as_str().ok_or_else(|| anyhow::anyhow!("Missing edge id"))?;
        let source = edge["source"].as_str().unwrap_or("");
        let source_port = edge["sourcePort"].as_str();
        let target = edge["target"].as_str().unwrap_or("");
        let target_port = edge["targetPort"].as_str();
        let label = edge["label"].as_str();

        conn.execute(
            "INSERT OR IGNORE INTO workspaces (id, name, path, created_at, updated_at) VALUES (?1, ?1, '', ?2, ?2)",
            params![workspace_id, now],
        )?;

        conn.execute(
            "INSERT INTO canvas_edges (id, workspace_id, source_id, source_port, target_id, target_port, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET source_id=?3, source_port=?4, target_id=?5, target_port=?6, label=?7",
            params![id, workspace_id, source, source_port, target, target_port, label, now],
        )?;

        let permissions = if edge["permissions"].is_array() {
            serde_json::to_string(&edge["permissions"])?
        } else {
            serde_json::to_string(&serde_json::json!(["read", "write", "send_prompt", "receive_response", "control", "share_context"]))?
        };
        conn.execute(
            "INSERT INTO connection_permissions (edge_id, permissions_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(edge_id) DO UPDATE SET permissions_json=?2, updated_at=?3",
            params![id, permissions, now],
        )?;
        Ok(())
    }

    pub fn delete_canvas_edge(&self, edge_id: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute("DELETE FROM connection_permissions WHERE edge_id = ?1", params![edge_id])?;
        conn.execute("DELETE FROM canvas_edges WHERE id = ?1", params![edge_id])?;
        Ok(())
    }

    pub fn nodes_are_connected(&self, first: &str, second: &str) -> Result<bool> {
        let conn = self.get_conn()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM canvas_edges
             WHERE (source_id = ?1 AND target_id = ?2)
                OR (source_id = ?2 AND target_id = ?1)",
            params![first, second],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn has_connection_permission(&self, first: &str, second: &str, permission: &str) -> Result<bool> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            "SELECT p.permissions_json
             FROM canvas_edges e
             LEFT JOIN connection_permissions p ON p.edge_id = e.id
             WHERE (e.source_id = ?1 AND e.target_id = ?2)
                OR (e.source_id = ?2 AND e.target_id = ?1)"
        )?;
        let rows = stmt.query_map(params![first, second], |row| row.get::<_, Option<String>>(0))?;
        for row in rows {
            match row? {
                Some(raw) => {
                    let values: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
                    if values.iter().any(|value| value == permission) {
                        return Ok(true);
                    }
                }
                None => return Ok(true),
            }
        }
        Ok(false)
    }

    pub fn connected_nodes(&self, node_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.source_id, e.target_id, e.label, p.permissions_json
             FROM canvas_edges e
             LEFT JOIN connection_permissions p ON p.edge_id = e.id
             WHERE e.source_id = ?1 OR e.target_id = ?1"
        )?;
        let rows = stmt.query_map(params![node_id], |row| {
            let source: String = row.get(1)?;
            let target: String = row.get(2)?;
            let peer = if source == node_id { target } else { source };
            let permissions = row.get::<_, Option<String>>(4)?
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .unwrap_or_else(|| serde_json::json!(["read", "write", "send_prompt", "receive_response", "control", "share_context"]));
            Ok(serde_json::json!({
                "edgeId": row.get::<_, String>(0)?,
                "nodeId": peer,
                "label": row.get::<_, Option<String>>(3)?,
                "permissions": permissions,
            }))
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    pub fn record_agent_request(
        &self,
        id: &str,
        source_session_id: &str,
        target_session_id: &str,
        request_kind: &str,
        status: &str,
        waited: bool,
    ) -> Result<()> {
        let conn = self.get_conn()?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO agent_request_audit (id, source_session_id, target_session_id, request_kind, status, waited, created_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?5 IN ('completed', 'timed_out', 'failed') THEN ?7 ELSE NULL END)
             ON CONFLICT(id) DO UPDATE SET status=?5, completed_at=CASE WHEN ?5 IN ('completed', 'timed_out', 'failed') THEN ?7 ELSE completed_at END",
            params![id, source_session_id, target_session_id, request_kind, status, if waited { 1 } else { 0 }, now],
        )?;
        Ok(())
    }

    pub fn list_agent_request_audit(&self, limit: usize) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, source_session_id, target_session_id, request_kind, status, waited, created_at, completed_at
             FROM agent_request_audit ORDER BY created_at DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "sourceSessionId": row.get::<_, String>(1)?,
                "targetSessionId": row.get::<_, String>(2)?,
                "kind": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(4)?,
                "waited": row.get::<_, i64>(5)? == 1,
                "createdAt": row.get::<_, String>(6)?,
                "completedAt": row.get::<_, Option<String>>(7)?,
            }))
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    // Roles
    pub fn get_roles(&self) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare("SELECT id, name, description, color, icon, instructions, permissions_json FROM roles ORDER BY name ASC")?;
        let rows = stmt.query_map([], |row| {
            let perms_str: String = row.get(6)?;
            let perms: serde_json::Value = serde_json::from_str(&perms_str).unwrap_or(serde_json::json!([]));
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "description": row.get::<_, String>(2)?,
                "color": row.get::<_, String>(3)?,
                "icon": row.get::<_, String>(4)?,
                "instructions": row.get::<_, String>(5)?,
                "permissions": perms,
            }))
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn save_role(&self, role: &serde_json::Value) -> Result<()> {
        let conn = self.get_conn()?;
        let now = chrono::Utc::now().to_rfc3339();
        let id = role["id"].as_str().ok_or_else(|| anyhow::anyhow!("Missing role id"))?;
        let name = role["name"].as_str().unwrap_or("Novo Role");
        let desc = role["description"].as_str().unwrap_or("");
        let color = role["color"].as_str().unwrap_or("#c8f169");
        let icon = role["icon"].as_str().unwrap_or("terminal");
        let instructions = role["instructions"].as_str().unwrap_or("");
        let perms = serde_json::to_string(&role["permissions"]).unwrap_or_else(|_| "[]".to_string());

        conn.execute(
            "INSERT INTO roles (id, name, description, color, icon, instructions, permissions_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET name=?2, description=?3, color=?4, icon=?5, instructions=?6, permissions_json=?7",
            params![id, name, desc, color, icon, instructions, perms, now],
        )?;
        Ok(())
    }

    // Routines
    pub fn get_routines(&self, workspace_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare("SELECT id, name, schedule_cron, target_agent, prompt, active, last_run, next_run FROM routines WHERE workspace_id = ?1")?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "schedule_cron": row.get::<_, String>(2)?,
                "target_agent": row.get::<_, String>(3)?,
                "prompt": row.get::<_, String>(4)?,
                "active": row.get::<_, i64>(5)? == 1,
                "last_run": row.get::<_, Option<String>>(6)?,
                "next_run": row.get::<_, Option<String>>(7)?,
            }))
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn save_routine(&self, workspace_id: &str, routine: &serde_json::Value) -> Result<()> {
        let conn = self.get_conn()?;
        let now = chrono::Utc::now().to_rfc3339();
        let id = routine["id"].as_str().ok_or_else(|| anyhow::anyhow!("Missing routine id"))?;
        let name = routine["name"].as_str().unwrap_or("Routine");
        let cron = routine["schedule_cron"].as_str().unwrap_or("0 * * * *");
        let target = routine["target_agent"].as_str().unwrap_or("Claude Code");
        let prompt = routine["prompt"].as_str().unwrap_or("");
        let active = if routine["active"].as_bool().unwrap_or(true) { 1 } else { 0 };

        conn.execute(
            "INSERT INTO routines (id, workspace_id, name, schedule_cron, target_agent, prompt, active, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET name=?3, schedule_cron=?4, target_agent=?5, prompt=?6, active=?7",
            params![id, workspace_id, name, cron, target, prompt, active, now],
        )?;
        Ok(())
    }
}
