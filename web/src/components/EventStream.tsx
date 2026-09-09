import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { iconForTool, ThinkingIcon } from "@/lib/toolIcon";
import type { GutterStep } from "@/lib/chunkSteps";
import type { ThinkingStep, ToolEvent } from "../types";
import { IconChevronDown, IconChevronUp } from "./organicIcons";

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

const SUMMARY_KEYS = ["query", "url", "command", "prompt", "file_path", "path", "pattern", "description"] as const;

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
    for (const key of ["results", "items", "matches", "files", "lines"] as const) {
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

function seconds(ms: number): string {
  return ms < 1000 ? "<1s" : `${Math.round(ms / 100) / 10}s`;
}

function stepSpan(step: GutterStep): { start?: number; end?: number } {
  if (step.kind === "thinking") return { start: step.startedAt, end: step.endedAt };
  return { start: step.tool.startedAt, end: step.tool.completedAt };
}

function stepTiming(step: GutterStep): string {
  const { start, end } = stepSpan(step);
  return start != null && end != null ? seconds(Math.max(0, end - start)) : "";
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

function stepIcon(step: GutterStep) {
  return step.kind === "thinking" ? ThinkingIcon : iconForTool(step.tool.name);
}

function stepName(step: GutterStep): string {
  return step.kind === "thinking" ? (step.complete ? "thought" : "thinking…") : step.tool.name;
}

function StepTitle({ step }: { step: GutterStep }) {
  if (step.kind === "thinking") return <span className="tool-step-title">{stepName(step)}</span>;
  const tool = step.tool;
  const summary = argSummary(tool.args);
  const failed = tool.status === "error";
  const count = !failed && tool.status === "completed" ? resultCount(tool.result) : "";
  return (
    <span className="tool-step-title">
      {tool.name}
      {summary && <code>{summary}</code>}
      {failed && <span className="is-failed">· failed</span>}
      {count && <span>· {count}</span>}
    </span>
  );
}

function ThinkingDetail({ step }: { step: ThinkingStep }) {
  return (
    <div className="tool-detail">
      <div className="is-thinking">
        {step.text}
        {!step.complete && <span className="ml-0.5 inline-block animate-pulse">▎</span>}
      </div>
    </div>
  );
}

function ToolDetail({ tool }: { tool: ToolEvent }) {
  const args = useMemo(() => formatValue(tool.args), [tool.args]);
  const output = tool.status === "running" ? tool.partialResult : tool.result;
  const result = useMemo(() => formatValue(output), [output]);
  return (
    <div className="tool-detail">
      {args && <pre>{args}</pre>}
      {result && <pre>{result}</pre>}
      {tool.error && <pre className="is-error">{tool.error}</pre>}
    </div>
  );
}

function Step({ step, last }: { step: GutterStep; last: boolean }) {
  const [open, setOpen] = useState(false);
  const active = isStepActive(step);
  const failed = step.kind === "tool" && step.tool.status === "error";
  const body = hasStepBody(step);
  const timing = stepTiming(step);
  return (
    <div className="tool-step">
      {!last && <span className="tool-step-thread" aria-hidden="true" />}
      <span className={cn("tool-dot", active && "is-running", failed && "is-error")} aria-hidden="true" />
      <div className="tool-step-body">
        <div className="tool-step-row">
          <StepTitle step={step} />
          {timing && <span className="tool-step-timing">{timing}</span>}
        </div>
        {step.kind === "thinking" && !open && step.text && <span className="tool-step-sub">{step.text.length > 160 ? `${step.text.slice(0, 160).trimEnd()}…` : step.text}</span>}
        {body && (
          <button type="button" className="tool-step-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "show"}
            {open ? <IconChevronUp /> : <IconChevronDown />}
          </button>
        )}
        {open && (step.kind === "thinking" ? <ThinkingDetail step={step} /> : <ToolDetail tool={step.tool} />)}
      </div>
    </div>
  );
}

export function EventStream({ steps }: { steps: GutterStep[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  const active = steps.some(isStepActive);
  const first = steps[0];
  const current = steps[steps.length - 1];
  const head = active ? current : first;
  const Icon = stepIcon(head);
  const summary = stepName(head);
  const count = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  const start = stepSpan(first).start;
  const end = stepSpan(current).end;
  const total = !active && start != null && end != null ? seconds(Math.max(0, end - start)) : "";

  if (!open) {
    return (
      <button type="button" className={cn("tool-pill", active && "is-active")} aria-expanded={false} onClick={() => setOpen(true)}>
        {/* eslint-disable-next-line react-hooks/static-components */}
        <Icon strokeWidth={2.75} />
        <span className="tool-pill-name">{summary}</span>
        <span className="tool-pill-count">· {count}</span>
        <IconChevronDown />
      </button>
    );
  }

  return (
    <div className="tool-patch">
      <div className="tool-patch-head">
        {/* eslint-disable-next-line react-hooks/static-components */}
        <Icon strokeWidth={2.75} />
        <span>{summary}</span>
        <span className="tool-patch-meta">{total ? `${count} · ${total}` : count}</span>
        <button type="button" className="tool-fold" aria-label="fold" onClick={() => setOpen(false)}>
          <IconChevronUp />
        </button>
      </div>
      <div className="tool-steps">
        {steps.map((step, i) => (
          <Step key={step.id} step={step} last={i === steps.length - 1} />
        ))}
      </div>
    </div>
  );
}
