import { useState } from "react";
import { BookOpen, FileText, Images, MessageCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WebAuthDevice } from "@/lib/api";
import { Chat } from "./Chat";
import { DiariesPage } from "./DiariesPage";
import { PagesNav, type ShellNavItem } from "./PagesNav";

type ShellPage = "chat" | "diaries" | "skills" | "files" | "gallery";

const NAV_ITEMS: ShellNavItem<ShellPage>[] = [
  { id: "chat", label: "chat", description: "where you two are", icon: MessageCircle, enabled: true },
  { id: "diaries", label: "diaries", description: "written days", icon: BookOpen, enabled: true },
  { id: "skills", label: "skills", description: "little tools", icon: Sparkles },
  { id: "files", label: "files", description: "notes by the door", icon: FileText },
  { id: "gallery", label: "gallery", description: "pictures left behind", icon: Images },
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
  const [diariesMounted, setDiariesMounted] = useState(false);
  const diariesActive = selectedPage === "diaries";

  const selectPage = (page: ShellPage) => {
    if (page === "diaries") setDiariesMounted(true);
    setSelectedPage(page);
  };

  const nav = <PagesNav items={NAV_ITEMS} selectedPage={selectedPage} onSelectPage={selectPage} />;

  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-background text-foreground antialiased">
      <section className={cn("min-w-0 flex-1 flex-col", selectedPage === "chat" ? "flex" : "hidden")}>
        <Chat nav={nav} authMode={authMode} authDevice={authDevice} onSignedOut={onSignedOut} />
      </section>
      {diariesMounted ? (
        <section className={cn("min-w-0 flex-1 flex-col", diariesActive ? "flex" : "hidden")}>
          <DiariesPage nav={nav} />
        </section>
      ) : null}
    </div>
  );
}
