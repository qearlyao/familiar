import type { ControlCommandDefinition } from "@/lib/slashCommands";

export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
}: {
  commands: readonly ControlCommandDefinition[];
  selectedIndex: number;
  onSelect: (command: ControlCommandDefinition) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="composer-panel" role="listbox" aria-label="small tools">
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          className="slash-item"
          aria-selected={index === selectedIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command)}
        >
          <span className="slash-name">/{command.name}</span>
          <span className="slash-desc">{command.description}</span>
        </button>
      ))}
    </div>
  );
}
