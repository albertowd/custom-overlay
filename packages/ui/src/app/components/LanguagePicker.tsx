import { type ReactNode, useEffect, useRef, useState } from 'react';
import { LANGUAGES, type Language } from '../../shared/i18n';
import { useLanguage, useT } from '../i18n';

/** Simplified flags (Windows has no flag emoji). They decorate the language name, never replace it. */
const FLAGS: Record<Language, ReactNode> = {
  en: (
    <>
      <rect width="21" height="14" fill="#fff" />
      {[0, 2, 4, 6, 8, 10, 12].map((i) => (
        <rect key={i} y={(i * 14) / 13} width="21" height={14 / 13} fill="#b22234" />
      ))}
      <rect width="9" height={(14 * 7) / 13} fill="#3c3b6e" />
    </>
  ),
  'pt-BR': (
    <>
      <rect width="21" height="14" fill="#009c3b" />
      <path d="M10.5 1.6 19 7l-8.5 5.4L2 7z" fill="#ffdf00" />
      <circle cx="10.5" cy="7" r="3.1" fill="#002776" />
    </>
  ),
  es: (
    <>
      <rect width="21" height="14" fill="#aa151b" />
      <rect y="3.5" width="21" height="7" fill="#f1bf00" />
    </>
  ),
  it: (
    <>
      <rect width="7" height="14" fill="#009246" />
      <rect x="7" width="7" height="14" fill="#fff" />
      <rect x="14" width="7" height="14" fill="#ce2b37" />
    </>
  ),
  ja: (
    <>
      <rect width="21" height="14" fill="#fff" />
      <circle cx="10.5" cy="7" r="4.2" fill="#bc002d" />
    </>
  ),
};

function Flag({ language }: { language: Language }) {
  return (
    <svg className="flag" viewBox="0 0 21 14" width="21" height="14" aria-hidden="true">
      {FLAGS[language]}
    </svg>
  );
}

export function LanguagePicker() {
  const t = useT();
  const language = useLanguage((s) => s.language);
  const setLanguage = useLanguage((s) => s.setLanguage);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className="language-picker" ref={ref}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        title={t('common.language')}
        onClick={() => setOpen(!open)}
      >
        <Flag language={current.code} />
        {current.name}
      </button>
      {open && (
        <ul className="language-menu" aria-label={t('common.language')}>
          {LANGUAGES.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                aria-current={l.code === language}
                lang={l.code}
                className={l.code === language ? 'active' : ''}
                onClick={() => {
                  setLanguage(l.code);
                  setOpen(false);
                }}
              >
                <Flag language={l.code} />
                {l.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
