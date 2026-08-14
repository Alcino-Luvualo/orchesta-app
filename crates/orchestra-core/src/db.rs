use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use tracing::info;

pub struct Database {
    conn_path: String,
}

const MIGRATIONS: &[(i64, &str)] = &[
    (1, "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"),
    (2, "CREATE TABLE IF NOT EXISTS canvas_viewports (workspace_id TEXT NOT NULL, floor_id TEXT NOT NULL DEFAULT '', x REAL NOT NULL, y REAL NOT NULL, zoom REAL NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, floor_id), FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE);"),
    (3, "CREATE TABLE IF NOT EXISTS note_revisions (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE);"),
    (4, "CREATE TABLE IF NOT EXISTS routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, output TEXT NOT NULL DEFAULT '', FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE);"),
    (5, "CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL);"),
];

impl Database {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn_path = path.as_ref().to_string_lossy().to_string();
        let db = Self { conn_path };
        db.init_tables()?;
        Ok(db)
    }

    pub fn path(&self) -> &str {
        &self.conn_path
    }

    fn get_conn(&self) -> Result<Connection> {
        let conn = Connection::open(&self.conn_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;

        let current_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        for (version, sql) in MIGRATIONS {
            if *version <= current_version {
                continue;
            }
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                params![version, chrono::Utc::now().to_rfc3339()],
            )?;
            conn.pragma_update(None, "user_version", version)?;
        }
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

    pub fn get_workspace_path(&self, workspace_id: &str) -> Result<Option<String>> {
        let conn = self.get_conn()?;
        conn.query_row(
            "SELECT path FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn workspace_exists(&self, workspace_id: &str) -> Result<bool> {
        let conn = self.get_conn()?;
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
            params![workspace_id],
            |row| row.get(0),
        )?;
        Ok(exists == 1)
    }

    pub fn get_floors(&self, workspace_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut statement = conn.prepare("SELECT id, workspace_id, name, branch, path, is_landing FROM floors WHERE workspace_id = ?1 ORDER BY is_landing DESC, name ASC")?;
        let rows = statement.query_map(params![workspace_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "workspaceId": row.get::<_, String>(1)?,
                "name": row.get::<_, String>(2)?,
                "branch": row.get::<_, String>(3)?,
                "path": row.get::<_, String>(4)?,
                "isLanding": row.get::<_, i64>(5)? == 1,
            }))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn delete_floor(&self, workspace_id: &str, floor_id: &str) -> Result<()> {
        let mut conn = self.get_conn()?;
        let transaction = conn.transaction()?;
        transaction.execute(
            "DELETE FROM connection_permissions WHERE edge_id IN (SELECT id FROM canvas_edges WHERE workspace_id = ?1 AND floor_id = ?2)",
            params![workspace_id, floor_id],
        )?;
        transaction.execute(
            "DELETE FROM canvas_edges WHERE workspace_id = ?1 AND floor_id = ?2",
            params![workspace_id, floor_id],
        )?;
        transaction.execute(
            "DELETE FROM canvas_nodes WHERE workspace_id = ?1 AND floor_id = ?2",
            params![workspace_id, floor_id],
        )?;
        transaction.execute(
            "DELETE FROM canvas_viewports WHERE workspace_id = ?1 AND floor_id = ?2",
            params![workspace_id, floor_id],
        )?;
        transaction.execute(
            "DELETE FROM floors WHERE id = ?1 AND workspace_id = ?2",
            params![floor_id, workspace_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_floor(&self, workspace_id: &str, floor: &serde_json::Value) -> Result<()> {
        let conn = self.get_conn()?;
        let id = floor["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing floor id"))?;
        let name = floor["name"].as_str().unwrap_or("Floor");
        let branch = floor["branch"].as_str().unwrap_or("main");
        let path = floor["path"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing floor path"))?;
        let landing = if floor["isLanding"].as_bool().unwrap_or(false) {
            1
        } else {
            0
        };
        conn.execute(
            "INSERT INTO floors (id, workspace_id, name, branch, path, is_landing, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET name=?3, branch=?4, path=?5, is_landing=?6",
            params![id, workspace_id, name, branch, path, landing, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn get_canvas_viewport(
        &self,
        workspace_id: &str,
        floor_id: Option<&str>,
    ) -> Result<Option<serde_json::Value>> {
        let conn = self.get_conn()?;
        let floor_key = floor_id.unwrap_or("");
        conn.query_row(
            "SELECT x, y, zoom FROM canvas_viewports WHERE workspace_id = ?1 AND floor_id = ?2",
            params![workspace_id, floor_key],
            |row| Ok(serde_json::json!({ "x": row.get::<_, f64>(0)?, "y": row.get::<_, f64>(1)?, "zoom": row.get::<_, f64>(2)? })),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn save_canvas_viewport(
        &self,
        workspace_id: &str,
        floor_id: Option<&str>,
        viewport: &serde_json::Value,
    ) -> Result<()> {
        let conn = self.get_conn()?;
        let floor_key = floor_id.unwrap_or("");
        let x = viewport["x"].as_f64().unwrap_or(0.0);
        let y = viewport["y"].as_f64().unwrap_or(0.0);
        let zoom = viewport["zoom"].as_f64().unwrap_or(1.0).clamp(0.1, 4.0);
        conn.execute(
            "INSERT INTO canvas_viewports (workspace_id, floor_id, x, y, zoom, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(workspace_id, floor_id) DO UPDATE SET x=?3, y=?4, zoom=?5, updated_at=?6",
            params![workspace_id, floor_key, x, y, zoom, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
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
    pub fn get_canvas_nodes_for_floor(
        &self,
        workspace_id: &str,
        floor_id: Option<&str>,
    ) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare("SELECT id, floor_id, kind, x, y, width, height, z_index, locked, collapsed, properties_json FROM canvas_nodes WHERE workspace_id = ?1 AND ((floor_id = ?2) OR (floor_id IS NULL AND ?2 IS NULL))")?;
        let rows = stmt.query_map(params![workspace_id, floor_id], |row| {
            let props_str: String = row.get(10)?;
            let props: serde_json::Value =
                serde_json::from_str(&props_str).unwrap_or(serde_json::json!({}));
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "floorId": row.get::<_, Option<String>>(1)?,
                "kind": row.get::<_, String>(2)?,
                "x": row.get::<_, f64>(3)?,
                "y": row.get::<_, f64>(4)?,
                "width": row.get::<_, f64>(5)?,
                "height": row.get::<_, f64>(6)?,
                "z_index": row.get::<_, i64>(7)?,
                "locked": row.get::<_, i64>(8)? == 1,
                "collapsed": row.get::<_, i64>(9)? == 1,
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
        let id = node["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing node id"))?;
        if !valid_identifier(id) {
            return Err(anyhow::anyhow!("Invalid node id"));
        }
        let floor_id = node["floorId"].as_str();
        let kind = node["kind"].as_str().unwrap_or("text");
        if !matches!(
            kind,
            "terminal"
                | "note"
                | "files"
                | "browser"
                | "device"
                | "text"
                | "shape"
                | "routine"
                | "git"
        ) {
            return Err(anyhow::anyhow!("Invalid node kind"));
        }
        let x = node["x"].as_f64().unwrap_or(0.0);
        let y = node["y"].as_f64().unwrap_or(0.0);
        let width = node["width"].as_f64().unwrap_or(300.0);
        let height = node["height"].as_f64().unwrap_or(200.0);
        if !x.is_finite()
            || !y.is_finite()
            || !width.is_finite()
            || !height.is_finite()
            || !(80.0..=4000.0).contains(&width)
            || !(60.0..=4000.0).contains(&height)
        {
            return Err(anyhow::anyhow!("Invalid node dimensions"));
        }
        let z_index = node["z_index"].as_i64().unwrap_or(1);
        let locked = if node["locked"].as_bool().unwrap_or(false) {
            1
        } else {
            0
        };
        let collapsed = if node["collapsed"].as_bool().unwrap_or(false) {
            1
        } else {
            0
        };
        let props_str =
            serde_json::to_string(&node["properties"]).unwrap_or_else(|_| "{}".to_string());

        if let Some(floor_id) = floor_id {
            let belongs: i64 = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM floors WHERE id = ?1 AND workspace_id = ?2)",
                params![floor_id, workspace_id],
                |row| row.get(0),
            )?;
            if belongs != 1 {
                return Err(anyhow::anyhow!("Floor does not belong to the workspace"));
            }
        }

        conn.execute(
            "INSERT INTO canvas_nodes (id, workspace_id, floor_id, kind, x, y, width, height, z_index, locked, collapsed, properties_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
             ON CONFLICT(id) DO UPDATE SET workspace_id=?2, floor_id=?3, kind=?4, x=?5, y=?6, width=?7, height=?8, z_index=?9, locked=?10, collapsed=?11, properties_json=?12, updated_at=?13",
            params![id, workspace_id, floor_id, kind, x, y, width, height, z_index, locked, collapsed, props_str, now],
        )?;
        Ok(())
    }

    pub fn canvas_node_context(&self, node_id: &str) -> Result<Option<serde_json::Value>> {
        let conn = self.get_conn()?;
        let row = conn.query_row(
            "SELECT workspace_id, floor_id, kind, x, y, width, height, properties_json FROM canvas_nodes WHERE id = ?1",
            params![node_id],
            |row| {
                let properties: String = row.get(7)?;
                Ok(serde_json::json!({
                    "workspaceId": row.get::<_, String>(0)?,
                    "floorId": row.get::<_, Option<String>>(1)?,
                    "kind": row.get::<_, String>(2)?,
                    "x": row.get::<_, f64>(3)?,
                    "y": row.get::<_, f64>(4)?,
                    "width": row.get::<_, f64>(5)?,
                    "height": row.get::<_, f64>(6)?,
                    "properties": serde_json::from_str::<serde_json::Value>(&properties).unwrap_or_else(|_| serde_json::json!({}))
                }))
            },
        );
        match row {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn delete_canvas_node_for_workspace(
        &self,
        workspace_id: &str,
        node_id: &str,
    ) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "DELETE FROM canvas_nodes WHERE id = ?1 AND workspace_id = ?2",
            params![node_id, workspace_id],
        )?;
        conn.execute(
            "DELETE FROM canvas_edges WHERE workspace_id = ?1 AND (source_id = ?2 OR target_id = ?2)",
            params![workspace_id, node_id],
        )?;
        Ok(())
    }

    // Canvas Edges
    pub fn get_canvas_edges_for_floor(
        &self,
        workspace_id: &str,
        floor_id: Option<&str>,
    ) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.floor_id, e.source_id, e.source_port, e.target_id, e.target_port, e.label,
                    p.permissions_json
             FROM canvas_edges e
             LEFT JOIN connection_permissions p ON p.edge_id = e.id
             WHERE e.workspace_id = ?1 AND ((e.floor_id = ?2) OR (e.floor_id IS NULL AND ?2 IS NULL))"
        )?;
        let rows = stmt.query_map(params![workspace_id, floor_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "floorId": row.get::<_, Option<String>>(1)?,
                "source": row.get::<_, String>(2)?,
                "sourcePort": row.get::<_, Option<String>>(3)?,
                "target": row.get::<_, String>(4)?,
                "targetPort": row.get::<_, Option<String>>(5)?,
                "label": row.get::<_, Option<String>>(6)?,
                "permissions": row.get::<_, Option<String>>(7)?
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .unwrap_or_else(|| serde_json::json!([])),
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
        let id = edge["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing edge id"))?;
        if !valid_identifier(id) {
            return Err(anyhow::anyhow!("Invalid edge id"));
        }
        let floor_id = edge["floorId"].as_str();
        let source = edge["source"].as_str().unwrap_or("");
        let source_port = edge["sourcePort"].as_str();
        let target = edge["target"].as_str().unwrap_or("");
        let target_port = edge["targetPort"].as_str();
        let label = edge["label"].as_str();

        let kinds = conn.query_row(
            "SELECT (SELECT kind FROM canvas_nodes WHERE id = ?1 AND workspace_id = ?3), (SELECT kind FROM canvas_nodes WHERE id = ?2 AND workspace_id = ?3)",
            params![source, target, workspace_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )?;
        if kinds.0.is_none() || kinds.1.is_none() {
            return Err(anyhow::anyhow!(
                "Both connection endpoints must exist in the workspace"
            ));
        }
        for endpoint in [source, target] {
            let endpoint_floor: Option<String> = conn.query_row(
                "SELECT floor_id FROM canvas_nodes WHERE id = ?1 AND workspace_id = ?2",
                params![endpoint, workspace_id],
                |row| row.get(0),
            )?;
            if endpoint_floor.as_deref() != floor_id {
                return Err(anyhow::anyhow!(
                    "Connection endpoints must be on the same floor"
                ));
            }
        }

        if let Some(floor_id) = floor_id {
            let belongs: i64 = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM floors WHERE id = ?1 AND workspace_id = ?2)",
                params![floor_id, workspace_id],
                |row| row.get(0),
            )?;
            if belongs != 1 {
                return Err(anyhow::anyhow!("Floor does not belong to the workspace"));
            }
        }

        conn.execute(
            "INSERT INTO canvas_edges (id, workspace_id, floor_id, source_id, source_port, target_id, target_port, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET workspace_id=?2, floor_id=?3, source_id=?4, source_port=?5, target_id=?6, target_port=?7, label=?8",
            params![id, workspace_id, floor_id, source, source_port, target, target_port, label, now],
        )?;

        let allowed: &[&str] =
            if Self::is_terminal_browser_connection(kinds.0.as_deref(), kinds.1.as_deref()) {
                &["inspect", "navigate", "control", "screenshot"]
            } else {
                match (kinds.0.as_deref(), kinds.1.as_deref()) {
                    (Some("terminal"), Some("terminal")) => {
                        &["send_prompt", "receive_response", "share_context"]
                    }
                    (Some("terminal"), Some("note")) => &["read", "write", "append"],
                    (Some("terminal"), Some("files")) => &["read", "write", "search", "execute"],
                    (Some("terminal"), Some("git")) => {
                        &["status", "stage", "commit", "branch", "push"]
                    }
                    _ => &["read", "write", "share_context"],
                }
            };
        let requested = edge["permissions"].as_array().cloned().unwrap_or_default();
        let permissions = requested
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .filter(|permission| {
                allowed
                    .iter()
                    .any(|allowed_permission| *allowed_permission == permission)
            })
            .collect::<Vec<_>>();
        let permissions = serde_json::to_string(&if permissions.is_empty() {
            allowed
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<_>>()
        } else {
            permissions
        })?;
        conn.execute(
            "INSERT INTO connection_permissions (edge_id, permissions_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(edge_id) DO UPDATE SET permissions_json=?2, updated_at=?3",
            params![id, permissions, now],
        )?;
        Ok(())
    }

    pub fn delete_canvas_edge_for_workspace(
        &self,
        workspace_id: &str,
        edge_id: &str,
    ) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "DELETE FROM connection_permissions WHERE edge_id IN (SELECT id FROM canvas_edges WHERE id = ?1 AND workspace_id = ?2)",
            params![edge_id, workspace_id],
        )?;
        conn.execute(
            "DELETE FROM canvas_edges WHERE id = ?1 AND workspace_id = ?2",
            params![edge_id, workspace_id],
        )?;
        Ok(())
    }

    pub fn nodes_are_connected(&self, first: &str, second: &str) -> Result<bool> {
        let conn = self.get_conn()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM canvas_edges
             WHERE source_id = ?1 AND target_id = ?2",
            params![first, second],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    fn node_kind(conn: &Connection, node_id: &str) -> rusqlite::Result<Option<String>> {
        conn.query_row(
            "SELECT kind FROM canvas_nodes WHERE id = ?1",
            params![node_id],
            |row| row.get(0),
        )
        .optional()
    }

    fn is_terminal_browser_connection(first_kind: Option<&str>, second_kind: Option<&str>) -> bool {
        matches!(
            (first_kind, second_kind),
            (Some("terminal"), Some("browser")) | (Some("browser"), Some("terminal"))
        )
    }

    /// Repair the legacy generic permission shape produced for a reverse
    /// browser -> terminal cable. A modern partial browser list contains at
    /// least one browser permission and remains explicit.
    fn normalize_browser_permissions(
        first_kind: Option<&str>,
        second_kind: Option<&str>,
        permissions: Vec<String>,
    ) -> Vec<String> {
        if Self::is_terminal_browser_connection(first_kind, second_kind)
            && !permissions.iter().any(|permission| {
                matches!(
                    permission.as_str(),
                    "inspect" | "navigate" | "control" | "screenshot"
                )
            })
        {
            return ["inspect", "navigate", "control", "screenshot"]
                .into_iter()
                .map(str::to_string)
                .collect();
        }
        permissions
    }

    /// Return the effective permissions for a request from `first` to
    /// `second`. Resource cables are visually undirected: if a note/files/
    /// browser node was created first and the terminal second, the terminal
    /// still owns the permissions. Terminal-to-terminal cables remain
    /// directional.
    pub fn connection_permission_report(
        &self,
        first: &str,
        second: &str,
    ) -> Result<serde_json::Value> {
        let conn = self.get_conn()?;
        let first_kind = Self::node_kind(&conn, first)?;
        let second_kind = Self::node_kind(&conn, second)?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.source_id, e.target_id, p.permissions_json
             FROM canvas_edges e
             LEFT JOIN connection_permissions p ON p.edge_id = e.id
             WHERE (e.source_id = ?1 AND e.target_id = ?2)
                OR (e.source_id = ?2 AND e.target_id = ?1)",
        )?;
        let rows = stmt.query_map(params![first, second], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut permissions = Vec::<String>::new();
        let mut edges = Vec::new();
        for row in rows {
            let (edge_id, source, target, raw) = row?;
            let exact = source == first && target == second;
            let reverse_resource = !exact
                && first_kind.as_deref() == Some("terminal")
                && second_kind.as_deref() != Some("terminal");
            let effective = exact || reverse_resource;
            let edge_permissions: Vec<String> = Self::normalize_browser_permissions(
                first_kind.as_deref(),
                second_kind.as_deref(),
                raw.as_deref()
                    .and_then(|value| serde_json::from_str(value).ok())
                    .unwrap_or_default(),
            );
            if effective {
                for permission in &edge_permissions {
                    if !permissions.iter().any(|item| item == permission) {
                        permissions.push(permission.clone());
                    }
                }
            }
            edges.push(serde_json::json!({
                "edgeId": edge_id,
                "source": source,
                "target": target,
                "storedDirection": if exact { "outbound" } else { "reverse" },
                "effective": effective,
                "permissions": edge_permissions
            }));
        }
        Ok(serde_json::json!({
            "source": first,
            "target": second,
            "sourceKind": first_kind,
            "targetKind": second_kind,
            "connected": !edges.is_empty(),
            "permissions": permissions,
            "edges": edges
        }))
    }

    pub fn has_connection_permission(
        &self,
        first: &str,
        second: &str,
        permission: &str,
    ) -> Result<bool> {
        let report = self.connection_permission_report(first, second)?;
        Ok(report["permissions"].as_array().is_some_and(|values| {
            values
                .iter()
                .any(|value| value.as_str() == Some(permission))
        }))
    }

    pub fn connected_nodes(&self, node_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.source_id, e.target_id, e.label, p.permissions_json
             FROM canvas_edges e
             LEFT JOIN connection_permissions p ON p.edge_id = e.id
             WHERE e.source_id = ?1 OR e.target_id = ?1",
        )?;
        let rows = stmt.query_map(params![node_id], |row| {
            let source: String = row.get(1)?;
            let target: String = row.get(2)?;
            let outbound = source == node_id;
            let peer = if outbound { target } else { source.clone() };
            let node_kind = Self::node_kind(&conn, node_id)?.unwrap_or_default();
            let peer_kind = Self::node_kind(&conn, &peer)?.unwrap_or_default();
            let effective_outbound =
                outbound || (node_kind == "terminal" && peer_kind != "terminal");
            let permissions = Self::normalize_browser_permissions(
                Some(node_kind.as_str()),
                Some(peer_kind.as_str()),
                row.get::<_, Option<String>>(4)?
                    .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
                    .unwrap_or_default(),
            );
            Ok(serde_json::json!({
                "edgeId": row.get::<_, String>(0)?,
                "nodeId": peer,
                "direction": if effective_outbound { "outbound" } else { "inbound" },
                "storedDirection": if outbound { "outbound" } else { "inbound" },
                "effectiveDirection": if effective_outbound { "outbound" } else { "inbound" },
                "sourceKind": node_kind,
                "targetKind": peer_kind,
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
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?5 IN ('completed', 'timed_out', 'failed', 'cancelled') THEN ?7 ELSE NULL END)
             ON CONFLICT(id) DO UPDATE SET status=?5, completed_at=CASE WHEN ?5 IN ('completed', 'timed_out', 'failed', 'cancelled') THEN ?7 ELSE completed_at END",
            params![id, source_session_id, target_session_id, request_kind, status, if waited { 1 } else { 0 }, now],
        )?;
        Ok(())
    }

    /// Return only the request history owned by the authenticated terminal.
    /// The audit table is shared by all terminals, so exposing the global
    /// list through the CLI would leak peer session identifiers and request
    /// state across the canvas access boundary.
    pub fn list_agent_request_audit_for_source(
        &self,
        source_session_id: &str,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, source_session_id, target_session_id, request_kind, status, waited, created_at, completed_at
             FROM agent_request_audit WHERE source_session_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![source_session_id, limit as i64], |row| {
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
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    // Roles
    pub fn get_roles(&self) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut stmt = conn.prepare("SELECT id, name, description, color, icon, instructions, permissions_json FROM roles ORDER BY name ASC")?;
        let rows = stmt.query_map([], |row| {
            let perms_str: String = row.get(6)?;
            let perms: serde_json::Value =
                serde_json::from_str(&perms_str).unwrap_or(serde_json::json!([]));
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
        let id = role["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing role id"))?;
        let name = role["name"].as_str().unwrap_or("Novo Role");
        let desc = role["description"].as_str().unwrap_or("");
        let color = role["color"].as_str().unwrap_or("#c8f169");
        let icon = role["icon"].as_str().unwrap_or("terminal");
        let instructions = role["instructions"].as_str().unwrap_or("");
        let perms =
            serde_json::to_string(&role["permissions"]).unwrap_or_else(|_| "[]".to_string());

        conn.execute(
            "INSERT INTO roles (id, name, description, color, icon, instructions, permissions_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET name=?2, description=?3, color=?4, icon=?5, instructions=?6, permissions_json=?7",
            params![id, name, desc, color, icon, instructions, perms, now],
        )?;
        Ok(())
    }

    pub fn delete_role(&self, id: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute("DELETE FROM roles WHERE id = ?1", params![id])?;
        Ok(())
    }

    // Environments and settings
    pub fn get_environments(&self) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn()?;
        let mut statement = conn.prepare(
            "SELECT id, name, kind, status, config_json, updated_at FROM environments ORDER BY name ASC",
        )?;
        let rows = statement.query_map([], |row| {
            let config: serde_json::Value = serde_json::from_str(&row.get::<_, String>(4)?)
                .unwrap_or_else(|_| serde_json::json!({}));
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "kind": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "config": config,
                "updatedAt": row.get::<_, String>(5)?,
            }))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_environment(&self, id: &str) -> Result<Option<serde_json::Value>> {
        Ok(self
            .get_environments()?
            .into_iter()
            .find(|environment| environment["id"].as_str() == Some(id)))
    }

    pub fn save_environment(&self, environment: &serde_json::Value) -> Result<()> {
        let conn = self.get_conn()?;
        let id = environment["id"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("Missing environment id"))?;
        let name = environment["name"].as_str().unwrap_or("Environment");
        let kind = environment["kind"].as_str().unwrap_or("local");
        let status = environment["status"].as_str().unwrap_or("configured");
        let config = environment
            .get("config")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if contains_sensitive_key(&config) {
            return Err(anyhow::anyhow!(
                "Secrets are not stored in SQLite; configure credentials through the OS keyring or SSH agent"
            ));
        }
        conn.execute(
            "INSERT INTO environments (id, name, kind, status, config_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET name=?2, kind=?3, status=?4, config_json=?5, updated_at=?6",
            params![
                id,
                name,
                kind,
                status,
                serde_json::to_string(&config)?,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn delete_environment(&self, id: &str) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute("DELETE FROM environments WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let conn = self.get_conn()?;
        conn.query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            params![key],
            |row| {
                let raw: String = row.get(0)?;
                Ok(serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null))
            },
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn save_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        if key.trim().is_empty() || contains_sensitive_key(value) {
            return Err(anyhow::anyhow!("Invalid or sensitive setting"));
        }
        let conn = self.get_conn()?;
        conn.execute(
            "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json=?2",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    pub fn record_audit(
        &self,
        actor: &str,
        action: &str,
        target: &str,
        details: &serde_json::Value,
    ) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "INSERT INTO audit_log (id, actor, action, target, details_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![format!("audit_{}", uuid::Uuid::new_v4()), actor, action, target, serde_json::to_string(details)?, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
}

fn contains_sensitive_key(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => object.iter().any(|(key, child)| {
            let normalized = key.to_ascii_lowercase();
            [
                "password",
                "passwd",
                "secret",
                "token",
                "private_key",
                "privatekey",
                "passphrase",
            ]
            .iter()
            .any(|needle| normalized.contains(needle))
                || contains_sensitive_key(child)
        }),
        serde_json::Value::Array(items) => items.iter().any(contains_sensitive_key),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::Database;
    use serde_json::json;
    use std::fs;

    fn temp_db() -> String {
        std::env::temp_dir()
            .join(format!("orchestra-db-test-{}.sqlite", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn migrations_and_scoped_canvas_state_work() {
        let path = temp_db();
        let database = Database::new(&path).expect("database initializes");
        database
            .save_workspace("ws", "Workspace", "/tmp")
            .expect("workspace saves");
        database
            .save_canvas_viewport("ws", None, &json!({ "x": 4.0, "y": 8.0, "zoom": 1.25 }))
            .expect("viewport saves");
        assert_eq!(
            database
                .get_canvas_viewport("ws", None)
                .expect("viewport reads")
                .expect("viewport exists")["zoom"],
            1.25
        );

        database
            .save_canvas_node(
                "ws",
                &json!({ "id": "terminal", "kind": "terminal", "x": 0, "y": 0, "properties": {} }),
            )
            .expect("terminal saves");
        database
            .save_canvas_node(
                "ws",
                &json!({ "id": "note", "kind": "note", "x": 1, "y": 1, "properties": {} }),
            )
            .expect("note saves");
        database
            .save_canvas_node(
                "ws",
                &json!({ "id": "browser", "kind": "browser", "x": 2, "y": 2, "properties": {} }),
            )
            .expect("browser saves");
        database
            .save_canvas_edge(
                "ws",
                &json!({ "id": "edge", "source": "terminal", "target": "note", "permissions": ["write"] }),
            )
            .expect("edge saves");
        assert!(database
            .has_connection_permission("terminal", "note", "write")
            .expect("permission reads"));
        assert!(!database
            .has_connection_permission("note", "terminal", "write")
            .expect("reverse permission reads"));
        database
            .save_canvas_edge(
                "ws",
                &json!({ "id": "browser-edge", "source": "browser", "target": "terminal", "permissions": ["read", "write", "share_context"] }),
            )
            .expect("reverse browser edge saves");
        assert!(database
            .has_connection_permission("terminal", "browser", "inspect")
            .expect("reverse browser inspect permission reads"));

        fs::remove_file(&path).expect("remove database");
        let wal = format!("{path}-wal");
        let shm = format!("{path}-shm");
        let _ = fs::remove_file(wal);
        let _ = fs::remove_file(shm);
    }

    #[test]
    fn refuses_plaintext_sensitive_environment_values() {
        let path = temp_db();
        let database = Database::new(&path).expect("database initializes");
        let result = database.save_environment(&json!({
            "id": "env",
            "name": "Remote",
            "kind": "ssh",
            "config": { "password": "do-not-store" }
        }));
        assert!(result.is_err());
        fs::remove_file(path).expect("remove database");
    }

    #[test]
    fn request_history_is_scoped_to_the_authenticated_source() {
        let path = temp_db();
        let database = Database::new(&path).expect("database initializes");
        database
            .record_agent_request(
                "req_a",
                "terminal_a",
                "terminal_b",
                "ask",
                "completed",
                true,
            )
            .expect("first request records");
        database
            .record_agent_request(
                "req_b",
                "terminal_b",
                "terminal_a",
                "ask",
                "completed",
                false,
            )
            .expect("second request records");

        let own = database
            .list_agent_request_audit_for_source("terminal_a", 20)
            .expect("scoped history reads");
        assert_eq!(own.len(), 1);
        assert_eq!(own[0]["id"], "req_a");

        fs::remove_file(&path).expect("remove database");
    }
}
