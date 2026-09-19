import { useCallback, useEffect, useState } from "react";
import {
  deleteSkill,
  fetchSkill,
  fetchSkills,
  importSkillFolder,
  saveSkill,
  setSkillEnabled,
  type WebSkillSummary,
} from "@/lib/api";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import { IconChevronLeft, IconFolderUp, IconInfo, IconPlus } from "./organicIcons";
import "./skills.css";

/** Skills 2a/2b/2c: the writing desk. The skills are tabs on the edge of a paper stack and the
    open one runs into the sheet it belongs to. The tabs carry desk news — what's unsaved, what
    was last written in, what's still missing its line. Whether a skill is listed at all is the
    shelf's job, next to the talk; here they only sit tucked back.

    A phone gets the stack alone (2c); opening a file takes the whole screen, with the save in
    the bar above the paper and the listing switch on its own card underneath. */

const PHONE = "(max-width: 700px)";
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** the file being started has no id until it is saved */
const NEW = "new";
/** a skill folder is writing and its notes; anything else on disk stays on disk */
const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|toml|csv)$/i;
const MAX_IMPORT_BYTES = 3 * 1024 * 1024;

interface Draft {
  name: string;
  description: string;
  content: string;
}

const BLANK: Draft = { name: "", description: "", content: "" };

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "today", "yesterday", "3 days ago", "last week" — whatever the reader's locale calls it. */
function since(mtimeMs: number): string {
  const days = Math.round((Date.now() - mtimeMs) / 86_400_000);
  if (days < 1) return "today";
  if (days < 7) return relative.format(-days, "day");
  if (days < 30) return relative.format(-Math.round(days / 7), "week");
  return relative.format(-Math.round(days / 30), "month");
}

const words = (content: string) => content.trim().split(/\s+/).filter(Boolean).length;
const same = (a: Draft, b: Draft) => a.name === b.name && a.description === b.description && a.content === b.content;

