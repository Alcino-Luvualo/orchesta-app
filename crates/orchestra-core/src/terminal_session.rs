use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// The terminal interaction owner. Phase B deliberately starts new sessions
/// in ShellFallback: without shell integration, the real PTY remains fully
/// usable and owns all keyboard input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalInteractionMode {
    ShellPrompt,
    CommandRunning,
    InteractiveProgram,
    AlternateScreen,
    PasswordInput,
    ShellFallback,
    Disconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalProcessStatus {
    Starting,
    Running,
    Exited,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum TerminalTransition {
    ProcessStarted {
        pid: Option<u32>,
    },
    PromptReady,
    CommandStarted,
    /// Rich/editor handoff. The shell's OSC markers can race with PTY output,
    /// so the prompt remains locked until its matching C/D/A sequence.
    RichCommandStarted,
    RichCommandFailed,
    CommandFinished {
        exit_code: Option<i32>,
    },
    CwdChanged {
        cwd: String,
    },
    InteractiveProgramStarted,
    AlternateScreenEntered,
    PasswordInputStarted,
    ShellFallback,
    ProcessExited {
        exit_code: Option<i32>,
    },
    Disconnected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalProcess {
    pub id: String,
    pub pid: Option<u32>,
    pub status: TerminalProcessStatus,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalView {
    pub id: String,
    pub client_id: String,
    pub attached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSession {
    pub id: String,
    pub process: TerminalProcess,
    pub interaction_mode: TerminalInteractionMode,
    pub cwd: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub command_exit_code: Option<i32>,
    pub views: HashMap<String, TerminalView>,
    #[serde(skip)]
    rich_command_pending: bool,
    #[serde(skip)]
    rich_shell_started: bool,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

impl TerminalSession {
    pub fn new(id: String, pid: Option<u32>, cwd: Option<String>) -> Self {
        Self {
            process: TerminalProcess {
                id: format!("process:{id}"),
                pid,
                status: TerminalProcessStatus::Running,
                exit_code: None,
            },
            id,
            interaction_mode: TerminalInteractionMode::ShellFallback,
            cwd,
            started_at: now_millis(),
            finished_at: None,
            command_exit_code: None,
            views: HashMap::new(),
            rich_command_pending: false,
            rich_shell_started: false,
        }
    }

    pub fn transition(&mut self, transition: TerminalTransition) -> Result<()> {
        match transition {
            TerminalTransition::ProcessStarted { pid } => {
                if self.process.status == TerminalProcessStatus::Running {
                    return Err(anyhow!("terminal process is already running"));
                }
                self.process.pid = pid;
                self.process.status = TerminalProcessStatus::Running;
                self.process.exit_code = None;
                self.interaction_mode = TerminalInteractionMode::ShellFallback;
                self.finished_at = None;
                self.command_exit_code = None;
                self.rich_command_pending = false;
                self.rich_shell_started = false;
            }
            TerminalTransition::PromptReady => {
                self.require_running("prompt-ready")?;
                // D/A from the previous prompt can arrive after a rich
                // handoff has been written to the PTY. It is not a confirmed
                // return boundary until the handoff's C marker is observed.
                if self.rich_command_pending && !self.rich_shell_started {
                    return Ok(());
                }
                self.rich_command_pending = false;
                self.rich_shell_started = false;
                self.interaction_mode = TerminalInteractionMode::ShellPrompt;
            }
            TerminalTransition::CommandStarted => {
                self.require_running("command-start")?;
                if self.rich_command_pending {
                    self.rich_shell_started = true;
                } else {
                    self.command_exit_code = None;
                    self.interaction_mode = TerminalInteractionMode::CommandRunning;
                }
            }
            TerminalTransition::RichCommandStarted => {
                self.require_running("rich-command-start")?;
                self.command_exit_code = None;
                self.rich_command_pending = true;
                self.rich_shell_started = false;
                self.interaction_mode = TerminalInteractionMode::CommandRunning;
            }
            TerminalTransition::RichCommandFailed => {
                self.require_running("rich-command-failed")?;
                self.rich_command_pending = false;
                self.rich_shell_started = false;
                self.interaction_mode = TerminalInteractionMode::ShellPrompt;
            }
            TerminalTransition::CommandFinished { exit_code } => {
                self.require_running("command-finish")?;
                self.command_exit_code = exit_code;
                // Wait for OSC 133;A before exposing a fresh prompt. This
                // keeps stale D/A and CWD events from unlocking the editor.
            }
            TerminalTransition::CwdChanged { cwd } => {
                self.require_running("cwd-change")?;
                self.cwd = Some(cwd);
            }
            TerminalTransition::InteractiveProgramStarted => {
                self.require_running("interactive-program-start")?;
                self.interaction_mode = TerminalInteractionMode::InteractiveProgram;
            }
            TerminalTransition::AlternateScreenEntered => {
                self.require_running("alternate-screen-enter")?;
                self.interaction_mode = TerminalInteractionMode::AlternateScreen;
            }
            TerminalTransition::PasswordInputStarted => {
                self.require_running("password-input-start")?;
                self.interaction_mode = TerminalInteractionMode::PasswordInput;
            }
            TerminalTransition::ShellFallback => {
                self.require_running("shell-fallback")?;
                self.interaction_mode = TerminalInteractionMode::ShellFallback;
            }
            TerminalTransition::ProcessExited { exit_code } => {
                if self.process.status == TerminalProcessStatus::Disconnected {
                    return Ok(());
                }
                self.process.status = TerminalProcessStatus::Exited;
                self.process.exit_code = exit_code;
                self.process.pid = None;
                self.interaction_mode = TerminalInteractionMode::Disconnected;
                self.command_exit_code = None;
                self.rich_command_pending = false;
                self.rich_shell_started = false;
                self.finished_at = Some(now_millis());
            }
            TerminalTransition::Disconnected => {
                self.process.status = TerminalProcessStatus::Disconnected;
                self.process.pid = None;
                self.interaction_mode = TerminalInteractionMode::Disconnected;
                self.command_exit_code = None;
                self.rich_command_pending = false;
                self.rich_shell_started = false;
                self.finished_at.get_or_insert_with(now_millis);
            }
        }
        Ok(())
    }

    fn require_running(&self, transition: &str) -> Result<()> {
        if matches!(
            self.process.status,
            TerminalProcessStatus::Running | TerminalProcessStatus::Starting
        ) {
            Ok(())
        } else {
            Err(anyhow!(
                "cannot apply {transition} while terminal process is {:?}",
                self.process.status
            ))
        }
    }
}

#[derive(Clone, Default)]
pub struct TerminalSessionRegistry {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalSessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(
        &self,
        session_id: String,
        pid: Option<u32>,
        cwd: Option<String>,
    ) -> Result<TerminalSession> {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.get(&session_id).is_some_and(|session| {
            matches!(
                session.process.status,
                TerminalProcessStatus::Running | TerminalProcessStatus::Starting
            )
        }) {
            return Err(anyhow!("terminal session is already running"));
        }
        let session = TerminalSession::new(session_id.clone(), pid, cwd);
        sessions.insert(session_id, session.clone());
        Ok(session)
    }

    pub fn ensure(
        &self,
        session_id: String,
        pid: Option<u32>,
        cwd: Option<String>,
    ) -> Result<TerminalSession> {
        if let Some(session) = self.snapshot(&session_id) {
            if session.process.status == TerminalProcessStatus::Running {
                return Ok(session);
            }
        }
        self.create(session_id, pid, cwd)
    }

    pub fn attach(
        &self,
        session_id: &str,
        view_id: String,
        client_id: String,
    ) -> Result<TerminalSession> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("terminal session is not registered"))?;
        session.require_running("view-attach")?;
        session.views.insert(
            view_id.clone(),
            TerminalView {
                id: view_id,
                client_id,
                attached: true,
            },
        );
        Ok(session.clone())
    }

    pub fn detach(&self, session_id: &str, view_id: &str) -> Result<TerminalSession> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("terminal session is not registered"))?;
        if let Some(view) = session.views.get_mut(view_id) {
            view.attached = false;
        }
        Ok(session.clone())
    }

    pub fn process_exited(
        &self,
        session_id: &str,
        exit_code: Option<i32>,
    ) -> Result<TerminalSession> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("terminal session is not registered"))?;
        session.transition(TerminalTransition::ProcessExited { exit_code })?;
        Ok(session.clone())
    }

    pub fn mark_disconnected(&self, session_id: &str) -> Result<TerminalSession> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("terminal session is not registered"))?;
        session.transition(TerminalTransition::Disconnected)?;
        Ok(session.clone())
    }

    #[allow(dead_code)]
    pub fn transition(
        &self,
        session_id: &str,
        transition: TerminalTransition,
    ) -> Result<TerminalSession> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("terminal session is not registered"))?;
        session.transition(transition)?;
        Ok(session.clone())
    }

    pub fn snapshot(&self, session_id: &str) -> Option<TerminalSession> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        TerminalInteractionMode, TerminalProcessStatus, TerminalSession, TerminalSessionRegistry,
        TerminalTransition,
    };

    #[test]
    fn interaction_mode_transitions_are_explicit_and_stateful() {
        let mut session = TerminalSession::new("session".into(), Some(42), Some("/tmp".into()));
        assert_eq!(
            session.interaction_mode,
            TerminalInteractionMode::ShellFallback
        );
        session.transition(TerminalTransition::PromptReady).unwrap();
        session
            .transition(TerminalTransition::CommandStarted)
            .unwrap();
        assert_eq!(
            session.interaction_mode,
            TerminalInteractionMode::CommandRunning
        );
        session
            .transition(TerminalTransition::CommandFinished { exit_code: Some(0) })
            .unwrap();
        assert_eq!(
            session.interaction_mode,
            TerminalInteractionMode::CommandRunning
        );
        session.transition(TerminalTransition::PromptReady).unwrap();
        session
            .transition(TerminalTransition::CwdChanged {
                cwd: "/workspace/project".into(),
            })
            .unwrap();
        assert_eq!(
            session.interaction_mode,
            TerminalInteractionMode::ShellPrompt
        );
        assert_eq!(session.command_exit_code, Some(0));
        assert_eq!(session.cwd.as_deref(), Some("/workspace/project"));
        session
            .transition(TerminalTransition::InteractiveProgramStarted)
            .unwrap();
        session
            .transition(TerminalTransition::AlternateScreenEntered)
            .unwrap();
        session
            .transition(TerminalTransition::ProcessExited { exit_code: Some(0) })
            .unwrap();
        assert_eq!(
            session.interaction_mode,
            TerminalInteractionMode::Disconnected
        );
        assert_eq!(session.process.status, TerminalProcessStatus::Exited);
        assert!(session.transition(TerminalTransition::PromptReady).is_err());
    }

    #[test]
    fn rich_handoff_ignores_stale_prompt_until_shell_started() {
        let mut session = TerminalSession::new("session".into(), Some(42), Some("/tmp".into()));
        session.transition(TerminalTransition::PromptReady).unwrap();
        session
            .transition(TerminalTransition::RichCommandStarted)
            .unwrap();
        session
            .transition(TerminalTransition::CommandFinished { exit_code: Some(1) })
            .unwrap();
        session.transition(TerminalTransition::PromptReady).unwrap();
        assert_eq!(
            session.interaction_mode,
            TerminalInteractionMode::CommandRunning
        );
        session
            .transition(TerminalTransition::CommandStarted)
            .unwrap();
        session
            .transition(TerminalTransition::CommandFinished { exit_code: Some(0) })
            .unwrap();
        session.transition(TerminalTransition::PromptReady).unwrap();
        assert_eq!(
            session.interaction_mode,
            TerminalInteractionMode::ShellPrompt
        );
        assert_eq!(session.command_exit_code, Some(0));
    }

    #[test]
    fn view_lifecycle_does_not_kill_the_process() {
        let registry = TerminalSessionRegistry::new();
        registry
            .create("session".into(), Some(7), Some("/tmp".into()))
            .unwrap();
        registry
            .attach("session", "view-1".into(), "client-1".into())
            .unwrap();
        let detached = registry.detach("session", "view-1").unwrap();
        assert_eq!(detached.process.status, TerminalProcessStatus::Running);
        assert!(!detached.views["view-1"].attached);
        let exited = registry.process_exited("session", Some(130)).unwrap();
        assert_eq!(
            exited.interaction_mode,
            TerminalInteractionMode::Disconnected
        );
        assert_eq!(exited.process.exit_code, Some(130));
    }

    #[test]
    fn disconnected_sessions_can_be_recreated_without_coupling_old_views() {
        let registry = TerminalSessionRegistry::new();
        registry.create("session".into(), Some(1), None).unwrap();
        registry.process_exited("session", Some(0)).unwrap();
        let recreated = registry.create("session".into(), Some(2), None).unwrap();
        assert_eq!(recreated.process.pid, Some(2));
        assert!(recreated.views.is_empty());
    }
}
