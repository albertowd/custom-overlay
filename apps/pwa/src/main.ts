import { mountApp } from '@custom-overlay/ui';
import { webApi } from './web-api';

void mountApp(document.getElementById('root'), webApi);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js').catch(() => {
    // Without a service worker the app still works, only not offline.
  });
}
