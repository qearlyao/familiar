import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { iconForTool, ThinkingIcon } from "@/lib/toolIcon";
import type { GutterStep } from "@/lib/chunkSteps";
import type { ThinkingStep, ToolEvent } from "../types";

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

function argSummary(args: unknown): string {
  if (!isRecord(args)) return "";
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function resultCount(result: unknown): string {
  if (result == null) return "";
  if (Array.isArray(result)) return result.length === 1 ? "1 item" : `${result.length} items`;
  if (isRecord(result)) {
    const candidates = ["results", "items", "matches", "files", "lines"] as const;
    for (const key of candidates) {
      const v = result[key];
      if (Array.isArray(v)) {
        const noun = key === "files" ? "file" : key === "lines" ? "line" : key === "matches" ? "match" : key === "items" ? "item" : "result";
        return v.length === 1 ? `1 ${noun}` : `${v.length} ${noun}s`;
      }
    }
  }
  if (typeof result === "string") {
    const lines = result.split("\n").length;
    if (lines > 3) return `${lines} lines`;
  }
  return "";
}

function formatThinkingTitle(step: ThinkingStep): string {
  if (!step.complete) return "thinking…";
  if (step.endedAt == null) return "thought";
  const ms = Math.max(0, step.endedAt - step.startedAt);
  if (ms < 1000) return "thought for <1s";
  return `thought for ${Math.round(ms / 100) / 10}s`;
}

function isStepActive(step: GutterStep): boolean {
  if (step.kind === "thinking") return !step.complete;
  return step.tool.status === "running" || step.tool.status === "pending";
}

function hasStepBody(step: GutterStep): boolean {
  if (step.kind === "thinking") return Boolean(step.text);
  const tool = step.tool;
  return Boolean(tool.args || tool.result || tool.partialResult || tool.error);
}

function IconCell({
  step,
  active,
  hideThreadAbove,
  hideThreadBelow,
}: {
  step: GutterStep | "done";
  active?: boolean;
  hideThreadAbove?: boolean;
  hideThreadBelow?: boolean;
}) {
  const Icon =
    step === "done"
      ? Check
      : step.kind === "thinking"
        ? ThinkingIcon
        : iconForTool(step.tool.name);
  return (
    <div className="relative flex h-7 w-7 shrink-0 items-center justify-center" aria-hidden>
      <span
        className={cn(
          "absolute left-1/2 w-px -translate-x-1/2 bg-border",
          hideThreadAbove ? "top-1/2" : "top-0",
          hideThreadBelow ? "bottom-1/2" : "bottom-0",
        )}
      />
      <span className="relative z-10 inline-flex size-4 items-center justify-center bg-muted">
        {/* eslint-disable-next-line react-hooks/static-components */}
        <Icon
          className={cn(
            "size-4 transition-colors",
            active ? "text-primary" : "text-muted-foreground/85",
          )}
        />
      </span>
    </div>
  );
}

function StepTitle({ step }: { step: GutterStep }) {
  if (step.kind === "thinking") {
    return (
      <span className="truncate font-serif italic text-sm tracking-wide text-foreground/75">
        {formatThinkingTitle(step)}
      </span>
    );
  }
  const tool = step.tool;
  const summary = argSummary(tool.args);
  const failed = tool.status === "error";
  const output = tool.status === "running" ? tool.partialResult : tool.result;
  const count = !failed && tool.status === "completed" ? resultCount(output) : "";
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-mono text-sm text-foreground/85">
        {tool.name}
      </span>
      {summary && (
        <span className="min-w-0 truncate font-mono text-sm text-muted-foreground/70">
          {summary}
        </span>
      )}
      {failed && (
        <span className="shrink-0 font-serif italic text-sm text-destructive/80">
          · failed
        </span>
      )}
      {count && !failed && (
        <span className="shrink-0 font-serif italic text-sm tracking-wide text-muted-foreground/65">
          · {count}
        </span>
      )}
    </span>
  );
}

function ThinkingContent({ step, active }: { step: ThinkingStep; active: boolean }) {
  return (
    <div className="font-serif italic text-sm leading-relaxed text-muted-foreground/85 whitespace-pre-wrap">
      {step.text}
      {active && <span className="ml-0.5 inline-block animate-pulse">▎</span>}
    </div>
  );
}

