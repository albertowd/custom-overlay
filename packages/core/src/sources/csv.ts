/** Split one CSV line, honouring double quoted fields ("a, b" and escaped "" quotes). */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

export function splitLines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r?\n/);
}

/** Parse a number cell; empty or invalid cells become NaN. */
export function parseNumber(cell: string | undefined): number {
  if (cell === undefined || cell === '') return Number.NaN;
  const n = Number(cell);
  return Number.isFinite(n) ? n : Number.NaN;
}
