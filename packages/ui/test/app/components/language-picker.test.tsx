import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LanguagePicker } from '../../../src/app/components/LanguagePicker';
import { useLanguage } from '../../../src/app/i18n';
import { LANGUAGES, type Language } from '../../../src/shared/i18n';
import { api } from '../fake-api';
import { resetStore } from './form-helpers';

beforeEach(() => resetStore());

const nameOf = (code: Language) => LANGUAGES.find((l) => l.code === code)?.name ?? code;
const toggle = () => screen.getByRole('button', { expanded: false }) as HTMLButtonElement;

describe('LanguagePicker', () => {
  it('shows the current language, menu closed', () => {
    render(<LanguagePicker />);
    expect(toggle().textContent).toBe(nameOf('en'));
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('lists every language with the current one marked, and switches language', async () => {
    const user = userEvent.setup();
    render(<LanguagePicker />);
    await user.click(toggle());
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(LANGUAGES.map((l) => l.name));
    const current = screen.getByRole('button', { current: true });
    expect(current.textContent).toBe(nameOf('en'));
    expect(current.className).toBe('active');

    await user.click(screen.getByRole('button', { name: nameOf('pt-BR') }));
    expect(useLanguage.getState().language).toBe('pt-BR');
    expect(document.documentElement.lang).toBe('pt-BR');
    expect(api().setLanguage).toHaveBeenCalledWith('pt-BR');
    expect(screen.queryByRole('list')).toBeNull();
    expect(toggle().textContent).toBe(nameOf('pt-BR'));
  });

  it('closes on Escape, a click outside or a second click, not on other keys or inside', async () => {
    const user = userEvent.setup();
    render(
      <>
        <LanguagePicker />
        <p>outside</p>
      </>,
    );
    await user.click(toggle());
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByRole('list')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('list')).toBeNull();

    await user.click(toggle());
    fireEvent.mouseDown(screen.getByRole('list'));
    expect(screen.getByRole('list')).toBeTruthy();
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('list')).toBeNull();

    await user.click(toggle());
    await user.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByRole('list')).toBeNull();
  });
});
