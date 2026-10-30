// Custom SVG icons: a 24-by-24 canvas, 2-pixel strokes and currentColor, so every platform shows the
// same shapes in both themes.
const paths = {
  home: <><path d="M3 10.2 12 3l9 7.2" /><path d="M5.6 12.2V20a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1v-7.8" /></>,
  dashboard: <><rect x="3" y="3" width="7.4" height="8.4" rx="1.4" /><rect x="13.6" y="3" width="7.4" height="5.2" rx="1.4" /><rect x="3" y="14.6" width="7.4" height="6.4" rx="1.4" /><rect x="13.6" y="11.4" width="7.4" height="9.6" rx="1.4" /></>,
  receipt: <><path d="M6 2.8h12v18.4l-2.4-1.6-2.4 1.6L12 19.6l-1.2 1.6-2.4-1.6L6 21.2Z" /><path d="M9.4 8h5.2M9.4 12h5.2" /></>,
  'file-text': <><path d="M13.4 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.6Z" /><path d="M13.4 3v5.6H19" /><path d="M8.8 13h6.4M8.8 16.6h4.4" /></>,
  settings: <><circle cx="12" cy="12" r="3.1" /><path d="M19.2 14.6a1.5 1.5 0 0 0 .3 1.65l.06.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.06a1.5 1.5 0 0 0-2.55 1.07v.17a1.8 1.8 0 1 1-3.6 0v-.09a1.5 1.5 0 0 0-2.61-1.01l-.06.06a1.8 1.8 0 1 1-2.55-2.55l.06-.06A1.5 1.5 0 0 0 4.6 13.9h-.17a1.8 1.8 0 1 1 0-3.6h.09A1.5 1.5 0 0 0 5.53 7.7l-.06-.06A1.8 1.8 0 1 1 8.02 5.1l.06.06a1.5 1.5 0 0 0 1.65.3h.08a1.5 1.5 0 0 0 .91-1.37v-.17a1.8 1.8 0 1 1 3.6 0v.09a1.5 1.5 0 0 0 2.55 1.07l.06-.06a1.8 1.8 0 1 1 2.55 2.55l-.06.06a1.5 1.5 0 0 0-.3 1.65v.08a1.5 1.5 0 0 0 1.37.91h.17a1.8 1.8 0 1 1 0 3.6h-.09a1.5 1.5 0 0 0-1.37.91Z" /></>,
  menu: <path d="M4 6.6h16M4 12h16M4 17.4h16" />,
  close: <path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />,
  check: <path d="M4.8 12.6 9.6 17.4 19.2 6.8" />,
  upload: <><path d="M12 15.6V4.4" /><path d="M7.6 8.8 12 4.4l4.4 4.4" /><path d="M4.4 17v2.4a1.2 1.2 0 0 0 1.2 1.2h12.8a1.2 1.2 0 0 0 1.2-1.2V17" /></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M4 17v3h16v-3" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 11h18M7 15h2M13 15h2M7 18h2" /></>,
  edit: <><path d="m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-5-5L4 14Z" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  refresh: <><path d="M20.2 11.4a8.2 8.2 0 0 0-14.3-4.3L3.8 9.2" /><path d="M3.8 4.6v4.6h4.6" /><path d="M3.8 12.6a8.2 8.2 0 0 0 14.3 4.3l2.1-2.1" /><path d="M20.2 19.4v-4.6h-4.6" /></>,
  spinner: <><circle cx="12" cy="12" r="8.6" opacity="0.22" /><path d="M20.6 12A8.6 8.6 0 0 0 12 3.4" /></>,
  user: <><circle cx="12" cy="8.2" r="4" /><path d="M4.4 20.4a7.6 7.6 0 0 1 15.2 0" /></>,
  tag: <><path d="M11.6 3.4H20a.6.6 0 0 1 .6.6v8.4a1.6 1.6 0 0 1-.47 1.13l-6.9 6.9a1.6 1.6 0 0 1-2.26 0l-7.53-7.53a1.6 1.6 0 0 1 0-2.26l6.9-6.9A1.6 1.6 0 0 1 11.6 3.4Z" /><path d="M16.6 7.4h.02" /></>,
  'arrow-up': <><path d="M12 19.6V4.4" /><path d="M6 10.4 12 4.4l6 6" /></>,
  'arrow-down': <><path d="M12 4.4v15.2" /><path d="M18 13.6 12 19.6l-6-6" /></>,
  'arrow-left': <><path d="M19.6 12H4.4" /><path d="M10.4 18 4.4 12l6-6" /></>,
  'arrow-right': <><path d="M4.4 12h15.2" /><path d="M13.6 6l6 6-6 6" /></>,
  sun: <><circle cx="12" cy="12" r="4.2" /><path d="M12 2.6v2.2M12 19.2v2.2M4.36 4.36l1.56 1.56M18.08 18.08l1.56 1.56M2.6 12h2.2M19.2 12h2.2M4.36 19.64l1.56-1.56M18.08 5.92l1.56-1.56" /></>,
  moon: <path d="M20.6 13.6A8.6 8.6 0 0 1 10.4 3.4a8.6 8.6 0 1 0 10.2 10.2Z" />,
  eye: <><path d="M2.2 12S5.9 5.4 12 5.4 21.8 12 21.8 12 18.1 18.6 12 18.6 2.2 12 2.2 12Z" /><circle cx="12" cy="12" r="3.2" /></>,
  'eye-off': <><path d="M10.7 6.6A9.7 9.7 0 0 1 12 5.4c6.1 0 9.8 6.6 9.8 6.6a18 18 0 0 1-3.1 4" /><path d="M6.8 7.6A17.4 17.4 0 0 0 2.2 12s3.7 6.6 9.8 6.6a9.4 9.4 0 0 0 4-.9" /><path d="M9.8 9.8a3.2 3.2 0 0 0 4.4 4.4" /><path d="M3.4 3.4l17.2 17.2" /></>,
  // Additional contact, sorting and drag symbols follow the same SVG conventions.
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>,
  phone: <path d="M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a15 15 0 0 1-7-7l2-2-2-5Z" />,
  medal: <><circle cx="12" cy="8" r="5" /><path d="m8.2 11.3-1.7 9.2L12 18l5.5 2.5-1.7-9.2" /></>,
  sort: <path d="M8 19.6V4.4m-4 4 4-4 4 4M16 4.4v15.2m-4-4 4 4 4-4" />,
  grip: <path d="M9 5h.02M15 5h.02M9 12h.02M15 12h.02M9 19h.02M15 19h.02" />,
  globe: <><circle cx="12" cy="12" r="8.6" /><path d="M3.4 12h17.2" /><path d="M12 3.4c2.3 2.3 3.5 5.3 3.5 8.6s-1.2 6.3-3.5 8.6c-2.3-2.3-3.5-5.3-3.5-8.6S9.7 5.7 12 3.4Z" /></>,
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className ? `icon ${className}` : 'icon'} viewBox="0 0 24 24" width={size} height={size}
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {paths[name]}
  </svg>
}
