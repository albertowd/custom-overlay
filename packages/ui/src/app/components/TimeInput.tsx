import { formatTimecode, parseTimeInput } from '@custom-overlay/core';
import { type KeyboardEvent, useId, useState } from 'react';
import { useT } from '../i18n';

interface TimeInputProps {
  /** Seconds, or null for an empty field (only with `placeholder`). */
  value: number | null;
  /** Shown when empty; empty input commits null. Without it the field cannot be emptied. */
  placeholder?: number;
  /** Apply a typed time; return false to reject it (out of range...). */
  onCommit(value: number | null): boolean;
  /** Message shown when a time is rejected. */
  rejectMessage?: string;
  /** Label above the field; without it the caller labels the field. */
  label?: string;
  /** Hint under an empty field; "Follows the timeline" by default. */
  emptyHint?: string;
}

/**
 * A time field filled from right to left like a video editor: `530` is 0.530 s, `2.530` is
 * 2.530 s, `2:30` is 2:30.000 and `5:23:` is 5:23:00.000. Shows `HH:MM:SS.mmm`, previews the
 * typed time, commits on Enter or blur and cancels on Escape.
 */
export function TimeInput({ value, placeholder, onCommit, rejectMessage, label, emptyHint }: TimeInputProps) {
  const t = useT();
  const id = useId();
  /** Text while editing, null when showing the value. */
  const [text, setText] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const canBeEmpty = placeholder !== undefined;
  const typed = text === null ? Number.NaN : parseTimeInput(text);
  const empty = text !== null && text.trim() === '';
  const unreadable = text !== null && !empty && Number.isNaN(typed);

  const commit = () => {
    if (text === null) return;
    if (empty && !canBeEmpty) {
      setText(null);
      return;
    }
    if (unreadable || !onCommit(empty ? null : typed)) {
      setRejected(true);
      return;
    }
    setRejected(false);
    setText(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      setText(null);
      setRejected(false);
    }
  };

  let hint = ' ';
  if (unreadable) hint = t('sync.timeInput.format');
  else if (rejected) hint = rejectMessage ?? t('sync.timeInput.rejected');
  else if (text !== null && !empty) hint = `= ${formatTimecode(typed)}`;
  else if (value === null && canBeEmpty) hint = emptyHint ?? t('sync.timeInput.followsTimeline');

  const field = (
    <>
      <input
        id={id}
        type="text"
        className={`mono ${unreadable || rejected ? 'invalid' : ''}`}
        value={text ?? (value === null ? '' : formatTimecode(value))}
        placeholder={placeholder === undefined ? undefined : formatTimecode(placeholder)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setText(e.target.value);
          setRejected(false);
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <span className={`field-hint ${unreadable || rejected ? 'error-text' : 'muted'}`}>{hint}</span>
    </>
  );
  if (label === undefined) return field;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {field}
    </div>
  );
}
