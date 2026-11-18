//! Optional live layer for Obsidian: an `obsidian://` handoff and a thin wrapper around the official CLI
//! (https://obsidian.md/help/cli). Nothing here is required by the rest of the app.
//!
//! The CLI talks to the running Obsidian app and launches it if it is not running. Its output formats and
//! exit codes are not documented, so callers treat output as opaque text and only a non-zero exit as failure.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CLI_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONTENT_CHARS: usize = 100_000;

/// Percent-encodes everything except RFC 3986 unreserved characters (the URI docs require encoded values).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `obsidian://open?path=<absolute path>`; the docs say `path` overrides `vault` and `file`.
pub fn open_uri(path: &Path) -> String {
    format!("obsidian://open?path={}", percent_encode(&path.to_string_lossy()))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

pub fn app_installed() -> bool {
    if Path::new("/Applications/Obsidian.app").exists() {
        return true;
    }
    home().is_some_and(|h| h.join("Applications/Obsidian.app").exists())
}

/// The CLI registers a symlink in /usr/local/bin on macOS (~/.local/bin on Linux). Looked up by file, never run.
pub fn find_cli() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("/usr/local/bin/obsidian"), PathBuf::from("/opt/homebrew/bin/obsidian")];
    if let Some(h) = home() {
        candidates.push(h.join(".local/bin/obsidian"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// The CLI takes `\n` and `\t` for newline and tab inside `content=`.
pub fn escape_content(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\n', "\\n").replace('\t', "\\t")
}

pub fn daily_append_args(content: &str, heading: Option<&str>) -> Result<Vec<String>, String> {
    if content.trim().is_empty() {
        return Err("Nothing to add to the daily note.".into());
    }
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err("That is too long to send through the Obsidian command line.".into());
    }
    let mut args = vec!["daily:append".to_string(), format!("content={}", escape_content(content))];
    if let Some(h) = heading.map(str::trim).filter(|h| !h.is_empty()) {
        args.push(format!("heading={h}"));
    }
    Ok(args)
}

/// Runs the CLI without a shell (each argument is passed as-is) and kills it after `timeout`.
pub fn run_cli(bin: &Path, args: &[String], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the Obsidian command line: {e}"))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut buf);
            }
            buf
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let start = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break s,
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Obsidian did not respond in time. Is it running and the command line enabled?".into());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if status.success() {
        Ok(stdout.trim().to_string())
    } else {
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(format!("Obsidian reported an error: {}", msg.trim()))
    }
}

pub fn cli_timeout() -> Duration {
    CLI_TIMEOUT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_paths_for_the_uri() {
        assert_eq!(percent_encode("/Users/a b/Notes & more/é.md"), "%2FUsers%2Fa%20b%2FNotes%20%26%20more%2F%C3%A9.md");
        assert_eq!(open_uri(Path::new("/v/a b.md")), "obsidian://open?path=%2Fv%2Fa%20b.md");
    }

    #[test]
    fn escapes_newlines_and_tabs_for_content() {
        assert_eq!(escape_content("a\r\nb\n\tc"), "a\\nb\\n\\tc");
    }

    #[test]
    fn builds_daily_append_args_and_rejects_bad_input() {
        let a = daily_append_args("- [ ] x\n- [ ] y", Some(" Meetings ")).unwrap();
        assert_eq!(a, vec!["daily:append", "content=- [ ] x\\n- [ ] y", "heading=Meetings"]);
        assert_eq!(daily_append_args("x", Some("  ")).unwrap().len(), 2);
        assert!(daily_append_args("  \n", None).is_err());
        assert!(daily_append_args(&"x".repeat(MAX_CONTENT_CHARS + 1), None).is_err());
    }

    #[cfg(unix)]
    mod stub_cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn stub(name: &str, body: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("mdc-obsidian-test-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join("obsidian");
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        }

        #[test]
        fn passes_each_argument_unchanged_without_a_shell() {
            let bin = stub("args", "for a in \"$@\"; do printf '[%s]' \"$a\"; done");
            let out = run_cli(&bin, &["daily:append".into(), "content=a b; echo hacked $(x)".into()], Duration::from_secs(5)).unwrap();
            assert_eq!(out, "[daily:append][content=a b; echo hacked $(x)]");
        }

        #[test]
        fn reports_failure_with_the_cli_message() {
            let bin = stub("fail", "echo 'no vault' >&2; exit 3");
            let err = run_cli(&bin, &[], Duration::from_secs(5)).unwrap_err();
            assert!(err.contains("no vault"), "{err}");
        }

        #[test]
        fn kills_a_hung_cli_after_the_timeout() {
            let bin = stub("hang", "sleep 30");
            let t = Instant::now();
            let err = run_cli(&bin, &[], Duration::from_millis(300)).unwrap_err();
            assert!(err.contains("did not respond"), "{err}");
            assert!(t.elapsed() < Duration::from_secs(5));
        }
    }
}
