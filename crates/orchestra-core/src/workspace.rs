use anyhow::Result;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

pub struct WorkspaceManager;

impl WorkspaceManager {
    pub fn read_dir_tree(dir_path: &str, depth_limit: usize) -> Result<Value> {
        let root = Path::new(dir_path);
        if !root.exists() {
            return Ok(json!({ "error": "Path does not exist" }));
        }
        Self::build_tree(root, 0, depth_limit)
    }

    fn build_tree(path: &Path, current_depth: usize, max_depth: usize) -> Result<Value> {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let is_dir = path.is_dir();

        if is_dir {
            let mut children = Vec::new();
            if current_depth < max_depth {
                if let Ok(entries) = fs::read_dir(path) {
                    for entry in entries.flatten() {
                        let child_path = entry.path();
                        let child_name = child_path.file_name().unwrap_or_default().to_string_lossy();
                        if child_name.starts_with('.') && child_name != ".floors" {
                            continue; // Skip hidden dirs by default except .floors
                        }
                        if child_name == "node_modules" || child_name == "target" || child_name == "dist" {
                            continue;
                        }
                        if let Ok(child_val) = Self::build_tree(&child_path, current_depth + 1, max_depth) {
                            children.push(child_val);
                        }
                    }
                }
            }
            // Sort: directories first, then files
            children.sort_by(|a, b| {
                let a_is_dir = a["is_dir"].as_bool().unwrap_or(false);
                let b_is_dir = b["is_dir"].as_bool().unwrap_or(false);
                if a_is_dir == b_is_dir {
                    a["name"].as_str().cmp(&b["name"].as_str())
                } else {
                    b_is_dir.cmp(&a_is_dir)
                }
            });

            Ok(json!({
                "name": name,
                "path": path.to_string_lossy(),
                "is_dir": true,
                "children": children,
            }))
        } else {
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
            Ok(json!({
                "name": name,
                "path": path.to_string_lossy(),
                "is_dir": false,
                "extension": ext,
            }))
        }
    }

    pub fn read_file(file_path: &str) -> Result<String> {
        let content = fs::read_to_string(file_path)?;
        Ok(content)
    }

    pub fn write_file(file_path: &str, content: &str) -> Result<()> {
        if let Some(parent) = Path::new(file_path).parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(file_path, content)?;
        Ok(())
    }

    pub fn search_files(dir_path: &str, query: &str) -> Result<Vec<Value>> {
        let mut results = Vec::new();
        let query_lower = query.to_lowercase();
        for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            let path_str = path.to_string_lossy();
            if path_str.contains("/node_modules/") || path_str.contains("/target/") || path_str.contains("/.git/") {
                continue;
            }
            if path.is_file() {
                if let Some(filename) = path.file_name() {
                    if filename.to_string_lossy().to_lowercase().contains(&query_lower) {
                        results.push(json!({
                            "name": filename.to_string_lossy(),
                            "path": path_str,
                        }));
                        if results.len() >= 50 {
                            break;
                        }
                    }
                }
            }
        }
        Ok(results)
    }
}
