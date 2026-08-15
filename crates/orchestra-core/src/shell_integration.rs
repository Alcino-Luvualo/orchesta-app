use anyhow::Result;
use std::path::{Path, PathBuf};

const MAX_PENDING_CONTROL_BYTES: usize = 16 * 1024;

/// Semantic signals emitted by the shell integration hooks. These signals are
/// kept separate from terminal bytes so OSC markers never become visible
/// output and can safely span multiple PTY reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEvent {
    PromptReady,
    CommandStarted,
    CommandFinished { exit_code: Option<i32> },
    CwdChanged { cwd: String },
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedShellOutput {
    pub data: Vec<u8>,
    pub events: Vec<ShellEvent>,
}

/// Incremental OSC parser. Only OSC 133 and OSC 7 are consumed; all other VT
/// and OSC sequences are forwarded byte-for-byte to xterm.js.
#[derive(Debug, Default)]
pub struct ShellIntegrationParser {
    pending: Vec<u8>,
}

impl ShellIntegrationParser {
    pub fn feed(&mut self, input: &[u8]) -> ParsedShellOutput {
        self.pending.extend_from_slice(input);
        let mut output = ParsedShellOutput::default();
        let mut cursor = 0;

        while cursor < self.pending.len() {
            let (payload_start, is_osc) = if self.pending[cursor] == 0x9d {
                (cursor + 1, true)
            } else if self.pending[cursor] == 0x1b
                && self.pending.get(cursor + 1).copied() == Some(b']')
            {
                (cursor + 2, true)
            } else if self.pending[cursor] == 0x1b && self.pending.get(cursor + 1).is_none() {
                // ESC may be the first half of ESC ] in the next PTY read.
                break;
            } else {
                (cursor, false)
            };

            if !is_osc {
                output.data.push(self.pending[cursor]);
                cursor += 1;
                continue;
            }

            let Some((terminator, terminator_len)) = self.find_osc_terminator(payload_start) else {
                if self.pending.len().saturating_sub(cursor) > MAX_PENDING_CONTROL_BYTES {
                    // A malicious or malformed unterminated OSC must not grow
                    // memory forever. Forward its ESC and continue normally.
                    output.data.push(self.pending[cursor]);
                    cursor += 1;
                    continue;
                }
                break;
            };

            let payload = &self.pending[payload_start..terminator];
            let sequence_end = terminator + terminator_len;
            if !self.parse_osc(payload, &mut output.events) {
                output
                    .data
                    .extend_from_slice(&self.pending[cursor..sequence_end]);
            }
            cursor = sequence_end;
        }

        self.pending.drain(..cursor);
        output
    }

    fn find_osc_terminator(&self, start: usize) -> Option<(usize, usize)> {
        let mut cursor = start;
        while cursor < self.pending.len() {
            match self.pending[cursor] {
                0x07 | 0x9c => return Some((cursor, 1)),
                0x1b if self.pending.get(cursor + 1).copied() == Some(b'\\') => {
                    return Some((cursor, 2));
                }
                _ => cursor += 1,
            }
        }
        None
    }

    fn parse_osc(&self, payload: &[u8], events: &mut Vec<ShellEvent>) -> bool {
        let Ok(payload) = std::str::from_utf8(payload) else {
            return false;
        };

        if let Some(marker) = payload.strip_prefix("133;") {
            let mut fields = marker.split(';');
            match fields.next().unwrap_or_default() {
                // OSC 133;A is the prompt-start marker. B is intentionally
                // consumed too: it is a visible-prompt boundary, not a state
                // transition needed by Orchesta.
                "A" => events.push(ShellEvent::PromptReady),
                "C" => events.push(ShellEvent::CommandStarted),
                "D" => events.push(ShellEvent::CommandFinished {
                    exit_code: fields.next().and_then(|value| value.parse::<i32>().ok()),
                }),
                "B" => {}
                _ => {}
            }
            return true;
        }

        if let Some(value) = payload.strip_prefix("7;") {
            let value = value.strip_prefix(';').unwrap_or(value);
            if !value.is_empty() {
                events.push(ShellEvent::CwdChanged {
                    cwd: file_uri_to_path(value),
                });
            }
            return true;
        }

        false
    }
}

