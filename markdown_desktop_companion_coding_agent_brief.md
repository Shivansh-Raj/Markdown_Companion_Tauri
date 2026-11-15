# Product Specification & Implementation Brief
## Markdown Desktop Companion — Cross-Platform Floating Markdown Widgets

**Document purpose:** This is the product brief and implementation prompt for an AI coding agent. Use it as the source of truth for understanding the product, planning the architecture, and implementing the application.

---

# 1. Your role and working approach

Act as a senior cross-platform desktop engineer and product-minded technical lead.

Your task is to build a lightweight desktop application for **macOS and Windows** that turns local Markdown (`.md`) files into compact, interactive floating windows—similar to digital sticky notes.

Do not interpret this as a conventional notes app, project-management dashboard, or full-screen Markdown editor. The core experience is a small desktop companion that can be summoned with a global keyboard shortcut, displays Markdown in an attractive compact window, and allows selected interactions such as checking off tasks.

Work in a disciplined, incremental way:

1. Inspect the existing repository before changing anything.
2. Identify the current stack, conventions, scripts, and existing functionality.
3. If the repository is empty, scaffold the recommended architecture below.
4. Produce a short implementation plan and identify any genuine blockers.
5. Implement in small, testable milestones.
6. Run relevant tests, linting, type checks, and builds after each milestone.
7. Keep macOS and Windows compatibility in mind from the beginning.
8. Do not claim a feature works on both platforms unless it has been tested or its platform-specific limitation is clearly documented.
9. Avoid unnecessary dependencies, premature abstractions, cloud services, accounts, and backend infrastructure.
10. Document setup, development, testing, packaging, and known limitations.

Do not rewrite the entire project unnecessarily. Preserve useful existing code and conventions.

---

# 2. Product vision

Build a **keyboard-driven, multi-window Markdown desktop companion**.

The user has Markdown files stored locally. The application runs quietly in the background. When the user presses a configurable global keyboard shortcut, a small launcher appears. The user can search for and select a Markdown file. The selected file opens in its own compact floating window.

That window:

- Does not take over the whole screen.
- Can be dragged and resized.
- Can stay above other application windows while visible.
- Renders the Markdown content.
- Allows task checkboxes to be toggled.
- Updates the original Markdown file when supported interactions occur.
- Refreshes automatically when the file is changed externally.
- Can be hidden and summoned again without losing its state.

Multiple Markdown files can have independent windows. The application should avoid opening duplicate windows for the same registered file.

**Product principle: Markdown files remain the source of truth.** The application is an interactive presentation and control layer over local files, not a replacement database for their contents.

## Intended feeling

The app should feel like a tiny utility living on the desktop—not another application the user has to switch into.

The visual direction is inspired by the supplied reference image: a compact retro/pixel-art checklist interface with a warm cream background, red accents, dark borders, pixel-inspired typography, and a distinctive progress display.

The reference image is inspiration for visual language and proportions, not a requirement to copy every element literally.

---

# 3. Confirmed product decisions

Treat these as requirements:

| Area | Decision |
|---|---|
| Operating systems | macOS and Windows |
| Window invocation | Appear when summoned using a global keyboard shortcut |
| Markdown files | Multiple files, each with its own independent window |
| Markdown rendering | Render the supported Markdown feature set, not only checklists |
| External changes | Detect and automatically refresh when the original Markdown file changes |
| Visual design | Retro / pixel-art aesthetic inspired by the supplied reference |
| Source of truth | Original local Markdown file |
| Primary interaction | Interactive task checkboxes and progress tracking |
| Runtime | Lightweight background desktop utility |

## Provisional defaults for decisions not yet finalized

Use these defaults unless repository constraints or implementation evidence suggest a better choice. Keep them configurable where practical.

1. **Shortcut behaviour:** The shortcut opens the searchable launcher. Existing tracker windows retain their current visibility; selecting an already-open tracker focuses its existing window.
2. **File discovery:** Support both individual file selection and folder-based discovery. Folder discovery should be opt-in and should not recursively scan the entire computer.
3. **Editing:** Initially treat normal Markdown content as read-only, but make task checkboxes interactive. Full Markdown editing inside the widget can be considered a later feature.

