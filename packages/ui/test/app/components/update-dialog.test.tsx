import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../src/app/i18n';
import { useStore } from '../../../src/app/store';
import type { UpdateInfo } from '../../../src/shared/api';
import { api, installFakeApi } from '../fake-api';
import { resetStore } from './form-helpers';

const SKIP_KEY = 'custom-overlay.update.skip';

const update: UpdateInfo = {
  current: '0.1.0',
  latest: '0.2.0',
  change: 'minor',
  title: 'v0.2.0',
  notes: '- Faster exports',
  pageUrl: 'https://example.com/releases/v0.2.0',
  downloadUrl: 'https://example.com/download/setup.exe',
  assetName: 'setup.exe',
};

// The dialog checks once per app start (module state): load a fresh copy per test.
async function renderDialog() {
  vi.resetModules();
  // The fresh modules get the running test's fake API.
  (await import('../../../src/app/api')).installApi(api());
  const i18n = await import('../../../src/app/i18n');
  const store = await import('../../../src/app/store');
  const { UpdateDialog } = await import('../../../src/app/components/UpdateDialog');
  const result = render(<UpdateDialog />);
  return { ...result, store: store.useStore, tr: i18n.t, UpdateDialog };
}

beforeEach(() => {
  resetStore();
  localStorage.clear();
});

describe('UpdateDialog', () => {
  it('stays hidden when the app is up to date', async () => {
    const api = installFakeApi();
    const { container } = await renderDialog();
    await waitFor(() => expect(api.checkForUpdate).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe('');
  });

  it('checks only once per app start', async () => {
    const api = installFakeApi();
    const { UpdateDialog, unmount } = await renderDialog();
    unmount();
    render(<UpdateDialog />);
    await waitFor(() => expect(api.checkForUpdate).toHaveBeenCalledTimes(1));
  });

  it('offers the installer and the release page', async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ checkForUpdate: async () => update });
    await renderDialog();
    const dialog = (await screen.findByRole('dialog', { hidden: true })) as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(screen.getByText(t('app.update.message', { latest: '0.2.0', current: '0.1.0' }))).toBeTruthy();
    expect(screen.getByText('- Faster exports')).toBeTruthy();
    expect(screen.getByText(t('app.update.change.minor'))).toBeTruthy();
    expect(screen.queryByText(t('app.update.noInstaller'))).toBeNull();
    await user.click(screen.getByRole('button', { name: t('app.update.download', { file: 'setup.exe' }) }));
    expect(api.openProjectUrl).toHaveBeenCalledWith(update.downloadUrl);
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });

  it('opens the release page, the main action without an installer', async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      checkForUpdate: async () => ({ ...update, notes: '', downloadUrl: null, assetName: null }),
    });
    await renderDialog();
    await screen.findByRole('dialog'); // open: showModal() runs in an effect
    expect(screen.getByText(t('app.update.noInstaller'))).toBeTruthy();
    expect(screen.queryByText(t('app.update.notes'))).toBeNull();
    const page = screen.getByRole('button', { name: t('app.update.page') });
    expect(page.className).toBe('primary');
    await user.click(page);
    expect(api.openProjectUrl).toHaveBeenCalledWith(update.pageUrl);
  });

  it('closes for later without remembering anything', async () => {
    const user = userEvent.setup();
    installFakeApi({ checkForUpdate: async () => update });
    await renderDialog();
    await screen.findByRole('dialog'); // open: showModal() runs in an effect
    await user.click(screen.getByRole('button', { name: t('app.update.later') }));
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(localStorage.getItem(SKIP_KEY)).toBeNull();
  });

  it('skips a version and stays quiet for it next time', async () => {
    const user = userEvent.setup();
    installFakeApi({ checkForUpdate: async () => update });
    const first = await renderDialog();
    await screen.findByRole('dialog'); // open: showModal() runs in an effect
    await user.click(screen.getByRole('button', { name: t('app.update.skip') }));
    expect(localStorage.getItem(SKIP_KEY)).toBe('0.2.0');
    first.unmount();

    const api = installFakeApi({ checkForUpdate: async () => update });
    const { container } = await renderDialog();
    await waitFor(() => expect(api.checkForUpdate).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });

  it('still offers the update when storage is unavailable', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    installFakeApi({ checkForUpdate: async () => update });
    await renderDialog();
    await screen.findByRole('dialog'); // open: showModal() runs in an effect
    await user.click(screen.getByRole('button', { name: t('app.update.skip') }));
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });

  it('ignores a failed check', async () => {
    const api = installFakeApi({
      checkForUpdate: async () => {
        throw new Error('offline');
      },
    });
    const { container } = await renderDialog();
    await waitFor(() => expect(api.checkForUpdate).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('waits for the new project dialog to close', async () => {
    installFakeApi({ checkForUpdate: async () => update });
    vi.resetModules();
    (await import('../../../src/app/api')).installApi(api());
    const { useStore: store } = await import('../../../src/app/store');
    store.setState({ naming: 'startup' });
    const { UpdateDialog } = await import('../../../src/app/components/UpdateDialog');
    render(<UpdateDialog />);
    await waitFor(() => expect(api().checkForUpdate).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    act(() => store.setState({ naming: null }));
    expect(await screen.findByRole('dialog', { hidden: true })).toBeTruthy();
    // The statically imported store is another module instance: untouched.
    expect(useStore.getState().naming).toBeNull();
  });
});
