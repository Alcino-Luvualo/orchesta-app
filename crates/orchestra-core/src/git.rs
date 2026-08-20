use anyhow::{anyhow, Result};
use std::path::{Component, Path};
use std::process::{Command, Output};
use tracing::info;

pub struct GitManager;

fn run_git(repo_path: &str, args: &[&str]) -> Result<Output> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!(
            "git {} failed: {}",
            args.join(" "),
            if details.is_empty() {
                "unknown error"
            } else {
                &details
            }
        ));
    }
    Ok(output)
}

fn run_git_owned(repo_path: &str, args: &[String]) -> Result<Output> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!(
            "git {} failed: {}",
            args.join(" "),
            if details.is_empty() {
                "unknown error"
            } else {
                &details
            }
        ));
    }
    Ok(output)
}

fn output_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn validate_ref_name(value: &str, label: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.starts_with('-')
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(anyhow!("Invalid {label}"));
    }
    let check = Command::new("git")
        .args(["check-ref-format", "--branch", value])
        .output()?;
    if !check.status.success() {
        return Err(anyhow!("Invalid {label}: {}", value));
    }
    Ok(())
}

fn validate_remote(value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.starts_with('-')
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(anyhow!("Invalid remote"));
    }
    Ok(())
}

fn validate_path(repo_path: &str, file_path: &str) -> Result<String> {
    let supplied = Path::new(file_path);
    let relative = if supplied.is_absolute() {
        supplied
            .strip_prefix(Path::new(repo_path))
            .map_err(|_| anyhow!("Git path is outside the repository"))?
    } else {
        supplied
    };
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(anyhow!("Invalid Git path"));
    }
    let value = relative
        .to_str()
        .ok_or_else(|| anyhow!("Git path is not valid UTF-8"))?;
    if value == "." || value.is_empty() {
        return Ok(".".to_string());
    }
    if value.starts_with('-') || value.contains('\0') {
        return Err(anyhow!("Invalid Git path"));
    }
    Ok(value.to_string())
}

fn resolve_commit_hash(repo_path: &str, value: &str) -> Result<String> {
    if !(4..=64).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(anyhow!("Invalid commit hash"));
    }
    let revision = format!("{value}^{{commit}}");
    let output = run_git(repo_path, &["rev-parse", "--verify", &revision])?;
    let resolved = output_text(&output).trim().to_ascii_lowercase();
    if !(40..=64).contains(&resolved.len())
        || !resolved.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(anyhow!("Git did not resolve a valid commit hash"));
    }
    Ok(resolved)
}

