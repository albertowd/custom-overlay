import type { AppApi } from '@custom-overlay/ui/api';

declare global {
  interface Window {
    api: AppApi;
  }
}
