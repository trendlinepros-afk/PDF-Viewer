/* PDF Viewer Pro — Electron main process */
'use strict';

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let pendingFile = null;

/* ==================== Auto-update ==================== */
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function runUpdateCheck() {
  // in dev / unpackaged runs the renderer falls back to its web-based check
  if (!app.isPackaged) return { status: 'unpackaged' };

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    return { status: 'error', message: String(err.message || err) };
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  try {
    const check = await autoUpdater.checkForUpdates();
    const latest = check && check.updateInfo && check.updateInfo.version;

    if (!latest || !isNewer(latest, app.getVersion())) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Check for Updates',
        message: "You're up to date!",
        detail: `PDF Viewer Pro ${app.getVersion()} is the latest version.`,
      });
      return { status: 'uptodate', version: app.getVersion() };
    }

    // update found — autoDownload is on, so wait for the download to finish
    const info = await new Promise((resolve, reject) => {
      const onDone = (i) => { autoUpdater.removeListener('error', onErr); resolve(i); };
      const onErr = (e) => { autoUpdater.removeListener('update-downloaded', onDone); reject(e); };
      autoUpdater.once('update-downloaded', onDone);
      autoUpdater.once('error', onErr);
    });

    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready to install',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Close and reopen the app now to finish installing the update, ' +
        'or keep working — it will install automatically the next time you quit.',
      buttons: ['Close and reopen now', "I'll do it on my own"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall());
    return { status: 'downloaded', version: info.version };
  } catch (err) {
    return { status: 'error', message: String((err && err.message) || err) };
  }
}

let updateCheckInFlight = null;
ipcMain.handle('check-updates', () => {
  if (!updateCheckInFlight) {
    updateCheckInFlight = runUpdateCheck().finally(() => { updateCheckInFlight = null; });
  }
  return updateCheckInFlight;
});

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a)) || null;
}

function sendFile(p) {
  try {
    const data = fs.readFileSync(p);
    win.webContents.send('open-file', { name: path.basename(p), data });
  } catch (err) {
    dialog.showErrorBox('Could not open file', String(err.message || err));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    const f = fileFromArgv(argv);
    if (f) sendFile(f);
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

// macOS file-association support
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win) sendFile(p);
  else pendingFile = p;
});

function menuSend(action) {
  if (win) win.webContents.send('menu', action);
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => menuSend('open') },
        { label: 'Save a Copy…', accelerator: 'CmdOrCtrl+S', click: () => menuSend('save') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => menuSend('print') },
        { type: 'separator' },
        { label: 'Document Properties…', accelerator: 'CmdOrCtrl+I', click: () => menuSend('properties') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'copy' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => menuSend('find') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => menuSend('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => menuSend('zoom-out') },
        { type: 'separator' },
        { label: 'Toggle Light / Dark Mode', click: () => menuSend('theme') },
        { label: 'Presentation Mode', accelerator: 'F5', click: () => menuSend('present') },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => menuSend('shortcuts') },
        { label: 'Check for Updates…', click: () => menuSend('update') },
        { type: 'separator' },
        {
          label: 'About PDF Viewer Pro',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About PDF Viewer Pro',
              message: 'PDF Viewer Pro',
              detail: `Version ${app.getVersion()}\n\nA free, full-featured PDF viewer.\nBuilt with Electron and Mozilla PDF.js.`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1a1b1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile('index.html');

  // external links (e.g. the release download link) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    const f = pendingFile || fileFromArgv(process.argv);
    pendingFile = null;
    if (f) sendFile(f);
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
