/* PDF Viewer Pro — Electron main process */
'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let pendingFile = null;

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
