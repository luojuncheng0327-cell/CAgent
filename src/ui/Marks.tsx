import React from 'react';

export const assistantPortrait = new URL('./assets/assistant-portrait.png', import.meta.url).href;

// Drawn here on a 24-unit grid from simple geometric primitives.
const strokes: Record<string, React.ReactNode> = {
  camera: (
    <>
      <path d="M3 7h5l2-3h4l2 3h5v13H3Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  selectAll: <path d="M3 6h18M3 12h18M3 18h18M3 6v12" />,
  selection: <rect x="4" y="4" width="16" height="16" rx="1.5" />,
  plus: <path d="M12 4.5v15M4.5 12h15" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  minus: <path d="M5 12h14" />,
  maximize: <path d="M6 6h12v12H6Z" />,
  restore: <path d="M8 8V4h12v12h-4M4 8h12v12H4Z" />,
  arrow: <path d="m9 5.5 6.5 6.5L9 18.5" />,
  back: <path d="m15 5.5-6.5 6.5 6.5 6.5" />,
  down: <path d="m6 9 6 6 6-6" />,
  up: <path d="m6 15 6-6 6 6" />,
  send: <path d="M19.5 5v7H5m5-5-5 5 5 5" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
  chat: (
    <path d="M5 4.5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-5 3v-3H5a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2Z" />
  ),
  panel: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
      <path d="M15.5 4v16" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
      <path d="M8.5 4v16" />
    </>
  ),
  folder: <path d="M3.5 19V5h6l2 3h9v11Zm0-7h17" />,
  folderPlus: (
    <>
      <path d="M3 19V5h6l2 3h10v11Z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  file: (
    <>
      <path d="M6 3.5h8l4 4V21H6Zm8 0V8h4M9 12h6M9 16h6" />
    </>
  ),
  filePlus: (
    <>
      <path d="M6 3.5h8l4 4V21H6Zm8 0V8h4M12 11v6M9 14h6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="m9 3 1 2h4l1-2 3 2-.7 2.2 2 3L22 11v3l-2.7.8-2 3L18 20l-3 2-1-2h-4l-1 2-3-2 .7-2.2-2-3L2 14v-3l2.7-.8 2-3L6 5Z" />
    </>
  ),
  memory: <path d="m12 3 9 9-9 9-9-9Z" />,
  pin: <path d="M8 3.5h8l-1 6 3 4H6l3-4Zm4 10v7" />,
  archive: (
    <>
      <path d="M4 8h16v12H4M9 12h6" />
      <rect x="3" y="3.5" width="18" height="4.5" rx="1" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-12" />,
  copy: (
    <>
      <rect x="8" y="7" width="12" height="14" rx="1.5" />
      <path d="M15 4H4v13" />
    </>
  ),
  moon: <path d="M20 15.5a9 9 0 1 1-11-12 8 8 0 0 0 11 12Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12c2.4-4 5.4-6 9.5-6s7.1 2 9.5 6c-2.4 4-5.4 6-9.5 6S4.9 16 2.5 12Z" />
      <circle cx="12" cy="12" r="2.7" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.7 0 2.3-.7 1.6-2.1-.8-1.6.2-3.1 1.9-3.1h2.1c2 0 3-1.4 2.9-3.8A8.5 8.5 0 0 0 12 3.5Z" />
      <circle cx="7.5" cy="11.5" r=".6" />
      <circle cx="9.5" cy="7.5" r=".6" />
      <circle cx="14.5" cy="7.5" r=".6" />
      <circle cx="17.5" cy="11" r=".6" />
    </>
  ),
  system: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="1.5" />
      <path d="M9 21h6m-3-4v4" />
    </>
  ),
  link: (
    <>
      <path d="m9 8 3-3a4 4 0 0 1 6 6l-2 2M8 11l-2 2a4 4 0 0 0 6 6l3-3m-6-1 6-6" />
    </>
  ),
  activity: <path d="M2 13h5l3-9 4 16 3-7h5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  tools: <path d="M14 3a6 6 0 0 0-6 8L3 16a3 3 0 0 0 4 4l6-6a6 6 0 0 0 8-7l-4 4-4-4 4-4Z" />,
  sparkle: <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z" />,
  shield: <path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6Z" />,
  bulb: <path d="M9 18h6m-5 3h4M8 15c0-2-3-3-3-7a7 7 0 0 1 14 0c0 4-3 5-3 7Z" />,
  model: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="4" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="5" r="2" />
      <circle cx="17" cy="5" r="2" />
      <circle cx="7" cy="20" r="2" />
      <path d="M7 7v11m10-11v3c0 4-10 0-10 5" />
    </>
  ),
  refresh: <path d="M20 8a8.5 8.5 0 1 0 0 8M20 3v5h-5" />,
  edit: <path d="m4 16 12-12 4 4L8 20l-5 1Zm9-9 4 4" />,
  filter: <path d="M3 4h18l-7 9v7l-4-2v-5Z" />,
  sort: <path d="M4 6h16M7 11h10M10 16h4" />,
  wrap: <path d="M3 6h18M3 11h14a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M3 16h4" />,
  more: (
    <>
      <circle cx="5" cy="12" r=".7" />
      <circle cx="12" cy="12" r=".7" />
      <circle cx="19" cy="12" r=".7" />
    </>
  ),
  note: <path d="M5 3h14v12l-6 6H5Zm8 18v-6h6M8 7h8M8 11h7" />,
  external: <path d="M14 3h7v7m0-7L11 13M10 5H4v15h15v-6" />,
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {strokes[name] ?? strokes.chat}
    </svg>
  );
}

export function Portrait({ name, size = 32, src }: { name: string; size?: number; src?: string }) {
  const letters = [...name.trim()];
  const seed = letters.reduce((sum, letter) => sum + letter.codePointAt(0)!, 0);
  const palette = ['#537d96', '#7d8171', '#967f91', '#9b7b67'];
  return (
    <span
      className={'initial-portrait' + (src ? ' image-portrait' : '')}
      aria-hidden="true"
      style={
        {
          '--portrait-size': `${size}px`,
          '--portrait-fill': palette[seed % palette.length],
        } as React.CSSProperties
      }
    >
      {letters[0]?.toLocaleUpperCase() ?? 'C'}
      {src && (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
    </span>
  );
}
