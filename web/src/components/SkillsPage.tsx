import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Power, PowerOff, RefreshCw, Save, Wand } from "lucide-react";
import {
  MarkdownEditorShell,
  MarkdownEditorSkeleton,
  type MarkdownViewMode,
} from "@/components/MarkdownEditorShell";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchSkill,
  fetchSkills,
  saveSkill,
  setSkillEnabled,
  type WebSkillEntry,
  type WebSkillSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface SkillDraft {
  name: string;
  description: string;
  enabled: boolean;
  content: string;
}

interface SkillRecord {
  summary: WebSkillSummary;
  saved?: SkillDraft;
  draft?: SkillDraft;
}

type SkillRecords = Record<string, SkillRecord | undefined>;

function formatSavedAt(mtimeMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(mtimeMs))
    .toLowerCase();
}

function skillStatus(skill: Pick<WebSkillSummary, "enabled" | "mtimeMs">): string {
  const listing = skill.enabled ? "listed for familiar" : "hidden from prompt";
  return `${listing} · saved ${formatSavedAt(skill.mtimeMs)}`;
}

function draftFromEntry(skill: WebSkillEntry): SkillDraft {
  return {
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    content: skill.content,
  };
}

function summaryFromEntry(skill: WebSkillEntry): WebSkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    relativePath: skill.relativePath,
    mtimeMs: skill.mtimeMs,
    sizeBytes: skill.sizeBytes,
    enabled: skill.enabled,
    diagnostics: skill.diagnostics,
  };
}

function draftsEqual(a: SkillDraft | undefined, b: SkillDraft | undefined): boolean {
  if (!a || !b) return a === b;
  return a.name === b.name && a.description === b.description && a.enabled === b.enabled && a.content === b.content;
}

function isDirtyRecord(record: SkillRecord | undefined): boolean {
  return !!record?.saved && !!record.draft && !draftsEqual(record.draft, record.saved);
}

function mergeSkillSummaries(current: SkillRecords, summaries: WebSkillSummary[]): SkillRecords {
  const next: SkillRecords = {};
  for (const summary of summaries) {
    next[summary.id] = { ...current[summary.id], summary };
  }
  return next;
}

function mergeLoadedSkill(current: SkillRecords, skill: WebSkillEntry): SkillRecords {
  const saved = draftFromEntry(skill);
  const currentRecord = current[skill.id];
  const preserveDraft = isDirtyRecord(currentRecord);
  return {
    ...current,
    [skill.id]: {
      ...currentRecord,
      summary: summaryFromEntry(skill),
      saved,
      draft: preserveDraft ? currentRecord?.draft : saved,
    },
  };
}

function mergeSavedSkill(current: SkillRecords, skill: WebSkillEntry): SkillRecords {
  const saved = draftFromEntry(skill);
  return {
    ...current,
    [skill.id]: {
      summary: summaryFromEntry(skill),
      saved,
      draft: saved,
    },
  };
}

// Toggling `enabled` writes only that flag to disk (content-safe endpoint), so an
// in-progress body edit must survive: keep the existing draft and re-point its
// `enabled` to the new disk value, leaving the dirty body untouched.
function mergeToggledSkill(current: SkillRecords, skill: WebSkillEntry): SkillRecords {
  const saved = draftFromEntry(skill);
  const record = current[skill.id];
  const preserveDraft = isDirtyRecord(record);
  return {
    ...current,
    [skill.id]: {
      summary: summaryFromEntry(skill),
      saved,
      draft: preserveDraft && record?.draft ? { ...record.draft, enabled: saved.enabled } : saved,
    },
  };
}

function mergeDraftPatch(current: SkillRecords, id: string, patch: Partial<SkillDraft>): SkillRecords {
  const record = current[id];
  const base = record?.draft ?? record?.saved;
  if (!record || !base) return current;
  return {
    ...current,
    [id]: {
      ...record,
      draft: { ...base, ...patch },
    },
  };
}

