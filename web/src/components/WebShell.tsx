import { useState } from "react";
import { BookOpen, FileHeart, LibraryBig, MessageCircle, Palette, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WebAuthDevice } from "@/lib/api";
import { Chat } from "./Chat";
import { DiariesPage } from "./DiariesPage";
import { FilesPage } from "./FilesPage";
import { GalleryPage } from "./GalleryPage";
import { LibraryPage } from "./LibraryPage";
import { PagesNav, type ShellNavItem } from "./PagesNav";
import { SkillsPage } from "./SkillsPage";

type ShellPage = "chat" | "library" | "diaries" | "skills" | "files" | "gallery";

const NAV_ITEMS: ShellNavItem<ShellPage>[] = [
  { id: "chat", label: "chat", description: "where you two are", icon: MessageCircle, enabled: true },
  { id: "library", label: "library", description: "the shelf you share", icon: LibraryBig, enabled: true },
  { id: "diaries", label: "diaries", description: "written days", icon: BookOpen, enabled: true },
  { id: "skills", label: "skills", description: "little tools", icon: Sparkles, enabled: true },
  { id: "files", label: "keepsakes", description: "the notes that make them them", icon: FileHeart, enabled: true },
  { id: "gallery", label: "makings", description: "the images and sounds it made", icon: Palette, enabled: true },
];

export function WebShell({
  authMode,
  authDevice,
  onSignedOut,
}: {
  authMode?: string;
  authDevice?: WebAuthDevice;
  onSignedOut?: () => void;
}) {
  const [selectedPage, setSelectedPage] = useState<ShellPage>("chat");
  const [libraryMounted, setLibraryMounted] = useState(false);
  const [diariesMounted, setDiariesMounted] = useState(false);
  const [skillsMounted, setSkillsMounted] = useState(false);
  const [filesMounted, setFilesMounted] = useState(false);
  const [galleryMounted, setGalleryMounted] = useState(false);
  const libraryActive = selectedPage === "library";
  const diariesActive = selectedPage === "diaries";
  const skillsActive = selectedPage === "skills";
  const filesActive = selectedPage === "files";
  const galleryActive = selectedPage === "gallery";

  const selectPage = (page: ShellPage) => {
    if (page === "library") setLibraryMounted(true);
    if (page === "diaries") setDiariesMounted(true);
    if (page === "skills") setSkillsMounted(true);
    if (page === "files") setFilesMounted(true);
    if (page === "gallery") setGalleryMounted(true);
    setSelectedPage(page);
  };

  const nav = <PagesNav items={NAV_ITEMS} selectedPage={selectedPage} onSelectPage={selectPage} />;

  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-background text-foreground antialiased">
      <section className={cn("min-w-0 flex-1 flex-col", selectedPage === "chat" ? "flex" : "hidden")}>
        <Chat nav={nav} authMode={authMode} authDevice={authDevice} onSignedOut={onSignedOut} />
      </section>
      {libraryMounted ? (
        <section className={cn("min-w-0 flex-1 flex-col", libraryActive ? "flex" : "hidden")}>
          <LibraryPage nav={nav} />
        </section>
      ) : null}
      {diariesMounted ? (
        <section className={cn("min-w-0 flex-1 flex-col", diariesActive ? "flex" : "hidden")}>
          <DiariesPage nav={nav} />
        </section>
      ) : null}
      {skillsMounted ? (
        <section className={cn("min-w-0 flex-1 flex-col", skillsActive ? "flex" : "hidden")}>
          <SkillsPage nav={nav} />
        </section>
      ) : null}
      {filesMounted ? (
        <section className={cn("min-w-0 flex-1 flex-col", filesActive ? "flex" : "hidden")}>
          <FilesPage nav={nav} />
        </section>
      ) : null}
      {galleryMounted ? (
        <section className={cn("min-w-0 flex-1 flex-col", galleryActive ? "flex" : "hidden")}>
          <GalleryPage nav={nav} />
        </section>
      ) : null}
    </div>
  );
}
