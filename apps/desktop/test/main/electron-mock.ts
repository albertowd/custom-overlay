// Stand-in for the `electron` module in main process and preload tests:
//   vi.mock('electron', () => import('./electron-mock'));
// IPC handlers registered with ipcMain.handle are kept in `handlers`, run them with `invoke`.
// One instance per test file (kept on globalThis), so it survives vi.resetModules().
import { vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

function create() {
  /** Folders returned by app.getPath, by name (`/system/<name>` when not set). */
  const paths: Record<string, string> = {};

  const app = {
    isPackaged: false,
    getPath: vi.fn((name: string) => paths[name] ?? `/system/${name}`),
    getVersion: vi.fn(() => '1.2.0'),
    getPreferredSystemLanguages: vi.fn((): string[] => ['en-US']),
    commandLine: { appendSwitch: vi.fn((..._args: unknown[]): void => undefined) },
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn((..._args: unknown[]): void => undefined),
    quit: vi.fn((..._args: unknown[]): void => undefined),
  };

  /** Listeners of `app.on`, by event. */
  function appListener(event: string): Listener {
    const call = app.on.mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`No app listener for ${event}`);
    return call[1] as Listener;
  }

  const handlers = new Map<string, Listener>();

  const ipcMain = {
    handle: vi.fn((channel: string, handler: Listener) => {
      handlers.set(channel, handler);
    }),
  };

  class FakeWebContents {
    readonly listeners = new Map<string, Listener>();
    url = 'app://index.html';
    destroyed = false;
    readonly send = vi.fn((..._args: unknown[]): void => undefined);
    readonly setWindowOpenHandler = vi.fn((..._args: unknown[]): void => undefined);
    isDestroyed(): boolean {
      return this.destroyed;
    }
    getURL(): string {
      return this.url;
    }
    on(event: string, listener: Listener): this {
      this.listeners.set(event, listener);
      return this;
    }
  }

  class BrowserWindow {
    static instances: BrowserWindow[] = [];
    /** Window returned by fromWebContents (null: the request has no window). */
    static current: BrowserWindow | null = null;
    static fromWebContents = vi.fn((): BrowserWindow | null => BrowserWindow.current);
    static getAllWindows = vi.fn((): BrowserWindow[] => BrowserWindow.instances);

    readonly webContents = new FakeWebContents();
    readonly listeners = new Map<string, Listener>();
    readonly onceListeners = new Map<string, Listener>();
    readonly show = vi.fn((..._args: unknown[]): void => undefined);
    readonly loadURL = vi.fn(async () => undefined);
    readonly loadFile = vi.fn(async () => undefined);

    constructor(readonly options: Record<string, unknown> = {}) {
      BrowserWindow.instances.push(this);
    }
    on(event: string, listener: Listener): this {
      this.listeners.set(event, listener);
      return this;
    }
    once(event: string, listener: Listener): this {
      this.onceListeners.set(event, listener);
      return this;
    }
  }

  const dialog = {
    showOpenDialog: vi.fn(
      async (..._args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> => ({
        canceled: true,
        filePaths: [],
      }),
    ),
    showSaveDialog: vi.fn(
      async (..._args: unknown[]): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true }),
    ),
    showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 0, checkboxChecked: false })),
    showMessageBoxSync: vi.fn((..._args: unknown[]) => 0),
  };

  const shell = {
    showItemInFolder: vi.fn((..._args: unknown[]): void => undefined),
    openExternal: vi.fn(async () => undefined),
  };

  const protocol = {
    registerSchemesAsPrivileged: vi.fn((..._args: unknown[]): void => undefined),
    handle: vi.fn((..._args: unknown[]): void => undefined),
  };

  const contextBridge = { exposeInMainWorld: vi.fn((..._args: unknown[]): void => undefined) };

  const ipcRenderer = {
    invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    on: vi.fn((..._args: unknown[]): void => undefined),
    removeListener: vi.fn((..._args: unknown[]): void => undefined),
  };

  const webUtils = { getPathForFile: vi.fn((file: { name: string }) => `/picked/${file.name}`) };

  return {
    paths,
    app,
    appListener,
    handlers,
    ipcMain,
    FakeWebContents,
    BrowserWindow,
    dialog,
    shell,
    protocol,
    contextBridge,
    ipcRenderer,
    webUtils,
  };
}

const holder = globalThis as { electronMock?: ReturnType<typeof create> };
holder.electronMock ??= create();
const mock = holder.electronMock;

export const {
  paths,
  app,
  appListener,
  handlers,
  ipcMain,
  FakeWebContents,
  BrowserWindow,
  dialog,
  shell,
  protocol,
  contextBridge,
  ipcRenderer,
  webUtils,
} = mock;
export type BrowserWindow = InstanceType<typeof BrowserWindow>;
export type FakeWebContents = InstanceType<typeof FakeWebContents>;

/** Run the IPC handler of a channel as the window `BrowserWindow.current` would. */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  const sender = BrowserWindow.current?.webContents ?? new FakeWebContents();
  return (await handler({ sender }, ...args)) as T;
}

export default mock;
