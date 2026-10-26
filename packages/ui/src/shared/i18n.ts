import { MESSAGES } from './locales';

/**
 * App languages. Chromium's own locale files are trimmed to the same list in
 * electron-builder.yml (`electronLanguages`), so keep both in sync.
 */
export const LANGUAGES = [
  { code: 'en', chromium: 'en-US', name: 'English' },
  { code: 'pt-BR', chromium: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'es', chromium: 'es', name: 'Español' },
  { code: 'it', chromium: 'it', name: 'Italiano' },
  { code: 'ja', chromium: 'ja', name: '日本語' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];
export const DEFAULT_LANGUAGE: Language = 'en';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((l) => l.code === value);
}

/** Best supported language for a list of preferred locales ("pt-BR", "es-AR", "ja-JP"...). */
export function matchLanguage(preferred: readonly string[]): Language {
  for (const locale of preferred) {
    const lower = locale.toLowerCase();
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === lower);
    if (exact) return exact.code;
    // Any Portuguese goes to pt-BR, the only Portuguese we have; same for the other languages.
    const base = lower.split('-')[0];
    const partial = LANGUAGES.find((l) => l.code.toLowerCase().split('-')[0] === base);
    if (partial) return partial.code;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * A message is a string with `{name}` placeholders, or plural forms picked by the `count`
 * parameter (`{ "one": "{count} file", "other": "{count} files" }`, see Intl.PluralRules).
 */
export type Message = string | (Partial<Record<Intl.LDMLPluralRule, string>> & { other: string });
export type Params = Record<string, string | number>;

type MessageTree = { [key: string]: Message | MessageTree };

function isPlural(value: Message | MessageTree): value is Message {
  return typeof value === 'object' && typeof value.other === 'string';
}

/** Flattens nested message files into dotted keys: `{ "toolbar": { "save": "Save" } }` → `toolbar.save`. */
export function flattenMessages(tree: MessageTree, prefix = '', out: Record<string, Message> = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const id = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string' || isPlural(value)) out[id] = value;
    else flattenMessages(value, id, out);
  }
  return out;
}

const flat = new Map<Language, Record<string, Message>>();

function messagesOf(language: Language): Record<string, Message> {
  let messages = flat.get(language);
  if (!messages) {
    messages = flattenMessages(MESSAGES[language] as MessageTree);
    flat.set(language, messages);
  }
  return messages;
}

function interpolate(text: string, params: Params, language: Language): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === 'number' ? value.toLocaleString(language) : value;
  });
}

/** Whether a message exists in English (the reference language). */
export function hasMessage(key: string): boolean {
  return key in messagesOf(DEFAULT_LANGUAGE);
}

/**
 * Message `key` in `language`, falling back to English, then to `fallback` (e.g. the English text
 * of a value defined by the core), then to the key itself so a missing message stays visible.
 */
export function translate(language: Language, key: string, params: Params = {}, fallback?: string): string {
  const message = messagesOf(language)[key] ?? messagesOf(DEFAULT_LANGUAGE)[key];
  if (message === undefined) return interpolate(fallback ?? key, params, language);
  if (typeof message === 'string') return interpolate(message, params, language);
  const count = Number(params.count ?? 0);
  const form = new Intl.PluralRules(language).select(count);
  return interpolate(message[form] ?? message.other, params, language);
}

export type Translate = (key: string, params?: Params, fallback?: string) => string;
