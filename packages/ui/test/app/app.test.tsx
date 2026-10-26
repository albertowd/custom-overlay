import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { useStore } from '../../src/app/store';
import { installFakeApi } from './fake-api';
import { api, loadSession, project, resetStores } from './helpers/project';

const store = () => useStore.getState();

/** Step buttons of the stepper, by title. */
const stepButton = (title: string) =>
  within(screen.getByRole('navigation')).getByRole('button', { name: new RegExp(`^\\d?✓?${title}`) });

describe('startup', () => {
  // App handles the startup once per module: each test gets fresh modules.
  async function freshApp() {
    vi.resetModules();
    // The fresh modules get the running test's fake API.
    (await import('../../src/app/api')).installApi(api());
    const [{ App: FreshApp }, { useStore: freshStore }] = await Promise.all([
      import('../../src/app/App'),
      import('../../src/app/store'),
    ]);
    return { FreshApp, freshStore };
  }

  it('asks for the name of a new project and loads the track list', async () => {
    const { FreshApp, freshStore } = await freshApp();
    const { unmount } = render(<FreshApp />);
    await waitFor(() => expect(freshStore.getState().naming).toBe('startup'));
    expect(api().trackCatalog).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
    unmount();
    render(<FreshApp />);
    expect(api().getStartupProject).toHaveBeenCalledTimes(1);
  });

  it('opens the project given on the command line', async () => {
    const { FreshApp, freshStore } = await freshApp();
    api().getStartupProject.mockResolvedValue({ path: '/projects/run.json', project: project('Monza') });
    render(<FreshApp />);
    await waitFor(() => expect(freshStore.getState().projectPath).toBe('/projects/run.json'));
    expect(freshStore.getState()).toMatchObject({ naming: null, step: 'summary' });
    expect(screen.getByDisplayValue('Monza')).toBeTruthy();
  });
});

