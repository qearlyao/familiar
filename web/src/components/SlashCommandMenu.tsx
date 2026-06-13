import type { ControlCommandDefinition } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

interface SlashCommandMenuProps {
  commands: readonly ControlCommandDefinition[];
  selectedIndex: number;
  onSelect: (command: ControlCommandDefinition) => void;
}

export function slashCommandText(command: ControlCommandDefinition): string {
  return `/${command.name}${command.argumentLabel ? " " : ""}`;
}

export function SlashCommandMenu({ commands, selectedIndex, onSelect }: SlashCommandMenuProps) {
  if (commands.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/70 pb-2" role="listbox">
      {commands.map((command, index) => {
        const active = index === selectedIndex;
        return (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(command)}
            className={cn(
              "flex min-h-8 w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left transition-colors",
              active ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted",
            )}
          >
            <span className="w-36 shrink-0 truncate font-mono text-xs">/{command.name}</span>
            <span className="min-w-0 flex-1 truncate font-serif text-xs italic text-muted-foreground">
              {command.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
