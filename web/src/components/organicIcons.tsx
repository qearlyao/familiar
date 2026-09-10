/* eslint-disable react-refresh/only-export-components */
import type { ReactNode, SVGProps } from "react";

// Glyphs transcribed from the redesign spec (Lucide-style, stroke 2.75).
function glyph(children: ReactNode) {
  return function Glyph({ size = 21, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {children}
      </svg>
    );
  };
}

export const RailChat = glyph(<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />);
export const RailVoice = glyph(<path d="M3 10v4M8 6v12M13 3v18M18 8v8M21 11v2" />);
export const RailLibrary = glyph(
  <>
    <rect x="3" y="4" width="6" height="16" rx="1.5" />
    <rect x="12" y="4" width="6" height="16" rx="1.5" />
    <path d="M21 5v14" />
  </>,
);
export const RailDiaries = glyph(
  <>
    <path d="M12 7v14" />
    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
  </>,
);
export const RailSkills = glyph(
  <>
    <path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z" />
    <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  </>,
);
export const RailKeepsakes = glyph(
  <path d="M19 13.5c1.3-1.3 2.5-2.8 2.5-4.7A4.8 4.8 0 0 0 16.7 4c-1.5 0-2.6.5-3.9 1.8C11.5 4.5 10.4 4 8.9 4A4.8 4.8 0 0 0 4.1 8.8c0 2 1.3 3.5 2.6 4.8l6.1 6.1z" />,
);
export const RailMakings = glyph(
  <>
    <path d="M12 21a9 9 0 1 1 9-9 4 4 0 0 1-4 4h-1.8a1.6 1.6 0 0 0-1.3 2.5 1.6 1.6 0 0 1-1.3 2.5z" />
    <circle cx="8.5" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
  </>,
);
export const RailSettings = glyph(
  <>
    <path d="M20 7h-8M9 17H4" />
    <circle cx="17" cy="17" r="3" />
    <circle cx="7" cy="7" r="3" />
  </>,
);
export const IconMore = glyph(
  <>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </>,
);

export const IconList = glyph(<path d="M4 7h16M4 13h16M4 19h9" />);
export const IconChevronDown = glyph(<path d="M6 9l6 6 6-6" />);
export const IconChevronLeft = glyph(<path d="M15 6l-6 6 6 6" />);
export const IconChevronRight = glyph(<path d="M9 6l6 6-6 6" />);
export const IconSearch = glyph(<><path d="M21 21l-4.3-4.3" /><circle cx="10.5" cy="10.5" r="7" /></>);
export const IconExpand = glyph(<><path d="M7 17 17 7" /><path d="M9 7h8v8" /></>);
export const IconChevronUp = glyph(<path d="M6 15l6-6 6 6" />);
export const IconSwitch = glyph(
  <>
    <path d="M7 8H3l4-4M7 8l-4 4" />
    <path d="M17 16h4l-4-4M17 16l4 4" />
    <path d="M10 8h11M3 16h11" />
  </>,
);
export const IconArrow = glyph(<path d="M5 12h13M12 5l7 7-7 7" />);
export const IconX = glyph(<path d="M18 6 6 18M6 6l12 12" />);
export const IconAgain = glyph(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </>,
);
export const IconEdit = glyph(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </>,
);
export const IconSticker = glyph(
  <>
    <path d="M13.5 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-6.5z" />
    <path d="M13.5 3v4.5a3 3 0 0 0 3 3H21" />
    <path d="M8.6 15.4a3.4 3.4 0 0 0 4.8 0" />
    <circle cx="8.7" cy="11" r="1" fill="currentColor" stroke="none" />
    <circle cx="13.2" cy="11" r="1" fill="currentColor" stroke="none" />
  </>,
);
export const IconPaperclip = glyph(
  <path d="M15.4 7.1 8.7 13.8a2.9 2.9 0 0 0 4.1 4.1l6.7-6.7a4.9 4.9 0 0 0-6.9-6.9L5.8 11a6.8 6.8 0 0 0 9.6 9.6l3.3-3.3" />,
);
export const IconMic = glyph(
  <>
    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
    <path d="M19 11v1a7 7 0 0 1-14 0v-1" />
    <path d="M12 19v3" />
  </>,
);
export const IconStop = glyph(<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />);
export const IconPlay = glyph(<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />);
export const IconPause = glyph(
  <>
    <rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" />
  </>,
);
export const IconCheck = glyph(<path d="M5 12l5 5L20 7" />);
export const IconDownload = glyph(
  <>
    <path d="M12 4v12" />
    <path d="M8 12l4 4 4-4" />
    <path d="M5 19h14" />
  </>,
);

export const NavModel = glyph(
  <>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4M9 14h.01M15 14h.01" />
  </>,
);
export const NavThinking = glyph(
  <path d="M12 4a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2.2A3 3 0 0 0 17 17v-2.2A3.5 3.5 0 0 0 16 8a4 4 0 0 0-4-4z" />,
);
export const NavHeartbeat = glyph(<path d="M3 12h3l2-4 3 8 2.5-5 1.5 3h4" />);
export const NavVoice = glyph(
  <>
    <path d="M11 5 7 9H4v6h3l4 4z" />
    <path d="M16 9a4 4 0 0 1 0 6" />
    <path d="M19 6.5a7.5 7.5 0 0 1 0 11" />
  </>,
);
export const NavImage = glyph(
  <>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4 18l5-5 4 4 3-3 4 4" />
  </>,
);
export const NavChannels = RailChat;
export const NavMemory = glyph(
  <>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </>,
);
export const NavNotifications = glyph(
  <>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
    <path d="M10.3 20a2 2 0 0 0 3.4 0" />
  </>,
);
export const NavDevices = glyph(
  <>
    <rect x="2" y="5" width="13" height="10" rx="2" />
    <rect x="16" y="9" width="6" height="11" rx="2" />
    <path d="M6 19h5" />
  </>,
);
