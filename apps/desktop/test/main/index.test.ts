import { basename, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, appListener, BrowserWindow, dialog, shell } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('../../src/main/export', () => ({ cancelExport: vi.fn(), exportRunning: vi.fn(() => false) }));
vi.mock('../../src/main/ipc', () => ({ registerIpcHandlers: vi.fn() }));
vi.mock('../../src/main/media-protocol', () => ({
  handleMediaProtocol: vi.fn(),
  registerMediaScheme: vi.fn(),
}));
vi.mock('../../src/main/settings', () => ({ applyChromiumLanguage: vi.fn(), t: (key: string) => key }));

const exportModule = await import('../../src/main/export');
const ipc = await import('../../src/main/ipc');
const media = await import('../../src/main/media-protocol');
const settings = await import('../../src/main/settings');

/** Start the app (a fresh main module) and wait until its window is created. */
async function start(): Promise<BrowserWindow> {
  BrowserWindow.instances = [];
  app.on.mockClear();
  vi.resetModules();
  await import('../../src/main/index');
  await vi.waitFor(() => expect(BrowserWindow.instances).toHaveLength(1));
  return BrowserWindow.instances[0] as BrowserWindow;
}

const event = () => ({ preventDefault: vi.fn() });

beforeEach(() => {
  app.isPackaged = true;
  vi.mocked(exportModule.exportRunning).mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('main process', () => {
  it('prepares the app before it is ready, then registers handlers and opens the window', async () => {
    const window = await start();
    expect(media.registerMediaScheme).toHaveBeenCalled();
    expect(settings.applyChromiumLanguage).toHaveBeenCalled();
    expect(media.handleMediaProtocol).toHaveBeenCalled();
    expect(ipc.registerIpcHandlers).toHaveBeenCalled();
    expect(window.options).toMatchObject({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    expect(window.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[\\/]index\.html$/));

    window.onceListeners.get('ready-to-show')?.();
    expect(window.show).toHaveBeenCalled();
  });

  it('loads the dev server in development', async () => {
    app.isPackaged = false;
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    const window = await start();
    expect(window.loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(window.loadFile).not.toHaveBeenCalled();
  });

  it('shows the app icon instead of the Electron one while developing', async () => {
    expect((await start()).options.icon).toBeUndefined();
    app.isPackaged = false;
    const icon = (await start()).options.icon as string;
    // From out/main to the build resources electron-builder embeds in the executable.
    const expected = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    expect(basename(icon)).toBe(expected);
    expect(basename(dirname(icon))).toBe('build');
    expect(basename(dirname(dirname(icon)))).toBe('desktop');
  });

  it('closes freely without an export', async () => {
    const window = await start();
    const close = event();
    window.listeners.get('close')?.(close);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(close.preventDefault).not.toHaveBeenCalled();
  });

  it('asks before closing during an export: keep exporting, or cancel and close', async () => {
    const window = await start();
    vi.mocked(exportModule.exportRunning).mockReturnValue(true);

    dialog.showMessageBoxSync.mockReturnValueOnce(0);
    const keep = event();
    window.listeners.get('close')?.(keep);
    expect(dialog.showMessageBoxSync).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ title: 'main.closeDuringExport.title', cancelId: 0 }),
    );
    expect(keep.preventDefault).toHaveBeenCalled();
    expect(exportModule.cancelExport).not.toHaveBeenCalled();

    dialog.showMessageBoxSync.mockReturnValueOnce(1);
    const close = event();
    window.listeners.get('close')?.(close);
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(exportModule.cancelExport).toHaveBeenCalled();
  });

  it('opens https links in the browser and never inside the app', async () => {
    const window = await start();
    const handler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
      url: string;
    }) => { action: string };

    expect(handler({ url: 'https://github.com/albertowd/custom-overlay' })).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/albertowd/custom-overlay');
    shell.openExternal.mockClear();
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('never navigates away from the app page', async () => {
    const window = await start();
    const navigate = window.webContents.listeners.get('will-navigate') as (e: unknown, url: string) => void;
    const away = event();
    navigate(away, 'https://example.com');
    expect(away.preventDefault).toHaveBeenCalled();
    const reload = event();
    navigate(reload, window.webContents.getURL());
    expect(reload.preventDefault).not.toHaveBeenCalled();
  });

  it('reopens a window when activated without one (macOS)', async () => {
    await start();
    appListener('activate')();
    expect(BrowserWindow.instances).toHaveLength(1);
    BrowserWindow.instances = [];
    appListener('activate')();
    expect(BrowserWindow.instances).toHaveLength(1);
  });

  it('quits when the last window closes, except on macOS', async () => {
    await start();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    appListener('window-all-closed')();
    expect(app.quit).not.toHaveBeenCalled();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    appListener('window-all-closed')();
    expect(app.quit).toHaveBeenCalled();
  });
});
