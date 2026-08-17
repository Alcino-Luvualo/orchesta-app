use crate::shell_integration::{prepare_shell_launch, ShellEvent, ShellIntegrationParser};
use anyhow::Result;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::mpsc;
use tracing::{error, info};

// Keep enough history for long-running agents and large build logs while
// staying below the 8 MiB IPC frame limit when a terminal is reattached
// (base64 encoding adds roughly one third to the raw byte count).
const MAX_SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;
const OUTPUT_QUEUE_CAPACITY: usize = 128;
const ORCHESTRA_SKILL_RELATIVE_PATH: &str = "skills/orchestra-canvas/SKILL.md";
const ORCHESTRA_PLUGIN_RELATIVE_PATH: &str = ".agents/plugins/plugins/orchestra";
const PACKAGED_SKILL_RELATIVE_PATH: &str = "skills/orchestra-canvas/SKILL.md";
const PACKAGED_PLUGIN_RELATIVE_PATH: &str = "plugins/orchestra";

// The packaged app normally resolves these files from its resources
// directory. Keeping the canonical skill embedded in the daemon makes a
// terminal launched from an arbitrary cwd remain useful in development and
// after a package manager relocates the app resources.
const EMBEDDED_ORCHESTRA_SKILL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../skills/orchestra-canvas/SKILL.md"
));

fn normalized_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        // A zero-sized PTY is invalid on POSIX and causes terminal programs
        // to render unpredictably during hidden/rapidly resized views.
        cols: cols.max(1),
        rows: rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub struct PtySession {
    token: String,
    context_dir: PathBuf,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send>>>,
    subscribers: Arc<Mutex<HashMap<String, mpsc::Sender<PtyOutput>>>>,
    output_history: Arc<Mutex<VecDeque<u8>>>,
}

#[derive(Debug, Clone)]
pub struct PtyOutput {
    pub data: Vec<u8>,
    pub events: Vec<ShellEvent>,
}

/// A lossless, bounded PTY output subscription.
///
/// The reader thread blocks only this PTY session when a client cannot accept
/// output quickly enough. That applies real backpressure to the kernel PTY
/// rather than silently dropping chunks (as a bounded broadcast channel would
/// do after a lagging receiver). Other terminal sessions remain independent.
pub struct PtyOutputSubscription {
    receiver: mpsc::Receiver<PtyOutput>,
    manager: PtyManager,
    session_id: String,
    subscription_id: String,
}

impl PtyOutputSubscription {
    pub async fn recv(&mut self) -> Option<PtyOutput> {
        self.receiver.recv().await
    }

    pub fn try_recv(&mut self) -> Option<PtyOutput> {
        self.receiver.try_recv().ok()
    }
}

impl Drop for PtyOutputSubscription {
    fn drop(&mut self) {
        self.manager
            .unsubscribe(&self.session_id, &self.subscription_id);
    }
}

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    exit_codes: Arc<Mutex<HashMap<String, Option<i32>>>>,
    // Notes created through the authenticated core are available immediately,
    // before the renderer's context synchronizer has written connectedNotes to
    // the terminal context file. This remains an in-memory allowlist scoped to
    // the daemon/session; core DB permission checks still gate every request.
    created_notes: Arc<Mutex<HashMap<String, HashSet<String>>>>,
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

fn path_from_env(name: &str, filename: &str) -> Option<PathBuf> {
    let raw = std::env::var_os(name)?;
    let path = PathBuf::from(raw);
    let candidate = if path.is_dir() {
        path.join(filename)
    } else {
        path
    };
    candidate.is_file().then_some(candidate)
}

fn skill_candidates(working_dir: &PathBuf) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = path_from_env("ORCHESTRA_SKILL_PATH", "SKILL.md") {
        candidates.push(path);
    }
    candidates.push(working_dir.join(ORCHESTRA_SKILL_RELATIVE_PATH));
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(ORCHESTRA_SKILL_RELATIVE_PATH));
    }

    // Development: target/{debug,release}/orchestra-core -> repository root.
    // Installed package: resources/bin/orchestra-core -> resources.
    if let Ok(executable) = std::env::current_exe() {
        let mut parent = executable.parent().map(PathBuf::from);
        for _ in 0..4 {
            if let Some(directory) = parent.take() {
                candidates.push(directory.join(ORCHESTRA_SKILL_RELATIVE_PATH));
                parent = directory.parent().map(PathBuf::from);
            } else {
                break;
            }
        }
    }

    // This candidate is present only for development builds; the existence
    // check keeps it harmless for a relocated release binary.
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(ORCHESTRA_SKILL_RELATIVE_PATH));
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../")
            .join(ORCHESTRA_SKILL_RELATIVE_PATH),
    );

    // Electron places extraResources below resources/. Keep this explicit so
    // a packaged daemon does not depend on its current working directory.
    if let Some(resources) = resource_root() {
        candidates.push(resources.join(PACKAGED_SKILL_RELATIVE_PATH));
    }
    candidates
}

