const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;
const SERVER_URL = 'http://127.0.0.1:3000';

function startServer() {
  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    env: { ...process.env, PORT: '3000' },
    stdio: 'pipe'
  });

  serverProcess.stdout.on('data', (data) => {
    console.log('Server:', data.toString());
  });

  serverProcess.stderr.on('data', (data) => {
    console.error('Server error:', data.toString());
  });
}

function waitForServer(url, onReady, attempt = 0) {
  http.get(url, (res) => {
    onReady();
  }).on('error', () => {
    if (attempt > 60) {
      console.error('El servidor no respondió a tiempo');
      if (mainWindow) {
        mainWindow.loadURL('data:text/html,<h1 style="font-family:sans-serif;padding:40px">El servidor no arranco. Cierra y vuelve a abrir.</h1>');
        mainWindow.show();
      }
      return;
    }
    setTimeout(() => waitForServer(url, onReady, attempt + 1), 300);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'NalessS\u266b\u266b',
    backgroundColor: '#e8ecd6',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
    show: false,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  waitForServer(SERVER_URL, () => {
    mainWindow.loadURL(SERVER_URL);
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});
