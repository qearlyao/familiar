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
        variant="outline"
        size="sm"
        className="mt-3"
      >
        {ORDER.map((option) => {
          const Icon = ICON[option];
          return (
            <ToggleGroupItem
              key={option}
              value={option}
              aria-label={LABEL[option]}
              className="gap-1.5 px-3 lowercase"
            >
              <Icon className="size-3.5" />
              <span>{LABEL[option]}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </section>
  );
}
