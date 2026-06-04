import { useState } from "react";
import { cn } from "@/lib/utils";
import type { WebAuthDevice } from "@/lib/api";
import { Chat } from "./Chat";
import { DiariesPage } from "./DiariesPage";
import { PagesNav, type ShellPage } from "./PagesNav";

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
  const nav = <PagesNav selectedPage={selectedPage} onSelectPage={setSelectedPage} />;

  return (
    <div className="relative flex h-dvh bg-background text-foreground antialiased">
      <section className={cn("min-w-0 flex-1 flex-col", selectedPage === "chat" ? "flex" : "hidden")}>
        <Chat nav={nav} authMode={authMode} authDevice={authDevice} onSignedOut={onSignedOut} />
      </section>
      {selectedPage === "diaries" ? (
        <section className="flex min-w-0 flex-1 flex-col animate-in fade-in-0 duration-200 motion-reduce:animate-none">
          <DiariesPage nav={nav} />
        </section>
      ) : null}
    </div>
  );
}
