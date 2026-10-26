import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isLanguage, LANGUAGES, type Language, matchLanguage, translate } from '@custom-overlay/ui/i18n';
import { app } from 'electron';

/** Kinds of files the dialogs remember a folder for: videos and logs usually live elsewhere than templates. */
export type FolderKind = 'media' | 'project' | 'template' | 'widget' | 'track' | 'values';

const FOLDER_KINDS: readonly FolderKind[] = ['media', 'project', 'template', 'widget', 'track', 'values'];

/** App preferences (not project settings), stored in the user data folder. */
interface Settings {
  /** Chosen by the user; null follows the system languages. */
  language: Language | null;
  /** Last folder a file of each kind was opened from or saved to. */
  folders: Partial<Record<FolderKind, string>>;
  /** Last folder of any dialog, for kinds not used yet. */
  lastFolder: string | null;
}

const file = () => join(app.getPath('userData'), 'settings.json');

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function read(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>;
    const folders: Settings['folders'] = {};
    for (const kind of FOLDER_KINDS) {
      const folder = raw.folders?.[kind];
      if (isText(folder)) folders[kind] = folder;
    }
    return {
      language: isLanguage(raw.language) ? raw.language : null,
      folders,
      lastFolder: isText(raw.lastFolder) ? raw.lastFolder : null,
    };
  } catch {
    return { language: null, folders: {}, lastFolder: null };
  }
}

let settings: Settings | null = null;

function current(): Settings {
  settings ??= read();
  return settings;
}

/**
 * Makes Chromium (built-in menus, input validation, spellchecker) use the chosen language. It must
 * run before the app is ready, so a new choice applies on the next start.
 */
export function applyChromiumLanguage(): void {
  const { language } = current();
  const chromium = LANGUAGES.find((l) => l.code === language)?.chromium;
  if (chromium) app.commandLine.appendSwitch('lang', chromium);
}

export function getLanguage(): Language {
  return current().language ?? matchLanguage(app.getPreferredSystemLanguages());
}

function save(patch: Partial<Settings>): void {
  settings = { ...current(), ...patch };
  writeFileSync(file(), JSON.stringify(settings, null, 2));
}

export function setLanguage(language: Language): void {
  save({ language });
}

/**
 * Folder a dialog for a kind of file starts in: the last one used for that kind, else the last
 * one of any dialog, else the system Videos (media) or Documents folder. Deleted folders are skipped.
 */
export function startFolder(kind: FolderKind): string {
  const { folders, lastFolder } = current();
  const candidates = [folders[kind], lastFolder];
  return (
    candidates.find((folder) => folder && existsSync(folder)) ??
    app.getPath(kind === 'media' ? 'videos' : 'documents')
  );
}

/** Remember the folder of a file the user just picked (opened or saved). */
export function rememberFolder(kind: FolderKind, filePath: string): void {
  const folder = dirname(filePath);
  save({ folders: { ...current().folders, [kind]: folder }, lastFolder: folder });
}

/** Message in the app language, for dialogs shown by the main process. */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(getLanguage(), key, params);
}
