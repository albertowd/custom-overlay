import { t } from '@custom-overlay/ui';

/**
 * Browsers never give file paths: the web app knows the files picked or dropped in this tab, by
 * name. A new project stores its media by file name, so the desktop app finds them when the
 * project is saved next to them (it reads paths relative to the project file).
 */
const files = new Map<string, File>();

/** Files that can be written again (File System Access API), by name: saving reuses the file. */
const handles = new Map<string, FileSystemFileHandle>();

/** Pickers remember a folder for each kind of file. */
export type PickerId = 'media' | 'project' | 'template' | 'widget' | 'track' | 'values' | 'export';

export interface FileType {
  description: string;
  /** MIME type → extensions (with the dot). */
  accept: Record<string, string[]>;
}

/**
 * File name of a stored path: projects of the desktop app store paths relative to the project
 * file (`../videos/GX010123.MP4`), so their files are found by name.
 */
export function fileNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** Make a file available to the app; returns the path that stands for it. */
export function addFile(file: File): string {
  files.set(file.name, file);
  return file.name;
}

/** The file a path stands for; throws when it was not picked in this tab. */
export function fileAt(path: string): File {
  const name = fileNameOf(path);
  const file = files.get(name);
  if (!file) throw new Error(t('web.files.notOpen', { name }));
  return file;
}

/** A file picked with `path` that has the same name and `extension` (any case), e.g. DJI subtitles. */
export function companionOf(path: string, extension: string): File | null {
  const wanted =
    fileNameOf(path)
      .replace(/\.[^.]*$/, '')
      .toLowerCase() + extension;
  for (const [name, file] of files) if (name.toLowerCase() === wanted) return file;
  return null;
}

/** Names of every file picked in this tab. */
export function knownFileNames(): string[] {
  return [...files.keys()];
}

export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function pickWithInput(types: FileType[], multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = types.flatMap((type) => Object.values(type.accept).flat()).join(',');
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

/** Ask for files to open (none when cancelled). They become available to the app. */
export async function openFiles(id: PickerId, types: FileType[], multiple = false): Promise<File[]> {
  if (!window.showOpenFilePicker) {
    const picked = await pickWithInput(types, multiple);
    for (const file of picked) addFile(file);
    return picked;
  }
  let picked: FileSystemFileHandle[];
  try {
    picked = await window.showOpenFilePicker({ id, types, multiple });
  } catch (error) {
    if (isAbort(error)) return [];
    throw error;
  }
  return Promise.all(
    picked.map(async (handle) => {
      const file = await handle.getFile();
      handles.set(file.name, handle);
      addFile(file);
      return file;
    }),
  );
}

async function canWrite(handle: FileSystemHandle): Promise<boolean> {
  const mode = { mode: 'readwrite' } as const;
  if ((await handle.queryPermission?.(mode)) === 'granted') return true;
  return (await handle.requestPermission?.(mode)) === 'granted';
}

async function write(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const stream = await handle.createWritable();
  await stream.write(blob);
  await stream.close();
}

/** Hand a file to the browser's downloads. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface SaveOptions {
  id: PickerId;
  /** Suggested file name. */
  name: string;
  type: FileType;
  text: string;
  /** A file saved or opened before: written again without asking when the browser allows it. */
  path?: string | null;
}

/**
 * Save a text file; returns its path (the file name), null when cancelled. Without the File System
 * Access API the file is downloaded.
 */
export async function saveFile(options: SaveOptions): Promise<string | null> {
  const blob = new Blob([options.text], { type: 'application/json' });
  const previous = options.path ? handles.get(fileNameOf(options.path)) : undefined;
  if (previous && (await canWrite(previous))) {
    await write(previous, blob);
    return previous.name;
  }
  if (!window.showSaveFilePicker) {
    const name = options.path ? fileNameOf(options.path) : options.name;
    download(blob, name);
    return name;
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await window.showSaveFilePicker({
      id: options.id,
      suggestedName: options.name,
      types: [options.type],
    });
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
  await write(handle, blob);
  handles.set(handle.name, handle);
  return handle.name;
}

/** Folders picked for exports in this tab, by name: the path that stands for them. */
const folders = new Map<string, FileSystemDirectoryHandle>();

/** Whether this browser can write into a folder the user picks (Chromium). */
export const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

/** Ask for a folder to write into; returns its name (the path that stands for it), null when cancelled. */
export async function pickFolder(id: PickerId): Promise<string | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    const folder = await window.showDirectoryPicker({ id, mode: 'readwrite' });
    folders.set(folder.name, folder);
    return folder.name;
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
}

/** The folder a path stands for, with write access; null when it was not picked in this tab. */
export async function writableFolder(path: string): Promise<FileSystemDirectoryHandle | null> {
  const folder = folders.get(fileNameOf(path));
  return folder && (await canWrite(folder)) ? folder : null;
}
