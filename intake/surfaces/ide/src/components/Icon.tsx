import type { SVGProps } from 'react';

export type IconName =
  | 'files' | 'search' | 'source' | 'debug' | 'extensions' | 'terminal'
  | 'spark' | 'settings' | 'command' | 'close' | 'chevron-right'
  | 'chevron-down' | 'refresh' | 'upload' | 'download' | 'folder-open' | 'plus'
  | 'play' | 'pause' | 'stop' | 'step-over' | 'step-in' | 'step-out'
  | 'undo' | 'redo' | 'menu' | 'copy' | 'check' | 'warning' | 'info';

const paths: Record<IconName, React.ReactNode> = {
  files: <><path d="M3 5.5h7l2 2h9v12H3z"/><path d="M3 8h18"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></>,
  source: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 5h3a4 4 0 0 1 4 4v6M15 15l-2-2m2 2 2-2"/></>,
  debug: <><path d="M9 5h6M10 2l1.5 3m2.5 0L15.5 2M7 10h10v5a5 5 0 0 1-10 0zM4 12h3m10 0h3M4 17h4m8 0h4"/></>,
  extensions: <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z"/>,
  terminal: <><path d="m4 7 5 5-5 5M11 17h9"/></>,
  spark: <><path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3.1 14H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>,
  command: <path d="M9 6V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>,
  close: <path d="M6 6l12 12M18 6 6 18"/>,
  'chevron-right': <path d="m9 5 7 7-7 7"/>,
  'chevron-down': <path d="m5 9 7 7 7-7"/>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 15v5h16v-5"/></>,
  download: <><path d="M12 4v12m-5-5 5 5 5-5"/><path d="M4 19h16"/></>,
  'folder-open': <><path d="M3 7h7l2 2h9v2"/><path d="M3 7v12h16l3-8H7l-3 8"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  play: <path d="m8 5 11 7-11 7z"/>,
  pause: <path d="M8 5v14m8-14v14"/>,
  stop: <path d="M6 6h12v12H6z"/>,
  'step-over': <><path d="M5 16a7 7 0 0 1 12-5"/><path d="m14 6 4 5-6 1"/><path d="M12 14v7"/></>,
  'step-in': <><path d="M12 3v14m-5-5 5 5 5-5"/><path d="M5 21h14"/></>,
  'step-out': <><path d="M12 21V7m-5 5 5-5 5 5"/><path d="M5 3h14"/></>,
  undo: <><path d="m9 7-5 5 5 5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></>,
  redo: <><path d="m15 7 5 5-5 5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5H5v11h3"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  warning: <><path d="M12 3 2.5 20h19z"/><path d="M12 9v4m0 3v.1"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/></>,
};

export function Icon({ name, size = 18, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