Do not block the MVP on these provisional decisions. Record any assumptions in the README.

---

# 4. Core user journey

1. User launches the application.
2. The application starts in the background and exposes a system-tray/menu-bar entry where supported.
3. User presses the configured global shortcut.
4. A compact searchable launcher appears.
5. User searches for a registered Markdown file or imports/discovers one.
6. User selects a file.
7. The app opens that file in a dedicated floating window.
8. User reads the content, scrolls, expands/collapses sections, and checks or unchecks tasks.
9. Checkbox changes are saved to the original Markdown file.
10. If the user edits the same file in VS Code or another editor, the floating window detects the external modification and refreshes.
11. User hides the tracker. The window's configuration is retained.
12. User summons it again and continues.

## Launcher behaviour

The launcher should include:

- Search field.
- List of registered Markdown files.
- File name and optionally parent-folder/path context.
- Recently opened files.
- Ability to add an individual `.md` file.
- Ability to register a folder for Markdown discovery.
- Clear indication when a file is already open.
- Keyboard navigation (up/down, Enter, Escape).
- A way to open the selected tracker or focus its existing window.

Suggested default shortcut: `Cmd/Ctrl + Shift + Space`, but make it configurable and handle registration failures gracefully if another application or OS feature already owns the shortcut.

---

# 5. Floating-window requirements

Each registered Markdown file should have its own independent window.

Example:

```text
tracker-001 -> ~/Documents/AI_Learning_Roadmap.md
tracker-002 -> ~/Projects/Project_Tracker.md
tracker-003 -> ~/Trading/Trading_Playbook.md
```

Required behaviour:

- Small, compact window rather than a full-screen interface.
- Always-on-top while visible, where supported.
- Frameless/custom window chrome where practical.
- Draggable by a defined title/header region.
- Resizable with sensible minimum dimensions.
- Independent scrolling.
- Hide/show without destroying application state.
- Close a tracker window without quitting the background application.
- Focus an existing window when its file is selected again.
- Prevent duplicate windows for the same canonical file path.
- Remember window position and dimensions.
- Restore registered trackers after application restart, but do not necessarily show every tracker automatically unless configured.
- Provide a clear close/hide affordance and keyboard-accessible controls.

Persist per-window settings such as:

- Stable tracker ID.
- Canonical file path.
- Window width and height.
- Window x/y position, where valid.
- Last-opened timestamp.
- Theme or display preferences, if per-window themes are supported.

Window positions may become invalid when a monitor is disconnected or display arrangement changes. Validate saved positions and recover off-screen windows to a visible location.

Do not assume native window behaviour is identical on macOS and Windows. Encapsulate platform-specific behaviour behind a window-management layer and test it on both platforms.

---

# 6. Markdown rendering requirements

Use **CommonMark plus GitHub Flavored Markdown (GFM)** as the initial supported baseline.

Support at least:

- Heading levels 1–6.
- Paragraphs and line breaks.
- Bold, italic, and strikethrough.
- Ordered and unordered lists.
- Nested lists.
- Task lists and checkboxes.
- Tables.
- Blockquotes.
- Horizontal rules.
- Inline code.
- Fenced code blocks.
- Syntax highlighting.
- Links.
- Images.
- Escaped Markdown characters.
- Long documents and independent scrolling.

Mathematical expressions using LaTeX are a desirable extension. Implement them if the selected Markdown pipeline supports them cleanly; otherwise document them as a post-MVP enhancement.

Use a proper Markdown parser/renderer. Do not implement Markdown parsing with ad-hoc regular expressions.

Suggested frontend ecosystem:

- `remark`
- `remark-gfm`
- `react-markdown`
- `remark-math` and `rehype-katex` for math, if included
- Shiki or another maintained syntax-highlighting solution

Evaluate dependency compatibility and security before selecting exact versions.

## Rendering and layout