function ToolContent({ tool }: { tool: ToolEvent }) {
  const formattedArgs = useMemo(() => formatValue(tool.args), [tool.args]);
  const output = tool.status === "running" ? tool.partialResult : tool.result;
  const formattedOutput = useMemo(() => formatValue(output), [output]);
  return (
    <div className="space-y-2">
      {formattedArgs && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground/80">
          {formattedArgs}
        </pre>
      )}
      {formattedOutput && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground/80">
          {formattedOutput}
        </pre>
      )}
      {tool.error && (
        <div className="font-mono text-xs whitespace-pre-wrap text-destructive/85">
          {tool.error}
        </div>
      )}
    </div>
  );
}

const COLLAPSED_HEIGHT_PX = 132;

function CollapsibleBody({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > COLLAPSED_HEIGHT_PX + 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const truncated = overflows && !open;

  return (
    <>
      <div
        className="relative overflow-hidden transition-[max-height] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ maxHeight: truncated ? `${COLLAPSED_HEIGHT_PX}px` : "9999px" }}
      >
        <div ref={ref}>{children}</div>
        {truncated && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-muted via-muted/80 to-transparent" />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1.5 font-serif italic text-xs tracking-wide text-foreground/75 underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          {open ? "show less" : "show more"}
        </button>
      )}
    </>
  );
}

function StepBodyRow({
  step,
  threadContinues,
}: {
  step: GutterStep;
  threadContinues: boolean;
}) {
  const stepActive = isStepActive(step);
  return (
    <div className="relative py-1">
      {threadContinues && (
        <span
          className="absolute left-3.5 inset-y-0 w-px -translate-x-1/2 bg-border"
          aria-hidden
        />
      )}
      <div className="ml-9 mt-1 mb-2">
        <CollapsibleBody>
          {step.kind === "thinking" ? (
            <ThinkingContent step={step} active={stepActive} />
          ) : (
            <ToolContent tool={step.tool} />
          )}
        </CollapsibleBody>
      </div>
    </div>
  );
}

export function EventStream({
  steps,
  autoCollapse = false,
}: {
  steps: GutterStep[];
  autoCollapse?: boolean;
}) {
  const active = steps.some(isStepActive);
  const allComplete = !active && steps.length > 0;
  const hasError = steps.some((s) => s.kind === "tool" && s.tool.status === "error");
  const showDone = allComplete && steps.length >= 2 && !hasError;

  const [open, setOpen] = useState(active);
  const userTouched = useRef(false);
  useEffect(() => {
    if (userTouched.current) return;
    if (active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(true);
    } else if (autoCollapse) {
      setOpen(false);
    }
  }, [active, autoCollapse]);

  const toggle = () => {
    userTouched.current = true;
    setOpen((prev) => !prev);
  };

  if (steps.length === 0) return null;

  const first = steps[0];
  const firstHasBody = hasStepBody(first);
  const more = steps.length - 1;
  const firstThreadBelow = open && (firstHasBody || more > 0 || showDone);

  return (
    <div className="flex flex-col rounded-lg bg-muted px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <IconCell
          step={first}
          active={isStepActive(first)}
          hideThreadAbove
          hideThreadBelow={!firstThreadBelow}
        />
        <div className="flex min-w-0 items-center gap-2">
          <StepTitle step={first} />
          {!open && more > 0 && (
            <span className="shrink-0 font-serif italic text-sm tracking-wide text-muted-foreground/60">
              · {more} more
            </span>
          )}
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/65 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
              open && "rotate-90",
            )}
          />
        </div>
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          {firstHasBody && (
            <StepBodyRow step={first} threadContinues={more > 0 || showDone} />
          )}
          {steps.slice(1).map((step, i) => {
            const realIdx = i + 1;
            const isLast = realIdx === steps.length - 1;
            const hasBody = hasStepBody(step);
            const iconThreadBelow = !isLast || showDone || hasBody;
            const bodyThreadContinues = !isLast || showDone;
            return (
              <div key={step.id} className="flex flex-col">
                <div className="flex w-full items-center gap-2">
                  <IconCell
                    step={step}
                    active={isStepActive(step)}
                    hideThreadBelow={!iconThreadBelow}
                  />
                  <StepTitle step={step} />
                </div>
                {hasBody && (
                  <StepBodyRow step={step} threadContinues={bodyThreadContinues} />
                )}
              </div>
            );
          })}
          {showDone && (
            <div className="flex w-full items-center gap-2">
              <IconCell step="done" hideThreadBelow />
              <span className="font-mono text-sm text-foreground/85">
                done
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
