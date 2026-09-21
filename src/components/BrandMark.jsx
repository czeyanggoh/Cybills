import { useId } from 'react';

/**
 * The CY brand mark — a "CY" monogram on a rounded navy tile, the same logo
 * CYWorkspace carries, so the practice's apps look like one family.
 *
 * Copied from cyworkspace's `src/components/BrandMark.jsx` and kept in step
 * with `public/logo.svg` (the favicon) and its PNG exports. If CYWorkspace's
 * mark changes, copy it across again rather than redrawing it here.
 */
export default function BrandMark({ className = 'w-9 h-9', title = 'CYBills' }) {
  // Gradient ids must be unique per instance — the header and the hero render
  // the mark on the same page, and duplicate ids in one document are invalid.
  const gid = useId();
  return (
    <svg
      viewBox="0 0 120 120"
      className={className}
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2563EB" />
          <stop offset="0.55" stopColor="#1E3A8A" />
          <stop offset="1" stopColor="#0B1224" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" rx="27" fill={`url(#${gid})`} />
      <g
        transform="translate(60 60) scale(0.86) translate(-60 -60)"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="12"
      >
        {/* C — a 256-degree arc whose mouth opens to the right */}
        <path d="M52.5 42.7A22 22 0 1 0 52.5 77.3" stroke="#FFFFFF" />
        {/* Y — two arms meeting a stem, nested into the C's mouth */}
        <path d="M68 38 86 58 104 38M86 58v24" stroke="#38BDF8" />
      </g>
    </svg>
  );
}