fn file_uri_to_path(value: &str) -> String {
    let path = if let Some(rest) = value.strip_prefix("file://") {
        if let Some(slash) = rest.find('/') {
            &rest[slash..]
        } else {
            "/"
        }
    } else {
        value
    };
    percent_decode(path)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == b'%' && cursor + 2 < bytes.len() {
            let high = hex_value(bytes[cursor + 1]);
            let low = hex_value(bytes[cursor + 2]);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high << 4) | low);
                cursor += 3;
                continue;
            }
        }
        decoded.push(bytes[cursor]);
        cursor += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub struct ShellLaunch {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Prepare an isolated startup file. The user's existing config is sourced
/// first, then Orchesta's hooks are appended, so custom prompts and aliases
/// keep working without modifying files in $HOME.
pub fn prepare_shell_launch(shell: &Path, directory: &Path) -> Result<ShellLaunch> {
    std::fs::create_dir_all(directory)?;
    let name = shell
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());

    match name {
        "bash" => {
            let integration = directory.join("integration.bash");
            let rcfile = directory.join("bashrc");
            write_file(&integration, bash_integration())?;
            let user_rc = PathBuf::from(home).join(".bashrc");
            write_file(
                &rcfile,
                format!(
                    "if [ -f {} ]; then . {}; fi\n. {}\n",
                    shell_quote(&user_rc),
                    shell_quote(&user_rc),
                    shell_quote(&integration)
                ),
            )?;
            Ok(ShellLaunch {
                args: vec![
                    "--rcfile".into(),
                    rcfile.to_string_lossy().into_owned(),
                    "-i".into(),
                ],
                env: vec![
                    ("ORCHESTRA_SHELL_INTEGRATION".into(), "available".into()),
                    (
                        "ORCHESTRA_SHELL_INTEGRATION_FILE".into(),
                        integration.to_string_lossy().into_owned(),
                    ),
                ],
            })
        }
        "zsh" => {
            let integration = directory.join("integration.zsh");
            let zshenv = directory.join(".zshenv");
            let zshrc = directory.join(".zshrc");
            let user_zdotdir = std::env::var("ZDOTDIR").unwrap_or_else(|_| home.clone());
            let user_rc = PathBuf::from(user_zdotdir).join(".zshrc");
            write_file(
                &zshenv,
                "# Orchesta shell integration bootstrap\n".to_string(),
            )?;
            write_file(&integration, zsh_integration())?;
            write_file(
                &zshrc,
                format!(
                    "if [[ -f {} ]]; then source {}; fi\nsource {}\n",
                    shell_quote(&user_rc),
                    shell_quote(&user_rc),
                    shell_quote(&integration)
                ),
            )?;
            Ok(ShellLaunch {
                args: vec!["-i".into()],
                env: vec![
                    ("ZDOTDIR".into(), directory.to_string_lossy().into_owned()),
                    ("ORCHESTRA_SHELL_INTEGRATION".into(), "available".into()),
                    (
                        "ORCHESTRA_SHELL_INTEGRATION_FILE".into(),
                        integration.to_string_lossy().into_owned(),
                    ),
                ],
            })
        }
        "fish" => {
            let integration = directory.join("integration.fish");
            write_file(&integration, fish_integration())?;
            Ok(ShellLaunch {
                args: vec![
                    "-i".into(),
                    "-C".into(),
                    format!("source {}", fish_quote(&integration)),
                ],
                env: vec![
                    ("ORCHESTRA_SHELL_INTEGRATION".into(), "available".into()),
                    (
                        "ORCHESTRA_SHELL_INTEGRATION_FILE".into(),
                        integration.to_string_lossy().into_owned(),
                    ),
                ],
            })
        }
        _ => Ok(ShellLaunch {
            args: vec![],
            env: vec![("ORCHESTRA_SHELL_INTEGRATION".into(), "unavailable".into())],
        }),
    }
}

fn write_file(path: &Path, contents: String) -> Result<()> {
    std::fs::write(path, contents).map_err(Into::into)
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn fish_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "\\'"))
}