- The renderer must be independent of the visual theme.
- Long tables and code blocks must not break the window layout.
- Images should fit the available content width while preserving aspect ratio.
- Links should open through a safe external-link flow.
- Large content should scroll inside the tracker window, not expand the window indefinitely.
- Avoid unsafe HTML rendering by default. If raw HTML support is ever added, sanitize it and document the security implications.
- Handle missing images and inaccessible local resources gracefully.

---

# 7. Interactive task checkboxes and progress

This is a primary feature, not a decorative checkbox.

Given:

```markdown
# AI Learning Roadmap

## Phase 1: Mathematics

- [x] Linear Algebra
- [x] Probability Theory
- [ ] Statistical Inference
- [ ] Optimization

## Phase 2: Machine Learning

- [ ] Regression
- [ ] Decision Trees
- [ ] Neural Networks
- [ ] Transformers
```

The widget should render the checkboxes as interactive controls.

When a checkbox is clicked:

1. Update the visible checkbox immediately.
2. Recalculate progress.
3. Update any relevant section-level progress.
4. Persist the corresponding task-state change to the original `.md` file.
5. Confirm the write succeeded, or roll back/show an error if it failed.

Progress can be displayed as `2/8 completed` and a visual progress bar.

Important details:

- Count actual Markdown task-list items, not ordinary bullet points.
- Support nested task lists.
- Preserve checked and unchecked states when reopening.
- Do not change unrelated Markdown formatting.
- Avoid changing the entire document's formatting just to update one checkbox.
- Ensure a task interaction cannot accidentally toggle a different task after the document is edited externally.

## Safe source updates

Prefer source-position-aware updates.

A suitable approach is:

- Parse Markdown and retain source positions for task-list markers.
- Identify the exact checkbox token (`[ ]` or `[x]`) associated with the clicked task.
- Verify the file version/hash still matches the version from which the source position was derived.
- Apply a minimal text replacement.
- If the source has changed, re-read and re-parse before attempting the update.
- Write safely, using a temporary file and atomic replacement where appropriate and supported.
- Preserve line endings and encoding where possible.

Do not serialize the entire AST back into Markdown after every checkbox interaction if that would reformat unrelated content.

---

# 8. Filesystem synchronization

Implement bidirectional synchronization between the widget and the original Markdown file.

## External edit flow

If a file is open in the widget and the user edits it externally:

1. Filesystem watcher receives a change event.
2. Debounce events because editors may write files in multiple steps.
3. Re-read the file.
4. Compare its content hash with the last known version.
5. Ignore unchanged content and events caused by the application's own write.
6. Parse the latest Markdown.
7. Refresh the corresponding window.
8. Preserve the user's scroll position where practical.

Use a native filesystem watcher through Rust, such as the `notify` crate, or another maintained cross-platform equivalent.

Avoid continuously polling every file.

## Concurrent modification and conflict safety

This area requires careful engineering.

Example: the user checks a task in the widget while VS Code modifies the same Markdown file.

Required safety behaviour:

- Maintain a known content hash/version for each open file.
- Serialize writes for a given file.
- Before applying a checkbox update, verify that the source version has not changed unexpectedly.
- If the file changed externally, re-read and re-parse it before applying an update.
- If the intended task can still be identified unambiguously, apply the minimal update to the latest content.
- If it cannot be identified safely, do not overwrite the file. Refresh the widget and notify the user that the edit could not be applied automatically.
- Never silently discard external edits.
- Never silently overwrite a newer version with stale content.

A full three-way merge system is not required for the MVP. Safe detection and a clear reload/reconciliation path are sufficient.

## File deletion and movement

Handle these cases:

- File is deleted while open.
- File is renamed or moved.
- Parent folder is unavailable.
- File becomes temporarily inaccessible.
- File is replaced by another file at the same path.

Show a useful status/error state. Do not crash or silently recreate a deleted file.

---

# 9. Visual design system

The reference direction is a compact retro/pixel-art desktop interface.

## Visual principles

