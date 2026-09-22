import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { fetchCron, updateCron, type CronChange, type CronJob, type CronPayload } from "@/lib/api";
import { useRequestState } from "@/lib/requestState";
import { CRON_FREQUENCIES } from "../../../../src/config/enums";
import { cn } from "@/lib/utils";
import { IconPlus } from "../organicIcons";
import { Sheet } from "../Sheet";
import { Card, EnumToggle, Field, OnOffToggle } from "./inputs";

type Frequency = CronJob["frequency"];

const FREQUENCY_OPTIONS = CRON_FREQUENCIES.map((value) => ({ value, label: value }));
const DELIVERY_OPTIONS = [
  { value: "queue", label: "wait for his turn" },
  { value: "follow_up", label: "slip it in" },
] as const;
const WEEKDAYS = ["sundays", "mondays", "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays"];
const WEEKDAY_OPTIONS = ["su", "mo", "tu", "we", "th", "fr", "sa"].map((label, index) => ({ value: String(index), label }));

const ordinal = new Intl.PluralRules("en", { type: "ordinal" });
const SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };
const nth = (n: number) => `${n}${SUFFIX[ordinal.select(n)]}`;
const when = (iso: string) => new Date(iso.replace(" ", "T")).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** the schedule as a sentence, the way you'd say it out loud */
function schedule(job: CronJob): string {
  switch (job.frequency) {
    case "once": return job.runAt ? `once, ${when(job.runAt)}` : "once";
    case "hourly": return `every hour at :${String(job.minute ?? 0).padStart(2, "0")}`;
    case "daily": return `every day at ${job.time}`;
    case "weekly": return `${WEEKDAYS[job.weekday ?? 0]} at ${job.time}`;
    case "monthly": return `the ${nth(job.day ?? 1)} of every month at ${job.time}`;
  }
}

/** a new frequency starts from its own schedule fields; the old ones mean nothing under it */
function withFrequency(job: CronJob, frequency: Frequency): CronJob {
  const { id, prompt, enabled, deliveryMode } = job;
  const base = { id, prompt, enabled, deliveryMode, frequency };
  switch (frequency) {
    case "once": return { ...base, runAt: "" };
    case "hourly": return { ...base, minute: 0 };
    case "daily": return { ...base, time: "09:00" };
    case "weekly": return { ...base, time: "09:00", weekday: 1 };
    case "monthly": return { ...base, time: "09:00", day: 1 };
  }
}

const blankJob = (): CronJob => ({ id: "", enabled: true, frequency: "daily", deliveryMode: "queue", prompt: "", time: "09:00" });

function JobRow({ job, lastFiredAt, busy, onChange, onEdit }: {
  job: CronJob;
  lastFiredAt: string | undefined;
  busy: boolean;
  onChange: (change: CronChange) => void;
  onEdit: () => void;
}) {
  const spent = job.frequency === "once" && lastFiredAt;
  return (
    <div className={cn("mcp-server cron-job", !job.enabled && "is-off")}>
      <div className="mcp-what">
        <span className="mcp-name">
          <OnOffToggle enabled={job.enabled} disabled={busy} ariaPrefix={`keep ${job.id} on`} onChange={(enabled) => onChange({ action: "update", id: job.id, job: { enabled } })} />
          <span className="cron-when">{schedule(job)}</span>
          <span className="mcp-chip">{job.id}</span>
        </span>
      </div>
      <p className="cron-prompt">{job.prompt}</p>
      <div className="mcp-foot">
        <small className="mcp-status cron-last">
          {spent ? `done — arrived ${when(lastFiredAt)}` : lastFiredAt ? `last arrived ${when(lastFiredAt)}` : "hasn't arrived yet"}
          {job.deliveryMode === "follow_up" && " · slips into a turn in progress"}
        </small>
        <button type="button" className="pill-button is-quiet" disabled={busy} onClick={onEdit}>edit</button>
        <button
          type="button"
          className="pill-button is-quiet"
          disabled={busy}
          onClick={() => window.confirm(`remove “${job.id}”?`) && onChange({ action: "delete", id: job.id })}
        >
          remove
        </button>
      </div>
    </div>
  );
}

