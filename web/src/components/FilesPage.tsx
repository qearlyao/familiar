import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw, Save } from "lucide-react";
import {
  MarkdownEditorShell,
  MarkdownEditorSkeleton,
  type MarkdownViewMode,
} from "@/components/MarkdownEditorShell";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchFile,
  fetchFiles,
  saveFile,
  type WebFileEntry,
  type WebFileId,
  type WebFileSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface FileRecord {
  summary: WebFileSummary;
  savedContent?: string;
  draft?: string;
}

type FileRecords = Partial<Record<WebFileId, FileRecord>>;

function formatSavedAt(mtimeMs: number | null): string {
  if (mtimeMs === null) return "not written yet";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(mtimeMs))
    .toLowerCase();
}

function fileMeta(file: WebFileSummary): string {
  return file.exists ? `saved ${formatSavedAt(file.mtimeMs)}` : "ready for a first note";
}

function mergeFileSummaries(current: FileRecords, summaries: WebFileSummary[]): FileRecords {
  const next: FileRecords = {};
  for (const summary of summaries) {
    next[summary.id] = { ...current[summary.id], summary };
  }
  return next;
}

function mergeLoadedFile(current: FileRecords, file: WebFileEntry): FileRecords {
  const { content: savedContent, ...summary } = file;
  return {
    ...current,
    [file.id]: {
      ...current[file.id],
      summary,
      savedContent,
    },
  };
}

function mergeSavedFile(current: FileRecords, file: WebFileEntry): FileRecords {
  const { content: savedContent, ...summary } = file;
  return {
    ...current,
    [file.id]: {
      summary,
      savedContent,
    },
  };
}

function mergeDraft(current: FileRecords, id: WebFileId, draft: string): FileRecords {
  const record = current[id];
  if (!record) return current;
  return {
    ...current,
    [id]: { ...record, draft },
  };
}

function isDirtyRecord(record: FileRecord | undefined): boolean {
  return record?.savedContent !== undefined && record.draft !== undefined && record.draft !== record.savedContent;
}

function FileListButton({
  file,
  active,
  dirty,
  onSelect,
}: {
  file: WebFileSummary;
  active: boolean;
  dirty: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn("note-row group", active && "note-row-active")}
    >
      <span className="note-row-name">{file.title}</span>
      <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {file.description}
      </span>
      <span
        className={cn(
          "mt-1 block font-serif text-[0.7rem] italic",
          dirty ? "text-primary/90" : "text-muted-foreground/80",
        )}
      >
        {dirty ? "unsaved changes" : file.exists ? `saved ${formatSavedAt(file.mtimeMs)}` : "ready for a first note"}
      </span>
      <span className="sr-only">
        {file.name}
        {dirty ? " unsaved changes" : ""}
      </span>
    </button>
  );
}

