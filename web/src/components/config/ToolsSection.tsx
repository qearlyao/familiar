import { useEffect, useState } from "react";
import { fetchTools, updateTool, type BuiltinTool, type ToolReach } from "@/lib/api";
import { useRequestState } from "@/lib/requestState";
import { cn } from "@/lib/utils";
import { IconChevronDown, IconChevronUp } from "../organicIcons";
import { Card } from "./inputs";

const SHELVES: { reach: ToolReach; label: string; note: string }[] = [
  { reach: "pinned", label: "always at hand", note: "rides in every message" },
  { reach: "loadable", label: "fetched when needed", note: "waits until they ask" },
  { reach: "off", label: "put away", note: "out of reach for good" },
];

/** The tools they were born holding: a lasting reach, and a rest that ends at the next restart. */
export function ToolsSection() {
  const [tools, setTools] = useState<BuiltinTool[] | undefined>(undefined);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const { error, isLoading, isMutating, run } = useRequestState();
  const busy = isLoading || isMutating;

  useEffect(() => {
    const id = window.setTimeout(() => void run(fetchTools, { busy: "load", apply: setTools }), 0);
    return () => window.clearTimeout(id);
  }, [run]);

  const change = (body: Parameters<typeof updateTool>[0]) => void run(() => updateTool(body), { apply: setTools });

  return (
    <Card title="their own hands" hint="tap a tool, then move it up or down a shelf. resting sets one aside until the next restart, then it comes back to the shelf it left.">
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      <div className="settings-rows">
        {SHELVES.map((shelf, shelfIndex) => {
          const chips = tools?.filter((tool) => tool.reach === shelf.reach) ?? [];
          return (
            <div key={shelf.reach} className="tool-shelf">
              <p>
                <span>{shelf.label}</span>
                <small>{shelf.note}</small>
              </p>
              <div className="tool-chips">
                {chips.map((tool) => {
                  const selected = picked === tool.name;
                  const move = (to: number) => () => {
                    change({ name: tool.name, reach: SHELVES[to].reach });
                    setPicked(tool.name);
                  };
                  return (
                    <div key={tool.name} className={cn("tool-chip", selected && "is-picked", (shelf.reach === "off" || tool.paused) && "is-off")}>
                      <button type="button" aria-expanded={selected} onClick={() => setPicked(selected ? undefined : tool.name)}>
                        <code>{tool.name}</code>
                        {tool.paused && <em>resting</em>}
                      </button>
                      {selected && (
                        <span className="tool-moves">
                          <button
                            type="button"
                            disabled={busy || shelfIndex === 0}
                            title={shelfIndex === 0 ? "already on the first shelf" : `move to ${SHELVES[shelfIndex - 1].label}`}
                            aria-label={shelfIndex === 0 ? "already on the first shelf" : `move ${tool.name} to ${SHELVES[shelfIndex - 1].label}`}
                            onClick={move(shelfIndex - 1)}
                          >
                            <IconChevronUp />
                          </button>
                          <button
                            type="button"
                            disabled={busy || shelfIndex === SHELVES.length - 1}
                            title={shelfIndex === SHELVES.length - 1 ? "already on the last shelf" : `move to ${SHELVES[shelfIndex + 1].label}`}
                            aria-label={shelfIndex === SHELVES.length - 1 ? "already on the last shelf" : `move ${tool.name} to ${SHELVES[shelfIndex + 1].label}`}
                            onClick={move(shelfIndex + 1)}
                          >
                            <IconChevronDown />
                          </button>
                          <button
                            type="button"
                            className="tool-rest"
                            disabled={busy}
                            title={tool.paused ? "back in hand" : "rest until the next restart"}
                            onClick={() => change({ name: tool.name, paused: !tool.paused })}
                          >
                            {tool.paused ? "wake" : "rest"}
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
                {chips.length === 0 && <span className="tool-empty">{tools ? "nothing here" : "…"}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
