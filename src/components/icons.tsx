/**
 * Inline SVG icon set — API FROZEN (scaffold-FE per §11.6), paths owned/polished by [F2].
 *
 *   <Icon name="book" size={18} className="…" />
 *
 * 24×24 viewBox, stroke-width 2, `currentColor`, no fill. Simple lucide-like hand-written
 * paths — F2 may replace the artwork but MUST keep the `name` union and props identical.
 */
import type { ReactNode } from 'react';

export const ICON_NAMES = [
  'book', 'search', 'bookmark', 'toc', 'notes', 'settings', 'sun', 'moon', 'type',
  'columns', 'scroll', 'maximize', 'close', 'chevronLeft', 'chevronRight', 'plus',
  'check', 'trash', 'edit', 'play', 'arrowLeft', 'layers', 'languages',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Stroke width override (default 2). */
  strokeWidth?: number;
  title?: string;
}

const PATHS: Record<IconName, ReactNode> = {
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  bookmark: <path d="M19 21 12 16.5 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  toc: (
    <>
      <path d="M3 5h18M3 12h12M3 19h18" />
    </>
  ),
  notes: (
    <>
      <path d="M14 3v5h5" />
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l6 6v10a2 2 0 0 1-2 2z" />
      <path d="M8 13h6M8 17h4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="18" r="2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  type: (
    <>
      <path d="M4 7V5h16v2" />
      <path d="M12 5v14M9 19h6" />
    </>
  ),
  columns: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </>
  ),
  scroll: (
    <>
      <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
    </>
  ),
  maximize: <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m20 6-11 11-5-5" />,
  trash: (
    <>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  play: <path d="M6 4.5v15l13-7.5z" />,
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 9 5-9 5-9-5z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </>
  ),
  languages: (
    <>
      <path d="m5 8 6 6M4 14l6-6 2-3" />
      <path d="M2 5h12M7 2h1" />
      <path d="m22 22-5-10-5 10M14 18h6" />
    </>
  ),
};

export function Icon({ name, size = 18, className, strokeWidth = 2, title }: IconProps) {
  const shape = PATHS[name];
  if (!shape) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {shape}
    </svg>
  );
}

export default Icon;