function JobForm({ initial, isNew, busy, error, onSave }: {
  initial: CronJob;
  isNew: boolean;
  busy: boolean;
  error: string | undefined;
  onSave: (job: CronJob) => void;
}) {
  const [job, setJob] = useState(initial);
  const edit = (patch: Partial<CronJob>) => setJob((current) => ({ ...current, ...patch }));
  const timed = job.frequency === "daily" || job.frequency === "weekly" || job.frequency === "monthly";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ ...job, id: job.id.trim() });
  };

  return (
    <form className="mcp-form" onSubmit={submit}>
      <div className="mcp-form-head">
        <Dialog.Title asChild>
          <h4>{isNew ? "a new job" : `edit ${initial.id}`}</h4>
        </Dialog.Title>
        <p>it arrives in your default conversation as a message from you.</p>
      </div>
      <fieldset className="cron-fields" disabled={busy}>
        <Field label="what to say">
          <textarea
            className="pill-input cron-textarea"
            required
            rows={4}
            placeholder="good morning — anything on your mind for today?"
            value={job.prompt}
            onChange={(e) => edit({ prompt: e.target.value })}
          />
        </Field>
        <Field label="how often">
          <EnumToggle value={job.frequency} options={FREQUENCY_OPTIONS} ariaPrefix="how often" disabled={busy} onChange={(frequency) => setJob(withFrequency(job, frequency))} />
        </Field>
        {job.frequency === "weekly" && (
          <Field label="on">
            <EnumToggle value={String(job.weekday ?? 1)} options={WEEKDAY_OPTIONS} ariaPrefix="weekday" disabled={busy} onChange={(day) => edit({ weekday: Number(day) })} />
          </Field>
        )}
        <div className="cron-at">
          {job.frequency === "once" && (
            <Field label="at">
              <input className="pill-input" type="datetime-local" required value={job.runAt ?? ""} onChange={(e) => edit({ runAt: e.target.value })} />
            </Field>
          )}
          {job.frequency === "hourly" && (
            <Field label="at minute">
              <input className="pill-input is-number" type="number" inputMode="numeric" required min={0} max={59} value={job.minute ?? 0} onChange={(e) => edit({ minute: e.target.valueAsNumber })} />
            </Field>
          )}
          {job.frequency === "monthly" && (
            <Field label="on day">
              <input className="pill-input is-number" type="number" inputMode="numeric" required min={1} max={31} value={job.day ?? 1} onChange={(e) => edit({ day: e.target.valueAsNumber })} />
            </Field>
          )}
          {timed && (
            <Field label="at">
              <input className="pill-input" type="time" required value={job.time ?? "09:00"} onChange={(e) => edit({ time: e.target.value })} />
            </Field>
          )}
        </div>
        {job.frequency === "monthly" && (job.day ?? 1) > 28 && <p className="settings-note">shorter months land on their last day.</p>}
        <Field label="if he's mid-reply">
          <EnumToggle value={job.deliveryMode} options={DELIVERY_OPTIONS} ariaPrefix="if he's mid-reply" disabled={busy} onChange={(deliveryMode) => edit({ deliveryMode })} />
        </Field>
        {isNew && (
          <Field label="name">
            <input
              className="pill-input"
              required
              pattern="[A-Za-z0-9._=\-]+"
              title="letters, numbers, and . _ = -"
              placeholder="morning-hello"
              spellCheck={false}
              autoCapitalize="off"
              value={job.id}
              onChange={(e) => edit({ id: e.target.value })}
            />
          </Field>
        )}
      </fieldset>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="mcp-foot">
        <button type="submit" className="pill-button" disabled={busy}>{busy ? "saving…" : isNew ? "schedule it" : "save"}</button>
      </div>
    </form>
  );
}

export function CronSection() {
  const [data, setData] = useState<CronPayload>();
  const [draft, setDraft] = useState<CronJob>();
  const isNew = !draft?.id;
  const { error, isLoading, isMutating, run } = useRequestState();
  const busy = isLoading || isMutating;
  useEffect(() => {
    const id = window.setTimeout(() => void run(fetchCron, { busy: "load", apply: setData }), 0);
    return () => window.clearTimeout(id);
  }, [run]);
  const change = (input: CronChange) => run(() => updateCron(input), { apply: setData });
  const save = async ({ id, ...job }: CronJob) => {
    if (await change({ action: isNew ? "create" : "update", id, job })) setDraft(undefined);
  };

  const on = data?.jobs.filter((job) => job.enabled).length ?? 0;
  const resting = (data?.jobs.length ?? 0) - on;
  return (
    <Card
      title="cron jobs"
      wide
      hint={data ? `${on} scheduled${resting ? ` · ${resting} resting` : ""} · times are ${data.timezone}` : "looking at the calendar…"}
      action={
        <Sheet
          open={draft !== undefined}
          onOpenChange={(open) => setDraft(open ? blankJob() : undefined)}
          className="mcp-add-panel cron-sheet"
          trigger={
            <Dialog.Trigger className="pill-button is-quiet" disabled={!data}>
              <IconPlus />
              add a job
            </Dialog.Trigger>
          }
        >
          <i className="mcp-add-grab" />
          {draft && <JobForm key={draft.id || "new"} initial={draft} isNew={isNew} busy={busy} error={error} onSave={(job) => void save(job)} />}
        </Sheet>
      }
    >
      {error && !draft && <p role="alert" className="settings-error">{error}</p>}
      <div className="settings-rows">
        {data?.jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            lastFiredAt={data.state[job.id]?.lastFiredAt}
            busy={busy}
            onChange={(input) => void change(input)}
            onEdit={() => setDraft(job)}
          />
        ))}
        {data?.jobs.length === 0 && <p className="settings-note">nothing scheduled yet — a morning hello is a good first one.</p>}
      </div>
    </Card>
  );
}
