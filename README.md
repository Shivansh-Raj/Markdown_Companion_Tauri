# Markdown Companion

A tiny desktop utility for macOS and Windows: press a global shortcut, pick a local Markdown file,
and it opens in its own compact, always-on-top, retro-styled window. Task checkboxes are
interactive and write straight back to the `.md` file. The file stays the source of truth.

Built with Tauri 2, React and TypeScript. Works fully offline; no accounts, telemetry or servers.
The full product brief is in `markdown_desktop_companion_coding_agent_brief.md`.

## Using it

1. Launch the app. It lives in the menu bar (macOS) or system tray (Windows); there is no Dock icon.
2. Press **Cmd/Ctrl + Shift + Space** (changeable in Settings) to open the launcher.
3. **+ ADD FILE** to pick a `.md` file, or add a watched folder in Settings (⚙ or `Cmd/Ctrl+,`).
4. Type to search, `↑/↓` to move, `Enter` to open. Selecting an open file focuses its window.
5. In a tracker: click checkboxes, scroll, `–` hides it, `✕` closes it, `Esc` hides it.
   The progress bar and per-heading counts update as you tick tasks.
6. Edit the file in any editor and the window refreshes by itself.
7. Quit from the tray menu (Cmd+Q is intentionally ignored for this background app).

## Install

Download the installer for your OS from the project's Releases page (built by CI from a `vX.Y.Z` tag).

| OS | Artifact | Notes |
|---|---|---|
| macOS 11+ | `.dmg` (Apple Silicon `aarch64`, Intel `x64`) | Drag to Applications |
| Windows 10/11 | `.exe` (NSIS, per-user, no admin) or `.msi` | Needs the WebView2 runtime (preinstalled on Windows 11; the installer fetches it if missing) |

### Unsigned builds
Releases are **not code-signed or notarized** unless you configure signing secrets, so the OS warns on first launch:

- **macOS:** right-click the app → **Open** → **Open**. If macOS says the app is damaged, run
  `xattr -dr com.apple.quarantine "/Applications/Markdown Companion.app"`.
- **Windows:** SmartScreen shows "Windows protected your PC": click **More info → Run anyway**.

To sign: set the Apple signing/notarization secrets (`APPLE_CERTIFICATE`, `APPLE_ID`, …) and a Windows
certificate in the Release workflow, per the
[Tauri signing guides](https://v2.tauri.app/distribute/sign/macos/).

## Development

Requires Node 20+ and a stable Rust toolchain (plus Xcode Command Line Tools on macOS, or the MSVC
build tools and WebView2 on Windows).

    npm install
    npm run tauri dev       # run the app with hot reload
    npm test                # frontend tests (Vitest)
    npm run typecheck
    npm run test:rust       # Rust tests, incl. real file-watcher tests
    npm run lint:rust       # clippy, warnings are errors
    npm run bundle          # production build + installer for the current OS

CI (`.github/workflows/ci.yml`) runs all of the above on macOS and Windows. Releases are built by
`release.yml` when you push a `v*` tag and are created as **drafts**.
Before publishing, follow [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

### Layout

    src/                 React UI: Launcher, TrackerWindow, MarkdownRenderer, Settings, services/
    src-tauri/src/
      store/             JSON metadata store (files, folders, window state, settings)
      filesystem/        safe reads, hash-verified minimal task edits, atomic writes, per-file locks
      watcher/           notify-based watching, debounce, hash filtering, self-write suppression
      windows/           launcher/tracker windows, saved-geometry recovery (geometry.rs)
      discovery/         bounded opt-in folder scan
      external.rs        allowlist for opening links
    docs/                sample.md, release checklist

## How it works

- **Source of truth:** metadata (registered paths, window geometry, settings) lives in
  `store.json` in the app data directory. Markdown content is never copied into it.
- **Reads/writes:** the UI cannot touch arbitrary paths; it can only read registered `.md` files via
  native commands, and write one thing: a task marker.
- **Task toggles:** a click sends the content hash it was derived from and the byte offset of the
  `[ ]`/`[x]` marker. Rust verifies both, replaces exactly those 3 bytes (CRLF, encoding and all other
  text untouched), and writes via temp file + atomic rename under a per-file lock. Read-only and
  non-UTF-8 files are refused.
- **Concurrent edits:** if the file changed, nothing is written. The app re-parses the fresh content
  and re-applies the click only if the task's text occurs exactly once; otherwise it refreshes and
  tells you nothing was written. External edits are never silently overwritten.
- **Sync:** the parent folder of each open file is watched (so atomic-replace saves are seen), events
  are debounced, and the file is re-read and compared by hash. The app's own writes are suppressed.
  Missing/unreadable files show a banner with Retry; deleted files are never recreated.
- **Rendering:** CommonMark + GFM via `react-markdown`; raw HTML is not rendered; links open only
  `http`, `https` and `mailto` through the system browser; only `https`/embedded images load.

## Assumptions

- Metadata is JSON rather than SQLite (tiny data, no migrations needed); the schema leaves room to move.
- The shortcut opens the launcher; picking an open tracker focuses it.
- Folder discovery is opt-in and bounded (3 levels, 500 files; hidden folders, `node_modules`,
  `target` and symlinks skipped).
- Normal Markdown is read-only; only task checkboxes are interactive.

## Known limitations

**Platform verification**
- Developed and tested on **macOS (Intel) only**. Windows builds are configured and built in CI,
  but no Windows pass has been done yet: global shortcut, always-on-top behaviour, watcher path
  handling (`\\?\` canonical paths) and DPI handling are unverified there.
- Not yet checked on Apple Silicon hardware, multiple/mixed-DPI displays, or over macOS full-screen apps.
- Release builds are unsigned (see above).

**Features**
- Local relative images (`![](./pic.png)`) show a placeholder; only `https` and embedded images load.
- LaTeX math is not supported (post-MVP).
- A moved/renamed file is reported as missing; the app does not follow it.
- Tasks with identical text are ambiguous after a concurrent edit, so nothing is auto-applied.
- Compact mode, per-window themes and launch-at-login are not implemented.
- "Reopen on launch" is off by default; trackers closed with ✕ are not reopened.
- The tray uses the full-colour app icon (not a macOS template icon).
- The launcher does not hide on blur (that would conflict with the file dialog).
- Files must be UTF-8.
