const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const INDEX_PATH = path.join(__dirname, 'index.html');
const DATA_FILE_NAME = 'board-preventivos-data.json';

let watcher = null;
let mainWin = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 600,
    title: 'Board de Cards Preventivos',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWin = win;

  // Bloqueia navegação da janela principal para fora do app.
  win.webContents.on('will-navigate', (event, url) => {
    const fileUrl = require('url').pathToFileURL(INDEX_PATH).href;
    if (url !== fileUrl) event.preventDefault();
  });

  // Bloqueia window.open / target=_blank dentro do renderer.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile('index.html');
  win.setMenuBarVisibility(false);

  win.on('closed', () => {
    if (watcher) { watcher.close(); watcher = null; }
    mainWin = null;
  });
}

// ─── Abrir URL externa (Sprint/Card hiperlinkáveis) ────────────────────
// Só aceita http/https para evitar execução de protocolos arbitrários.
ipcMain.handle('open-external', async (_event, url) => {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid-url' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'disallowed-protocol' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

// ─── Persistência em arquivo compartilhado (OneDrive/SharePoint/rede) ──
function dataFilePath(folderPath) {
  return path.join(folderPath, DATA_FILE_NAME);
}

// Seleciona a pasta compartilhada via diálogo nativo do SO.
ipcMain.handle('data:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWin, {
    title: 'Selecionar pasta compartilhada (OneDrive / SharePoint / rede)',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, folderPath: result.filePaths[0] };
});

// Lê o arquivo de dados da pasta compartilhada. Se ainda não existir
// (primeira vez que alguém aponta para essa pasta), retorna data: null,
// sem erro — o renderer trata isso como "arquivo novo, ainda vazio".
ipcMain.handle('data:read', async (_event, folderPath) => {
  try {
    const p = dataFilePath(folderPath);
    if (!fs.existsSync(p)) return { ok: true, data: null };
    const raw = fs.readFileSync(p, 'utf8');
    const stat = fs.statSync(p);
    return { ok: true, data: JSON.parse(raw), mtimeMs: stat.mtimeMs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Escreve o arquivo de dados de forma atômica (grava em .tmp e renomeia)
// para reduzir o risco de o OneDrive sincronizar um arquivo parcialmente
// escrito no meio de uma gravação.
ipcMain.handle('data:write', async (_event, folderPath, data) => {
  try {
    const p = dataFilePath(folderPath);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    const stat = fs.statSync(p);
    return { ok: true, mtimeMs: stat.mtimeMs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Observa a pasta compartilhada; quando o arquivo muda (porque outra
// colega salvou e o OneDrive sincronizou), avisa o renderer para recarregar.
ipcMain.handle('data:watch-start', (event, folderPath) => {
  try {
    if (watcher) { watcher.close(); watcher = null; }
    const dir = folderPath;
    let debounce = null;
    watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
      if (filename !== DATA_FILE_NAME) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.webContents.send('data:changed');
      }, 400);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('data:watch-stop', () => {
  if (watcher) { watcher.close(); watcher = null; }
  return { ok: true };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => { app.quit(); });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
