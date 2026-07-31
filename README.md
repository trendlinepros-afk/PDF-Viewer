# PDF Viewer Pro

A free, full-featured **Windows desktop application** that replaces the premium
Adobe PDF viewer. Built with Electron and [Mozilla PDF.js](https://mozilla.github.io/pdf.js/) —
no subscription, no account.

## Installation (Windows)

1. Go to the [latest release](https://github.com/trendlinepros-afk/PDF-Viewer/releases/latest).
2. Download either installer:
   - **`PDF-Viewer-Pro-Setup-<version>.exe`** — standard installer (recommended;
     supports in-app auto-update)
   - **`PDF-Viewer-Pro-<version>.msi`** — MSI package (for enterprise / GPO deployment)
3. Run it. The app registers itself as a viewer for `.pdf` files, so you can
   double-click any PDF or right-click → *Open with → PDF Viewer Pro*.

Installers are built automatically by GitHub Actions
(`.github/workflows/build-windows.yml`) whenever a `v*` tag is pushed.

## Features

### Viewing
- Open PDFs via file picker (`Ctrl+O`) or **drag & drop** anywhere in the window
- **Continuous scroll**, **single page**, and **two-page** view modes
- Zoom: presets 50–400%, **Fit Width**, **Fit Page**, **Automatic**, `Ctrl` + mouse wheel,
  and keyboard (`Ctrl` `+` / `Ctrl` `-`)
- Page **rotation** (clockwise / counterclockwise)
- **Presentation mode** (fullscreen, `F5`) with arrow-key navigation
- Crisp high-DPI rendering (retina-aware)

### Navigation
- Page thumbnails sidebar with live current-page tracking
- **Bookmarks / outline** panel (from the PDF's table of contents)
- Jump-to-page box, previous/next buttons, `Home`/`End`, arrow keys
- Full-text **search** (`Ctrl+F`) with match count, highlight-all, and
  next/previous match navigation

### Annotation & commenting
- **Highlight** text in any color
- **Freehand drawing** (pen tool)
- **Sticky notes** with editable pop-up text
- **Undo / redo** for all annotation actions (`Ctrl+Z` / `Ctrl+Y`)
- Comments panel listing every annotation, with jump-to and delete
- Annotations **persist automatically** (per document, stored locally in your browser)
- Hand tool for drag-to-pan

### Document tools
- **Print** with high-resolution page rendering (`Ctrl+P`)
- **Save / download** a copy (`Ctrl+S`)
- **Document properties** dialog: title, author, creation date, producer,
  PDF version, page count, file size (`Ctrl+I`)

### AI
- **AI Summary** — one click summarizes the open document using Google Gemini
  (overview, key points, action items). Bring your own free API key from
  aistudio.google.com/apikey.
- **Settings menu** (top right) manages theme, AI model, and the API key —
  the key is stored only on your device and is never displayed after saving,
  but can be replaced or removed at any time.

### Interface
- **Light / dark mode** toggle (remembers your choice, follows system preference by default)
- **Check for updates** button in the lower-left status bar
- Keyboard-shortcut reference (press `?`)
- Responsive Adobe-style toolbar, sidebar, and status bar

### Desktop extras
- Native Windows app with **EXE and MSI installers**
- `.pdf` **file association** — double-click PDFs to open them
- Native menu bar (File / Edit / View / Help) with standard accelerators
- Single-instance app: opening another PDF reuses the running window

## Developing

```bash
npm install        # installs Electron + electron-builder
npm start          # run the desktop app locally
npm run dist       # build Windows EXE + MSI installers into dist/ (run on Windows)
```

Release flow: bump `version` in `package.json`, `js/app.js` (`APP_VERSION`),
and `version.json`, then push a matching tag (e.g. `v1.1.0`) or run the
*Build Windows Installers* workflow manually. GitHub Actions builds the
installers on a Windows runner and attaches them (plus the `latest.yml`
auto-update manifest) to the release.

**Check for updates** (lower-left button or *Help* menu) uses that manifest:
the installed app downloads the new version in the background and then asks
whether to **close and reopen now** to finish installing, or wait — in which
case it installs automatically the next time you quit the app.

The viewer core is plain HTML/CSS/JS, so it also runs in a browser for quick
development: `python3 -m http.server 8080` and open `http://localhost:8080`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open file |
| `Ctrl+S` | Save / download |
| `Ctrl+P` | Print |
| `Ctrl+F` | Find in document |
| `←` / `→` | Previous / next page |
| `Home` / `End` | First / last page |
| `Ctrl` `+` / `Ctrl` `-` | Zoom in / out |
| `Ctrl+0` | Fit width |
| `R` / `Shift+R` | Rotate right / left |
| `F4` | Toggle sidebar |
| `F5` | Presentation mode |
| `V` `H` `D` `N` | Select / Hand / Draw / Note tool |
| `?` | Shortcut help |

## Updates

The **Check for updates** button (lower-left) compares your running version
against `version.json` on the `main` branch of this repository and tells you
if a newer release is available.
