import { useState, type ReactNode } from "react";
import { AudioLines, BookOpen, FileHeart, LibraryBig, MessageCircle, Palette, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WebAuthDevice } from "@/lib/api";
import { Chat } from "./Chat";
import { DiariesPage } from "./DiariesPage";
import { FilesPage } from "./FilesPage";
import { GalleryPage } from "./GalleryPage";
import { LibraryPage } from "./LibraryPage";
import { PagesNav, type ShellNavItem } from "./PagesNav";
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

/** one row per room: what the pages nav shows, what the rail/mobile bar draws, what the surface renders.
    chat has no `Page` — it owns its own surface below. */
type ShellRoom = ShellNavItem<ShellPage> & {
  rail: typeof RailChat;
  Page?: (props: { nav: ReactNode }) => ReactNode;
};

const ROOMS: ShellRoom[] = [
  { id: "chat", label: "chat", description: "where you two are", icon: MessageCircle, enabled: true, rail: RailChat },
  { id: "voice", label: "voice", description: "out loud, in real time", icon: AudioLines, enabled: true, rail: RailVoice, Page: VoiceCallPage },
  { id: "library", label: "library", description: "the shelf you share", icon: LibraryBig, enabled: true, rail: RailLibrary, Page: LibraryPage },
  { id: "diaries", label: "diaries", description: "written days", icon: BookOpen, enabled: true, rail: RailDiaries, Page: DiariesPage },
  { id: "skills", label: "skills", description: "little tools", icon: Sparkles, enabled: true, rail: RailSkills, Page: SkillsPage },
  { id: "files", label: "keepsakes", description: "the notes that make them them", icon: FileHeart, enabled: true, rail: RailKeepsakes, Page: FilesPage },
  { id: "gallery", label: "makings", description: "the images and sounds it made", icon: Palette, enabled: true, rail: RailMakings, Page: GalleryPage },
];

type NavTarget = ShellPage | "settings";

/** mobile bar: slot one pins where you are, the middle set flips, the dots toggle it. */
const MOBILE_PRIMARY: NavTarget[] = ["voice", "library", "diaries"];
const MOBILE_SECONDARY: NavTarget[] = ["files", "gallery", "skills", "settings"];

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
  const [mounted, setMounted] = useState<Set<ShellPage>>(() => new Set(["chat"]));
  const [swapped, setSwapped] = useState(false);

  const selectPage = (page: ShellPage) => {
    setMounted((prev) => (prev.has(page) ? prev : new Set(prev).add(page)));
    setSelectedPage(page);
    setSettingsOpen(false);
    setSwapped(false);
  };
  const openSettings = () => {
    setSelectedPage("chat");
    setSettingsOpen(true);
    setSwapped(false);
  };

  const nav = <PagesNav items={ROOMS} selectedPage={selectedPage} onSelectPage={selectPage} />;
  const isCurrent = (page: ShellPage) => selectedPage === page && !settingsOpen;

  const railButton = ({ id, label, rail: Icon }: ShellRoom) => (
    <button key={id} type="button" title={label} aria-label={label} aria-current={isCurrent(id) ? "page" : undefined} onClick={() => selectPage(id)}>
      <Icon />
    </button>
  );

  const current: NavTarget = settingsOpen ? "settings" : selectedPage;
  const isSecondary = MOBILE_SECONDARY.includes(current);
  const pinned: NavTarget = swapped || isSecondary ? current : "chat";
  const flipped: NavTarget[] = swapped
    ? [...(isSecondary ? (["chat"] as NavTarget[]) : []), ...MOBILE_SECONDARY.filter((p) => p !== current)]
    : MOBILE_PRIMARY;

  const mobileButton = (page: NavTarget, slot: string, index = 0) => {
    const room = ROOMS.find((r) => r.id === page);
    const Icon = room?.rail ?? RailSettings;
    const label = room?.label ?? "settings";
    return (
      <button
        // remount on every flip so the slide-in replays
        key={slot === "flip" ? `flip-${swapped}-${page}` : `${slot}-${page}`}
        type="button"
        title={label}
        aria-label={label}
        aria-current={page === current ? "page" : undefined}
        data-slot={slot}
        style={slot === "flip" ? { animationDelay: `${index * 28}ms` } : undefined}
        onClick={() => (page === "settings" ? openSettings() : selectPage(page))}
      >
        <Icon />
      </button>
    );
  };

  return (
    <div className="familiar-shell relative flex h-dvh w-full overflow-hidden antialiased">
      <nav className="room-rail" aria-label="rooms">
        <button className="room-brand" aria-label="home" onClick={() => selectPage("chat")}>f</button>
        <div className="room-rail-items">{ROOMS.map(railButton)}</div>
        <div className="room-rail-bottom">
          <button type="button" title="settings" aria-label="settings" aria-current={settingsOpen ? "page" : undefined} onClick={openSettings}>
            <RailSettings />
          </button>
          <div className="room-rail-you" aria-hidden="true" />
        </div>
      </nav>
      <section className={cn("room-surface min-w-0 flex-1 flex-col", selectedPage === "chat" ? "flex" : "hidden")}>
        <Chat settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen} authMode={authMode} authDevice={authDevice} onSignedOut={onSignedOut} />
      </section>
      {ROOMS.map(({ id, Page }) =>
        Page && mounted.has(id) ? (
          <section key={id} className={cn("room-surface min-w-0 flex-1 flex-col", selectedPage === id ? "flex" : "hidden")}>
            <Page nav={nav} />
          </section>
        ) : null,
      )}
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
