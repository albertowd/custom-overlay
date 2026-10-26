import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mountApp } from '../../src/app';
import { createFakeApi } from './fake-api';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('app entry', () => {
  it('needs the root element', async () => {
    await expect(mountApp(document.getElementById('root'), createFakeApi())).rejects.toThrow(
      'Missing #root element',
    );
  });

  it('installs the API, loads the language, then renders the app into the root', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const api = createFakeApi();
    api.getLanguage.mockResolvedValue('es');
    await mountApp(document.getElementById('root'), api);
    expect(api.getLanguage).toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('#root .toolbar')).not.toBeNull());
    expect(document.documentElement.lang).toBe('es');
    // Spanish texts: the toolbar's Save button is translated.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