fn bounded_text(output: &Output, limit: usize) -> (String, bool) {
    let text = String::from_utf8_lossy(&output.stdout);
    if text.len() <= limit {
        return (text.into_owned(), false);
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (
        format!("{}\n\n[diff truncated by Orchestra]\n", &text[..end]),
        true,
    )
}

impl GitManager {
    pub fn get_status(repo_path: &str) -> Result<serde_json::Value> {
        let output = run_git(repo_path, &["status", "--porcelain=v2", "-z"])?;
        let raw = String::from_utf8_lossy(&output.stdout);
        let mut files = Vec::new();
        let mut records = raw.split('\0').filter(|record| !record.is_empty());
        while let Some(record) = records.next() {
            match record.as_bytes().first().copied() {
                Some(b'1') => {
                    let fields = record.splitn(9, ' ').collect::<Vec<_>>();
                    if fields.len() == 9 {
                        files.push(serde_json::json!({ "path": fields[8], "status": fields[1] }));
                    }
                }
                Some(b'2') => {
                    let fields = record.splitn(10, ' ').collect::<Vec<_>>();
                    if fields.len() == 10 {
                        let original = records.next().unwrap_or("");
                        files.push(serde_json::json!({ "path": fields[9], "originalPath": original, "status": fields[1] }));
                    }
                }
                Some(b'u') => {
                    let fields = record.splitn(11, ' ').collect::<Vec<_>>();
                    if fields.len() == 11 {
                        files.push(serde_json::json!({ "path": fields[10], "status": fields[1], "conflict": true }));
                    }
                }
                Some(b'?') => files.push(serde_json::json!({ "path": record.strip_prefix("? ").unwrap_or(""), "status": "??" })),
                _ => {}
            }
        }

        let branch_output = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(["symbolic-ref", "--short", "-q", "HEAD"])
            .output()?;
        let branch = if branch_output.status.success() {
            output_text(&branch_output).trim().to_string()
        } else {
            output_text(&run_git(repo_path, &["rev-parse", "--short", "HEAD"])?)
                .trim()
                .to_string()
        };

        let (ahead, behind) = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                let values = output_text(&output)
                    .split_whitespace()
                    .map(str::parse::<u64>)
                    .collect::<Result<Vec<_>, _>>()
                    .ok()?;
                // `upstream...HEAD` reports behind first and ahead second.
                Some((
                    values.get(1).copied().unwrap_or(0),
                    values.first().copied().unwrap_or(0),
                ))
            })
            .unwrap_or((0, 0));

        Ok(serde_json::json!({
            "branch": branch,
            "modified_files": files,
            "clean": files.is_empty(),
            "ahead": ahead,
            "behind": behind
        }))
    }

    pub fn get_diff(repo_path: &str, file_path: Option<&str>) -> Result<String> {
        let mut args = vec!["diff", "--no-ext-diff", "--"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        if let Some(file) = file_path {
            args.push(validate_path(repo_path, file)?);
        }
        Ok(output_text(&run_git_owned(repo_path, &args)?))
    }

    pub fn get_staged_diff(repo_path: &str, file_path: Option<&str>) -> Result<String> {
        let mut args = vec!["diff", "--cached", "--no-ext-diff", "--"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        if let Some(file) = file_path {
            args.push(validate_path(repo_path, file)?);
        }
        Ok(output_text(&run_git_owned(repo_path, &args)?))
    }

    pub fn get_log(repo_path: &str, limit: usize) -> Result<Vec<serde_json::Value>> {
        let limit_arg = format!("-n{}", limit.clamp(1, 1000));
        let output = run_git(
            repo_path,
            &[
                "log",
                "--all",
                &limit_arg,
                "--date=iso-strict",
                "--pretty=format:%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x1e",
            ],
        )?;
        let raw = String::from_utf8_lossy(&output.stdout);
        let mut commits = Vec::new();
        for record in raw
            .split('\u{1e}')
            .filter(|record| !record.trim().is_empty())
        {
            let parts = record.split('\0').collect::<Vec<_>>();
            if parts.len() < 6 {
                continue;
            }
            let refs = parts[5]
                .split(", ")
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            commits.push(serde_json::json!({
                "hash": parts[0],
                "parents": parts[1].split_whitespace().filter(|value| !value.is_empty()).collect::<Vec<_>>(),
                "author": parts[2],
                "time": parts[3],
                "message": parts[4],
                "refs": refs
            }));
        }
        Ok(commits)
    }

    pub fn show_commit(
        repo_path: &str,
        commit_hash: &str,
        paths: &[String],
    ) -> Result<serde_json::Value> {
        let hash = resolve_commit_hash(repo_path, commit_hash)?;
        let safe_paths = paths
            .iter()
            .map(|path| validate_path(repo_path, path))
            .collect::<Result<Vec<_>>>()?;

        let mut names = vec![
            "diff-tree".to_string(),
            "--root".to_string(),
            "--first-parent".to_string(),
            "-m".to_string(),
            "--no-commit-id".to_string(),
            "--name-status".to_string(),
            "-z".to_string(),
            "-r".to_string(),
            "-M".to_string(),
            hash.clone(),
            "--".to_string(),
        ];
        names.extend(safe_paths.iter().cloned());
        let names_output = run_git_owned(repo_path, &names)?;
        let mut tokens = names_output.stdout.split(|byte| *byte == 0);
        let mut files = Vec::new();
        loop {
            let Some(status_bytes) = tokens.next() else {
                break;
            };
            if status_bytes.is_empty() {
                continue;
            }
            let status = String::from_utf8_lossy(status_bytes).to_string();
            let Some(first_path) = tokens.next().filter(|value| !value.is_empty()) else {
                break;
            };
            let first_path = String::from_utf8_lossy(first_path).to_string();
            if status.starts_with('R') || status.starts_with('C') {
                let Some(next_path) = tokens.next().filter(|value| !value.is_empty()) else {
                    break;
                };
                files.push(serde_json::json!({
                    "status": status,
                    "originalPath": first_path,
                    "path": String::from_utf8_lossy(next_path)
                }));
            } else {
                files.push(serde_json::json!({ "status": status, "path": first_path }));
            }
        }

        let mut patch = vec![
            "show".to_string(),
            "--format=".to_string(),
            "--no-ext-diff".to_string(),
            "--no-color".to_string(),
            "--find-renames".to_string(),
            "--first-parent".to_string(),
            "-m".to_string(),
            "--root".to_string(),
            hash.clone(),
            "--".to_string(),
        ];
        patch.extend(safe_paths);
        let patch_output = run_git_owned(repo_path, &patch)?;
        let (diff, truncated) = bounded_text(&patch_output, 4 * 1024 * 1024);
        Ok(serde_json::json!({
            "hash": hash,
            "files": files,
            "diff": diff,
            "truncated": truncated
        }))
    }

    pub fn stage_file(repo_path: &str, file_path: &str) -> Result<()> {
        let relative = validate_path(repo_path, file_path)?;
        run_git(repo_path, &["add", "--", &relative])?;
        Ok(())
    }

    pub fn unstage_file(repo_path: &str, file_path: &str) -> Result<()> {
        let relative = validate_path(repo_path, file_path)?;
        run_git(repo_path, &["restore", "--staged", "--", &relative])?;
        Ok(())
    }

    pub fn commit(repo_path: &str, message: &str) -> Result<()> {
        Self::commit_with_options(repo_path, message, false, false)
    }

    pub fn commit_with_options(
        repo_path: &str,
        message: &str,
        amend: bool,
        sign: bool,
    ) -> Result<()> {
        if message.trim().is_empty() {
            return Err(anyhow!("Commit message is required"));
        }
        let mut args = vec!["commit"];
        if amend {
            args.push("--amend");
        }
        if sign {
            args.push("-S");
        }
        args.extend(["-m", message]);
        run_git(repo_path, &args)?;
        Ok(())
    }

    pub fn refs(repo_path: &str) -> Result<serde_json::Value> {
        let output = run_git(
            repo_path,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream:short)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
            ],
        )?;
        let refs = output_text(&output)
            .lines()
            .filter_map(|line| {
                let parts = line.split('\0').collect::<Vec<_>>();
                let full = parts.first()?.strip_prefix("refs/")?;
                let object = parts.get(1).copied().unwrap_or_default();
                let kind = if full.starts_with("heads/") {
                    "local"
                } else if full.starts_with("remotes/") {
                    "remote"
                } else {
                    "tag"
                };
                let name = full
                    .strip_prefix("heads/")
                    .or_else(|| full.strip_prefix("remotes/"))
                    .or_else(|| full.strip_prefix("tags/"))
                    .unwrap_or(full);
                Some(serde_json::json!({
                    "name": name,
                    "fullName": format!("refs/{full}"),
                    "kind": kind,
                    "hash": object,
                    "upstream": parts.get(3).copied().filter(|value| !value.is_empty())
                }))
            })
            .collect::<Vec<_>>();
        let head = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(["symbolic-ref", "--short", "-q", "HEAD"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| output_text(&output).trim().to_string());
        Ok(serde_json::json!({ "head": head, "refs": refs }))
    }

    pub fn blame(repo_path: &str, file_path: &str) -> Result<Vec<serde_json::Value>> {
        let relative = validate_path(repo_path, file_path)?;
        let output = run_git(repo_path, &["blame", "--line-porcelain", "--", &relative])?;
        let mut lines = Vec::new();
        let mut current = serde_json::Map::new();
        for raw in output_text(&output).lines() {
            if raw.starts_with('\t') {
                current.insert("content".to_string(), serde_json::json!(&raw[1..]));
                current.insert("line".to_string(), serde_json::json!(lines.len() + 1));
                lines.push(serde_json::Value::Object(current));
                current = serde_json::Map::new();
            } else if raw.len() >= 40
                && raw.as_bytes()[0].is_ascii_hexdigit()
                && raw[..40].chars().all(|c| c.is_ascii_hexdigit())
            {
                current.insert("commit".to_string(), serde_json::json!(&raw[..40]));
            } else if let Some(value) = raw.strip_prefix("author ") {
                current.insert("author".to_string(), serde_json::json!(value));
            } else if let Some(value) = raw.strip_prefix("author-time ") {
                current.insert("authorTime".to_string(), serde_json::json!(value));
            } else if let Some(value) = raw.strip_prefix("summary ") {
                current.insert("summary".to_string(), serde_json::json!(value));
            }
        }
        Ok(lines)
    }

    pub fn stash_list(repo_path: &str) -> Result<Vec<serde_json::Value>> {
        let output = run_git(repo_path, &["stash", "list", "--format=%gd%x00%H%x00%s"])?;
        Ok(output_text(&output)
            .lines()
            .filter_map(|line| {
                let parts = line.split('\0').collect::<Vec<_>>();
                Some(serde_json::json!({
                    "name": parts.first()?,
                    "hash": parts.get(1)?,
                    "message": parts.get(2)?
                }))
            })
            .collect())
    }

    pub fn stash_push(
        repo_path: &str,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<()> {
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
            args.extend(["-m", message]);
        }
        run_git(repo_path, &args)?;
        Ok(())
    }

    pub fn stash_action(repo_path: &str, action: &str, name: &str) -> Result<()> {
        if !matches!(action, "apply" | "pop" | "drop") {
            return Err(anyhow!("Invalid stash action"));
        }
        if name.trim().is_empty() || name.starts_with('-') || name.chars().any(|c| c.is_control()) {
            return Err(anyhow!("Invalid stash name"));
        }
        run_git(repo_path, &["stash", action, name])?;
        Ok(())
    }

    pub fn branch_list(repo_path: &str) -> Result<Vec<serde_json::Value>> {
        let output = run_git(
            repo_path,
            &[
                "for-each-ref",
                "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)",
                "refs/heads",
            ],
        )?;
        Ok(output_text(&output)
            .lines()
            .filter_map(|line| {
                let parts = line.split('\0').collect::<Vec<_>>();
                Some(serde_json::json!({
                    "name": parts.first()?,
                    "hash": parts.get(1)?,
                    "current": parts.get(2).is_some_and(|value| *value == "*"),
                    "upstream": parts.get(3).copied().filter(|value| !value.is_empty())
                }))
            })
            .collect())
    }

    pub fn branch_create(
        repo_path: &str,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<()> {
        validate_ref_name(name, "branch name")?;
        let start = start_point.unwrap_or("HEAD");
        if start.starts_with('-') || start.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(anyhow!("Invalid branch start point"));
        }
        if checkout {
            run_git(repo_path, &["switch", "-c", name, start])?;
        } else {
            run_git(repo_path, &["branch", name, start])?;
        }
        Ok(())
    }

    pub fn branch_checkout(repo_path: &str, name: &str) -> Result<()> {
        validate_ref_name(name, "branch name")?;
        run_git(repo_path, &["switch", name])?;
        Ok(())
    }

    pub fn branch_rename(repo_path: &str, old: &str, new: &str) -> Result<()> {
        validate_ref_name(old, "branch name")?;
        validate_ref_name(new, "branch name")?;
        run_git(repo_path, &["branch", "-m", old, new])?;
        Ok(())
    }

    pub fn branch_delete(repo_path: &str, name: &str, force: bool, confirm: bool) -> Result<()> {
        validate_ref_name(name, "branch name")?;
        if (force || name == "main" || name == "master") && !confirm {
            return Err(anyhow!(
                "Confirmation is required for destructive branch deletion"
            ));
        }
        run_git(
            repo_path,
            &["branch", if force { "-D" } else { "-d" }, name],
        )?;
        Ok(())
    }

    pub fn tag(
        repo_path: &str,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
    ) -> Result<()> {
        validate_ref_name(name, "tag name")?;
        let mut args = vec!["tag"];
        if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
            args.extend(["-a", name, "-m", message]);
        } else {
            args.push(name);
        }
        if let Some(target) = target.filter(|value| !value.trim().is_empty()) {
            if target.starts_with('-')
                || target.chars().any(|c| c.is_control() || c.is_whitespace())
            {
                return Err(anyhow!("Invalid tag target"));
            }
            args.push(target);
        }
        run_git(repo_path, &args)?;
        Ok(())
    }

    pub fn tag_delete(repo_path: &str, name: &str, confirm: bool) -> Result<()> {
        validate_ref_name(name, "tag name")?;
        if !confirm {
            return Err(anyhow!("Confirmation is required to delete a tag"));
        }
        run_git(repo_path, &["tag", "-d", name])?;
        Ok(())
    }

    pub fn remote_operation(
        repo_path: &str,
        operation: &str,
        remote: Option<&str>,
        branch: Option<&str>,
        force: bool,
        confirm: bool,
    ) -> Result<()> {
        if !matches!(operation, "fetch" | "pull" | "push") {
            return Err(anyhow!("Invalid remote operation"));
        }
        let remote = remote.unwrap_or("origin");
        validate_remote(remote)?;
        let branch = branch.filter(|value| !value.trim().is_empty());
        if let Some(branch) = branch {
            validate_ref_name(branch, "branch name")?;
        }
        if operation == "push" && force && !confirm {
            return Err(anyhow!("Confirmation is required for force push"));
        }
        let mut args = vec![operation];
        if operation == "fetch" && remote == "--all" {
            args.push("--all");
        } else {
            args.push(remote);
        }
        if operation == "push" {
            if force {
                args.push("--force-with-lease");
            }
            if let Some(branch) = branch {
                args.push(branch);
            }
        } else if operation == "pull" {
            if let Some(branch) = branch {
                args.push(branch);
            }
        }
        run_git(repo_path, &args)?;
        Ok(())
    }

    pub fn history_operation(
        repo_path: &str,
        operation: &str,
        target: &str,
        confirm: bool,
    ) -> Result<()> {
        if !matches!(operation, "merge" | "rebase" | "cherry-pick" | "revert") {
            return Err(anyhow!("Invalid history operation"));
        }
        if target.trim().is_empty()
            || target.starts_with('-')
            || target.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(anyhow!("Invalid history target"));
        }
        if matches!(operation, "rebase" | "cherry-pick" | "revert") && !confirm {
            return Err(anyhow!("Confirmation is required for history mutation"));
        }
        run_git(repo_path, &[operation, target])?;
        Ok(())
    }

    pub fn operation_control(repo_path: &str, operation: &str) -> Result<()> {
        if !matches!(
            operation,
            "merge-abort"
                | "merge-continue"
                | "rebase-abort"
                | "rebase-continue"
                | "cherry-pick-abort"
                | "cherry-pick-continue"
        ) {
            return Err(anyhow!("Invalid operation control"));
        }
        let (command, action) = operation
            .split_once('-')
            .ok_or_else(|| anyhow!("Invalid operation control"))?;
        run_git(repo_path, &[command, action])?;
        Ok(())
    }

    pub fn reset(repo_path: &str, target: &str, mode: &str, confirm: bool) -> Result<()> {
        if !matches!(mode, "soft" | "mixed" | "hard")
            || target.trim().is_empty()
            || target.starts_with('-')
            || target.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(anyhow!("Invalid reset request"));
        }
        if mode == "hard" && !confirm {
            return Err(anyhow!("Confirmation is required for hard reset"));
        }
        run_git(repo_path, &["reset", &format!("--{mode}"), target])?;
        Ok(())
    }

    pub fn create_floor_worktree(
        repo_path: &str,
        floor_name: &str,
        branch_name: &str,
    ) -> Result<String> {
        if floor_name.trim().is_empty() || branch_name.trim().is_empty() {
            return Err(anyhow!("Floor name and branch are required"));
        }
        if floor_name.contains('/')
            || floor_name.contains('\\')
            || floor_name == "."
            || floor_name == ".."
            || branch_name.chars().any(|character| character.is_control())
        {
            return Err(anyhow!("Invalid floor or branch name"));
        }
        let target_dir = Path::new(repo_path).join(".floors").join(floor_name);
        std::fs::create_dir_all(
            target_dir
                .parent()
                .ok_or_else(|| anyhow!("Invalid floors directory"))?,
        )?;
        info!(
            "Creating git worktree floor at {} for branch {}",
            target_dir.display(),
            branch_name
        );
        let first = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(["worktree", "add", "-b", branch_name])
            .arg(&target_dir)
            .output()?;
        if !first.status.success() {
            run_git(
                repo_path,
                &[
                    "worktree",
                    "add",
                    target_dir.to_str().unwrap_or_default(),
                    branch_name,
                ],
            )?;
        }
        Ok(target_dir.to_string_lossy().to_string())
    }

    pub fn list_worktrees(repo_path: &str) -> Result<Vec<serde_json::Value>> {
        let output = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
        let mut worktrees = Vec::new();
        let mut current_path = None::<String>;
        let mut current_branch = None::<String>;
        let mut detached = false;
        let flush = |worktrees: &mut Vec<serde_json::Value>,
                     path: &mut Option<String>,
                     branch: &mut Option<String>,
                     detached: &mut bool| {
            if let Some(path) = path.take() {
                worktrees.push(serde_json::json!({ "path": path, "branch": branch.take().unwrap_or_else(|| if *detached { "(detached)".to_string() } else { "".to_string() }), "detached": *detached }));
            }
            *detached = false;
        };
        for line in output_text(&output).lines() {
            if line.is_empty() {
                flush(
                    &mut worktrees,
                    &mut current_path,
                    &mut current_branch,
                    &mut detached,
                );
            } else if let Some(value) = line.strip_prefix("worktree ") {
                current_path = Some(value.to_string());
            } else if let Some(value) = line.strip_prefix("branch ") {
                current_branch = Some(value.trim_start_matches("refs/heads/").to_string());
            } else if line == "detached" {
                detached = true;
            }
        }
        flush(
            &mut worktrees,
            &mut current_path,
            &mut current_branch,
            &mut detached,
        );
        Ok(worktrees)
    }

    pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<()> {
        let status = Self::get_status(worktree_path)?;
        if !status["clean"].as_bool().unwrap_or(false) {
            return Err(anyhow!(
                "Worktree has uncommitted changes; clean it before removal"
            ));
        }
        run_git(repo_path, &["worktree", "remove", worktree_path])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::GitManager;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    fn run(repo: &PathBuf, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn head(repo: &PathBuf) -> String {
        run(repo, &["rev-parse", "HEAD"])
    }

    fn temp_repo() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("orchestra-git-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create repository");
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&path)
                .args(args)
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Orchestra Test"]);
        fs::write(path.join("README.md"), "initial\n").expect("write file");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "initial"]);
        path
    }

    #[test]
    fn reads_status_diff_log_and_commits_real_git_state() {
        let repo = temp_repo();
        fs::write(repo.join("README.md"), "changed\n").expect("modify file");
        fs::write(repo.join("name with spaces.txt"), "new\n").expect("create spaced file");
        let status = GitManager::get_status(&repo.to_string_lossy()).expect("status");
        assert!(!status["branch"].as_str().unwrap_or_default().is_empty());
        assert!(status["modified_files"]
            .as_array()
            .expect("status files")
            .iter()
            .any(|file| file["path"] == "README.md"));
        assert!(status["modified_files"]
            .as_array()
            .expect("status files")
            .iter()
            .any(|file| file["path"] == "name with spaces.txt"));
        let file_path = repo.join("README.md").to_string_lossy().to_string();
        assert!(
            GitManager::get_diff(&repo.to_string_lossy(), Some(&file_path))
                .expect("diff")
                .contains("changed")
        );
        GitManager::stage_file(&repo.to_string_lossy(), "README.md").expect("stage");
        GitManager::stage_file(&repo.to_string_lossy(), "name with spaces.txt")
            .expect("stage spaced file");
        GitManager::commit(&repo.to_string_lossy(), "change").expect("commit");
        assert!(
            GitManager::get_status(&repo.to_string_lossy()).expect("clean status")["clean"]
                .as_bool()
                .unwrap_or(false)
        );
        assert!(
            GitManager::get_log(&repo.to_string_lossy(), 10)
                .expect("log")
                .len()
                >= 2
        );
        fs::remove_dir_all(repo).expect("remove repository");
    }

    #[test]
    fn creates_isolated_floor_worktree() {
        let repo = temp_repo();
        let worktree = GitManager::create_floor_worktree(
            &repo.to_string_lossy(),
            "floor-test",
            "feature/floor-test",
        )
        .expect("worktree");
        assert!(PathBuf::from(&worktree).join("README.md").is_file());
        assert!(GitManager::list_worktrees(&repo.to_string_lossy())
            .expect("worktrees")
            .iter()
            .any(|item| item["path"] == worktree));
        fs::remove_dir_all(repo).expect("remove repository");
    }

    #[test]
    fn shows_root_normal_rename_binary_empty_and_merge_commits() {
        let repo = temp_repo();
        let repo_string = repo.to_string_lossy().to_string();

        let root = GitManager::show_commit(&repo_string, &head(&repo), &[]).expect("root");
        assert_eq!(root["files"][0]["status"], "A");
        assert_eq!(root["files"][0]["path"], "README.md");
        assert!(root["diff"]
            .as_str()
            .unwrap_or_default()
            .contains("initial"));

        fs::write(repo.join("README.md"), "normal change\n").expect("normal change");
        run(&repo, &["add", "README.md"]);
        run(&repo, &["commit", "-q", "-m", "normal"]);
        let normal = GitManager::show_commit(&repo_string, &head(&repo), &[]).expect("normal");
        assert_eq!(normal["files"][0]["status"], "M");
        assert!(normal["diff"]
            .as_str()
            .unwrap_or_default()
            .contains("normal change"));

        run(&repo, &["mv", "README.md", "renamed.md"]);
        run(&repo, &["commit", "-q", "-m", "rename"]);
        let renamed = GitManager::show_commit(&repo_string, &head(&repo), &[]).expect("rename");
        assert!(renamed["files"].as_array().unwrap().iter().any(|file| {
            file["status"].as_str().unwrap_or_default().starts_with('R')
                && file["originalPath"] == "README.md"
                && file["path"] == "renamed.md"
        }));

        fs::write(repo.join("binary.dat"), [0_u8, 1, 2, 0, 255]).expect("binary");
        run(&repo, &["add", "binary.dat"]);
        run(&repo, &["commit", "-q", "-m", "binary"]);
        let binary = GitManager::show_commit(&repo_string, &head(&repo), &[]).expect("binary");
        assert!(binary["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "binary.dat"));
        assert!(binary["diff"]
            .as_str()
            .unwrap_or_default()
            .contains("Binary files"));

        run(&repo, &["commit", "--allow-empty", "-q", "-m", "empty"]);
        let empty = GitManager::show_commit(&repo_string, &head(&repo), &[]).expect("empty");
        assert!(empty["files"].as_array().unwrap().is_empty());
        assert!(empty["diff"].as_str().unwrap_or_default().is_empty());

        let main_branch = run(&repo, &["symbolic-ref", "--short", "HEAD"]);
        run(&repo, &["switch", "-q", "-c", "feature/show-commit"]);
        fs::write(repo.join("feature.txt"), "feature\n").expect("feature file");
        run(&repo, &["add", "feature.txt"]);
        run(&repo, &["commit", "-q", "-m", "feature"]);
        run(&repo, &["switch", "-q", &main_branch]);
        fs::write(repo.join("main.txt"), "main\n").expect("main file");
        run(&repo, &["add", "main.txt"]);
        run(&repo, &["commit", "-q", "-m", "main"]);
        run(
            &repo,
            &[
                "merge",
                "--no-ff",
                "-q",
                "feature/show-commit",
                "-m",
                "merge",
            ],
        );
        let merge = GitManager::show_commit(&repo_string, &head(&repo), &[]).expect("merge");
        assert!(merge["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "feature.txt"));
        assert!(merge["diff"]
            .as_str()
            .unwrap_or_default()
            .contains("feature"));

        assert!(GitManager::show_commit(&repo_string, "HEAD;touch-pwned", &[]).is_err());
        assert!(
            GitManager::show_commit(&repo_string, &head(&repo), &["../outside".to_string()])
                .is_err()
        );
        fs::remove_dir_all(repo).expect("remove repository");
    }
}
