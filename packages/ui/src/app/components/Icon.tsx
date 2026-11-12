/** Line icons drawn on a 20 x 20 grid, in the current text color. */
const PATHS = {
  eye: 'M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  'eye-off':
    'M3 3l14 14 M8.2 4.7A8.6 8.6 0 0 1 10 4.5c5 0 8 5.5 8 5.5a14 14 0 0 1-2.6 3.3 M5.6 6.1C3.4 7.6 2 10 2 10s3 5.5 8 5.5c1.3 0 2.5-.4 3.5-.9',
  up: 'M5 12.5 10 7.5l5 5',
  down: 'M5 7.5 10 12.5l5-5',
  chevron: 'M7.5 5 12.5 10l-5 5',
  group: 'M3 5.5h5l1.5 1.5H17v8.5H3Z',
  'align-left': 'M3.5 3v14 M6.5 6h9v3h-9Z M6.5 11h5v3h-5Z',
  'align-center': 'M10 3v14 M5.5 6h9v3h-9Z M7.5 11h5v3h-5Z',
  'align-right': 'M16.5 3v14 M4.5 6h9v3h-9Z M8.5 11h5v3h-5Z',
  'align-top': 'M3 3.5h14 M6 6.5h3v9H6Z M11 6.5h3v5h-3Z',
  'align-middle': 'M3 10h14 M6 5.5h3v9H6Z M11 7.5h3v5h-3Z',
  'align-bottom': 'M3 16.5h14 M6 4.5h3v9H6Z M11 8.5h3v5h-3Z',
  'distribute-horizontal': 'M3 3v14 M17 3v14 M6.5 7h2.5v6H6.5Z M11 7h2.5v6H11Z',
  'distribute-vertical': 'M3 3h14 M3 17h14 M7 6.5h6V9H7Z M7 11h6v2.5H7Z',
  plus: 'M10 4v12 M4 10h12',
  trash: 'M4 6h12 M8 6V4h4v2 M5.5 6l.8 10h7.4l.8-10',
  copy: 'M7 7h9v9H7Z M4 13V4h9',
  more: 'M5 10h.01 M10 10h.01 M15 10h.01',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon-svg"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
