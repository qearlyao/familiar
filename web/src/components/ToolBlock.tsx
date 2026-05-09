import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolEvent } from "../types";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const SUMMARY_KEYS = [
  "query",
  "url",
  "command",
  "prompt",
  "file_path",
  "path",
  "pattern",
  "description",
] as const;

function argSummary(tool: ToolEvent): string {
  if (!isRecord(tool.args)) return "";
  for (const key of SUMMARY_KEYS) {
    const value = tool.args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function statusHint(tool: ToolEvent): string {
  if (tool.status === "pending") return "queued";
  if (tool.status === "running") return "running…";
  if (tool.status === "error") return "failed";
  return "done";
}

function aggregateLabel(tools: ToolEvent[]): string {
  const total = tools.length;
  const noun = total === 1 ? "tool call" : "tool calls";
  const running = tools.filter(
    (tool) => tool.status === "running" || tool.status === "pending",
  ).length;
  if (running > 0) return `${total} ${noun} · ${running} running`;
  const failed = tools.filter((tool) => tool.status === "error").length;
  if (failed > 0) return `${total} ${noun} · ${failed} failed`;
  return `${total} ${noun}`;
}

function ToolEntry({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const summary = argSummary(tool);
  const formattedArgs = formatValue(tool.args);
  const output = tool.status === "running" ? tool.partialResult : tool.result;
  const formattedOutput = formatValue(output);
  const hasDetails = Boolean(formattedArgs || formattedOutput || tool.error);

  return (
    <Collapsible open={open && hasDetails} onOpenChange={setOpen}>
      <CollapsibleTrigger
        disabled={!hasDetails}
        className="group flex w-full items-center gap-1.5 py-1 text-xs uppercase tracking-wider text-muted-foreground/55 transition-colors hover:text-muted-foreground disabled:cursor-default disabled:hover:text-muted-foreground/55"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            open && hasDetails && "rotate-90",
            !hasDetails && "opacity-0",
          )}
        />
        <span className="shrink-0">{tool.name}</span>
        {summary && (
          <span className="min-w-0 truncate normal-case tracking-normal text-muted-foreground/70">
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0">{statusHint(tool)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-1 mt-1 space-y-2 border-l border-border/70 pl-3 text-[0.95em] leading-relaxed text-muted-foreground/80">
          {formattedArgs && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
              {formattedArgs}
            </pre>
          )}
          {formattedOutput && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
              {formattedOutput}
            </pre>
          )}
          {tool.error && <div className="text-destructive">{tool.error}</div>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolBlock({ tools }: { tools: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 mb-3">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground/55 transition-colors hover:text-muted-foreground">
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span>{aggregateLabel(tools)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 border-l-2 border-border pl-3">
          {tools.map((tool) => (
            <ToolEntry key={tool.id} tool={tool} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
