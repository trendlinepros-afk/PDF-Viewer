# PDF Viewer Pro

A free, full-featured, browser-based replacement for the premium Adobe PDF viewer.
Built on [Mozilla PDF.js](https://mozilla.github.io/pdf.js/) — no installation,
no subscription, no account. Just open `index.html`.

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
- Comments panel listing every annotation, with jump-to and delete
- Annotations **persist automatically** (per document, stored locally in your browser)
- Hand tool for drag-to-pan

### Document tools
- **Print** with high-resolution page rendering (`Ctrl+P`)
- **Save / download** a copy (`Ctrl+S`)
- **Document properties** dialog: title, author, creation date, producer,
  PDF version, page count, file size (`Ctrl+I`)

### Interface
- **Light / dark mode** toggle (remembers your choice, follows system preference by default)
- **Check for updates** button in the lower-left status bar
- Keyboard-shortcut reference (press `?`)
- Responsive Adobe-style toolbar, sidebar, and status bar

## Getting started

Serve the folder with any static file server and open it in a browser:

```bash
# any of these work
python3 -m http.server 8080
npx serve .
```

Then browse to `http://localhost:8080`.

> Opening `index.html` directly from disk (`file://`) also works in most
> browsers, but a local server is recommended so the update checker can run.

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
