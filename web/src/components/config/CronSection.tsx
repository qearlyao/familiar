import { useCallback, useEffect, useState } from "react";
import { fetchCron, updateCron, type CronChange, type CronJob, type CronPayload } from "@/lib/api";
import { useRequestState } from "@/lib/requestState";
import { CRON_FREQUENCIES } from "../../../../src/config/enums";
import { Card, EnumToggle, Field, OnOffToggle, Rows } from "./inputs";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DELIVERY_OPTIONS = [
  { value: "queue", label: "queued turn" },
  { value: "follow_up", label: "follow-up" },
] as const;
const emptyJob = (): CronJob => ({ id: "", enabled: true, frequency: "daily", deliveryMode: "queue", prompt: "", time: "09:00" });

function schedule(job: CronJob): string {
  switch (job.frequency) {
    case "once": return `once · ${job.runAt}`;
    case "hourly": return `hourly · minute ${job.minute ?? 0}`;
    case "daily": return `daily · ${job.time}`;
    case "weekly": return `${weekdays[job.weekday ?? 0]} · ${job.time}`;
    case "monthly": return `monthly · day ${job.day ?? 1} · ${job.time}`;
  }
}

export function CronSection() {
  const [data, setData] = useState<CronPayload>();
  const [draft, setDraft] = useState<{ job: CronJob; action: "create" | "update" }>();
  const { error, isLoading, isMutating, run } = useRequestState();
  const busy = isLoading || isMutating;
  const refresh = useCallback(() => void run(fetchCron, { busy: "load", apply: setData }), [run]);
  useEffect(() => {
    const id = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(id);
  }, [refresh]);
  const change = (input: CronChange) => run(() => updateCron(input), { apply: setData });
  const job = draft?.job;
  const edit = (next: Partial<CronJob>) => draft && setDraft({ ...draft, job: { ...draft.job, ...next } });

  return <Card title="cron jobs" wide hint="scheduled prompts in your default conversation. changes apply without a restart.">
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="cron-toolbar">
      <p>{data ? `${data.timezone} · checked every ${data.pollSeconds}s` : "loading schedules…"}</p>
      <button type="button" className="pill-button is-quiet" disabled={busy} onClick={refresh}>refresh</button>
      <button type="button" className="pill-button" disabled={busy || !data} onClick={() => setDraft({ job: emptyJob(), action: "create" })}>add job</button>
    </div>
    <p className="settings-note">All times use the server timezone shown above. Repeating jobs catch up their latest due time when enabled. Monthly dates are clamped to the last day of shorter months.</p>
    {data?.jobs.length === 0 && <p className="settings-note">No cron jobs yet.</p>}
    <Rows>
      {data?.jobs.map((stored) => <div className="cron-job" key={stored.id}>
        <div className="cron-toolbar">
          <strong>{stored.id}</strong><span>{schedule(stored)} · {stored.deliveryMode === "queue" ? "queued turn" : "follow-up"}</span>
          <OnOffToggle enabled={stored.enabled} disabled={busy} ariaPrefix={`enable ${stored.id}`} onChange={(enabled) => void change({ action: "update", id: stored.id, job: { enabled } })} />
          <button type="button" className="pill-button is-quiet" disabled={busy} onClick={() => setDraft({ job: { ...stored }, action: "update" })}>edit</button>
          <button type="button" className="pill-button is-quiet" disabled={busy} onClick={() => { if (window.confirm(`Delete cron job “${stored.id}”?`)) void change({ action: "delete", id: stored.id }); }}>delete</button>
        </div>
        <p className="cron-prompt">{stored.prompt}</p>
        <small className="settings-note">{data.state[stored.id]?.lastFiredAt ? `Last started: ${data.state[stored.id].lastFiredAt}` : "Not run yet"}</small>
      </div>)}
    </Rows>
    {draft && job && <form className="cron-form" onSubmit={async (event) => {
      event.preventDefault();
      const { id, ...fields } = job;
      if (await change({ action: draft.action, id, job: fields })) setDraft(undefined);
    }}>
      <h4>{draft.action === "update" ? "edit job" : "new job"}</h4>
      <fieldset disabled={busy}>
        <Field label="Job ID"><input aria-label="Job ID" className="pill-input" required pattern="[A-Za-z0-9._=\-]+" disabled={draft.action === "update"} value={job.id} onChange={(e) => edit({ id: e.target.value })} /></Field>
        <Field label="Frequency"><select aria-label="Frequency" className="pill-input" value={job.frequency} onChange={(e) => {
          const frequency = e.target.value as CronJob["frequency"];
          setDraft({ ...draft, job: { id: job.id, prompt: job.prompt, enabled: job.enabled, deliveryMode: job.deliveryMode, frequency,
            ...(frequency === "once" ? { runAt: "" } : frequency === "hourly" ? { minute: 0 } : { time: "09:00" }),
            ...(frequency === "weekly" ? { weekday: 0 } : frequency === "monthly" ? { day: 1 } : {}) } });
        }}>{CRON_FREQUENCIES.map((frequency) => <option key={frequency}>{frequency}</option>)}</select></Field>
        {job.frequency === "once" && <Field label="Run at (server time or ISO with offset)"><input aria-label="Run at" className="pill-input" required placeholder="2026-12-31 09:00" value={job.runAt ?? ""} onChange={(e) => edit({ runAt: e.target.value })} /></Field>}
        {job.frequency === "hourly" && <Field label="Minute"><input aria-label="Minute" className="pill-input" type="number" required min={0} max={59} value={job.minute ?? 0} onChange={(e) => edit({ minute: e.target.valueAsNumber })} /></Field>}
        {job.frequency !== "once" && job.frequency !== "hourly" && <Field label="Time"><input aria-label="Time" className="pill-input" type="time" required value={job.time ?? "09:00"} onChange={(e) => edit({ time: e.target.value })} /></Field>}
        {job.frequency === "weekly" && <Field label="Weekday"><select aria-label="Weekday" className="pill-input" value={job.weekday ?? 0} onChange={(e) => edit({ weekday: Number(e.target.value) })}>{weekdays.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></Field>}
        {job.frequency === "monthly" && <Field label="Day of month"><input aria-label="Day of month" className="pill-input" type="number" required min={1} max={31} value={job.day ?? 1} onChange={(e) => edit({ day: e.target.valueAsNumber })} /></Field>}
        <Field label="Delivery"><EnumToggle value={job.deliveryMode} options={DELIVERY_OPTIONS} ariaPrefix="delivery" disabled={busy} onChange={(deliveryMode) => edit({ deliveryMode })} /></Field>
        <Field label="Enabled"><OnOffToggle enabled={job.enabled} disabled={busy} ariaPrefix="enabled" onChange={(enabled) => edit({ enabled })} /></Field>
        <Field label="Prompt"><textarea aria-label="Prompt" className="pill-input" required rows={4} value={job.prompt} onChange={(e) => edit({ prompt: e.target.value })} /></Field>
      </fieldset>
      <div className="cron-toolbar"><button className="pill-button" type="submit" disabled={busy}>save job</button><button className="pill-button is-quiet" type="button" disabled={busy} onClick={() => setDraft(undefined)}>cancel</button></div>
    </form>}
  </Card>;
}
