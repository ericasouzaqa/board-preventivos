const { app, BrowserWindow } = require('electron');
const path = require('path');

// Único arquivo local que a janela pode carregar/navegar.
const INDEX_PATH = path.join(__dirname, 'index.html');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: 'Painel de Qualidade Preventiva',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Bloqueia navegação para fora do arquivo local da aplicação
  // (mitiga navegação externa em caso de conteúdo malicioso injetado).
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== 'file://' + INDEX_PATH) {
      event.preventDefault();
    }
  });

  // Bloqueia a criação de novas janelas/abas via window.open ou target=_blank.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile('index.html');
  win.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