fn plugin_candidates(working_dir: &PathBuf) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("ORCHESTRA_PLUGIN_PATH") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            candidates.push(path);
        }
    }
    candidates.push(working_dir.join(ORCHESTRA_PLUGIN_RELATIVE_PATH));
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(ORCHESTRA_PLUGIN_RELATIVE_PATH));
    }
    if let Ok(executable) = std::env::current_exe() {
        let mut parent = executable.parent().map(PathBuf::from);
        for _ in 0..4 {
            if let Some(directory) = parent.take() {
                candidates.push(directory.join("plugins/orchestra"));
                parent = directory.parent().map(PathBuf::from);
            } else {
                break;
            }
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.agents/plugins/plugins/orchestra"),
    );
    if let Some(resources) = resource_root() {
        candidates.push(resources.join(PACKAGED_PLUGIN_RELATIVE_PATH));
    }
    candidates
}

fn resource_root() -> Option<PathBuf> {
    std::env::var_os("ORCHESTRA_RESOURCES_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|executable| executable.parent().map(PathBuf::from))
                .and_then(|bin_dir| bin_dir.parent().map(PathBuf::from))
        })
}

fn resolve_skill_and_plugin(
    working_dir: &PathBuf,
    context_dir: &PathBuf,
) -> Result<(PathBuf, Option<PathBuf>)> {
    let skill_path = skill_candidates(working_dir)
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path));

    let skill_path = if let Some(path) = skill_path {
        path
    } else {
        let embedded_path = context_dir.join("skill/orchestra-canvas/SKILL.md");
        if let Some(parent) = embedded_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&embedded_path, EMBEDDED_ORCHESTRA_SKILL)?;
        embedded_path
    };

    let plugin_path = plugin_candidates(working_dir)
        .into_iter()
        .find(|path| path.join(".codex-plugin/plugin.json").is_file())
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path));
    Ok((skill_path, plugin_path))
}

fn cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("ORCHESTRA_CLI") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join("orchestra"));
        }
    }
    if let Some(resources) = resource_root() {
        candidates.push(resources.join("bin/orchestra"));
    }
    candidates
}

/// npm injects lifecycle metadata into every process launched from an npm
/// script. `npm_config_prefix` is especially harmful here: nvm treats it as a
/// conflicting global prefix and can rewrite the login shell's PATH, hiding
/// otherwise installed CLIs. Keep user registry/auth/config variables intact,
/// but remove process-local lifecycle/prefix state from a new terminal.
///
/// The list contains the canonical spellings for documentation and tests. The
/// predicate below is case-insensitive because nvm scans the whole environment
/// with `toupper()` and therefore rejects mixed-case variants too.
const SHELL_ENV_REMOVE: &[&str] = &[
    "PREFIX",
    "npm_config_prefix",
    "npm_config_global_prefix",
    "npm_config_local_prefix",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_execpath",
    "npm_node_execpath",
    "npm_package_json",
    "npm_package_name",
    "npm_package_version",
    "npm_command",
];

const PROTECTED_ENV: &[&str] = &[
    "ORCHESTRA",
    "ORCHESTRA_SESSION_ID",
    "ORCHESTRA_TERMINAL_ID",
    "ORCHESTRA_TOKEN",
    "ORCHESTRA_SOCKET",
    "ORCHESTRA_PORTAL_SOCKET",
    "ORCHESTRA_CONTEXT_DIR",
    "ORCHESTRA_WORKSPACE_DIR",
    "ORCHESTRA_BOOTSTRAP_FILE",
    "ORCHESTRA_CLI",
    // The packaged skill/plugin resolver is daemon-owned. A terminal request
    // may customise ordinary process variables, but it must not redirect the
    // resource root and silently launch a different skill or plugin tree.
    "ORCHESTRA_RESOURCES_DIR",
    "ORCHESTRA_SKILL_PATH",
    "ORCHESTRA_PLUGIN_PATH",
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "CLICOLOR",
    "FORCE_COLOR",
    "NO_COLOR",
    "PATH",
];

fn is_npm_process_environment(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    SHELL_ENV_REMOVE
        .iter()
        .any(|candidate| normalized == candidate.to_ascii_lowercase())
        || normalized.starts_with("npm_lifecycle_")
        || normalized.starts_with("npm_package_")
}

fn is_protected_environment(key: &str) -> bool {
    is_npm_process_environment(key)
        || PROTECTED_ENV
            .iter()
            .any(|candidate| key.eq_ignore_ascii_case(candidate))
}

