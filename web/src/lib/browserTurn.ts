import { createContext } from "react";
import type { Step, ToolStep } from "../types";

/** The id of the newest turn that touched the browser: the one place its live box shows. */
export const BrowserTurn = createContext<string | undefined>(undefined);

const BROWSER_TOOL = /agent[_-]browser/i;

export function usesBrowser(step: Step): step is ToolStep {
  if (step.kind !== "tool") return false;
  const { name, args } = step.tool;
  // a codemode script calls the browser tools by name inside its source
  return BROWSER_TOOL.test(name) || (name === "codemode" && BROWSER_TOOL.test(JSON.stringify(args ?? "")));
}
