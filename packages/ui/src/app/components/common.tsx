import { type SeriesSummary, type SourceKind, sampleAt, type TelemetrySeries } from '@custom-overlay/core';
import { type DragEvent, type ReactNode, useState } from 'react';
import { formatTime, formatValue } from '../format';
import { useT } from '../i18n';

export function StepHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="step-header">
      <div>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="key-values">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'accent';
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  gopro: 'GoPro',
  racechrono: 'RaceChrono',
  dji: 'DJI',
};

export function ChannelChips({ summary }: { summary: SeriesSummary }) {
  const t = useT();
  return (
    <div className="chips">
      {summary.channels.map((c) => (
        <span
          key={c.key}
          className="chip"
          title={t('app.channel.tooltip', { label: c.label, count: c.samples, rate: c.rateHz.toFixed(1) })}
        >
          {c.key}
          <small>{c.rateHz >= 1 ? `${c.rateHz.toFixed(0)} Hz` : ''}</small>
        </span>
      ))}
    </div>
  );
}

export function SeriesFacts({ summary }: { summary: SeriesSummary }) {
  const t = useT();
  return (
    <KeyValues
      rows={[
        [t('common.duration'), formatTime(summary.durationSeconds)],
        [
          t('app.series.startUtc'),
          summary.startTime ? summary.startTime.replace('T', ' ').replace('Z', '') : t('common.unknown'),
        ],
        [t('app.series.channels'), String(summary.channels.length)],
      ]}
    />
  );
}

/** Current values of every channel of a series at a timeline time. */
export function LiveValues({
  series,
  offset,
  time,
}: {
  series: TelemetrySeries;
  offset: number;
  time: number;
}) {
  return (
    <table className="live-values">
      <tbody>
        {series.channels.map((c) => (
          <tr key={c.key}>
            <th title={c.label}>{c.key}</th>
            <td>{formatValue(sampleAt(c, time - offset), c.unit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface DropZoneProps {
  onFiles(files: File[]): void;
  children: ReactNode;
  className?: string;
}

export function DropZone({ onFiles, children, className = '' }: DropZoneProps) {
  const t = useT();
  const [over, setOver] = useState(false);
  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <section
      aria-label={t('app.dropFiles')}
      className={`drop-zone ${over ? 'over' : ''} ${className}`}
      onDragOver={(e) => {
        stop(e);
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        stop(e);
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {children}
    </section>
  );
}
