import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadMode, saveMode, type ThemeMode } from "@/lib/theme";

const ORDER: ThemeMode[] = ["light", "dark", "auto"];
const ICON: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  auto: Monitor,
};
const LABEL: Record<ThemeMode, string> = {
  light: "light mode",
  dark: "dark mode",
  auto: "system mode",
};

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => loadMode());

  useEffect(() => {
    saveMode(mode);
  }, [mode]);

  const Icon = ICON[mode];
  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`theme: ${LABEL[mode]}, click for ${LABEL[next]}`}
      title={LABEL[mode]}
      className="size-8"
      onClick={() => setMode(next)}
    >
      <Icon className="size-4" />
    </Button>
  );
}
