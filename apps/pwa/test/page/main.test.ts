import { mountApp } from '@custom-overlay/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webApi } from '../../src/web-api';

vi.mock('@custom-overlay/ui', () => ({ mountApp: vi.fn(async () => undefined) }));
vi.mock('../../src/web-api', () => ({ webApi: { name: 'web api' } }));

const register = vi.fn(async (_url: string) => ({}));

async function start(production: boolean) {
  vi.stubEnv('PROD', production);
  vi.resetModules();
  await import('../../src/main');
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  register.mockClear();
  Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('web app entry', () => {
  it('mounts the app with the browser API', async () => {
    await start(false);
    expect(mountApp).toHaveBeenLastCalledWith(document.getElementById('root'), webApi);
  });

  it('works offline once built: registers the service worker', async () => {
    await start(true);
    expect(register).toHaveBeenCalledWith('./sw.js');
  });

  it('skips the service worker during development', async () => {
    await start(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('still runs when the service worker cannot be registered', async () => {
    register.mockRejectedValueOnce(new Error('insecure context'));
    await expect(start(true)).resolves.toBeUndefined();
    expect(mountApp).toHaveBeenCalled();
  });
});