- Warm cream/off-white surfaces.
- Muted red/coral primary accent.
- Dark, high-contrast borders.
- Pixel-inspired typography, used selectively for titles and controls.
- Retro progress bars and checkbox styling.
- Compact spacing and clear hierarchy.
- Subtle shadows to distinguish the floating window from the desktop.
- Minimal controls; no unnecessary dashboard chrome.

Potential themes:

1. Retro Red — primary theme inspired by the reference.
2. Pixel Dark — dark retro variant.
3. Optional neutral theme later.

## Important design constraints

- The app must remain readable at small window dimensions.
- Pixel fonts should not reduce readability for long paragraphs or code.
- Markdown content should remain legible even when it is not styled like a retro game.
- Use sensible minimum window sizes.
- Keep the title/header compact.
- Use a distinct scrollable content region.
- Avoid making the entire window look like a keyboard illustration; the supplied image is a visual reference, not a literal layout specification.

The design should feel intentional and cohesive, not like a generic web page placed inside a desktop window.

---

# 10. Recommended technical architecture

## Preferred stack

| Layer | Technology | Responsibility |
|---|---|---|
| Desktop runtime | Tauri 2 | Native application, windows, lifecycle |
| Frontend | React + TypeScript | Launcher and tracker interfaces |
| Native/backend logic | Rust | File operations, watchers, window coordination |
| Markdown parsing | remark / unified ecosystem | Markdown parsing and GFM |
| Rendering | react-markdown | Render Markdown as React components |
| Syntax highlighting | Shiki or maintained alternative | Code blocks |
| Math rendering | KaTeX ecosystem, optional | LaTeX |
| Filesystem watcher | Rust `notify` or equivalent | External file changes |
| App metadata | SQLite or lightweight local store | Registered paths, preferences, window state |
| Styling | CSS / CSS variables | Retro themes and responsive layout |

Tauri is the recommended starting point because the product needs native desktop windows, global shortcuts, local filesystem access, and cross-platform packaging without the overhead of a full browser runtime.

Electron is not the default recommendation for this project. Reconsider only if a concrete Tauri limitation makes it necessary.

## Architecture overview

```text
                    GLOBAL KEYBOARD SHORTCUT
                              |
                              v
                     SEARCHABLE LAUNCHER
                              |
                              v
                      FILE REGISTRY
                              |
                              v
                        WINDOW MANAGER
                         /    |    \
                        /     |     \
                       v      v      v
                    Window  Window  Window
                       1      2      N
                       |      |      |
                       +------+------+
                              |
                              v
                       MARKDOWN RENDERER
                              |
                              v
                       INTERACTIVE AST
                              |
                              v
                      TASK INTERACTION LAYER
                              |
                              v
                      MARKDOWN FILE SERVICE
                         /            \
                        v              v
                  READ / WRITE     FILE WATCHER
                        |              |
                        +------v-------+
                         LOCAL .MD FILES

                  LOCAL APP SETTINGS STORE
                  - registered files
                  - window state
                  - shortcut
                  - preferences
```

## Separation of responsibilities

### Frontend

Responsible for:

- Launcher UI.
- Search and file selection.
- Tracker window content.
- Markdown rendering.
- Checkbox interaction.
- Progress indicators.
- Theme and display preferences.
- User-facing errors and sync status.

### Rust/native layer

Responsible for:

- Global shortcut registration.
- Creating, showing, hiding, focusing and closing native windows.
- Filesystem access.
- File watching.
- Safe file writes.
- Content hashes and synchronization coordination.
- Persistent application settings.
- Platform-specific behaviour.

The frontend should not be allowed to read and write arbitrary filesystem paths without controlled native commands and appropriate permissions.

## Suggested repository layout

Adapt this to the existing repository if one exists.

```text
markdown-desktop/
├── src/
│   ├── app/
│   ├── components/
│   │   ├── Launcher/
│   │   ├── TrackerWindow/
│   │   ├── MarkdownRenderer/
│   │   ├── TaskCheckbox/
│   │   ├── ProgressBar/
│   │   └── WindowControls/
│   ├── hooks/
│   ├── services/
│   │   ├── markdownParser.ts
│   │   ├── markdownSync.ts
│   │   ├── fileRegistry.ts
│   │   └── windowManager.ts
│   ├── themes/
│   ├── types/
│   └── styles/
│
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   ├── filesystem/
│   │   ├── watcher/
│   │   ├── windows/
│   │   ├── database/
│   │   └── lib.rs
│   ├── capabilities/
│   └── tauri.conf.json
│
├── tests/
├── docs/
├── README.md
└── package.json
```

