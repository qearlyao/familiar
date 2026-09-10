import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { WebAuthDevice } from "@/lib/api";
import { ContactCard } from "./ContactCard";
import { Chat, type ShelfName } from "./Chat";
import type { ComposerHandle } from "./Composer";
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

interface RoomProps {
  /** hand something to the talk, and land there */
  onBring: (text: string) => void;
  /** the way back out of a pushed page */
  onBack: () => void;
}

/** one row per room: what the rail/mobile bar draws and what the surface renders.
    chat has no `Page` — the shell owns its surface. A room that can hand something to the talk
    takes `onBring`; the rest ignore it. */
const ROOMS: { id: ShellPage; label: string; rail: typeof RailChat; Page?: ComponentType<RoomProps> }[] = [
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
  held,
  pushed,
  onNavigate,
  children,
}: {
  current: NavTarget;
  /** a room whose shelf is held open over the talk — marked apart from the room you're in */
  held?: NavTarget;
  /** a room entered from a shelf carries its own back arrow, so the phone bar steps aside */
  pushed?: boolean;
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
    <div className="familiar-shell relative flex h-dvh w-full overflow-hidden antialiased" data-pushed={pushed ? "" : undefined}>
      <nav className="room-rail" aria-label="rooms">
        <button className="room-brand" aria-label="home" onClick={() => go("chat")}>f</button>
        <div className="room-rail-items">
          {ROOMS.map(({ id, label, rail: Icon }) => (
            <button key={id} type="button" title={label} aria-label={label} aria-current={current === id ? "page" : undefined}
              data-held={held === id ? "" : undefined} onClick={() => go(id)}>
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
  const [shelf, setShelf] = useState<ShelfName | undefined>();
  const [mounted, setMounted] = useState<Set<ShellPage>>(() => new Set(["chat"]));
  const composer = useRef<ComposerHandle>(null);

  const open = (page: ShellPage) => {
    setMounted((prev) => (prev.has(page) ? prev : new Set(prev).add(page)));
    setSelectedPage(page);
    setSettingsOpen(false);
  };

  const showing = selectedPage === "chat" && !settingsOpen ? shelf : undefined;

  // a day, a page, a keepsake — whatever a room hands over lands in the draft, and you land there too
  const bring = (text: string) => {
    composer.current?.append(text);
    setShelf(undefined);
    open("chat");
  };

  const navigate = (target: NavTarget) => {
    if (target === "settings") {
      setSelectedPage("chat");
      setSettingsOpen(true);
      return;
    }
    // diaries and skills arrive as a shelf over the talk (Chat 1a); the full room is somewhere
    // you go into from there. the rail pill is the shelf's own toggle — press it again and it goes.
    if (target === "diaries" || target === "skills") {
      setShelf(showing === target ? undefined : target);
      setSelectedPage("chat");
      setSettingsOpen(false);
      return;
    }
    setShelf(undefined);
    open(target);
  };

  return (
    <ShellChrome
      current={settingsOpen ? "settings" : selectedPage}
      held={showing}
      pushed={(selectedPage === "diaries" || selectedPage === "skills") && !settingsOpen}
      onNavigate={navigate}
    >
      <section className={cn("room-surface min-w-0 flex-1 flex-col", selectedPage === "chat" ? "flex" : "hidden")}>
        <Chat
          composer={composer}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
          shelf={shelf}
          onShelfChange={setShelf}
          onOpenArchive={(page) => {
            setShelf(undefined);
            open(page);
          }}
          authMode={authMode}
          authDevice={authDevice}
          onSignedOut={onSignedOut}
        />
      </section>
      {ROOMS.map(({ id, Page }) =>
        Page && mounted.has(id) ? (
          <section key={id} className={cn("room-surface min-w-0 flex-1 flex-col", selectedPage === id ? "flex" : "hidden")}>
            <Page onBring={bring} onBack={() => open("chat")} />
          </section>
        ) : null,
      )}
    </ShellChrome>
  );
}
