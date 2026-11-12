import type { Project } from '@custom-overlay/core';
import { useEffect, useState } from 'react';
import type { SupportIssue, SupportIssueCode } from '../../shared/api';
import { api } from '../api';
import { useT } from '../i18n';

/** What the support checks depend on: the videos and the output settings. */
function checkKey(project: Project | undefined): string {
  if (!project) return '';
  const { output, export: settings } = project;
  return JSON.stringify([
    project.videos.filter((v) => v.enabled).map((v) => v.path),
    output.width,
    output.height,
    output.color,
    settings.mode,
    settings.encoder.codec,
    settings.encoder.bitrateMbps,
    settings.encoder.audio,
    settings.encoder.audioBitrateKbps,
  ]);
}

/**
 * What this browser cannot do (see `AppApi.supportIssues`): about the browser alone without a
 * project. Checked again when the videos or the output settings change.
 */
export function useSupportIssues(project?: Project): SupportIssue[] {
  const [issues, setIssues] = useState<SupportIssue[]>([]);
  const key = checkKey(project);
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked again only when the key changes
  useEffect(() => {
    let current = true;
    api()
      .supportIssues(project)
      .then((found) => current && setIssues(found))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [key]);
  return issues;
}

const ICONS: Record<SupportIssue['severity'], string> = { error: '⛔', warning: '⚠️', info: 'ℹ️' };

/** Alerts for support issues, the most serious first; only `codes` when given. */
export function SupportAlerts({
  issues,
  codes,
}: {
  issues: readonly SupportIssue[];
  codes?: readonly SupportIssueCode[];
}) {
  const t = useT();
  const order = { error: 0, warning: 1, info: 2 };
  const shown = issues
    .filter((issue) => !codes || codes.includes(issue.code))
    .sort((a, b) => order[a.severity] - order[b.severity]);
  if (shown.length === 0) return null;
  return (
    <div className="support-alerts">
      {shown.map((issue) => (
        <p
          key={`${issue.code}:${issue.params?.label ?? ''}`}
          className={`alert ${issue.severity}`}
          role={issue.severity === 'error' ? 'alert' : 'status'}
        >
          <span aria-hidden="true">{ICONS[issue.severity]}</span>
          <span>{t(`app.support.${issue.code}`, issue.params ?? {})}</span>
        </p>
      ))}
    </div>
  );
}

/** The browser's own limits, once when the app opens (the web app); can be closed. */
export function SupportBanner() {
  const t = useT();
  const issues = useSupportIssues();
  const [closed, setClosed] = useState(false);
  if (closed || issues.length === 0) return null;
  return (
    <section className="support-banner" aria-label={t('app.support.title')}>
      <SupportAlerts issues={issues} />
      <button type="button" className="small" onClick={() => setClosed(true)}>
        {t('app.support.dismiss')}
      </button>
    </section>
  );
}

/** Problems with the project's videos (any step that shows them). */
export const DECODE_CODES: readonly SupportIssueCode[] = ['cannotDecode', 'cannotDecodeAudio'];
