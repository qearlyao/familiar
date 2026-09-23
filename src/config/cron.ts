import { dueCronSlot, loadSchedulerState } from "../runtime/scheduler.js";
import { createWriteQueue } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { setConfigOverride } from "./overrides.js";
import { assertKnownKeys } from "./readers.js";
import { readCronJob } from "./sections.js";
import type { Config } from "./types.js";

type CronJob = Config["cron"]["jobs"][number];

/** a wall, not a tuning knob: past this many, something has gone wrong rather than gotten busy */
const MAX_CRON_JOBS = 20;

/** update patches the stored job, so a caller can flip one field without resending the rest.
    A frequency change replaces the schedule outright: the old frequency's fields are invalid
    or dead under the new one. */
function mergeOntoStored(stored: CronJob, patch: Record<string, unknown>): Record<string, unknown> {
	const base =
		patch.frequency === undefined || patch.frequency === stored.frequency
			? stored
			: { name: stored.name, prompt: stored.prompt, enabled: stored.enabled, deliveryMode: stored.deliveryMode };
	return { ...base, ...patch };
}

function validateOneJob(value: unknown, stored: CronJob | undefined): CronJob {
	const job = readCronJob(value, "job", "camel");
	// a once job that is already due would fire the moment it is saved — unless its time is
	// untouched, in which case whatever was going to happen already has
	if (job.frequency === "once" && job.runAt !== stored?.runAt && dueCronSlot(job, undefined, Date.now())) {
		throw new Error(`runAt is in the past: ${job.name}`);
	}
	return job;
}

export async function cronPayload(config: Config) {
	const state = await loadSchedulerState(config.workspace.dataDir);
	return {
		jobs: config.cron.jobs,
		state: state.cron,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}

const enqueue = createWriteQueue("cron settings");

/** Serialize read/modify/write across the agent and Web UI so concurrent additions survive. */
export async function manageCron(config: Config, input: unknown) {
	if (!isRecord(input)) throw new Error("cron request must be an object");
	assertKnownKeys(input, "cron request", ["action", "job", "name"]);
	const { action } = input;
	if (action === "list") return cronPayload(config);
	// validate before taking the queue so a bad request never logs as a failed write
	if (action !== "create" && action !== "update" && action !== "delete") {
		throw new Error("action must be list, create, update, or delete");
	}
	let name: string;
	let job: CronJob | undefined;
	if (action === "create") {
		const draft = input.job;
		if (!isRecord(draft)) throw new Error("create needs a job");
		if (input.name !== undefined) throw new Error("create takes the name inside job, not beside action");
		// without this, a create missing frequency silently becomes a once job and complains about
		// runAt instead of the field that was actually left out
		if (draft.name === undefined || draft.frequency === undefined || draft.prompt === undefined) {
			throw new Error("create needs job.name, job.frequency, and job.prompt");
		}
		job = validateOneJob(draft, undefined);
		name = job.name;
	} else {
		if (typeof input.name !== "string") throw new Error(`${action} needs name beside action: the job to ${action}`);
		name = input.name;
		if (action === "update") {
			const patch = input.job;
			if (!isRecord(patch)) throw new Error("update needs a job");
			// run history is keyed by name, so a rename would forget what already fired and fire it again
			if (patch.name !== undefined && patch.name !== name) {
				const renamed = String(patch.name);
				throw new Error(`can't rename a job ("${name}" → "${renamed}"); delete it and create "${renamed}"`);
			}
			const stored = config.cron.jobs.find((existing) => existing.name === name);
			// a partial patch aimed at nothing would otherwise be validated as a whole job and complain
			// about the fields it was never going to carry
			if (!stored) throw new Error(`Cron job not found: ${name}`);
			job = validateOneJob(mergeOntoStored(stored, patch), stored);
		}
	}
	await enqueue(async () => {
		const index = config.cron.jobs.findIndex((existing) => existing.name === name);
		if (action === "create" && index !== -1)
			throw new Error(`Cron job already exists: ${name}; use update to change it`);
		if (action !== "create" && index === -1) throw new Error(`Cron job not found: ${name}`);
		if (action === "create" && config.cron.jobs.length >= MAX_CRON_JOBS) {
			throw new Error(`Cron job limit reached: ${MAX_CRON_JOBS}`);
		}
		const jobs = !job
			? config.cron.jobs.filter((existing) => existing.name !== name)
			: action === "create"
				? [...config.cron.jobs, job]
				: config.cron.jobs.with(index, job);
		await setConfigOverride("cron", jobs);
		config.cron.jobs = jobs;
		console.info("Cron settings updated", { action, name, jobs: jobs.length });
	});
	return cronPayload(config);
}
