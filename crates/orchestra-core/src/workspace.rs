use anyhow::Result;
use serde_json::{json, Value};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;

pub struct WorkspaceManager;

impl WorkspaceManager {
    pub fn canonical_root(root: &str) -> Result<PathBuf> {
        let path = Path::new(root);
        if !path.is_dir() {
            return Err(anyhow::anyhow!(
                "Workspace root is not a directory: {}",
                root
            ));
        }
        Ok(fs::canonicalize(path)?)
    }

    /// Resolve a user supplied path without allowing `..` or symlinks to
    /// escape the selected workspace. Existing paths are fully canonicalized;
    /// for a new file, the parent is canonicalized before the final segment is
    /// appended.
    pub fn secure_path(root: &str, requested: &str, allow_missing: bool) -> Result<PathBuf> {
        let root = Self::canonical_root(root)?;
        let requested_path = Path::new(requested);
        let candidate = if requested_path.is_absolute() {
            requested_path.to_path_buf()
        } else {
            root.join(requested_path)
        };

        let resolved = if candidate.exists() {
            fs::canonicalize(&candidate)?
        } else if allow_missing {
            let parent = candidate
                .parent()
                .ok_or_else(|| anyhow::anyhow!("Path has no parent"))?;
            let parent = fs::canonicalize(parent)?;
            parent.join(
                candidate
                    .file_name()
                    .ok_or_else(|| anyhow::anyhow!("Invalid path"))?,
            )
        } else {
            return Err(anyhow::anyhow!(
                "Path does not exist: {}",
                candidate.display()
            ));
        };

        if resolved != root && !resolved.starts_with(&root) {
            return Err(anyhow::anyhow!("Path is outside the workspace"));
        }
        Ok(resolved)
    }

    pub fn read_dir_tree(dir_path: &str, depth_limit: usize) -> Result<Value> {
        let root = Path::new(dir_path);
        if !root.is_dir() {
            return Err(anyhow::anyhow!("Path is not a directory: {}", dir_path));
        }
        Self::build_tree(root, 0, depth_limit)
    }

