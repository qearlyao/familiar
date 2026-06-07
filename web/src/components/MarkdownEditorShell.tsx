import { type ReactNode } from "react";
import { ChevronLeft, Eye, Pencil } from "lucide-react";
import remarkGfm from "remark-gfm";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type MarkdownViewMode = "edit" | "preview";

interface MarkdownEditorToolbarControls {
  modeIcon: ReactNode;
  viewToggle: ReactNode;
}

interface MarkdownEditorShellProps {
  mobileEditor: boolean;
  backLabel: string;
  onBack: () => void;
  editorReady: boolean;
  mode: MarkdownViewMode;
  onModeChange: (mode: MarkdownViewMode) => void;
  modeSubject: string;
  settle: boolean;
  toolbar: (controls: MarkdownEditorToolbarControls) => ReactNode;
  renderEdit: (animationClassName: string) => ReactNode;
  previewText: string;
  previewProseClassName: string;
  emptyPreviewText: string;
  previewHeader?: ReactNode;
  previewArticleClassName?: string;
}

export function MarkdownEditorSkeleton() {
  return (
    <div className="space-y-3 px-5 py-5" aria-hidden>
      <div className="h-3 w-32 rounded-sm bg-muted-foreground/10" />
      <div className="h-4 w-56 rounded-sm bg-muted-foreground/10" />
      <div className="mt-6 h-3 w-full rounded-sm bg-muted-foreground/10" />
      <div className="h-3 w-11/12 rounded-sm bg-muted-foreground/10" />
      <div className="h-3 w-3/4 rounded-sm bg-muted-foreground/10" />
    </div>
  );
}

function EmptyPreview({ text }: { text: string }) {
  return (
    <div className="flex min-h-[18rem] items-center justify-center px-6 text-center">
      <p className="max-w-sm font-serif text-sm italic leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}

export function MarkdownEditorShell({
  mobileEditor,
  backLabel,
  onBack,
  editorReady,
  mode,
  onModeChange,
  modeSubject,
  settle,
  toolbar,
  renderEdit,
  previewText,
  previewProseClassName,
  emptyPreviewText,
  previewHeader,
  previewArticleClassName,
}: MarkdownEditorShellProps) {
  const editAnimationClassName = settle
    ? "duration-200 ease-out-quart animate-in fade-in-0 motion-reduce:animate-none"
    : "";
  const previewAnimationClassName = settle
    ? "duration-200 ease-out-quart animate-in fade-in-0 slide-in-from-bottom-[0.25rem] motion-reduce:animate-none"
    : "";
  const modeIcon =
    mode === "edit" ? <Pencil className="size-3 shrink-0" /> : <Eye className="size-3 shrink-0" />;
  const viewToggle = (
    <ToggleGroup
      type="single"
      value={mode}
      onValueChange={(value) => {
        if (value === "edit" || value === "preview") onModeChange(value);
      }}
      size="sm"
      variant="outline"
      aria-label="view mode"
    >
      <ToggleGroupItem value="edit" aria-label={`edit ${modeSubject}`}>
        <Pencil className="size-3.5" />
        edit
      </ToggleGroupItem>
      <ToggleGroupItem value="preview" aria-label={`preview ${modeSubject}`}>
        <Eye className="size-3.5" />
        preview
      </ToggleGroupItem>
    </ToggleGroup>
  );

  return (
    <main
      className={cn(
        "min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card md:flex md:flex-1",
        mobileEditor ? "flex flex-1" : "hidden md:flex",
      )}
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-left font-serif text-xs italic text-muted-foreground transition-colors hover:text-foreground md:hidden"
      >
        <ChevronLeft className="size-3.5" />
        {backLabel}
      </button>
      {toolbar({ modeIcon, viewToggle })}
      {!editorReady ? (
        <MarkdownEditorSkeleton />
      ) : mode === "edit" ? (
        renderEdit(editAnimationClassName)
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <article
            className={cn(
              "mx-auto w-full max-w-[72ch] px-6 py-8 md:px-8 md:py-10",
              previewArticleClassName,
              previewAnimationClassName,
            )}
          >
            {previewHeader}
            {previewText.trim() ? (
              <MarkdownRenderer
                text={previewText}
                remarkPlugins={[remarkGfm]}
                className={cn("warm-prose", previewProseClassName)}
              />
            ) : (
              <EmptyPreview text={emptyPreviewText} />
            )}
          </article>
        </ScrollArea>
      )}
    </main>
  );
}