fn bash_integration() -> String {
    r#"# Orchesta shell integration for bash. Do not edit generated files.
__orchestra_command_started=0
__orchestra_in_prompt=0
__orchestra_emit() {
  printf '\033]%s\007' "$1"
}
__orchestra_preexec() {
  case "$BASH_COMMAND" in
    __orchestra_*|__orchestra_prompt_hook*) return ;;
  esac
  if [ "$__orchestra_in_prompt" -eq 0 ] && [ "$__orchestra_command_started" -eq 0 ]; then
    __orchestra_command_started=1
    __orchestra_emit '133;C'
  fi
}
__orchestra_prompt_hook() {
  local __orchestra_status=$?
  __orchestra_in_prompt=1
  __orchestra_emit "133;D;$__orchestra_status"
  __orchestra_emit "7;file://${HOSTNAME}${PWD}"
  __orchestra_emit '133;A'
  __orchestra_in_prompt=0
  __orchestra_command_started=0
  return "$__orchestra_status"
}
trap '__orchestra_preexec' DEBUG
if [ -n "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="__orchestra_prompt_hook;$PROMPT_COMMAND"
else
  PROMPT_COMMAND=__orchestra_prompt_hook
fi
"#
    .to_string()
}

fn zsh_integration() -> String {
    r#"# Orchesta shell integration for zsh. Do not edit generated files.
autoload -Uz add-zsh-hook
__orchestra_emit() { print -Pn "\e]$1\a" }
__orchestra_preexec() { __orchestra_emit '133;C' }
__orchestra_precmd() {
  local __orchestra_status=$?
  __orchestra_emit "133;D;$__orchestra_status"
  __orchestra_emit "7;file://${HOST}${PWD}"
  __orchestra_emit '133;A'
  return $__orchestra_status
}
add-zsh-hook preexec __orchestra_preexec
add-zsh-hook precmd __orchestra_precmd
"#
    .to_string()
}

fn fish_integration() -> String {
    r#"# Orchesta shell integration for fish. Do not edit generated files.
function __orchestra_emit
  printf '\e]%s\a' $argv[1]
end
function __orchestra_preexec --on-event fish_preexec
  __orchestra_emit '133;C'
end
function __orchestra_postexec --on-event fish_postexec
  set -l __orchestra_status $status
  __orchestra_emit "133;D;$__orchestra_status"
  __orchestra_emit "7;file://$hostname$PWD"
end
function __orchestra_prompt --on-event fish_prompt
  __orchestra_emit '133;A'
end
"#
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::{ParsedShellOutput, ShellEvent, ShellIntegrationParser};

    #[test]
    fn parses_fragmented_osc_133_and_7_without_visible_markers() {
        let mut parser = ShellIntegrationParser::default();
        assert_eq!(
            parser
                .feed(b"before\x1b]133;C\x07after\x1b]7;file://host/tmp/a%20b\x1b\\")
                .data,
            b"beforeafter"
        );
        let parsed = parser.feed(b"\x1b]133;D;7\x07\x1b]133;A\x07");
        assert_eq!(
            parsed,
            ParsedShellOutput {
                data: vec![],
                events: vec![
                    ShellEvent::CommandFinished { exit_code: Some(7) },
                    ShellEvent::PromptReady,
                ]
            }
        );
    }

    #[test]
    fn preserves_unknown_osc_and_regular_escape_sequences() {
        let mut parser = ShellIntegrationParser::default();
        let parsed = parser.feed(b"x\x1b]0;title\x07y\x1b[31mz\x1b]133;X\x07");
        assert_eq!(parsed.data, b"x\x1b]0;title\x07y\x1b[31mz");
        assert!(parsed.events.is_empty());
    }

    #[test]
    fn malformed_unterminated_marker_is_buffered_then_flushed_at_limit() {
        let mut parser = ShellIntegrationParser::default();
        assert_eq!(parser.feed(b"hello\x1b]133;C").data, b"hello");
        let parsed = parser.feed(&vec![b'x'; 16 * 1024]);
        assert!(!parsed.data.is_empty());
    }

    #[test]
    fn parses_c1_osc_and_percent_decodes_working_directory() {
        let mut parser = ShellIntegrationParser::default();
        let parsed = parser.feed(b"\x9d7;;file:///tmp/ol\xc3\xa1\x9c");
        assert_eq!(
            parsed.events,
            vec![ShellEvent::CwdChanged {
                cwd: "/tmp/olá".into()
            }]
        );
    }
}
