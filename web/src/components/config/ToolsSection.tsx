import { useEffect, useState } from "react";
import { fetchTools, updateTool, type BuiltinTool } from "@/lib/api";
import { useRequestState } from "@/lib/requestState";
import { cn } from "@/lib/utils";
import { Card, EnumToggle } from "./inputs";

const REACH_OPTIONS = [
  { value: "pinned", label: "always at hand" },
  { value: "loadable", label: "fetched when needed" },
  { value: "off", label: "put away" },
] as const;

/** The tools they were born holding: a lasting reach, and a rest that ends at the next restart. */
export function ToolsSection() {
  const [tools, setTools] = useState<BuiltinTool[] | undefined>(undefined);
  const { error, isLoading, isMutating, run } = useRequestState();
  const busy = isLoading || isMutating;

  useEffect(() => {
    const id = window.setTimeout(() => void run(fetchTools, { busy: "load", apply: setTools }), 0);
    return () => window.clearTimeout(id);
  }, [run]);

  const change = (body: Parameters<typeof updateTool>[0]) => void run(() => updateTool(body), { apply: setTools });

  return (
    <Card title="their own hands" hint="how each tool sits with them. the toggle is lasting: always at hand, fetched only when they ask for it, or put away for good. rest for now sets a tool aside just until the next restart, then it comes back however the toggle left it.">
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      <div className="tool-rows">
        {tools?.map((tool) => (
          <div key={tool.name} className={cn("tool-row", (tool.reach === "off" || tool.paused) && "is-off")}>
            <div className="settings-row">
              <code>{tool.name}</code>
              <button type="button" className="pill-button is-quiet" disabled={busy} onClick={() => change({ name: tool.name, paused: !tool.paused })}>
                {tool.paused ? "back in hand" : "rest until restart"}
              </button>
            </div>
            <EnumToggle value={tool.reach} options={REACH_OPTIONS} ariaPrefix={`how they reach ${tool.name}`} disabled={busy} onChange={(reach) => change({ name: tool.name, reach })} />
          </div>
        ))}
      </div>
    </Card>
  );
}
