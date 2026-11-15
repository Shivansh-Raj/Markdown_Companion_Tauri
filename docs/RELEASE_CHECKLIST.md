# Release checklist

The brief requires at least one real macOS pass and one real Windows pass before claiming
cross-platform readiness. Automated tests cover logic; the items below cover what only a real
desktop session can show. Record the OS version, who tested and the result for each release.

## 1. Automated gates (CI runs these on macOS and Windows)

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run lint:rust` (clippy, warnings are errors)
- [ ] `npm run test:rust` (includes real file-watcher, atomic-write and read-only tests)

## 2. Build

- [ ] Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
- [ ] Tag `vX.Y.Z` and push; the **Release** workflow creates a *draft* GitHub release with:
  - macOS: `.dmg` for Apple Silicon (`aarch64`) and Intel (`x64`)
  - Windows: NSIS `.exe` installer (per-user, no admin) and `.msi`
- [ ] Locally: `npm run bundle` builds for the current OS only.

## 3. Install test (per OS, on a machine without the dev toolchain)

- [ ] Install from the draft-release artifact.
- [ ] First launch works (see README for the unsigned-app steps). No terminal or Node/Rust needed.
- [ ] No Dock icon (macOS) / no taskbar button (Windows); a tray / menu-bar icon appears.
- [ ] Uninstall removes the app. User data (`store.json`) is left in place by design.

## 4. Manual test matrix (run on **both** macOS and Windows)

### Shortcut and launcher
- [ ] Default shortcut (`Cmd/Ctrl+Shift+Space`) opens the launcher from inside another app.
- [ ] Pressing it again hides the launcher.
- [ ] Changing the shortcut in Settings works and survives a restart.
- [ ] Choosing a shortcut owned by another app shows an error and keeps the old one working.
- [ ] Up/Down/Enter/Esc work; the search filters by name and folder.

### Windows
- [ ] Add a file: it opens in a compact frameless window.
- [ ] Drag by the title bar; resize from every edge/corner; minimum size is enforced.
- [ ] Always-on-top: the tracker stays above a maximized normal window (and above a
      full-screen app on macOS: note the actual behaviour).
- [ ] Hide (–) and re-summon from the launcher keeps content and scroll position.
- [ ] Close (✕) does not quit the app; the tray icon remains.
- [ ] Selecting an open file focuses the existing window (no duplicate).
- [ ] Two files open side by side, independently scrollable.
- [ ] Quit, relaunch: size and position are restored.
- [ ] Disconnect a monitor (or change resolution) while a tracker was on it, relaunch with
      "Reopen on launch": the window is recovered to a visible spot.
- [ ] Mixed-DPI setups: window size looks right after moving between monitors.

### Tasks and files
- [ ] Clicking a checkbox updates the bar, counts and section badges immediately.
- [ ] The `.md` file changes only at that `[ ]`/`[x]` (check with `git diff` or a diff tool).
- [ ] CRLF files keep CRLF; non-ASCII text is unchanged.
- [ ] Read-only file: click rolls back and shows an error.

### Synchronization
- [ ] Edit and save in VS Code: the window updates within ~1s and keeps its scroll position.
- [ ] Editors that save via rename/atomic replace (VS Code, vim, Notepad++) are detected.
- [ ] Click a checkbox right after an external edit: either re-applied safely or refused with a
      message; never overwrites the external change.
- [ ] Rename or delete the file: "File not found" banner, checkboxes disabled, no file recreated.
      Restore it: window recovers (or **RETRY**).
- [ ] File on a network/cloud-synced folder: note any missed events.

### Settings, tray, accessibility
- [ ] Theme switch applies to all open windows, including code highlighting.
- [ ] Watched folder: files appear tagged FOLDER; opening one registers it.
- [ ] Tray: Open launcher, Show all, Hide all, Settings, Quit all work.
- [ ] Keyboard only: Tab reaches checkboxes and the scroll region; Esc hides a tracker.
- [ ] Screen reader (VoiceOver / Narrator) announces launcher results and checkbox labels.

### Performance sanity
- [ ] Idle CPU is ~0% with several trackers open (Activity Monitor / Task Manager).
- [ ] Memory with three trackers open is reasonable; record the number.
- [ ] A 5,000-line Markdown file opens and scrolls without freezing.

## 5. Publish

- [ ] Fill in the test record below; fix or document any failures in README "Known limitations".
- [ ] Publish the draft release only after both OS passes.

## Test record

| Release | OS / version | Tester | Date | Result / notes |
|---|---|---|---|---|
| | macOS | | | |
| | Windows | | | |
