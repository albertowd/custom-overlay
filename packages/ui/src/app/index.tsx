import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppApi } from '../shared/api';
import { App } from './App';
import { installApi } from './api';
import { initLanguage } from './i18n';
import './styles.css';

/** Render the app into `root` with the API of its host (Electron or the browser). */
export async function mountApp(root: HTMLElement | null, api: AppApi): Promise<void> {
  if (!root) throw new Error('Missing #root element');
  installApi(api);
  await initLanguage();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

/** Translation in the current app language, for host code (messages of errors and pickers). */
export { t } from './i18n';