export function FilesPage({ nav }: { nav?: ReactNode }) {
  const [fileOrder, setFileOrder] = useState<WebFileId[]>([]);
  const [fileRecords, setFileRecords] = useState<FileRecords>({});
  const [selectedId, setSelectedId] = useState<WebFileId>();
  const [mode, setMode] = useState<MarkdownViewMode>("edit");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [savedNotice, setSavedNotice] = useState<string | undefined>();
  const [mobileEditor, setMobileEditor] = useState(false);
  const [settle, setSettle] = useState(false);

  const selectedRecord = selectedId ? fileRecords[selectedId] : undefined;
  const selectedSummary = selectedRecord?.summary;
  const draft = selectedRecord?.draft ?? selectedRecord?.savedContent ?? "";
  const dirty = isDirtyRecord(selectedRecord);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(undefined);
    try {
      const next = await fetchFiles();
      setFileOrder(next.map((file) => file.id));
      setFileRecords((current) => mergeFileSummaries(current, next));
      setSelectedId((current) => (current && next.some((file) => file.id === current) ? current : next[0]?.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Loads a file's saved baseline into the cache. Never touches `draft`, so an
  // in-progress edit survives a reload, a note switch, or a refresh.
  const loadFile = useCallback(async (id: WebFileId) => {
    setLoadingFile(true);
    setError(undefined);
    try {
      const next = await fetchFile(id);
      setFileRecords((current) => mergeLoadedFile(current, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const saveCurrentFile = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    setError(undefined);
    setSavedNotice(undefined);
    try {
      const next = await saveFile(selectedId, draft);
      setFileRecords((current) => mergeSavedFile(current, next));
      setSavedNotice("familiar knows this now");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, selectedId]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(id);
  }, [loadList]);

  useEffect(() => {
    if (!selectedId || fileRecords[selectedId]?.savedContent !== undefined) return;
    const id = window.setTimeout(() => void loadFile(selectedId), 0);
    return () => window.clearTimeout(id);
  }, [fileRecords, loadFile, selectedId]);

  useEffect(() => {
    if (!savedNotice) return;
    const id = window.setTimeout(() => setSavedNotice(undefined), 2600);
    return () => window.clearTimeout(id);
  }, [savedNotice]);

  const refresh = useCallback(() => {
    void loadList();
    if (selectedId) void loadFile(selectedId);
  }, [loadFile, loadList, selectedId]);

  const files = useMemo(
    () => fileOrder.flatMap((id) => (fileRecords[id]?.summary ? [fileRecords[id].summary] : [])),
    [fileOrder, fileRecords],
  );

  const dirtyById = useMemo(() => {
    const out: Partial<Record<WebFileId, boolean>> = {};
    for (const id of fileOrder) {
      if (isDirtyRecord(fileRecords[id])) out[id] = true;
    }
    return out;
  }, [fileOrder, fileRecords]);

  const canSave = dirty && !saving && !loadingFile;
  const showInitialSkeleton = loadingList && fileOrder.length === 0;
  const editorReady = selectedRecord?.savedContent !== undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b-2 border-primary/20 bg-background px-3 py-4 md:px-8">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          {nav}
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="font-serif text-2xl leading-none tracking-tight">keepsakes</h1>
            <p className="font-serif text-[0.8rem] italic text-muted-foreground">the names and notes kept close</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="refresh"
            title="refresh"
            className="text-muted-foreground hover:text-foreground"
            onClick={refresh}
            disabled={loadingList}
          >
            <RefreshCw className={cn("size-4", loadingList && "animate-spin motion-reduce:animate-none")} />
          </Button>
        </div>
      </header>
      {error ? (
        <p className="border-b border-border bg-card px-3 py-2 font-serif text-xs italic text-destructive md:px-8">
          {error}
        </p>
      ) : savedNotice ? (
        <p className="border-b border-border bg-card px-3 py-2 font-serif text-xs italic text-muted-foreground md:px-8">
          {savedNotice}
        </p>
      ) : null}
      {showInitialSkeleton ? (
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 overflow-hidden px-4 py-5 md:flex-row md:px-8">
          <aside className="min-h-0 flex-1 rounded-md border border-border bg-card p-3 md:w-72 md:flex-none">
            <div className="space-y-3" aria-hidden>
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="h-18 rounded-sm bg-muted-foreground/10" />
              ))}
            </div>
          </aside>
          <main className="hidden min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-card md:block">
            <MarkdownEditorSkeleton />
          </main>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 overflow-hidden px-4 py-5 md:flex-row md:px-8">
          <aside
            className={cn(
              "min-h-0 flex-col rounded-md border border-border bg-card py-2 md:flex md:w-72 md:flex-none",
              mobileEditor ? "hidden md:flex" : "flex flex-1",
            )}
          >
            <div className="px-4 pb-2 pt-3">
              <p className="font-serif text-sm leading-tight tracking-tight">the five notes</p>
              <p className="mt-1 font-serif text-xs italic text-muted-foreground">
                each one changes how familiar knows the room.
              </p>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-1 pb-1">
                {files.map((file) => (
                  <FileListButton
                    key={file.id}
                    file={file}
                    active={file.id === selectedId}
                    dirty={dirtyById[file.id] === true}
                    onSelect={() => {
                      setSelectedId(file.id);
                      setMobileEditor(true);
                      setSettle(true);
                      setSavedNotice(undefined);
                    }}
                  />
                ))}
              </div>
            </ScrollArea>
          </aside>
          <MarkdownEditorShell
            mobileEditor={mobileEditor}
            backLabel="all notes"
            onBack={() => setMobileEditor(false)}
            editorReady={editorReady}
            mode={mode}
            onModeChange={setMode}
            modeSubject="file"
            settle={settle}
            toolbar={({ viewToggle }) => (
              <div className="flex flex-col gap-3 px-4 pb-3 pt-2 md:flex-row md:flex-wrap md:items-start md:px-6 md:pb-4 md:pt-5">
                <div className="min-w-0 flex-1">
                  <h1 className="font-serif text-2xl leading-tight tracking-tight text-balance">
                    {selectedSummary?.title ?? "note"}
                  </h1>
                  <p className="mt-1 max-w-[62ch] text-xs leading-relaxed text-muted-foreground">
                    {selectedSummary?.description ?? "loading note"}
                  </p>
                </div>
                <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 md:w-auto md:justify-end">
                  {viewToggle}
                  <Button type="button" size="sm" onClick={() => void saveCurrentFile()} disabled={!canSave}>
                    <Save className="size-3.5" />
                    {saving ? "saving" : "save note"}
                  </Button>
                </div>
                <p className="basis-full font-serif text-xs italic text-muted-foreground">
                  {dirty ? "unsaved changes" : selectedSummary ? fileMeta(selectedSummary) : "loading note"}
                </p>
              </div>
            )}
            renderEdit={(animationClassName) => (
              <Textarea
                value={draft}
                onChange={(event) => {
                  if (!selectedId) return;
                  setFileRecords((current) => mergeDraft(current, selectedId, event.target.value));
                }}
                spellCheck
                aria-label={`edit ${selectedSummary?.title ?? "note"}`}
                className={cn(
                  "mx-auto min-h-0 w-full max-w-[72ch] flex-1 resize-none rounded-none border-0 bg-card px-6 py-8 font-sans text-[0.95rem] leading-relaxed shadow-none focus-visible:ring-0 md:px-8 md:py-10",
                  animationClassName,
                )}
              />
            )}
            previewText={draft}
            previewProseClassName="file-prose"
            emptyPreviewText="this note is quiet for now."
          />
        </div>
      )}
    </div>
  );
}