    fn build_tree(path: &Path, current_depth: usize, max_depth: usize) -> Result<Value> {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let is_dir = path.is_dir();

        if is_dir {
            let mut children = Vec::new();
            if current_depth < max_depth {
                if let Ok(entries) = fs::read_dir(path) {
                    for entry in entries.flatten() {
                        let child_path = entry.path();
                        if entry
                            .file_type()
                            .map(|kind| kind.is_symlink())
                            .unwrap_or(true)
                        {
                            continue;
                        }
                        let child_name =
                            child_path.file_name().unwrap_or_default().to_string_lossy();
                        if child_name.starts_with('.') && child_name != ".floors" {
                            continue; // Skip hidden dirs by default except .floors
                        }
                        if child_name == "node_modules"
                            || child_name == "target"
                            || child_name == "dist"
                        {
                            continue;
                        }
                        if let Ok(child_val) =
                            Self::build_tree(&child_path, current_depth + 1, max_depth)
                        {
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
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
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
        let path = Path::new(file_path);
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("File has no parent directory"))?;
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(
            ".{}.orchestra-{}.tmp",
            path.file_name().unwrap_or_default().to_string_lossy(),
            Uuid::new_v4()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    }

    pub fn create_file(file_path: &str) -> Result<()> {
        if Path::new(file_path).exists() {
            return Err(anyhow::anyhow!("Path already exists"));
        }
        Self::write_file(file_path, "")
    }

    pub fn create_directory(dir_path: &str) -> Result<()> {
        if Path::new(dir_path).exists() {
            return Err(anyhow::anyhow!("Path already exists"));
        }
        fs::create_dir_all(dir_path)?;
        Ok(())
    }

    pub fn rename(source: &str, target: &str) -> Result<()> {
        if Path::new(target).exists() {
            return Err(anyhow::anyhow!("Target path already exists"));
        }
        fs::rename(source, target)?;
        Ok(())
    }

    pub fn delete(path: &str) -> Result<()> {
        let target = Path::new(path);
        if target.is_dir() {
            fs::remove_dir_all(target)?;
        } else {
            fs::remove_file(target)?;
        }
        Ok(())
    }

    pub fn search_files(dir_path: &str, query: &str) -> Result<Vec<Value>> {
        let mut results = Vec::new();
        let query_lower = query.to_lowercase();
        for entry in WalkDir::new(dir_path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            let path_str = path.to_string_lossy();
            if path_str.contains("/node_modules/")
                || path_str.contains("/target/")
                || path_str.contains("/.git/")
            {
                continue;
            }
            if path.is_file() {
                if let Some(filename) = path.file_name() {
                    if filename
                        .to_string_lossy()
                        .to_lowercase()
                        .contains(&query_lower)
                    {
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

    pub fn search_content(dir_path: &str, query: &str) -> Result<Vec<Value>> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for entry in WalkDir::new(dir_path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            let path_str = path.to_string_lossy();
            if !path.is_file()
                || path_str.contains("/node_modules/")
                || path_str.contains("/target/")
                || path_str.contains("/.git/")
                || path_str.contains("/.orchestra/terminals/")
            {
                continue;
            }
            let Ok(bytes) = fs::read(path) else { continue };
            if bytes.contains(&0u8) {
                continue;
            }
            let Ok(content) = String::from_utf8(bytes) else {
                continue;
            };
            for (index, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    results.push(json!({
                        "name": path.file_name().unwrap_or_default().to_string_lossy(),
                        "path": path_str,
                        "line": index + 1,
                        "snippet": line.trim().chars().take(300).collect::<String>()
                    }));
                    if results.len() >= 100 {
                        return Ok(results);
                    }
                }
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspaceManager;
    use std::fs;
    use std::path::PathBuf;

    fn temp_workspace() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("orchestra-workspace-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create temporary workspace");
        path
    }

    #[test]
    fn rejects_escape_and_symlink_paths() {
        let root = temp_workspace();
        let outside = root
            .parent()
            .expect("temp parent")
            .join(format!("orchestra-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&outside).expect("create outside dir");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link")).expect("create symlink");

        assert!(WorkspaceManager::secure_path(&root.to_string_lossy(), "../", false).is_err());
        assert!(
            WorkspaceManager::secure_path(&root.to_string_lossy(), "link/file.txt", true).is_err()
        );
        assert!(WorkspaceManager::secure_path(&root.to_string_lossy(), "new.txt", true).is_ok());

        fs::remove_dir_all(&root).expect("remove workspace");
        fs::remove_dir_all(&outside).expect("remove outside");
    }

    #[test]
    fn writes_files_atomically_and_reads_them_back() {
        let root = temp_workspace();
        let file = root.join("notes").join("note.md");
        WorkspaceManager::write_file(&file.to_string_lossy(), "versão íntegra").expect("write");
        assert_eq!(
            WorkspaceManager::read_file(&file.to_string_lossy()).expect("read"),
            "versão íntegra"
        );
        assert!(!root
            .join("notes")
            .read_dir()
            .expect("read dir")
            .any(|entry| {
                entry
                    .map(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                    .unwrap_or(false)
            }));
        fs::remove_dir_all(&root).expect("remove workspace");
    }

    #[test]
    fn searches_real_file_content_without_following_build_or_git_trees() {
        let root = temp_workspace();
        fs::write(root.join("source.ts"), "const orchestraReady = true;\n").expect("write source");
        let results = WorkspaceManager::search_content(&root.to_string_lossy(), "orchestraReady")
            .expect("search content");
        assert_eq!(results[0]["line"], 1);
        assert_eq!(results[0]["name"], "source.ts");
        fs::remove_dir_all(&root).expect("remove workspace");
    }
}
