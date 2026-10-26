import { join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { cancelExport, exportRunning } from './export';
import { registerIpcHandlers } from './ipc';
import { handleMediaProtocol, registerMediaScheme } from './media-protocol';
import { applyChromiumLanguage, t } from './settings';

registerMediaScheme();
applyChromiumLanguage();

/**
 * The app icon while developing. A packaged app shows the icon built into its executable, but
 * `npm run dev` runs electron.exe, so its window and taskbar button would show Electron's.
 */
function devIcon(platform: NodeJS.Platform = process.platform): string | undefined {
  if (app.isPackaged) return undefined;
  return join(__dirname, '../../build', platform === 'win32' ? 'icon.ico' : 'icon.png');
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#14161a',
    title: 'Custom Overlay',
    icon: devIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Closing during an export would leave ffmpeg writing a broken file: ask first.
  window.on('close', (event) => {
    if (!exportRunning()) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: t('main.closeDuringExport.title'),
      message: t('main.closeDuringExport.message'),
      detail: t('main.closeDuringExport.detail'),
      buttons: [t('main.closeDuringExport.keep'), t('main.closeDuringExport.cancelAndClose')],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 0) event.preventDefault();
    else cancelExport();
  });

  // Never open other pages inside the app: external links go to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  // macOS takes the Dock icon from the app bundle, Electron's own while developing.
  const dockIcon = process.platform === 'darwin' ? devIcon() : undefined;
  if (dockIcon) app.dock?.setIcon(dockIcon);
  handleMediaProtocol();
  registerIpcHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