function SkillListItem({
  skill,
  active,
  dirty,
  busy,
  onSelect,
  onToggle,
}: {
  skill: WebSkillSummary;
  active: boolean;
  dirty: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const toggleLabel = skill.enabled ? "hide skill" : "list skill";
  return (
    <div
      className={cn(
        "group flex items-start gap-2 border-b border-border/60 px-2 py-2.5 last:border-b-0",
        active && "bg-muted/45",
      )}
    >
      <span
        className={cn(
          "mt-2.5 size-1.5 shrink-0 rounded-full transition-colors",
          active ? "bg-primary" : skill.enabled ? "bg-muted-foreground/45" : "bg-muted-foreground/15",
        )}
        aria-hidden
      />
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span
          className={cn(
            "block truncate font-serif text-[1.02rem] leading-tight tracking-tight transition-colors",
            active ? "text-primary" : "text-foreground group-hover:text-primary",
          )}
        >
          {skill.name}
        </span>
        <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
          {skill.description || "missing description"}
        </span>
        <span
          className={cn(
            "mt-1 block font-serif text-[0.7rem] italic",
            dirty ? "text-primary/90" : skill.enabled ? "text-muted-foreground/80" : "text-muted-foreground/60",
          )}
        >
          {dirty ? "unsaved changes" : skillStatus(skill)}
        </span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`${toggleLabel}: ${skill.name}`}
        title={toggleLabel}
        aria-pressed={skill.enabled}
        disabled={busy}
        onClick={onToggle}
        className={cn("mt-0.5 text-muted-foreground hover:text-foreground", skill.enabled && "text-primary")}
      >
        {skill.enabled ? <Power className="size-3.5" /> : <PowerOff className="size-3.5" />}
      </Button>
    </div>
  );
}

function SkillsSkeleton() {
  return (
    <div className="workspace-frame flex flex-1 flex-col gap-5 overflow-hidden px-4 py-5 md:flex-row md:px-8">
      <aside className="min-h-0 flex-1 rounded-md border border-border bg-card p-3 md:w-72 md:flex-none">
        <div className="space-y-3" aria-hidden>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-16 rounded-sm bg-muted-foreground/10" />
          ))}
        </div>
      </aside>
      <main className="hidden min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-card md:block">
        <div className="h-4 w-28 rounded-sm bg-muted-foreground/15" />
        <div className="mt-5 h-9 w-64 rounded-sm bg-muted-foreground/10" />
        <MarkdownEditorSkeleton />
      </main>
    </div>
  );
}

function EmptySkills({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="flex h-full min-h-[18rem] items-center justify-center px-6 text-center">
      <div className="max-w-sm">
        <Wand className="mx-auto size-7 text-muted-foreground" />
        <h2 className="mt-5 font-serif text-xl leading-tight tracking-tight">no skills here yet</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          workspace skills will appear here once a markdown skill file is added.
        </p>
        <Button type="button" variant="ghost" className="mt-5" onClick={onRefresh}>
          <RefreshCw className="size-4" />
          check again
        </Button>
      </div>
    </div>
  );
}

