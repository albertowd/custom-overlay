import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  flattenMessages,
  hasMessage,
  isLanguage,
  LANGUAGES,
  matchLanguage,
  translate,
} from '../../src/shared/i18n';

describe('languages', () => {
  it('recognises the supported language codes only', () => {
    for (const { code } of LANGUAGES) expect(isLanguage(code)).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage('pt')).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });

  it('matches system locales exactly, by base language, or falls back to English', () => {
    expect(matchLanguage(['pt-BR'])).toBe('pt-BR');
    expect(matchLanguage(['PT-br'])).toBe('pt-BR');
    expect(matchLanguage(['pt-PT'])).toBe('pt-BR');
    expect(matchLanguage(['es-AR', 'en-US'])).toBe('es');
    expect(matchLanguage(['ja-JP'])).toBe('ja');
    expect(matchLanguage(['fr-FR', 'de-DE', 'it-CH'])).toBe('it');
    expect(matchLanguage(['fr-FR'])).toBe(DEFAULT_LANGUAGE);
    expect(matchLanguage([])).toBe(DEFAULT_LANGUAGE);
  });
});

describe('messages', () => {
  it('flattens nested message files into dotted keys and keeps plural forms whole', () => {
    const plural = { one: '{count} file', other: '{count} files' };
    expect(flattenMessages({ toolbar: { save: 'Save', files: plural }, title: 'App' })).toEqual({
      'toolbar.save': 'Save',
      'toolbar.files': plural,
      title: 'App',
    });
  });

  it('knows which keys exist in English', () => {
    expect(hasMessage('main.filters.videos')).toBe(true);
    expect(hasMessage('main.filters.nothing')).toBe(false);
  });

  it('translates in the language, interpolating parameters', () => {
    expect(translate('en', 'main.filters.videos')).toBe('Videos');
    expect(translate('pt-BR', 'main.filters.videos')).toBe('Vídeos');
    expect(translate('en', 'main.chapters.files', { count: 1 })).toBe('1 file');
    expect(translate('en', 'main.chapters.files', { count: 3 })).toBe('3 files');
    expect(translate('pt-BR', 'main.chapters.files', { count: 2 })).toBe('2 arquivos');
  });

  it('formats numbers for the language and leaves unknown placeholders visible', () => {
    expect(translate('en', 'main.chapters.files', { count: 1234 })).toBe('1,234 files');
    expect(translate('pt-BR', 'main.chapters.files', { count: 1234 })).toBe('1.234 arquivos');
    expect(translate('en', 'missing.key', { name: 'x' }, 'Hello {name} {other}')).toBe('Hello x {other}');
  });

  it('uses the plural "other" form without a count', () => {
    expect(translate('en', 'main.chapters.files')).toBe('{count} files');
  });

  it('falls back to the fallback text, then to the key', () => {
    expect(translate('ja', 'nowhere.to.be.found', {}, 'Fallback')).toBe('Fallback');
    expect(translate('ja', 'nowhere.to.be.found')).toBe('nowhere.to.be.found');
  });
});
