import { mountApp } from '@custom-overlay/ui';
import { registerServiceWorker } from './updates';
import { webApi } from './web-api';

void mountApp(document.getElementById('root'), webApi);

if (import.meta.env.PROD && 'serviceWorker' in navigator) registerServiceWorker();