export function SkillsPage({ nav }: { nav?: ReactNode }) {
  const [skillOrder, setSkillOrder] = useState<string[]>([]);
  const [skillRecords, setSkillRecords] = useState<SkillRecords>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [mode, setMode] = useState<MarkdownViewMode>("edit");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingSkill, setLoadingSkill] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggleBusyId, setToggleBusyId] = useState<string>();
  const [error, setError] = useState<string | undefined>();
  const [savedNotice, setSavedNotice] = useState<string | undefined>();
  const [mobileEditor, setMobileEditor] = useState(false);
  const [settle, setSettle] = useState(false);

  const selectedRecord = selectedId ? skillRecords[selectedId] : undefined;
  const selectedSummary = selectedRecord?.summary;
  const draft = selectedRecord?.draft ?? selectedRecord?.saved;
  const dirty = isDirtyRecord(selectedRecord);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(undefined);
    try {
      const next = await fetchSkills();
      setSkillOrder(next.map((skill) => skill.id));
      setSkillRecords((current) => mergeSkillSummaries(current, next));
      setSelectedId((current) => (current && next.some((skill) => skill.id === current) ? current : next[0]?.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadSkill = useCallback(async (id: string) => {
    setLoadingSkill(true);
    setError(undefined);
    try {
      const next = await fetchSkill(id);
      setSkillRecords((current) => mergeLoadedSkill(current, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSkill(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void loadList();
    if (selectedId) void loadSkill(selectedId);
  }, [loadList, loadSkill, selectedId]);

  const saveCurrentSkill = useCallback(async () => {
    if (!selectedId || !draft) return;
    setSaving(true);
    setError(undefined);
    setSavedNotice(undefined);
    try {
      const next = await saveSkill(selectedId, draft);
      setSkillRecords((current) => mergeSavedSkill(current, next));
      setSavedNotice("skill saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, selectedId]);

  const toggleSkill = useCallback(
    async (id: string, enabled: boolean) => {
      setToggleBusyId(id);
      setError(undefined);
      setSavedNotice(undefined);
      try {
        const next = await setSkillEnabled(id, enabled);
        setSkillRecords((current) => mergeToggledSkill(current, next));
        setSavedNotice(enabled ? "skill listed for familiar" : "skill hidden from prompt");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setToggleBusyId(undefined);
      }
    },
    [],
  );

  useEffect(() => {
    const id = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(id);
  }, [loadList]);

  useEffect(() => {
    if (!selectedId || selectedRecord?.saved !== undefined) return;
    const id = window.setTimeout(() => void loadSkill(selectedId), 0);
    return () => window.clearTimeout(id);
  }, [loadSkill, selectedId, selectedRecord?.saved]);

  useEffect(() => {
    if (!savedNotice) return;
    const id = window.setTimeout(() => setSavedNotice(undefined), 2600);
    return () => window.clearTimeout(id);
  }, [savedNotice]);

  const skills = useMemo(
    () => skillOrder.flatMap((id) => (skillRecords[id]?.summary ? [skillRecords[id].summary] : [])),
    [skillOrder, skillRecords],
  );

  const dirtyById = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const id of skillOrder) {
      if (isDirtyRecord(skillRecords[id])) out[id] = true;
    }
    return out;
  }, [skillOrder, skillRecords]);

  const listedCount = skills.filter((skill) => skill.enabled).length;
  const editorReady = !!draft;
  const canSave = editorReady && dirty && !saving && !loadingSkill;
  const showInitialSkeleton = loadingList && skillOrder.length === 0;
  const diagnostics = selectedSummary?.diagnostics ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b-2 border-primary/20 bg-background px-3 py-4 md:px-8">
        <div className="workspace-frame flex items-center gap-3">
          {nav}
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="font-serif text-2xl leading-none tracking-tight">skills</h1>
            <p className="font-serif text-[0.8rem] italic text-muted-foreground">little tools, kept in reach</p>
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
        <SkillsSkeleton />
      ) : skills.length === 0 ? (
        <EmptySkills onRefresh={refresh} />
      ) : (
        <div className="workspace-frame flex flex-1 flex-col gap-5 overflow-hidden px-4 py-5 md:flex-row md:px-8">
          <aside
            className={cn(
              "min-h-0 flex-col rounded-md border border-border bg-card py-2 md:flex md:w-72 md:flex-none",
              mobileEditor ? "hidden md:flex" : "flex flex-1",
            )}
          >
            <div className="px-4 pb-2 pt-3">
              <p className="font-serif text-sm leading-tight tracking-tight">workspace skills</p>
              <p className="mt-1 font-serif text-xs italic text-muted-foreground">
                {listedCount} of {skills.length} listed for familiar
              </p>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-1 pb-1">
                {skills.map((skill) => (
                  <SkillListItem
                    key={skill.id}
                    skill={skill}
                    active={skill.id === selectedId}
                    dirty={dirtyById[skill.id] === true}
                    busy={toggleBusyId === skill.id}
                    onSelect={() => {
                      setSelectedId(skill.id);
                      setMobileEditor(true);
                      setSettle(true);
                      setSavedNotice(undefined);
                    }}
                    onToggle={() => {
                      void toggleSkill(skill.id, !skill.enabled);
                    }}
                  />
                ))}
              </div>
            </ScrollArea>
          </aside>
          <MarkdownEditorShell
            mobileEditor={mobileEditor}
            backLabel="all skills"
            onBack={() => setMobileEditor(false)}
            editorReady={editorReady}
            mode={mode}
            onModeChange={setMode}
            modeSubject="skill"
            settle={settle}
            toolbar={({ modeIcon, viewToggle }) => (
              <div className="relative flex flex-col gap-2 px-4 py-2.5 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/60 after:content-[''] md:px-6 md:after:inset-x-8">
                <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground/80">
                    {modeIcon}
                    <span className="truncate">{selectedSummary?.relativePath ?? draft?.name ?? "skill"}</span>
                  </span>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!selectedId || !draft || toggleBusyId === selectedId}
                      onClick={() => {
                        if (selectedId && draft) void toggleSkill(selectedId, !draft.enabled);
                      }}
                      className={cn(draft?.enabled && "text-primary")}
                    >
                      {draft?.enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                      {draft?.enabled ? "hide skill" : "list skill"}
                    </Button>
                    {viewToggle}
                    <Button type="button" size="sm" onClick={() => void saveCurrentSkill()} disabled={!canSave}>
                      <Save className="size-3.5" />
                      {saving ? "saving" : "save skill"}
                    </Button>
                  </div>
                </div>
                {diagnostics.length > 0 ? (
                  <div className="w-full rounded-md bg-muted/55 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                    <p className="flex items-center gap-1.5 font-serif italic text-foreground">
                      <AlertTriangle className="size-3.5 text-primary" />
                      skill check
                    </p>
                    <ul className="mt-1 grid gap-1">
                      {diagnostics.map((diagnostic) => (
                        <li key={diagnostic}>{diagnostic}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
            renderEdit={(animationClassName) => {
              if (!draft) return null;
              return (
                <ScrollArea className="min-h-0 flex-1">
                  <div
                    className={cn(
                      "mx-auto grid w-full max-w-[72ch] gap-5 px-6 pb-6 pt-4 md:px-8 md:pb-8 md:pt-5",
                      animationClassName,
                    )}
                  >
                    <div className="grid gap-4 rounded-md bg-muted/35 p-3">
                      <label className="grid gap-1.5">
                        <span className="font-serif text-xs italic text-muted-foreground">name</span>
                        <input
                          type="text"
                          value={draft.name}
                          onChange={(event) => {
                            if (!selectedId) return;
                            setSkillRecords((current) =>
                              mergeDraftPatch(current, selectedId, { name: event.target.value }),
                            );
                          }}
                          autoComplete="off"
                          spellCheck={false}
                          className="h-9 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                        />
                      </label>
                      <label className="grid gap-1.5">
                        <span className="font-serif text-xs italic text-muted-foreground">description</span>
                        <Textarea
                          value={draft.description}
                          onChange={(event) => {
                            if (!selectedId) return;
                            setSkillRecords((current) =>
                              mergeDraftPatch(current, selectedId, { description: event.target.value }),
                            );
                          }}
                          className="min-h-20 resize-none rounded-md bg-background text-sm leading-relaxed"
                        />
                      </label>
                    </div>
                    <label className="grid min-h-[28rem] gap-2">
                      <span className="font-serif text-xs italic text-muted-foreground">body</span>
                      <Textarea
                        value={draft.content}
                        onChange={(event) => {
                          if (!selectedId) return;
                          setSkillRecords((current) =>
                            mergeDraftPatch(current, selectedId, { content: event.target.value }),
                          );
                        }}
                        spellCheck
                        aria-label={`edit ${draft.name}`}
                        className="min-h-[28rem] resize-y rounded-md bg-card px-4 py-4 font-sans text-[0.95rem] leading-relaxed shadow-none"
                      />
                    </label>
                  </div>
                </ScrollArea>
              );
            }}
            previewText={draft?.content ?? ""}
            previewProseClassName="skill-prose"
            emptyPreviewText="this skill has no body yet."
            previewHeader={
              draft ? (
                <div className="mb-7 border-b border-border/70 pb-5">
                  <h2 className="font-serif text-xl leading-tight tracking-tight">{draft.name}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{draft.description}</p>
                </div>
              ) : null
            }
            previewArticleClassName="pb-8 pt-4 md:pb-10 md:pt-5"
          />
        </div>
      )}
    </div>
  );
}