Keep modules cohesive. Avoid creating files or abstractions that do not have a clear responsibility.

---

# 11. Data model

The Markdown content itself must not be duplicated into the application database as the authoritative copy.

Use local application storage only for metadata.

A possible schema:

## `tracked_files`

- `id`: stable application-generated identifier.
- `canonical_path`: canonical path to the Markdown file.
- `display_name`: user-facing file name.
- `registered_at`: registration timestamp.
- `last_opened_at`: last-opened timestamp.
- `is_favorite`: optional preference.

## `window_state`

- `tracker_id`: associated tracked-file ID.
- `width`
- `height`
- `x`
- `y`
- `theme`
- `last_visibility_state`, if useful.

## `app_settings`

- Global shortcut.
- Theme default.
- Startup preference.
- Folder-discovery settings.
- Other application-level preferences.

Use migrations if SQLite is selected. Keep the data model small and avoid building a complicated database layer for simple settings.

---

# 12. Security, privacy and reliability

- The application should work offline.
- Do not upload Markdown content to any server.
- Do not introduce analytics or telemetry by default.
- Request only the filesystem access actually needed.
- Validate paths and handle symlinks carefully.
- Sanitize or safely handle external links and images.
- Avoid unsafe raw HTML rendering.
- Never overwrite a file based on stale content.
- Handle permission errors and locked files gracefully.
- Keep the application responsive while parsing or watching large files.
- Do not crash if a file becomes unavailable.
- Do not expose local file contents through unnecessary logs.

---

# 13. Performance expectations

The application is intended to be lightweight.

Design for:

- Low idle CPU usage.
- No unnecessary background polling.
- Efficient filesystem watching.
- Lazy rendering or other sensible strategies for large documents.
- No duplicate native windows for the same file.
- Efficient refreshes rather than rebuilding every window after one file changes.
- No heavy backend server or cloud dependency.

Do not optimize prematurely. Establish basic measurements and investigate real bottlenecks.

---

# 14. Development milestones

Build the product incrementally.

## Milestone 1 — Desktop foundation

- Scaffold Tauri 2 + React + TypeScript.
- Confirm macOS development build.
- Confirm Windows build configuration.
- Implement background application lifecycle.
- Implement global shortcut.
- Implement searchable launcher.
- Add individual Markdown file selection.
- Open one Markdown file in a compact floating window.
- Implement dragging, resizing, hide/show and focus.
- Ensure selecting an already-open file focuses its existing window.

**Acceptance:** A user can summon the launcher, choose a Markdown file, and view it in a separate floating desktop window.

## Milestone 2 — Markdown rendering

- Add CommonMark and GFM.
- Render headings, paragraphs, lists, tables, links, images, quotes, code blocks and task lists.
- Add syntax highlighting.
- Add scrolling and sensible layout constraints.
- Add the first retro theme.

**Acceptance:** A representative Markdown test document renders correctly in the floating window.

## Milestone 3 — Interactive tasks

- Make Markdown task checkboxes interactive.
- Calculate total and completed tasks.
- Add progress bar.
- Persist checkbox updates to the original Markdown file.
- Preserve unrelated source formatting.
- Add tests for nested and mixed task lists.

**Acceptance:** Checking a task changes the original file without reformatting unrelated content.

## Milestone 4 — External synchronization

- Add native filesystem watcher.
- Add debounce and self-write suppression.
- Add content hash/version tracking.
- Refresh the appropriate window on external changes.
- Handle concurrent changes safely.
- Handle deleted, moved and inaccessible files.

**Acceptance:** External edits appear in the widget without restarting the app, and conflicting edits are never silently overwritten.

## Milestone 5 — Persistence and polish

