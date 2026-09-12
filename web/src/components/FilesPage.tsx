import { createElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import {
  fetchAuthMode,
  fetchFiles,
  markFileSeen,
  saveFile,
  type WebFileId,
  type WebFileSeen,
  type WebFileSummary,
} from "@/lib/api";
import { keepsakeBlocks, unreadLines } from "./keepsakeBlocks";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import { IconChevronLeft, IconChevronRight, IconEdit, IconEye, IconInfo, IconKeep } from "./organicIcons";
import "./keepsakes.css";

/** Keepsakes 1a/1b/2a/2b: the kept shelf. These files ride into every chat, so the shelf reads
    as kept things rather than a stack you pick from, and each card carries what it costs the
    window. Reading is the default; the switch in the sheet head throws it to raw markdown.

    A phone gets the shelf alone (2a); opening a file takes the whole screen (2b), with the
    discard/keep pair above the tab bar. */

const PHONE = "(max-width: 700px)";
/** rough and honestly labelled — four bytes to a token is close enough to size the bars */
const BYTES_PER_TOKEN = 4;

interface Kept {
  summary: WebFileSummary;
  /** what's on disk; undefined until the file has been opened once */
  saved?: string;
  /** what's been typed since, kept per file so switching cards doesn't lose it */
  draft?: string;
}

type Shelf = Partial<Record<WebFileId, Kept>>;

/** one tone per file, shared by the totals slice and that file's own strip */
const TONES = ["#2b1901", "#4c3e2c", "#525833", "#d6bd8a", "#8c7a5c"];
const UNSAVED = "#6e2e14";

const tokens = (text: string) => Math.round(text.length / BYTES_PER_TOKEN);
const stem = (name: string) => name.replace(/\.md$/i, "");
const dirtyRow = (kept: Kept | undefined) =>
  kept?.saved !== undefined && kept.draft !== undefined && kept.draft !== kept.saved;
/** what a card weighs: whatever text is in hand, and the size on disk until it's been opened */
const weight = (kept: Kept | undefined) => {
  const text = kept?.draft ?? kept?.saved;
  return text === undefined ? Math.round((kept?.summary.sizeBytes ?? 0) / BYTES_PER_TOKEN) : tokens(text);
};

function since(mtimeMs: number | null): string {
  if (mtimeMs === null) return "nothing written yet";
  return `saved ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(mtimeMs))
    .toLowerCase()}`;
}

/** the blocks of a keepsake as it stands on disk, for marking it read */
const fingerprints = (text: string) => keepsakeBlocks(text).map((block) => block.fingerprint);

const NO_MARKS: ReadonlySet<number> = new Set();
/** every element that can stand alone in a keepsake, so a mark lands on exactly what changed */
const MARKABLE = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"] as const;

interface MarkableProps {
  node?: { position?: { start: { line: number } } };
  className?: string;
  children?: ReactNode;
}

/** tags each top-level block that started on an unread line, so the prose shows what's new */
function markUnread(marks: ReadonlySet<number>): Components | undefined {
  if (marks.size === 0) return undefined;
  const wrap = (tag: string) =>
    function Marked({ node, className, children, ...rest }: MarkableProps) {
      const line = node?.position?.start.line;
      return createElement(
        tag,
        { ...rest, className: cn(className, line !== undefined && marks.has(line) && "kept-new") },
        children,
      );
    };
  return Object.fromEntries(MARKABLE.map((tag) => [tag, wrap(tag)])) as Components;
}

export function FilesPage({ onBack, visible }: { onBack: () => void; visible: boolean }) {
  const phone = useMediaQuery(PHONE);
  const [order, setOrder] = useState<WebFileId[]>([]);
  const [shelf, setShelf] = useState<Shelf>({});
  const [openId, setOpenId] = useState<WebFileId>();
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState<WebFileSeen>({});
  const [persona, setPersona] = useState("they");
  const [note, setNote] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const say = (err: unknown) => setNote(err instanceof Error ? err.message : String(err));

  const reload = useCallback(
    () =>
      fetchFiles()
        .then(async ({ files, seen: read }) => {
          setOrder(files.map((file) => file.id));
          // the first card is open on a desk; a phone starts on the shelf itself
          if (!window.matchMedia(PHONE).matches) setOpenId((cur) => cur ?? files[0]?.id);
          // the listing carries each keepsake's text — the shelf needs it to say what's unread
          setShelf((prev) => {
            const next: Shelf = {};
            for (const { content, ...summary } of files) {
              next[summary.id] = { ...prev[summary.id], summary, saved: content };
            }
            return next;
          });
          setSeen(read);

          // a keepsake with no record has never been looked at; baseline it now so the next
          // change to it reads as new rather than the whole file reading as new
          for (const file of files) {
            if (read[file.id]) continue;
            setSeen(await markFileSeen(file.id, fingerprints(file.content)));
          }
        })
        .catch(say)
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void reload();
    fetchAuthMode()
      .then(({ personaName }) => setPersona(personaName))
      .catch(() => undefined);
  }, [reload]);

  const kept = openId ? shelf[openId] : undefined;
  const draft = kept?.draft ?? kept?.saved ?? "";
  const dirty = dirtyRow(kept);
  const ready = kept?.saved !== undefined;

  // what's unread in each keepsake, against what was on disk the last time you looked at it
  const unread = useMemo(() => {
    const out: Partial<Record<WebFileId, ReadonlySet<number>>> = {};
    for (const id of order) {
      const text = shelf[id]?.saved;
      if (text !== undefined) out[id] = unreadLines(text, seen[id]);
    }
    return out;
  }, [order, seen, shelf]);

  // an edit in hand moves every line under it, so the marks stand down until it's saved or dropped
  const marks = (!dirty && openId && unread[openId]) || NO_MARKS;

  // leaving a file is what marks it read: switching cards, closing it, or leaving the room
  const latest = useRef(shelf);
  useEffect(() => {
    latest.current = shelf;
  }, [shelf]);
  useEffect(() => {
    if (!openId || !visible) return;
    return () => {
      const text = latest.current[openId]?.saved;
      if (text !== undefined) markFileSeen(openId, fingerprints(text)).then(setSeen).catch(() => undefined);
    };
  }, [openId, visible]);

  const keep = () => {
    if (!openId || !dirty) return;
    setBusy(true);
    setNote(undefined);
    saveFile(openId, draft)
      .then(({ content, ...summary }) => {
        setShelf((prev) => ({ ...prev, [summary.id]: { summary, saved: content } }));
        setNote(`${persona} knows this now`);
        // what you just wrote is by definition read
        return markFileSeen(summary.id, fingerprints(content)).then(setSeen);
      })
      .catch(say)
      .finally(() => setBusy(false));
  };

  const discard = () => {
    if (!openId) return;
    setShelf((prev) => (prev[openId] ? { ...prev, [openId]: { ...prev[openId], draft: undefined } } : prev));
    setNote(undefined);
  };

  const files = order.flatMap((id) => (shelf[id]?.summary ? [{ id, kept: shelf[id] as Kept }] : []));
  const total = files.reduce((sum, file) => sum + weight(file.kept), 0);
  const share = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));

  const openFile = (id: WebFileId) => {
    setOpenId(id);
    setEditing(dirtyRow(shelf[id]));
    setNote(undefined);
  };

  const tone = (index: number) => TONES[index];
  const openIndex = Math.max(order.indexOf(openId as WebFileId), 0);
  const onDisk = kept?.saved === undefined ? weight(kept) : tokens(kept.saved);
  const delta = weight(kept) - onDisk;

  /* what the open file costs: its own tone for what's on disk, clay for what isn't saved yet */
  const weighBar = (
    <span className="kept-weigh">
      <span className="kept-track">
        <span style={{ width: `${share(onDisk)}%`, background: tone(openIndex) }} />
        {delta !== 0 && <span style={{ width: `${share(Math.abs(delta))}%`, background: UNSAVED }} />}
      </span>
      <span className={cn(delta !== 0 && "kept-loud")}>
        {weight(kept).toLocaleString()}
        {delta === 0 ? "" : ` · ${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString()} unsaved`}
      </span>
    </span>
  );

  const modeSwitch = (
    <button
      type="button"
      role="switch"
      aria-checked={editing}
      className="kept-mode"
      title={editing ? "back to reading" : "edit the file"}
      onClick={() => setEditing(!editing)}
    >
      {editing ? <IconEdit size={13} /> : <IconEye size={13} />}
      {editing ? "editing" : "reading"}
      <span>
        <span />
      </span>
    </button>
  );

  const body = !ready ? (
    <div className="kept-read">
      <p className="kept-quiet">opening it…</p>
    </div>
  ) : editing ? (
    <textarea
      className="kept-body"
      value={draft}
      aria-label={`edit ${kept?.summary.name}`}
      placeholder="write it the way you'd tell a person. they read markdown."
      onChange={(event) =>
        setShelf((prev) =>
          openId && prev[openId] ? { ...prev, [openId]: { ...prev[openId], draft: event.target.value } } : prev,
        )
      }
    />
  ) : (
    <div className="kept-read">
      {draft.trim() ? (
        <MarkdownRenderer
          text={draft}
          remarkPlugins={[remarkGfm]}
          components={markUnread(marks)}
          className="warm-prose kept-prose"
        />
      ) : (
        <p className="kept-quiet">this one is still empty — throw the switch and write the first line.</p>
      )}
    </div>
  );

  const foot = (
    <footer className="kept-foot">
      <span className={cn(note && "kept-loud", !note && marks.size > 0 && "kept-fresh")}>
        {note ??
          (dirty
            ? "unsaved · not carried yet"
            : marks.size > 0
              ? "shaded parts are new since you last looked"
              : kept
                ? since(kept.summary.mtimeMs)
                : "")}
      </span>
      <button type="button" className="kept-discard" disabled={busy || !dirty} onClick={discard}>
        discard
      </button>
      <button type="button" className="kept-keep" disabled={busy || !dirty} onClick={keep}>
        <IconKeep size={15} />
        keep it
      </button>
    </footer>
  );

  return (
    <div className="kept chat-theme">
      <div className="kept-shelf">
        <header className="kept-head">
          <button type="button" className="kept-back" aria-label="back to the talk" title="back to the talk" onClick={onBack}>
            <IconChevronLeft size={17} />
          </button>
          <div>
            <h2>keepsakes</h2>
            <span>
              {loading
                ? "taking them off the shelf…"
                : `${files.length} ${files.length === 1 ? "file" : "files"} ${persona} always carries`}
            </span>
          </div>
        </header>

        {total > 0 && (
          <div className="kept-total">
            <span>
              <b>{total.toLocaleString()}</b>
              <span>tokens of the window, about</span>
            </span>
            <span className="kept-slices">
              {files.map((file, index) => (
                <span
                  key={file.id}
                  style={{ width: `${share(weight(file.kept))}%`, background: tone(index) }}
                />
              ))}
            </span>
            <span>{persona} reads all of them before you speak</span>
          </div>
        )}

        <div className="kept-cards">
          {files.map(({ id, kept: file }, index) => {
            const isOpen = id === openId;
            const unsaved = dirtyRow(file);
            const fresh = (isOpen && !dirty ? marks.size : (unread[id]?.size ?? 0)) || 0;
            return (
              <button key={id} type="button" className={cn("kept-card", isOpen && "is-open")} onClick={() => openFile(id)}>
                <span className="kept-card-name">
                  <b>{stem(file.summary.name)}</b>
                  <code className="kept-card-code">.md</code>
                  <IconChevronRight size={17} />
                </span>
                <span className={cn("kept-card-line", unsaved && "is-loud", !unsaved && fresh > 0 && "is-new")}>
                  {unsaved
                    ? "unsaved · writing now"
                    : fresh > 0
                      ? `${fresh} ${fresh === 1 ? "part is" : "parts are"} new since you looked`
                      : file.summary.description}
                </span>
                <span className="kept-weigh">
                  <span className="kept-track">
                    <span
                      style={{ width: `${share(isOpen ? onDisk : weight(file))}%`, background: isOpen ? undefined : tone(index) }}
                    />
                    {isOpen && delta !== 0 && <span style={{ width: `${share(Math.abs(delta))}%`, background: UNSAVED }} />}
                  </span>
                  <span>{weight(file).toLocaleString()}</span>
                </span>
              </button>
            );
          })}
        </div>

        <p className="kept-note" title={`${persona} writes in MEMORY.md too — edit or delete those lines like your own.`}>
          <IconInfo size={14} />
          kept for good — emptied, never removed
        </p>
      </div>

      {!openId ? (
        !phone && (
          <article className="kept-sheet is-shut">
            <p>{note ?? "pick one off the shelf."}</p>
          </article>
        )
      ) : phone ? (
        <div className="kept-open">
          <header className="kept-bar">
            <button
              type="button"
              className="kept-back"
              aria-label="back to the shelf"
              title="back to the shelf"
              onClick={() => setOpenId(undefined)}
            >
              <IconChevronLeft size={17} />
            </button>
            <span>
              <b>{kept?.summary.name}</b>
              <span className={cn(dirty && "kept-loud", !dirty && marks.size > 0 && "kept-fresh")}>
                {dirty
                  ? `${editing ? "editing" : "reading"} · not saved`
                  : marks.size > 0
                    ? `${marks.size} shaded ${marks.size === 1 ? "part is" : "parts are"} new`
                    : since(kept?.summary.mtimeMs ?? null)}
              </span>
            </span>
            {modeSwitch}
          </header>
          {weighBar}
          <article className="kept-sheet">
            <div className="kept-naming">
              <b>{kept?.summary.title}</b>
              <span>{editing ? "raw markdown · both of you write here" : kept?.summary.description}</span>
            </div>
            {body}
          </article>
          {foot}
        </div>
      ) : (
        <article className="kept-sheet">
          <header className="kept-sheet-head">
            <code>keepsakes/{kept?.summary.name}</code>
            <span className="kept-share">
              {weight(kept).toLocaleString()} tokens · {share(weight(kept))}% of what {persona} carries
            </span>
            {delta !== 0 && (
              <span className="kept-share kept-loud kept-unsaved">
                {delta > 0 ? "+" : "−"}
                {Math.abs(delta).toLocaleString()} unsaved
              </span>
            )}
            {modeSwitch}
          </header>
          <div className="kept-naming">
            <b>{kept?.summary.title}</b>
            <span>{editing ? "raw markdown · both of you write here" : kept?.summary.description}</span>
          </div>
          {body}
          {foot}
        </article>
      )}
    </div>
  );
}