fn sanitize_shell_environment(cmd: &mut CommandBuilder) {
    // CommandBuilder starts with a snapshot of the daemon's environment. Walk
    // that snapshot's source so arbitrary case variants (for example
    // `Npm_Config_Prefix`) are removed rather than only the two usual spellings.
    for (key, _) in std::env::vars_os() {
        if let Some(key) = key.to_str() {
            if is_npm_process_environment(key) {
                cmd.env_remove(&key);
            }
        }
    }
    // Keep this explicit for environments whose key cannot be represented as
    // UTF-8, and for the canonical names even when they were not inherited.
    for key in SHELL_ENV_REMOVE {
        cmd.env_remove(key);
        cmd.env_remove(key.to_ascii_uppercase());
    }
}

fn inherited_shell_path() -> Option<String> {
    let mut paths = Vec::new();

    // nvm exports NVM_BIN after selecting a Node version. Prepending this
    // directory gives shells a useful fallback even when an Electron/npm
    // launcher supplied a PATH that omitted the selected version. The path is
    // taken from the environment and is only used when it is an existing
    // directory; no user-specific or version-specific path is hardcoded.
    if let Some(nvm_bin) = std::env::var_os("NVM_BIN")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
    {
        paths.push(nvm_bin);
    }

    if let Some(existing) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&existing) {
            if !paths.iter().any(|entry| entry == &path) {
                paths.push(path);
            }
        }
    }

    std::env::join_paths(paths)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
}

fn configured_portal_socket(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Keep the terminal's portal endpoint coupled to the daemon endpoint when
/// Electron did not explicitly provide one. The desktop uses the same
/// `<core-socket>.portal.sock` convention; deriving it here prevents a PTY
/// launched by a standalone core from falling back to the historical shared
/// `/tmp/portal.sock` endpoint.
fn derived_portal_socket_path(core_socket: &str) -> String {
    let raw = PathBuf::from(core_socket);
    let absolute = if raw.is_absolute() {
        raw
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(&raw))
            .unwrap_or(raw)
    };
    let value = absolute.to_string_lossy();
    value
        .strip_suffix(".sock")
        .map(|prefix| format!("{prefix}.portal.sock"))
        .unwrap_or_else(|| format!("{value}.portal.sock"))
}

