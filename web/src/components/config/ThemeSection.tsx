import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { loadMode, saveMode, type ThemeMode } from "@/lib/theme";

const ORDER: ThemeMode[] = ["light", "dark", "auto"];
const ICON: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  auto: Monitor,
};
const LABEL: Record<ThemeMode, string> = {
  light: "light",
  dark: "dark",
  auto: "system",
};

export function ThemeSection() {
  const [mode, setMode] = useState<ThemeMode>(() => loadMode());

  useEffect(() => {
    saveMode(mode);
  }, [mode]);

  return (
    <section>
      <h3 className="font-serif text-lg leading-tight tracking-tight text-foreground">theme</h3>
      <p className="mt-1 font-serif text-xs italic text-muted-foreground">
        light, dark, or follow your system.
      </p>
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(value) => {
          if (value) setMode(value as ThemeMode);
        }}
        spacing={1}
        className="mt-4 rounded-lg bg-muted/40 p-1"
      >
        {ORDER.map((option) => {
          const Icon = ICON[option];
          return (
            <ToggleGroupItem
              key={option}
              value={option}
              aria-label={LABEL[option]}
              className="h-9 gap-2 rounded-md px-3.5 text-sm lowercase text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary"
            >
              <Icon className="size-4" />
              <span>{LABEL[option]}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </section>
  );
}
