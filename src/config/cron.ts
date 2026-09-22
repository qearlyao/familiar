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
			: { id: stored.id, prompt: stored.prompt, enabled: stored.enabled, deliveryMode: stored.deliveryMode };
	return { ...base, ...patch };
}

function validateOneJob(value: unknown, stored: CronJob | undefined): CronJob {
	const job = readCronJob(value, "job", "camel");
	// a once job that is already due would fire the moment it is saved — unless its time is
	// untouched, in which case whatever was going to happen already has
	if (job.frequency === "once" && job.runAt !== stored?.runAt && dueCronSlot(job, undefined, Date.now())) {
		throw new Error(`runAt is in the past: ${job.id}`);
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
	assertKnownKeys(input, "cron request", ["action", "job", "id"]);
	const { action } = input;
	if (action === "list") return cronPayload(config);
	// validate before taking the queue so a bad request never logs as a failed write
	if (action !== "create" && action !== "update" && action !== "delete") {
		throw new Error("action must be list, create, update, or delete");
	}
	const { id } = input;
	if (typeof id !== "string") throw new Error("id must be a string");
	let job: CronJob | undefined;
	if (action !== "delete") {
		const patch = input.job;
		if (!isRecord(patch)) throw new Error(`${action} needs a job`);
		if (patch.id !== undefined) throw new Error("id goes at the top level, not inside job");
		// only update may go partial; without this, a create missing frequency silently becomes a once
		// job and complains about runAt instead of the field that was actually left out
		if (action === "create" && (patch.frequency === undefined || patch.prompt === undefined)) {
			throw new Error("create needs job.frequency and job.prompt");
		}
		const stored = action === "update" ? config.cron.jobs.find((existing) => existing.id === id) : undefined;
		// a partial patch aimed at nothing would otherwise be validated as a whole job and complain
		// about the fields it was never going to carry
		if (action === "update" && !stored) throw new Error(`Cron job not found: ${id}`);
		job = validateOneJob({ ...(stored ? mergeOntoStored(stored, patch) : patch), id }, stored);
	}
	await enqueue(async () => {
		const index = config.cron.jobs.findIndex((existing) => existing.id === id);
		if (action === "create" ? index !== -1 : index === -1) {
			throw new Error(`Cron job ${action === "create" ? "already exists" : "not found"}: ${id}`);
		}
		if (action === "create" && config.cron.jobs.length >= MAX_CRON_JOBS) {
			throw new Error(`Cron job limit reached: ${MAX_CRON_JOBS}`);
		}
		const jobs = !job
			? config.cron.jobs.filter((existing) => existing.id !== id)
			: action === "create"
				? [...config.cron.jobs, job]
				: config.cron.jobs.with(index, job);
		await setConfigOverride("cron", jobs);
		config.cron.jobs = jobs;
		console.info("Cron settings updated", { action, id, jobs: jobs.length });
	});
	return cronPayload(config);
}
