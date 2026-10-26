import type { AppApi } from '../shared/api';

let installed: AppApi | null = null;

/** Give the app its host: the Electron preload API, or the browser implementation. */
export function installApi(api: AppApi): void {
  installed = api;
}

/** The host API; `installApi` runs before the app renders. */
export function api(): AppApi {
  if (!installed) throw new Error('The app API is not installed');
  return installed;
}
