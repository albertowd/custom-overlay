import { mountApp } from '@custom-overlay/ui';

// The preload script exposes the main process API on `window.api`.
void mountApp(document.getElementById('root'), window.api);
