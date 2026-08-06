use anyhow::Result;
use std::process::Command;
use tracing::info;

pub struct GitManager;

impl GitManager {
    pub fn get_status(repo_path: &str) -> Result<serde_json::Value> {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("status")
            .arg("--porcelain")
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut files = Vec::new();
        for line in stdout.lines() {
            if line.len() >= 3 {
                let status_code = &line[..2];
                let file_path = line[3..].trim();
                files.push(serde_json::json!({
                    "path": file_path,
                    "status": status_code.trim(),
                }));
            }
        }

        let branch_output = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("rev-parse")
            .arg("--abbrev-ref")
            .arg("HEAD")
            .output()?;
        let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();

        Ok(serde_json::json!({
            "branch": branch,
            "modified_files": files,
            "clean": files.is_empty(),
        }))
    }

    pub fn get_diff(repo_path: &str, file_path: Option<&str>) -> Result<String> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(repo_path).arg("diff");
        if let Some(f) = file_path {
            cmd.arg(f);
        }
        let output = cmd.output()?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    pub fn get_log(repo_path: &str, limit: usize) -> Result<Vec<serde_json::Value>> {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("log")
            .arg(format!("-n{}", limit))
            .arg("--pretty=format:%H|%an|%s|%cr")
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut commits = Vec::new();
        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() == 4 {
                commits.push(serde_json::json!({
                    "hash": parts[0],
                    "author": parts[1],
                    "message": parts[2],
                    "time": parts[3],
                }));
            }
        }
        Ok(commits)
    }

    pub fn stage_file(repo_path: &str, file_path: &str) -> Result<()> {
        Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("add")
            .arg(file_path)
            .status()?;
        Ok(())
    }

    pub fn commit(repo_path: &str, message: &str) -> Result<()> {
        Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("commit")
            .arg("-m")
            .arg(message)
            .status()?;
        Ok(())
    }

    pub fn create_floor_worktree(repo_path: &str, floor_name: &str, branch_name: &str) -> Result<String> {
        let target_dir = format!("{}/.floors/{}", repo_path, floor_name);
        info!("Creating git worktree floor at {} for branch {}", target_dir, branch_name);
        
        let output = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("worktree")
            .arg("add")
            .arg("-b")
            .arg(branch_name)
            .arg(&target_dir)
            .output()?;

        if !output.status.success() {
            // Fallback if branch exists: checkout existing
            Command::new("git")
                .arg("-C")
                .arg(repo_path)
                .arg("worktree")
                .arg("add")
                .arg(&target_dir)
                .arg(branch_name)
                .output()?;
        }

        Ok(target_dir)
    }

    pub fn list_worktrees(repo_path: &str) -> Result<Vec<serde_json::Value>> {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("worktree")
            .arg("list")
            .arg("--porcelain")
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut worktrees = Vec::new();
        let mut current_path = String::new();
        let mut current_branch = String::new();

        for line in stdout.lines() {
            if line.starts_with("worktree ") {
                current_path = line[9..].to_string();
            } else if line.starts_with("branch ") {
                current_branch = line[7..].trim_start_matches("refs/heads/").to_string();
                worktrees.push(serde_json::json!({
                    "path": current_path.clone(),
                    "branch": current_branch.clone(),
                }));
            }
        }

        Ok(worktrees)
    }
}