export function SkillsPage({ onBack, personaName: persona }: { onBack: () => void; personaName: string }) {
  const phone = useMediaQuery(PHONE);
  const [skills, setSkills] = useState<WebSkillSummary[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [saved, setSaved] = useState<Draft>(BLANK);
  const [note, setNote] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const say = (err: unknown) => setNote(err instanceof Error ? err.message : String(err));

  const reload = useCallback(
    () =>
      fetchSkills()
        .then(setSkills)
        .catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!openId || openId === NEW) return;
    let live = true;
    fetchSkill(openId)
      .then((skill) => {
        if (!live) return;
        const next = { name: skill.name, description: skill.description, content: skill.content };
        setDraft(next);
        setSaved(next);
      })
      .catch(say);
    return () => {
      live = false;
    };
  }, [openId]);

  const openFile = (id: string) => {
    setOpenId(id);
    setDraft(BLANK);
    setSaved(BLANK);
    setNote(undefined);
  };

  const entry = skills.find((skill) => skill.id === openId);
  const dirty = openId === NEW ? !same(draft, BLANK) : Boolean(openId) && !same(draft, saved);
  const named = NAME_RE.test(draft.name.trim()) && Boolean(draft.description.trim());

  const save = () => {
    if (!openId || !named) return;
    const id = openId === NEW ? `${draft.name.trim()}.md` : openId;
    setBusy(true);
    setNote(undefined);
    saveSkill(id, { ...draft, enabled: entry?.enabled ?? true })
      .then((skill) => {
        setSaved({ name: skill.name, description: skill.description, content: skill.content });
        setOpenId(skill.id);
        return reload();
      })
      .catch(say)
      .finally(() => setBusy(false));
  };

  const throwAway = () => {
    if (!openId) return;
    if (openId === NEW) {
      setOpenId(undefined);
      return;
    }
    setBusy(true);
    deleteSkill(openId)
      .then(() => {
        setOpenId(undefined);
        setNote(undefined);
        return reload();
      })
      .catch(say)
      .finally(() => setBusy(false));
  };

  // a folder off the disk lands whole: its SKILL.md and the writing beside it, nothing binary
  const carryIn = async (picked: FileList | null) => {
    const all = picked ? [...picked] : [];
    if (all.length === 0) return;
    const folder = all[0].webkitRelativePath.split("/")[0] ?? "";
    const kept = all.filter((file) => TEXT_FILE.test(file.name) && file.size < 512 * 1024);
    const left = all.length - kept.length;
    if (kept.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES) {
      setNote("that folder is too heavy to carry in");
      return;
    }
    setBusy(true);
    setNote(undefined);
    try {
      const files = await Promise.all(
        kept.map(async (file) => ({
          path: file.webkitRelativePath.split("/").slice(1).join("/"),
          content: await file.text(),
        })),
      );
      const skill = await importSkillFolder(folder, files);
      await reload();
      openFile(skill.id);
      if (left > 0) setNote(`carried in, minus ${left === 1 ? "one file that wasn't" : `${left} files that weren't`} writing`);
    } catch (error) {
      say(error);
    } finally {
      setBusy(false);
    }
  };

  // the switch lands before the write does; if the write fails it goes back where it was
  const flip = ({ id, enabled }: WebSkillSummary) => {
    const put = (next: boolean) =>
      setSkills((prev) => prev.map((skill) => (skill.id === id ? { ...skill, enabled: next } : skill)));
    put(!enabled);
    setNote(undefined);
    setSkillEnabled(id, !enabled).catch((err: unknown) => {
      put(enabled);
      say(err);
    });
  };

  const tab = (skill: WebSkillSummary) => {
    const isOpen = skill.id === openId;
    const line =
      isOpen && dirty ? "unsaved · writing now" : skill.description ? `last edited ${since(skill.mtimeMs)}` : "no description yet";
    return (
      <button
        key={skill.id}
        type="button"
        className={cn("desk-tab", isOpen && "is-open", !skill.enabled && "is-aside")}
        onClick={() => openFile(skill.id)}
      >
        <b>{skill.name}</b>
        <span className={cn((isOpen && dirty) || !skill.description ? "is-loud" : undefined)}>{line}</span>
      </button>
    );
  };

  const path = `skills/${openId === NEW ? `${draft.name.trim() || "untitled"}.md` : openId}`;
  const count = `${words(draft.content).toLocaleString()} words`;
  const stamp = entry ? `last saved ${since(entry.mtimeMs)}` : undefined;

  const saveButton = (
    <button type="button" className="desk-save" disabled={busy || !named || !dirty} onClick={save}>
      {phone ? "save" : "save the file"}
    </button>
  );

  const listing = entry && (
    <div className="desk-listing">
      <span>
        <b>{entry.enabled ? `listed for ${persona}` : "kept aside"}</b>
        <span>holds in every chat</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={entry.enabled}
        className="desk-switch"
        title={entry.enabled ? "keep aside" : `list for ${persona}`}
        onClick={() => flip(entry)}
      >
        <span />
      </button>
    </div>
  );

  const paper = (
    <>
      <div className="desk-naming">
        <input
          className="desk-name"
          value={draft.name}
          placeholder="what should they call it?"
          aria-label="the file's name"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <textarea
          className="desk-when"
          rows={2}
          value={draft.description}
          placeholder="and when should they reach for it?"
          aria-label="when to reach for it"
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
        <span className="desk-hint">this line is how they decide to reach for it</span>
      </div>
      <textarea
        className="desk-body"
        value={draft.content}
        aria-label="the file"
        placeholder={
          "Write it the way you'd tell a person: what to do, what not to do, and what to do when it goes long.\n\n## headings are fine — they read markdown"
        }
        onChange={(event) => setDraft({ ...draft, content: event.target.value })}
      />
      <footer className="desk-foot">
        {!phone && saveButton}
        {note ? (
          <span className="desk-loud">{note}</span>
        ) : !named ? (
          <span>it needs a lowercase-hyphened name and a line about when to use it</span>
        ) : (
          <span>{dirty ? "unsaved" : [phone ? count : undefined, stamp].filter(Boolean).join(" · ")}</span>
        )}
        <button type="button" className="desk-throw" disabled={busy} onClick={throwAway}>
          {openId === NEW ? "throw it away" : "delete"}
        </button>
      </footer>
    </>
  );

  return (
    <div className="desk chat-theme">
      <div className="desk-stack">
        <header className="desk-head">
          <button type="button" className="desk-back" aria-label="back to the talk" title="back to the talk" onClick={onBack}>
            <IconChevronLeft size={17} />
          </button>
          <div>
            <h2>skills</h2>
            <span>{loading ? "opening the drawer…" : `${skills.length} ${skills.length === 1 ? "file" : "files"} on the desk`}</span>
          </div>
        </header>

        <div className="desk-tabs">
          {skills.filter((skill) => skill.enabled).map(tab)}
          {skills.some((skill) => !skill.enabled) && (
            <div className="desk-rule">
              <span />
              <span>tucked back</span>
            </div>
          )}
          {skills.filter((skill) => !skill.enabled).map(tab)}
          {openId === NEW && (
            <button type="button" className="desk-tab is-open is-fresh">
              <b>{draft.name.trim() || "untitled"}</b>
              <span className="is-loud">{dirty ? "unsaved · writing now" : "nothing written yet"}</span>
            </button>
          )}
        </div>

        {skills.some((skill) => !skill.enabled) && (
          <p
            className="desk-aside-note"
            title={`${persona} isn't carrying those. That's decided on the shelf, next to the talk.`}
          >
            <IconInfo size={14} />
            tucked back = not on the shelf
          </p>
        )}

        <div className="desk-doings">
          <button
            type="button"
            className="desk-start"
            onClick={() => {
              setOpenId(NEW);
              setDraft(BLANK);
              setSaved(BLANK);
              setNote(undefined);
            }}
          >
            <IconPlus size={15} />
            <span>start a file</span>
          </button>
          <label className="desk-import" title="import a folder">
            <IconFolderUp size={15} />
            <span>import a folder</span>
            <input
              type="file"
              multiple
              aria-label="import a folder"
              // a directory picker is the browser's own; React has no prop for it
              ref={(el) => {
                el?.setAttribute("webkitdirectory", "");
              }}
              onChange={(event) => {
                void carryIn(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </div>

      {!openId ? (
        !phone && (
          <article className="desk-sheet is-shut">
            <p>{note ?? "pick a file off the stack, or start one."}</p>
          </article>
        )
      ) : phone ? (
        <div className="desk-open">
          <header className="desk-bar">
            <button
              type="button"
              className="desk-back"
              aria-label="back to the stack"
              title="back to the stack"
              onClick={() => setOpenId(undefined)}
            >
              <IconChevronLeft size={17} />
            </button>
            <code>{path}</code>
            {saveButton}
          </header>
          <article className="desk-sheet">{paper}</article>
          {listing}
        </div>
      ) : (
        <article className="desk-sheet">
          <header className="desk-sheet-head">
            <code>{path}</code>
            <span className="desk-words">{count}</span>
            {listing}
          </header>
          {paper}
        </article>
      )}
    </div>
  );
}
