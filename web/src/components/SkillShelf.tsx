import { useEffect, useState } from "react";
import { fetchSkills, setSkillEnabled, type WebSkillSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Shelf } from "./Shelf";

/** Skills 1a/1c: the shelf only decides what they carry — listed, or kept aside. The switch is
    global, and says so. Writing the file is a different job, one link away. */

export function SkillShelf({ open, onClose, personaName, onOpenArchive }: {
  open: boolean;
  onClose: () => void;
  personaName: string;
  onOpenArchive: () => void;
}) {
  const [skills, setSkills] = useState<WebSkillSummary[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchSkills()
      .then((all) => live && setSkills(all))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open]);

  const put = (id: string, enabled: boolean) =>
    setSkills((prev) => prev.map((skill) => (skill.id === id ? { ...skill, enabled } : skill)));

  // the switch lands before the write does; if the write fails it goes back where it was
  const flip = ({ id, enabled }: WebSkillSummary) => {
    put(id, !enabled);
    setError(undefined);
    setSkillEnabled(id, !enabled).catch((err: unknown) => {
      put(id, enabled);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const listed = skills.filter((skill) => skill.enabled);
  const aside = skills.filter((skill) => !skill.enabled);

  const group = (label: string, rows: WebSkillSummary[]) =>
    rows.length > 0 && (
      <>
        <span className="shelf-label">{label}</span>
        {rows.map((skill) => (
          <button
            key={skill.id}
            type="button"
            role="switch"
            aria-checked={skill.enabled}
            className={cn("shelf-skill", skill.enabled && "is-listed")}
            title={skill.enabled ? "keep aside" : `list for ${personaName}`}
            onClick={() => flip(skill)}
          >
            <span className="shelf-skill-lines">
              <b>{skill.name}</b>
              <em>{skill.description}</em>
            </span>
            <span className="shelf-switch" aria-hidden />
          </button>
        ))}
      </>
    );

  return (
    <Shelf
      open={open}
      onClose={onClose}
      title="skills"
      sub={loading ? "what they can reach for" : `${listed.length} of ${skills.length} listed for ${personaName}`}
    >
      {error && <p className="shelf-note" role="alert">that switch didn’t hold · {error}</p>}
      <div className="shelf-skills">
        {group(`listed for ${personaName}`, listed)}
        {group("kept aside", aside)}
        {!loading && skills.length === 0 && <p className="shelf-note">nothing written yet — the first one starts on the desk.</p>}
      </div>
      <div className="shelf-foot">
        <span className="shelf-hint">switching one on or off changes it everywhere, not only in this talk.</span>
        <button type="button" className="shelf-archive" onClick={onOpenArchive}>write and edit skills →</button>
      </div>
    </Shelf>
  );
}
