import type { ReactNode } from "react";

// The reader's glyphs, drawn to the mockup's paths (24px grid, 2.75 stroke).
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const BackIcon = () => <Glyph><path d="M19 12H6M12 5l-7 7 7 7" /></Glyph>;
export const MarginIcon = () => <Glyph><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></Glyph>;
export const NotesIcon = () => <Glyph><path d="M4 4h11l5 5v11H4z" /><path d="M8 10h7M8 14h5" /></Glyph>;
export const DiscussIcon = () => <Glyph><path d="M20 12a7 7 0 0 1-7 7H8l-4 3V12a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7z" /></Glyph>;
export const NoteIcon = () => <Glyph><path d="M16.5 4.5l3 3L9 18l-4 1 1-4z" /></Glyph>;
export const MoreIcon = () => <Glyph><circle cx="12" cy="12" r="1.6" /><circle cx="18.5" cy="12" r="1.6" /><circle cx="5.5" cy="12" r="1.6" /></Glyph>;
export const CloseIcon = () => <Glyph><path d="M6 6l12 12M18 6L6 18" /></Glyph>;
export const ExportIcon = () => <Glyph><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" /></Glyph>;
