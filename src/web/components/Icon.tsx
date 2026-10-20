/** 一套 16px 线性图标，1.5px 描边，颜色随文字 */
const PATHS = {
  today: 'M3 6.5 8 2.5l5 4V13a.5.5 0 0 1-.5.5h-3v-4h-3v4h-3A.5.5 0 0 1 3 13V6.5Z',
  map: 'M2.5 4 6 2.5l4 1.5 3.5-1.5v9.5L10 13.5 6 12l-3.5 1.5V4ZM6 2.5V12M10 4v9.5',
  library: 'M3 2.5h7.5l2.5 2.5v8.5H3v-11ZM10.5 2.5V5H13M5.5 8h5M5.5 10.5h5',
  settings:
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM13 8.6V7.4l-1.5-.5-.4-1 .7-1.4-.9-.9-1.4.7-1-.4L8.6 2.5H7.4l-.5 1.5-1 .4-1.4-.7-.9.9.7 1.4-.4 1-1.5.5v1.2l1.5.5.4 1-.7 1.4.9.9 1.4-.7 1 .4.5 1.5h1.2l.5-1.5 1-.4 1.4.7.9-.9-.7-1.4.4-1 1.5-.5Z',
  menu: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  chevron: 'M6 3.5 10.5 8 6 12.5',
  back: 'M10 3.5 5.5 8l4.5 4.5',
  external: 'M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11 9.5v3.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5H7',
  topic: 'M3 3h10v10H3zM3 6.5h10',
  bell: 'M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3L4 11ZM6.5 13.5a1.5 1.5 0 0 0 3 0',
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name]} />
    </svg>
  );
}

/** 微课堂的标志：四级逐渐升高的台阶，对应理解 → 回忆 → 应用 → 保持 */
export function Mark() {
  return (
    <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
      <rect x="1" y="14" width="4" height="7" rx="1.5" fill="#b7d9d3" />
      <rect x="6.5" y="10" width="4" height="11" rx="1.5" fill="#7dbcb2" />
      <rect x="12" y="6" width="4" height="15" rx="1.5" fill="#3d968b" />
      <rect x="17.5" y="1" width="4" height="20" rx="1.5" fill="#1b6e66" />
    </svg>
  );
}