fn orchestra_bootstrap(context_dir: &PathBuf, skill_path: &str) -> String {
    format!(
        "# Orchestra context (silent bootstrap)\n\
The connected-terminal context is available through the injected environment and CLI.\n\
Before acting, inspect the current context with: orchestra doctor; orchestra connections; orchestra agents.\n\
Use only nodes returned by orchestra connections and only their granted permissions. For every interactive terminal: read `orchestra terminal screen <id> --plain`, classify the visible state, act intentionally, then inspect or wait for a visible result. `inputWritten` is not proof that an agent processed input.\n\
Read the Orchestra skill at {skill_path}. The generated local bootstrap context is at {context_file}. Never print ORCHESTRA_TOKEN.",
        skill_path = skill_path,
        context_file = context_dir.join("bootstrap.md").display()
    )
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            exit_codes: Arc::new(Mutex::new(HashMap::new())),
            created_notes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn_terminal(
        &self,
        session_id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        env_vars: Option<HashMap<String, String>>,
        command_line: Option<String>,
    ) -> Result<(PtyOutputSubscription, String)> {
        if self.sessions.lock().unwrap().contains_key(&session_id) {
            return Err(anyhow::anyhow!(
                "Terminal already exists; attach using its terminal token"
            ));
        }
        self.created_notes.lock().unwrap().remove(&session_id);

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(normalized_size(cols, rows))?;

        let shell = std::env::var("ORCHESTRA_SHELL")
            .or_else(|_| std::env::var("SHELL"))
            .ok()
            .filter(|path| std::path::Path::new(path).is_file())
            .or_else(|| {
                ["/usr/bin/zsh", "/bin/zsh", "/usr/bin/bash", "/bin/bash"]
                    .into_iter()
                    .find(|path| std::path::Path::new(path).is_file())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "/bin/sh".to_string());

        let mut cmd = CommandBuilder::new(shell.clone());
        sanitize_shell_environment(&mut cmd);
        cmd.env("TERM", "xterm-256color");
        // Keep interactive agents and TUIs on the same color-capable
        // contract as a normal modern terminal. Some launch environments
        // inherit NO_COLOR or advertise only a basic terminal, which makes
        // Codex/agy intentionally fall back to monochrome output.
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Orchestra");
        cmd.env("TERM_PROGRAM_VERSION", "1");
        cmd.env("CLICOLOR", "1");
        cmd.env("FORCE_COLOR", "1");
        cmd.env_remove("NO_COLOR");

        let command_line = command_line.filter(|value| !value.trim().is_empty());
        if let Some(command_line) = command_line.as_ref() {
            if command_line.len() > 16 * 1024
                || command_line.chars().any(|character| character == '\0')
            {
                return Err(anyhow::anyhow!("Terminal command is invalid or too large"));
            }
        }

        // Inject Orchestra environment variables
        let token = uuid::Uuid::new_v4().to_string();
        cmd.env("ORCHESTRA_SESSION_ID", &session_id);
        cmd.env("ORCHESTRA_TERMINAL_ID", &session_id);
        cmd.env("ORCHESTRA_TOKEN", &token);
        cmd.env("ORCHESTRA", "1");
        let socket_path = std::env::var("ORCHESTRA_SOCKET")
            .or_else(|_| {
                std::env::var("XDG_RUNTIME_DIR")
                    .map(|dir| format!("{}/orchestra/orchestra.sock", dir))
            })
            .unwrap_or_else(|_| "/tmp/orchestra.sock".to_string());
        cmd.env("ORCHESTRA_SOCKET", &socket_path);
        // The desktop owns one portal control socket per app/core instance.
        // Propagate that exact path into every PTY so `orchestra browser`
        // never falls back to the shared /tmp/portal.sock when several
        // Orchestra windows are running. The Electron launcher supplies this
        // alongside ORCHESTRA_SOCKET; no guessed path is safe here.
        let portal_socket =
            configured_portal_socket(std::env::var("ORCHESTRA_PORTAL_SOCKET").ok().as_deref())
                .unwrap_or_else(|| derived_portal_socket_path(&socket_path));
        cmd.env("ORCHESTRA_PORTAL_SOCKET", portal_socket);

        let working_dir = resolve_working_dir(cwd.as_deref())?;
        let context_dir = working_dir
            .join(".orchestra")
            .join("terminals")
            .join(&session_id);
        std::fs::create_dir_all(&context_dir)?;
        cmd.env("ORCHESTRA_CONTEXT_DIR", &context_dir);
        cmd.env("ORCHESTRA_WORKSPACE_DIR", &working_dir);
        let (skill_path, plugin_path) = resolve_skill_and_plugin(&working_dir, &context_dir)?;
        let skill_path = skill_path.to_string_lossy().into_owned();
        let bootstrap = orchestra_bootstrap(&context_dir, &skill_path);
        std::fs::write(context_dir.join("bootstrap.md"), &bootstrap)?;
        cmd.env("ORCHESTRA_BOOTSTRAP_FILE", context_dir.join("bootstrap.md"));
        cmd.env("ORCHESTRA_SKILL_PATH", &skill_path);
        if let Some(plugin_path) = plugin_path {
            cmd.env("ORCHESTRA_PLUGIN_PATH", plugin_path);
        }

        if let Some(vars) = env_vars {
            for (key, val) in vars {
                // Caller-provided values must not replace daemon-owned
                // credentials, context, terminal contract, or the sanitized
                // npm environment. All other variables retain the public API's
                // ability to customize a terminal.
                if is_protected_environment(&key) {
                    continue;
                }
                cmd.env(&key, &val);
            }
        }

        // Apply the inherited shell PATH after user-supplied variables so an
        // Electron/npm launcher cannot hide the selected nvm version. The
        // packaged Orchestra CLI is then prepended as well; ORCHESTRA_CLI
        // remains absolute for shells that do not preserve PATH changes.
        let mut shell_path = inherited_shell_path();
        if let Some(cli_path) = cli_candidates().into_iter().find(|path| path.is_file()) {
            cmd.env("ORCHESTRA_CLI", &cli_path);
            let mut paths = vec![cli_path
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| cli_path.clone())];
            if let Some(path) = shell_path.take() {
                paths.extend(std::env::split_paths(std::ffi::OsStr::new(&path)));
            }
            shell_path = std::env::join_paths(paths)
                .ok()
                .map(|value| value.to_string_lossy().into_owned());
        }
        if let Some(path) = shell_path {
            cmd.env("PATH", path);
        }

        cmd.cwd(&working_dir);

        let shell_integration_dir = context_dir.join("shell");
        let shell_launch =
            prepare_shell_launch(std::path::Path::new(&shell), &shell_integration_dir)?;
        for (key, value) in &shell_launch.env {
            cmd.env(key, value);
        }

        // Keep the first visible agent history clean. The old implementation
        // appended the bootstrap markdown as Codex/agy's initial prompt,
        // which made every session start with a noisy Orchestra banner. The
        // same context remains available through ORCHESTRA_BOOTSTRAP_FILE,
        // ORCHESTRA_SKILL_PATH and the authenticated CLI.
        if let Some(command_line) = command_line {
            // The command is deliberately executed by the user's shell so
            // aliases, npm shims and agent launchers behave exactly as they
            // do in a normal terminal.
            let mut shell_args = shell_launch.args;
            shell_args.push("-c".into());
            shell_args.push(command_line);
            cmd.args(shell_args);
        } else {
            cmd.args(shell_launch.args);
        }

        let subscribers: Arc<Mutex<HashMap<String, mpsc::Sender<PtyOutput>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        // Register the first subscriber before the child starts so the shell's
        // initial prompt cannot be lost between spawn and socket subscription.
        let initial_subscription_id = uuid::Uuid::new_v4().to_string();
        let (initial_sender, initial_receiver) = mpsc::channel(OUTPUT_QUEUE_CAPACITY);
        subscribers
            .lock()
            .unwrap()
            .insert(initial_subscription_id.clone(), initial_sender);
        let initial_subscription = PtyOutputSubscription {
            receiver: initial_receiver,
            manager: self.clone(),
            session_id: session_id.clone(),
            subscription_id: initial_subscription_id,
        };

        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                return Err(error.into());
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                return Err(error.into());
            }
        };

        let session_id_clone = session_id.clone();
        let subscribers_clone = subscribers.clone();
        let output_history = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_SCROLLBACK_BYTES)));
        let history_clone = output_history.clone();

        // Background reader thread for PTY output
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut shell_parser = ShellIntegrationParser::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF / Shell exited
                    Ok(n) => {
                        let parsed = shell_parser.feed(&buf[..n]);
                        {
                            let mut history = history_clone.lock().unwrap();
                            history.extend(parsed.data.iter().copied());
                            while history.len() > MAX_SCROLLBACK_BYTES {
                                history.pop_front();
                            }
                        }
                        let targets = subscribers_clone
                            .lock()
                            .unwrap()
                            .iter()
                            .map(|(id, sender)| (id.clone(), sender.clone()))
                            .collect::<Vec<_>>();
                        let mut closed = Vec::new();
                        for (subscription_id, sender) in targets {
                            // This is intentionally blocking: dropping PTY
                            // bytes would corrupt interactive programs. The
                            // queue is bounded so a dead/slow client applies
                            // backpressure instead of causing unbounded memory
                            // growth.
                            if sender
                                .blocking_send(PtyOutput {
                                    data: parsed.data.clone(),
                                    events: parsed.events.clone(),
                                })
                                .is_err()
                            {
                                closed.push(subscription_id);
                            }
                        }
                        if !closed.is_empty() {
                            let mut subscriptions = subscribers_clone.lock().unwrap();
                            for subscription_id in closed {
                                subscriptions.remove(&subscription_id);
                            }
                        }
                    }
                    Err(e) => {
                        error!("PTY read error for {}: {}", session_id_clone, e);
                        break;
                    }
                }
            }
            // Closing all senders lets subscribers emit a terminal exit event
            // even when the process ends without an explicit `terminal.kill`.
            subscribers_clone.lock().unwrap().clear();
            info!("PTY session {} closed", session_id_clone);
        });

        let master_arc = Arc::new(Mutex::new(pair.master));
        let writer_arc = Arc::new(Mutex::new(writer));
        let child_arc: Arc<Mutex<Box<dyn Child + Send>>> = Arc::new(Mutex::new(child));
        let monitor_child = child_arc.clone();

        let session = PtySession {
            token: token.clone(),
            context_dir: context_dir.clone(),
            writer: writer_arc,
            master: master_arc,
            child: child_arc,
            subscribers,
            output_history,
        };

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), session);
        self.exit_codes.lock().unwrap().remove(&session_id);

        // Keep the PTY session independent from the renderer while still
        // reporting a real terminal exit and releasing dead sessions. The
        // wait happens off the daemon async runtime so a long-running shell
        // never blocks IPC.
        let monitor_manager = self.clone();
        let monitor_session_id = session_id.clone();
        thread::spawn(move || {
            let exit_code = loop {
                // Poll rather than holding the child mutex in wait(): the
                // kill path must be able to acquire the same handle to send
                // its escalation signals.
                let status = monitor_child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok().flatten());
                if let Some(status) = status {
                    break Some(status.exit_code() as i32);
                }
                thread::sleep(std::time::Duration::from_millis(50));
            };
            monitor_manager
                .exit_codes
                .lock()
                .unwrap()
                .insert(monitor_session_id.clone(), exit_code);
            monitor_manager
                .sessions
                .lock()
                .unwrap()
                .remove(&monitor_session_id);
        });
        info!("Spawned PTY session {}", session_id);
        Ok((initial_subscription, token))
    }

    pub fn write_input(&self, session_id: &str, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let lock = self.sessions.lock().unwrap();
        let session = lock
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Terminal is not running"))?;
        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let lock = self.sessions.lock().unwrap();
        let session = lock
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Terminal is not running"))?;
        let master = session.master.lock().unwrap();
        master.resize(normalized_size(cols, rows))?;
        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> Result<()> {
        // Remove the session before waiting on the child. The exit monitor
        // also needs the sessions lock after wait() returns; holding it while
        // signalling would deadlock a normal terminal shutdown.
        let session = self.sessions.lock().unwrap().remove(session_id);
        self.created_notes.lock().unwrap().remove(session_id);
        if let Some(session) = session {
            session.subscribers.lock().unwrap().clear();
            if let Ok(mut child) = session.child.lock() {
                if let Some(pid) = child.process_id() {
                    // portable-pty creates a session for the child on POSIX;
                    // signal the process group first so agent subprocesses do
                    // not survive the terminal node.
                    let _ = kill(Pid::from_raw(-(pid as i32)), Signal::SIGHUP);
                    std::thread::sleep(std::time::Duration::from_millis(40));
                    let _ = kill(Pid::from_raw(-(pid as i32)), Signal::SIGTERM);
                    std::thread::sleep(std::time::Duration::from_millis(40));
                    let _ = kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL);
                }
                let _ = child.kill();
            }
            info!("Killed PTY session {}", session_id);
        }
        Ok(())
    }

    pub fn subscribe(&self, session_id: &str) -> Option<PtyOutputSubscription> {
        let lock = self.sessions.lock().unwrap();
        lock.get(session_id).map(|session| {
            let subscription_id = uuid::Uuid::new_v4().to_string();
            let (sender, receiver) = mpsc::channel::<PtyOutput>(OUTPUT_QUEUE_CAPACITY);
            session
                .subscribers
                .lock()
                .unwrap()
                .insert(subscription_id.clone(), sender);
            PtyOutputSubscription {
                receiver,
                manager: self.clone(),
                session_id: session_id.to_string(),
                subscription_id,
            }
        })
    }

    fn unsubscribe(&self, session_id: &str, subscription_id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().get(session_id) {
            session.subscribers.lock().unwrap().remove(subscription_id);
        }
    }

    pub fn list_sessions(&self) -> Vec<String> {
        let lock = self.sessions.lock().unwrap();
        lock.keys().cloned().collect()
    }

    pub fn authorizes(&self, session_id: &str, token: &str) -> bool {
        let lock = self.sessions.lock().unwrap();
        lock.get(session_id)
            .is_some_and(|session| session.token == token)
    }

    pub fn token_for(&self, session_id: &str) -> Option<String> {
        let lock = self.sessions.lock().unwrap();
        lock.get(session_id).map(|session| session.token.clone())
    }

    pub fn process_id(&self, session_id: &str) -> Option<u32> {
        let lock = self.sessions.lock().unwrap();
        lock.get(session_id)
            .and_then(|session| session.child.lock().ok()?.process_id())
    }

    pub fn snapshot(&self, session_id: &str) -> Result<Vec<u8>> {
        let lock = self.sessions.lock().unwrap();
        let session = lock
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Terminal is not running"))?;
        let snapshot = session
            .output_history
            .lock()
            .unwrap()
            .iter()
            .copied()
            .collect();
        Ok(snapshot)
    }

    pub fn exit_code(&self, session_id: &str) -> Option<Option<i32>> {
        self.exit_codes.lock().unwrap().get(session_id).copied()
    }

    pub fn send_prompt(&self, session_id: &str, prompt: &str) -> Result<()> {
        let pasted = format!("\x1b[200~{}\x1b[201~\r", prompt);
        self.write_input(session_id, pasted.as_bytes())
    }

    fn note_path_for_session(&self, session_id: &str, note_id: &str) -> Result<PathBuf> {
        if note_id.is_empty()
            || !note_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            return Err(anyhow::anyhow!("Invalid note id"));
        }
        let lock = self.sessions.lock().unwrap();
        let session = lock
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Terminal is not running"))?;
        let orchestra_dir = session
            .context_dir
            .parent()
            .and_then(|dir| dir.parent())
            .ok_or_else(|| anyhow::anyhow!("Invalid Orchestra context directory"))?;
        Ok(orchestra_dir.join("notes").join(format!("{}.md", note_id)))
    }

    fn connected_note_path(&self, session_id: &str, note_id: &str) -> Result<PathBuf> {
        let note_path = self.note_path_for_session(session_id, note_id)?;
        let context_dir = {
            let lock = self.sessions.lock().unwrap();
            lock.get(session_id)
                .ok_or_else(|| anyhow::anyhow!("Terminal is not running"))?
                .context_dir
                .clone()
        };
        let context_connected = std::fs::read_to_string(context_dir.join("context.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|context| context["connectedNotes"].as_array().cloned())
            .is_some_and(|notes| {
                notes
                    .iter()
                    .any(|note| note["id"].as_str() == Some(note_id))
            });
        let created_by_core = self
            .created_notes
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|notes| notes.contains(note_id));
        if !context_connected && !created_by_core {
            return Err(anyhow::anyhow!(
                "That note is not connected to this terminal"
            ));
        }
        Ok(note_path)
    }

    /// Register and materialize a note created by the authenticated core.
    /// The renderer will later include the node in context.json; until then,
    /// the scoped in-memory allowlist makes note-read/write deterministic.
    pub fn create_note(&self, session_id: &str, note_id: &str, content: &str) -> Result<PathBuf> {
        let note_path = self.note_path_for_session(session_id, note_id)?;
        let parent = note_path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Invalid note path"))?;
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".{}.{}.tmp", note_id, uuid::Uuid::new_v4()));
        std::fs::write(&temporary, content)?;
        if let Err(error) = std::fs::rename(&temporary, &note_path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.into());
        }
        self.created_notes
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert(note_id.to_string());
        Ok(note_path)
    }

    pub fn read_note(&self, session_id: &str, note_id: &str) -> Result<String> {
        std::fs::read_to_string(self.connected_note_path(session_id, note_id)?).map_err(Into::into)
    }

    pub fn write_note(&self, session_id: &str, note_id: &str, content: &str) -> Result<()> {
        let note_path = self.connected_note_path(session_id, note_id)?;
        let parent = note_path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Invalid note path"))?;
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".{}.{}.tmp", note_id, uuid::Uuid::new_v4()));
        std::fs::write(&temporary, content)?;
        std::fs::rename(temporary, note_path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        configured_portal_socket, derived_portal_socket_path, is_npm_process_environment,
        is_protected_environment, normalized_size, orchestra_bootstrap, resolve_skill_and_plugin,
        PtyManager, MAX_SCROLLBACK_BYTES, SHELL_ENV_REMOVE,
    };
    use std::time::Duration;

    #[test]
    fn zero_dimensions_are_never_forwarded_to_a_pty() {
        let size = normalized_size(0, 0);
        assert_eq!(size.cols, 1);
        assert_eq!(size.rows, 1);

        let size = normalized_size(80, 24);
        assert_eq!(size.cols, 80);
        assert_eq!(size.rows, 24);
    }

    #[test]
    fn scrollback_budget_stays_below_the_ipc_frame_limit() {
        assert!(MAX_SCROLLBACK_BYTES >= 4 * 1024 * 1024);
        // Reattach responses base64-encode the raw PTY history. Leave room for
        // JSON framing and the protocol's eight-megabyte maximum frame.
        assert!(MAX_SCROLLBACK_BYTES * 4 / 3 < crate::protocol::MAX_FRAME_SIZE);
    }

    #[test]
    fn npm_lifecycle_prefix_is_removed_without_touching_user_config_contract() {
        assert!(SHELL_ENV_REMOVE.contains(&"npm_config_prefix"));
        assert!(SHELL_ENV_REMOVE.contains(&"npm_config_global_prefix"));
        assert!(is_npm_process_environment("NPM_CONFIG_PREFIX"));
        assert!(is_npm_process_environment("Npm_Config_Prefix"));
        assert!(is_npm_process_environment("npm_lifecycle_command"));
        assert!(is_npm_process_environment("NPM_PACKAGE_JSON"));
        assert!(is_npm_process_environment("PREFIX"));
        assert!(SHELL_ENV_REMOVE.contains(&"npm_lifecycle_event"));
        assert!(!is_npm_process_environment("npm_config_registry"));
        assert!(!is_npm_process_environment("npm_config_userconfig"));
    }

    #[test]
    fn caller_environment_cannot_replace_daemon_owned_values() {
        assert!(is_protected_environment("ORCHESTRA_TOKEN"));
        assert!(is_protected_environment("orchestra_session_id"));
        assert!(is_protected_environment("PATH"));
        assert!(is_protected_environment("orchestra_resources_dir"));
        assert!(is_protected_environment("npm_config_prefix"));
        assert!(!is_protected_environment("npm_config_registry"));
        assert!(!is_protected_environment("MY_TERMINAL_FLAG"));
    }

    #[test]
    fn portal_socket_configuration_is_explicit_and_trimmed() {
        assert_eq!(
            configured_portal_socket(Some("  /run/user/1000/orchesta-1.portal.sock ")),
            Some("/run/user/1000/orchesta-1.portal.sock".into())
        );
        assert_eq!(configured_portal_socket(Some("  ")), None);
        assert_eq!(configured_portal_socket(None), None);
        assert!(is_protected_environment("ORCHESTRA_PORTAL_SOCKET"));
    }

    #[test]
    fn portal_socket_follows_the_exact_core_socket_when_not_explicit() {
        assert_eq!(
            derived_portal_socket_path("/tmp/orchesta-a.sock"),
            "/tmp/orchesta-a.portal.sock"
        );
        assert_eq!(
            derived_portal_socket_path("/tmp/orchesta-a"),
            "/tmp/orchesta-a.portal.sock"
        );
    }

    #[test]
    fn bootstrap_context_does_not_inject_a_visible_startup_banner() {
        let context = orchestra_bootstrap(
            &std::path::PathBuf::from("/tmp/orchestra-test-context"),
            "/tmp/skills/orchestra-canvas/SKILL.md",
        );
        assert!(!context.contains("You are running inside Orchestra"));
        assert!(context.contains("silent bootstrap"));
    }

    #[test]
    fn development_skill_resolution_returns_real_files() {
        let root = std::env::temp_dir().join(format!(
            "orchestra-skill-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).expect("temporary skill root should be creatable");
        let context = root.join(".orchestra/terminals/test");
        std::fs::create_dir_all(&context).expect("temporary context should be creatable");

        let (skill, plugin) =
            resolve_skill_and_plugin(&root, &context).expect("skill resolution should not fail");
        assert!(skill.is_file(), "ORCHESTRA_SKILL_PATH must point to a file");
        assert!(skill.file_name().is_some_and(|name| name == "SKILL.md"));
        assert!(plugin
            .as_ref()
            .is_some_and(|path| path.join(".codex-plugin/plugin.json").is_file()));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_tokens_are_scoped_to_the_live_session() {
        let root = std::env::temp_dir().join(format!(
            "orchestra-auth-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).expect("temporary auth root should be creatable");
        let manager = PtyManager::new();
        let session_id = format!("auth_session_{}", uuid::Uuid::new_v4().simple());
        let (_subscription, token) = manager
            .spawn_terminal(
                session_id.clone(),
                Some(root.to_string_lossy().to_string()),
                80,
                24,
                None,
                Some("printf auth-ready; sleep 5".to_string()),
            )
            .expect("terminal should spawn");

        assert!(!token.is_empty(), "a live terminal must receive a token");
        assert!(manager.authorizes(&session_id, &token));
        assert!(!manager.authorizes(&session_id, "stale-token"));

        manager.kill(&session_id).expect("terminal should stop");
        assert!(!manager.authorizes(&session_id, &token));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_core_created_note_is_readable_before_context_sync() {
        let root = std::env::temp_dir().join(format!(
            "orchestra-note-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).expect("temporary note root should be creatable");
        let manager = PtyManager::new();
        let session_id = format!("note_session_{}", uuid::Uuid::new_v4().simple());
        manager
            .spawn_terminal(
                session_id.clone(),
                Some(root.to_string_lossy().to_string()),
                80,
                24,
                None,
                None,
            )
            .expect("terminal should spawn");

        let note_id = "note_immediate";
        let note_path = manager
            .create_note(&session_id, note_id, "first")
            .expect("core note should materialize");
        assert!(note_path.is_file());
        assert_eq!(
            manager
                .read_note(&session_id, note_id)
                .expect("created note should be readable"),
            "first"
        );
        manager
            .write_note(&session_id, note_id, "second")
            .expect("created note should be writable");
        assert_eq!(
            manager
                .read_note(&session_id, note_id)
                .expect("updated note should be readable"),
            "second"
        );
        manager.kill(&session_id).expect("terminal should stop");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn real_pty_round_trip_and_explicit_kill_are_lossless() {
        let root = std::env::temp_dir().join(format!(
            "orchestra-pty-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).expect("temporary PTY root should be creatable");

        let manager = PtyManager::new();
        let session_id = "phase_a_pty_round_trip".to_string();
        let (mut output, token) = manager
            .spawn_terminal(
                session_id.clone(),
                Some(root.to_string_lossy().to_string()),
                80,
                24,
                None,
                None,
            )
            .expect("real PTY should spawn");
        assert!(!token.is_empty());
        manager
            .resize(&session_id, 0, 0)
            .expect("zero resize requests should be normalized");
        manager
            .write_input(&session_id, b"printf 'phase-a-pty\\n'\r")
            .expect("PTY input should be written");

        let received = tokio::time::timeout(Duration::from_secs(5), async {
            let mut bytes = Vec::new();
            while let Some(chunk) = output.recv().await {
                bytes.extend_from_slice(&chunk.data);
                if bytes
                    .windows(b"phase-a-pty".len())
                    .any(|window| window == b"phase-a-pty")
                {
                    return true;
                }
            }
            false
        })
        .await
        .expect("PTY output should arrive before the timeout");
        assert!(received, "PTY output did not contain the command result");

        manager
            .write_input(&session_id, b"seq 1 100000\r")
            .expect("heavy PTY input should be written");
        let heavy_output_received = tokio::time::timeout(Duration::from_secs(10), async {
            let mut bytes = Vec::new();
            while let Some(chunk) = output.recv().await {
                bytes.extend_from_slice(&chunk.data);
                if bytes
                    .windows(b"99999".len())
                    .any(|window| window == b"99999")
                {
                    return true;
                }
            }
            false
        })
        .await
        .expect("heavy PTY output should arrive before the timeout");
        assert!(
            heavy_output_received,
            "heavy PTY output did not reach the subscriber"
        );

        manager
            .kill(&session_id)
            .expect("explicit PTY kill should succeed");
        assert!(manager.write_input(&session_id, b"x").is_err());
        drop(output);
        let _ = std::fs::remove_dir_all(root);
    }
}
