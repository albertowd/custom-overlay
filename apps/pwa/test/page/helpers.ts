import { vi } from 'vitest';

/** What a dismissed browser picker rejects with. */
export const abortError = () => new DOMException('The user aborted a request.', 'AbortError');

export interface FakeFileHandle extends FileSystemFileHandle {
  /** Everything written to the file, one entry per write. */
  written: unknown[];
}

/** A File System Access file handle over `file`, granting or denying write access. */
export function fileHandle(file: File, permission: PermissionState = 'granted'): FakeFileHandle {
  const written: unknown[] = [];
  const handle = {
    kind: 'file',
    name: file.name,
    written,
    getFile: async () => file,
    createWritable: async () => ({
      write: async (data: unknown) => {
        written.push(data);
      },
      close: async () => undefined,
    }),
    queryPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => permission),
  };
  return handle as unknown as FakeFileHandle;
}

export interface FakeFolderHandle extends FileSystemDirectoryHandle {
  /** Files written into the folder, by name. */
  files: Map<string, FakeFileHandle>;
}

/** A File System Access folder handle that keeps what is written into it. */
export function folderHandle(name: string, permission: PermissionState = 'granted'): FakeFolderHandle {
  const files = new Map<string, FakeFileHandle>();
  const handle = {
    kind: 'directory',
    name,
    files,
    getFileHandle: async (fileName: string) => {
      let file = files.get(fileName);
      if (!file) {
        file = fileHandle(new File([], fileName));
        files.set(fileName, file);
      }
      return file;
    },
    queryPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => permission),
  };
  return handle as unknown as FakeFolderHandle;
}

/**
 * File inputs answer as if the user picked `picked` (null: cancelled). Returns the last input
 * clicked.
 */
export function mockFileInput(picked: File[] | null): () => HTMLInputElement {
  let last: HTMLInputElement | null = null;
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    last = this;
    if (picked) {
      Object.defineProperty(this, 'files', { value: picked });
      this.dispatchEvent(new Event('change'));
    } else {
      this.dispatchEvent(new Event('cancel'));
    }
  });
  return () => {
    if (!last) throw new Error('No file input was clicked');
    return last;
  };
}

/** Object URLs (jsdom has none) and the links clicked for downloads. */
export function mockLinkClicks(): HTMLAnchorElement[] {
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${++next}`);
  URL.revokeObjectURL = vi.fn();
  const clicks: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push(this);
  });
  return clicks;
}