describe('App', () => {
  // The first render handles the startup (asks for a name): get it out of the way once.
  beforeAll(async () => {
    installFakeApi();
    const { unmount } = render(<App />);
    await waitFor(() => expect(store().naming).toBe('startup'));
    unmount();
  });

  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('toolbar', () => {
    it('shows the project name and unsaved changes in the window title', async () => {
      const user = userEvent.setup();
      render(<App />);
      expect(document.title).toBe('Untitled project — Custom Overlay');
      const name = screen.getByDisplayValue(store().project.name);
      await user.clear(name);
      await user.type(name, 'Spa');
      expect(store().project.name).toBe('Spa');
      expect(document.title).toBe('Spa • — Custom Overlay');
      expect(screen.getByTitle('Unsaved changes')).toBeTruthy();
      expect(name.getAttribute('title')).toBe('Unsaved project');
      act(() => useStore.setState({ projectPath: '/p/spa.json' }));
      expect(name.getAttribute('title')).toBe('/p/spa.json');
    });

    it('asks before discarding unsaved changes', async () => {
      const user = userEvent.setup();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<App />);
      await user.click(screen.getByRole('button', { name: 'New' }));
      expect(confirm).not.toHaveBeenCalled();
      expect(store().naming).toBe('new');
      act(() => {
        store().cancelNewProject();
        store().setName('Changed');
      });
      await user.click(screen.getByRole('button', { name: 'New' }));
      await user.click(screen.getByRole('button', { name: 'Open…' }));
      expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?');
      expect(store().naming).toBeNull();
      expect(api().openProject).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      await user.click(screen.getByRole('button', { name: 'Open…' }));
      expect(api().openProject).toHaveBeenCalledTimes(1);
    });

    it('saves and saves as', async () => {
      const user = userEvent.setup();
      useStore.setState({ projectPath: '/p.json' });
      render(<App />);
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(api().saveProject).toHaveBeenLastCalledWith('/p.json', store().project);
      await user.click(screen.getByRole('button', { name: 'Save as…' }));
      expect(api().saveProject).toHaveBeenLastCalledWith(null, store().project);
    });

    it('saves and opens with the keyboard, unless busy', async () => {
      const user = userEvent.setup();
      useStore.setState({ projectPath: '/p.json' });
      render(<App />);
      await user.keyboard('{Control>}s{/Control}');
      expect(api().saveProject).toHaveBeenLastCalledWith('/p.json', expect.anything());
      await user.keyboard('{Control>}{Shift>}S{/Shift}{/Control}');
      await user.keyboard('{Meta>}o{/Meta}');
      expect(api().openProject).toHaveBeenCalledTimes(1);
      await user.keyboard('s{Control>}x{/Control}');
      expect(api().saveProject).toHaveBeenCalledTimes(1);

      act(() => useStore.setState({ valuesBusy: true }));
      await user.keyboard('{Control>}o{/Control}');
      expect(api().openProject).toHaveBeenCalledTimes(1);
    });
  });

  describe('stepper and footer', () => {
    it('walks through the steps, skipping optional ones', async () => {
      const user = userEvent.setup();
      render(<App />);
      const back = screen.getByRole('button', { name: '← Back' });
      expect(back).toHaveProperty('disabled', true);
      // Videos are optional: without any, the step can be skipped.
      expect(within(stepButton('Videos')).getByText('optional')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Skip →' }));
      expect(store().step).toBe('sources');
      // Without a video a data source is required: the error is the hint.
      expect(screen.getByText('Without a video, at least one data source is required').className).toContain(
        'error-text',
      );
      expect(stepButton('Data sources').className).toContain('has-error');
      await user.click(screen.getByRole('button', { name: '← Back' }));
      expect(store().step).toBe('videos');
    });

    it('jumps to reachable steps only', async () => {
      const user = userEvent.setup();
      render(<App />);
      const sync = stepButton('Sync');
      expect(sync).toHaveProperty('disabled', true);
      await user.click(stepButton('Template'));
      expect(store().step).toBe('template');
      expect(stepButton('Template').className).toContain('active');
    });

    it('marks complete steps and offers Next', async () => {
      const user = userEvent.setup();
      loadSession();
      render(<App />);
      const videos = stepButton('Videos');
      expect(within(videos).getByText('✓')).toBeTruthy();
      expect(within(videos).getByText('complete')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Next →' }));
      expect(store().step).toBe('sources');
    });

    it('shows warnings as muted hints and every issue in the step tooltip', () => {
      useStore.setState({ step: 'template' });
      render(<App />);
      const hint = document.querySelector('.footer-hint');
      expect(hint?.className).toContain('muted');
      expect(stepButton('Template').getAttribute('title')).toBe(hint?.textContent);
      expect(stepButton('Videos').getAttribute('title')).toMatch(/^Select the videos/);
    });

    it('has no Next on the last step', () => {
      useStore.setState({ step: 'export' });
      render(<App />);
      expect(screen.queryByRole('button', { name: /Next|Skip/ })).toBeNull();
    });
  });

  describe('about line', () => {
    it('names the app and opens the project page', async () => {
      const user = userEvent.setup();
      render(<App />);
      const about = await screen.findByRole('button', { name: /^Custom Overlay 0\.1\.0/ });
      expect(about.textContent).toMatch(/© 2026(–\d{4})? Alberto$/);
      await user.click(about);
      expect(api().openProjectUrl).toHaveBeenCalledWith('https://github.com/example/custom-overlay');
    });

    it('shows a range of years after the first one', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2028, 3, 1));
      render(<App />);
      expect((await screen.findByRole('button', { name: /^Custom Overlay/ })).textContent).toContain(
        '© 2026–2028 Alberto',
      );
    });
  });

  describe('notices', () => {
    it('shows a notice until closed', async () => {
      const user = userEvent.setup();
      render(<App />);
      act(() => store().notify('error', 'Something failed'));
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('Something failed');
      expect(alert.className).toContain('error');
      await user.click(within(alert).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('hides a notice after a few seconds', () => {
      vi.useFakeTimers();
      render(<App />);
      act(() => store().notify('info', 'Saved'));
      act(() => vi.advanceTimersByTime(5999));
      expect(screen.getByRole('alert')).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('renders the current step', () => {
    render(<App />);
    const content = document.querySelector('main.content');
    for (const step of ['videos', 'sources', 'summary', 'export'] as const) {
      act(() => store().goTo(step));
      expect(content?.childElementCount).toBeGreaterThan(0);
      expect(document.querySelector('.step-item.active')?.textContent).toMatch(
        new RegExp(step === 'summary' ? 'Summary' : step, 'i'),
      );
    }
  });
});