- Add file registry.
- Add folder-based discovery.
- Persist window dimensions and position.
- Add system tray/menu-bar controls.
- Add theme preferences.
- Add compact mode if time permits.
- Improve keyboard navigation and accessibility.

**Acceptance:** Registered trackers and preferences survive application restarts.

## Milestone 6 — Packaging and release

- Package for macOS.
- Package for Windows.
- Test global shortcuts on both platforms.
- Test always-on-top and window behaviour on both platforms.
- Test filesystem synchronization on both platforms.
- Document installation and known limitations.
- Produce a release checklist.

**Acceptance:** A user can install and use the app on either supported OS without needing a development environment.

---

# 15. Testing strategy

Create automated tests for the logic that can be tested without a native desktop session.

At minimum, cover:

### Markdown tests

- All supported Markdown elements.
- GFM tables and task lists.
- Nested task lists.
- Empty files.
- Very long files.
- Malformed Markdown.
- Unicode and non-English content.
- Different line endings (LF and CRLF).

### File update tests

- Toggle unchecked to checked.
- Toggle checked to unchecked.
- Update a nested checkbox.
- Preserve unrelated formatting.
- Preserve line endings.
- Detect stale source positions.
- Handle missing and read-only files.
- Handle external modifications during a task update.

### Synchronization tests

- External edit refreshes the correct tracker.
- Self-generated write does not cause an unnecessary refresh loop.
- Multiple quick file writes are debounced.
- Concurrent edits do not silently overwrite changes.
- Deleted files produce a recoverable error state.

### Window tests

- Opening a tracker.
- Focusing an existing tracker.
- Preventing duplicate windows.
- Hiding and restoring.
- Persisting dimensions and position.
- Recovering an off-screen window.

### Platform tests

At least one real macOS and one real Windows test pass is required before claiming cross-platform release readiness.

---

# 16. Explicitly out of scope for the initial MVP

Do not build these unless requested later:

- User accounts or authentication.
- Cloud synchronization.
- Collaboration or sharing.
- AI-generated task extraction.
- AI summaries.
- Built-in calendar or reminders.
- Full project-management features.
- A web application.
- A hosted backend.
- Mobile applications.
- A full Markdown authoring editor.
- Complex plugin architecture.
- Automatic scanning of the entire computer.

Keep the architecture extensible, but do not implement speculative features.

---

# 17. Definition of done

The MVP is complete when:

1. It runs as a background desktop application.
2. A configurable global shortcut opens the launcher.
3. Users can register local Markdown files.
4. Multiple files can have independent floating windows.
5. The same file cannot accidentally create duplicate windows.
6. Windows can be moved, resized, hidden and restored.
7. CommonMark and GFM content renders correctly.
8. Task checkboxes are interactive.
9. Checkbox changes are written back to the original Markdown file.
10. External edits are detected and reflected automatically.
11. Concurrent modifications are handled without silent data loss.
12. Window settings persist across restarts.
13. The retro visual system is cohesive and readable.
14. macOS and Windows builds are tested.
15. Setup, usage and known limitations are documented.

---

# 18. Instructions for the coding agent

Before implementation, return:

1. Your understanding of the product in your own words.
2. Your proposed architecture based on the actual repository.
3. Any changes you recommend to this specification, with reasons.
4. A milestone-based implementation plan.
5. Platform-specific risks you have identified.
6. Dependencies you intend to introduce.

Then begin implementation with **Milestone 1 only**.

Do not attempt to implement every milestone in one giant change. After each milestone:

- Run tests and type checks.
- Report what works.
- Report what remains incomplete.
- Identify platform-specific gaps.
- Keep the application runnable.

When a requirement is ambiguous, choose the simplest behaviour consistent with this specification, document the assumption, and continue unless the ambiguity could cause data loss or a major architectural decision.

**Final product test:** A user should be able to press a keyboard shortcut while working in any application, summon a small retro-styled Markdown tracker, interact with its checklist, and return to their work without opening a full-screen application.

The product should be small in experience, dependable in engineering, and useful every day.
