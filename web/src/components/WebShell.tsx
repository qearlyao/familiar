import { useState } from "react";
import {
  BookOpen,
  FileText,
  Images,
  MessageCircle,
  PanelLeftOpen,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WebAuthDevice } from "@/lib/api";
import { Chat } from "./Chat";
import { DiariesPage } from "./DiariesPage";

type ShellPage = "chat" | "diaries" | "skills" | "files" | "gallery";

interface ShellNavItem {
  id: ShellPage;
  label: string;
  description: string;
  icon: LucideIcon;
  enabled?: boolean;
}

const NAV_ITEMS: ShellNavItem[] = [
  {
    id: "chat",
    label: "chat",
    description: "where you two are",
    icon: MessageCircle,
    enabled: true,
  },
  {
    id: "diaries",
    label: "diaries",
    description: "written days",
    icon: BookOpen,
    enabled: true,
  },
  {
    id: "skills",
    label: "skills",
    description: "little tools",
    icon: Sparkles,
  },
  {
    id: "files",
    label: "files",
    description: "notes by the door",
    icon: FileText,
  },
  {
    id: "gallery",
    label: "gallery",
    description: "pictures left behind",
    icon: Images,
  },
];

function ShellButton({
  item,
  active,
  onClick,
}: {
  item: ShellNavItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  const enabled = item.enabled === true;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      className={cn(
        "flex h-11 w-full items-center gap-3 rounded-md px-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active
          ? "bg-primary text-primary-foreground hover:bg-primary"
          : enabled
            ? "text-sidebar-foreground/70 hover:bg-primary/20 hover:text-sidebar-foreground"
            : "cursor-default text-sidebar-foreground/35",
      )}
      aria-current={active ? "page" : undefined}
      title={enabled ? item.label : `${item.label} soon`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background/55 text-current">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm leading-tight">{item.label}</span>
        <span
          className={cn(
            "mt-0.5 block truncate font-serif text-[11px] italic",
            active ? "text-primary-foreground/75" : "text-muted-foreground",
          )}
        >
          {item.description}
        </span>
      </span>
    </button>
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
  const [selectedPage, setSelectedPage] = useState<ShellPage>("chat");
  const [pagePanelOpen, setPagePanelOpen] = useState(false);

  return (
    <div className="relative flex h-dvh bg-background text-foreground antialiased">
      <PopoverPrimitive.Root open={pagePanelOpen} onOpenChange={setPagePanelOpen}>
        <PopoverPrimitive.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="pages"
            title="pages"
            className="fixed top-3 left-3 z-20 size-9 bg-transparent text-muted-foreground shadow-none hover:bg-primary/20 hover:text-foreground md:left-4"
          >
            <PanelLeftOpen className="size-[1.125rem]" />
          </Button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="bottom"
            align="start"
            sideOffset={8}
            collisionPadding={16}
            className={cn(
              "z-50 w-72 max-w-[calc(100vw-1.5rem)] origin-(--radix-popover-content-transform-origin)",
              "rounded-lg bg-sidebar p-3 text-sidebar-foreground shadow-lg",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
              "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
              "motion-reduce:animate-none dark:bg-card dark:text-card-foreground",
              "dark:shadow-[2px_3px_12px_0_oklch(0.14_0.01_58_/_0.34)]",
            )}
          >
            <div className="px-3 pb-5">
              <div className="min-w-0 flex-1">
                <p className="font-serif text-lg leading-tight tracking-tight">familiar</p>
                <p className="mt-1 font-serif text-xs italic text-muted-foreground">choose a room</p>
              </div>
            </div>
            <nav className="grid gap-2">
              {NAV_ITEMS.map((item) => (
                <ShellButton
                  key={item.id}
                  item={item}
                  active={selectedPage === item.id}
                  onClick={() => {
                    if (item.enabled !== true) return;
                    setSelectedPage(item.id);
                    setPagePanelOpen(false);
                  }}
                />
              ))}
            </nav>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <section className={cn("min-w-0 flex-1 flex-col", selectedPage === "chat" ? "flex" : "hidden")}>
        <Chat authMode={authMode} authDevice={authDevice} onSignedOut={onSignedOut} />
      </section>
      {selectedPage === "diaries" ? (
        <section className="flex min-w-0 flex-1 flex-col animate-in fade-in-0 duration-200 motion-reduce:animate-none">
          <DiariesPage />
        </section>
      ) : null}
    </div>
  );
}
