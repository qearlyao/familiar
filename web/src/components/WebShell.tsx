import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { WebAuthDevice } from "@/lib/api";
import { ContactCard } from "./ContactCard";
import { Chat } from "./Chat";
import { DiariesPage } from "./DiariesPage";
import { FilesPage } from "./FilesPage";
import { GalleryPage } from "./GalleryPage";
import { LibraryPage } from "./LibraryPage";
import { SkillsPage } from "./SkillsPage";
import { VoiceCallPage } from "./VoiceCallPage";
import {
  IconMore,
  RailChat,
  RailDiaries,
  RailKeepsakes,
  RailLibrary,
  RailMakings,
  RailSettings,
  RailSkills,
  RailVoice,
} from "./organicIcons";
import "./chat.css";

type ShellPage = "chat" | "voice" | "library" | "diaries" | "skills" | "files" | "gallery";
export type NavTarget = ShellPage | "settings";

/** one row per room: what the rail/mobile bar draws and what the surface renders.
    chat has no `Page` — the shell owns its surface. */
const ROOMS: { id: ShellPage; label: string; rail: typeof RailChat; Page?: () => ReactNode }[] = [
  { id: "chat", label: "chat", rail: RailChat },
  { id: "voice", label: "voice", rail: RailVoice, Page: VoiceCallPage },
  { id: "library", label: "library", rail: RailLibrary, Page: LibraryPage },
  { id: "diaries", label: "diaries", rail: RailDiaries, Page: DiariesPage },
  { id: "skills", label: "skills", rail: RailSkills, Page: SkillsPage },
  { id: "files", label: "keepsakes", rail: RailKeepsakes, Page: FilesPage },
  { id: "gallery", label: "makings", rail: RailMakings, Page: GalleryPage },
];

/** mobile bar: slot one pins where you are, the middle set flips, the dots toggle it. */
const MOBILE_PRIMARY: NavTarget[] = ["voice", "library", "diaries"];
const MOBILE_SECONDARY: NavTarget[] = ["files", "gallery", "skills", "settings"];

/** the rail and the mobile bar around whatever surfaces are showing. */
export function ShellChrome({
  current,
  onNavigate,
  children,
}: {
  current: NavTarget;
  onNavigate: (target: NavTarget) => void;
  children: ReactNode;
}) {
  const [swapped, setSwapped] = useState(false);
  const go = (target: NavTarget) => {
    setSwapped(false);
    onNavigate(target);
  };

  const isSecondary = MOBILE_SECONDARY.includes(current);
  const pinned: NavTarget = swapped || isSecondary ? current : "chat";
  const flipped: NavTarget[] = swapped
    ? [...(isSecondary ? (["chat"] as NavTarget[]) : []), ...MOBILE_SECONDARY.filter((p) => p !== current)]
    : MOBILE_PRIMARY;

  const mobileButton = (target: NavTarget, slot: string, index = 0) => {
    const room = ROOMS.find((r) => r.id === target);
    const Icon = room?.rail ?? RailSettings;
    const label = room?.label ?? "settings";
    return (
      <button
        // remount on every flip so the slide-in replays
        key={slot === "flip" ? `flip-${swapped}-${target}` : `${slot}-${target}`}
        type="button"
        title={label}
        aria-label={label}
        aria-current={target === current ? "page" : undefined}
        data-slot={slot}
        style={slot === "flip" ? { animationDelay: `${index * 28}ms` } : undefined}
        onClick={() => go(target)}
      >
        <Icon />
      </button>
    );
  };

  return (
    <div className="familiar-shell relative flex h-dvh w-full overflow-hidden antialiased">
      <nav className="room-rail" aria-label="rooms">
        <button className="room-brand" aria-label="home" onClick={() => go("chat")}>f</button>
        <div className="room-rail-items">
          {ROOMS.map(({ id, label, rail: Icon }) => (
            <button key={id} type="button" title={label} aria-label={label} aria-current={current === id ? "page" : undefined} onClick={() => go(id)}>
              <Icon />
            </button>
          ))}
        </div>
        <div className="room-rail-bottom">
          <button type="button" title="settings" aria-label="settings" aria-current={current === "settings" ? "page" : undefined} onClick={() => go("settings")}>
            <RailSettings />
          </button>
          <ContactCard />
        </div>
      </nav>
      {children}
      <nav className="room-mobile-nav" aria-label="rooms" data-swapped={swapped ? "" : undefined}>
        {mobileButton(pinned, "pin")}
        {flipped.map((page, i) => mobileButton(page, "flip", i))}
        <button
          type="button"
          title="everything else"
          aria-label="everything else"
          aria-expanded={swapped}
          data-swapped={swapped ? "" : undefined}
          onClick={() => setSwapped((v) => !v)}
        >
          <IconMore />
        </button>
      </nav>
    </div>
  );
}

export function WebShell({
  authMode,
  authDevice,
  onSignedOut,
}: {
  authMode?: string;
  authDevice?: WebAuthDevice;
  onSignedOut?: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedPage, setSelectedPage] = useState<ShellPage>("chat");
  const [shelfOpen, setShelfOpen] = useState(false);
  const [mounted, setMounted] = useState<Set<ShellPage>>(() => new Set(["chat"]));

  const open = (page: ShellPage) => {
    setMounted((prev) => (prev.has(page) ? prev : new Set(prev).add(page)));
    setSelectedPage(page);
    setSettingsOpen(false);
  };

  const showing = shelfOpen && selectedPage === "chat" && !settingsOpen;

  const navigate = (target: NavTarget) => {
    if (target === "settings") {
      setSelectedPage("chat");
      setSettingsOpen(true);
      return;
    }
    // diaries arrive as a shelf over the talk (Chat 1a); the archive is a room you go into from there.
    // the rail pill is the shelf's own toggle — press it again and the shelf goes away.
    if (target === "diaries") {
      setShelfOpen(!showing);
      setSelectedPage("chat");
      setSettingsOpen(false);
      return;
    }
    setShelfOpen(false);
    open(target);
  };

  return (
    <ShellChrome current={settingsOpen ? "settings" : showing ? "diaries" : selectedPage} onNavigate={navigate}>
      <section className={cn("room-surface min-w-0 flex-1 flex-col", selectedPage === "chat" ? "flex" : "hidden")}>
        <Chat
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
          shelfOpen={shelfOpen}
          onShelfOpenChange={setShelfOpen}
          onOpenArchive={() => {
            setShelfOpen(false);
            open("diaries");
          }}
          authMode={authMode}
          authDevice={authDevice}
          onSignedOut={onSignedOut}
        />
      </section>
      {ROOMS.map(({ id, Page }) =>
        Page && mounted.has(id) ? (
          <section key={id} className={cn("room-surface min-w-0 flex-1 flex-col", selectedPage === id ? "flex" : "hidden")}>
            <Page />
          </section>
        ) : null,
      )}
    </ShellChrome>
  );
}
