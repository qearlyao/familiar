import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CronJobConfig } from "../src/config/types.js";
import {
	buildCronInjectionText,
	buildHeartbeatInjectionText,
	dueCronSlot,
	formatIdleDuration,
	isHeartbeatDue,
	seedCronState,
} from "../src/runtime/scheduler.js";

describe("scheduler helpers", () => {
	it("formats idle durations for heartbeat text", () => {
		assert.equal(formatIdleDuration(59 * 60 * 1000), "59m");
		assert.equal(formatIdleDuration((1 * 60 + 12) * 60 * 1000), "1h 12m");
		assert.equal(formatIdleDuration((2 * 24 + 3) * 60 * 60 * 1000), "2d 3h");
	});

	it("builds a neutral heartbeat envelope without user identity fields", () => {
		const text = buildHeartbeatInjectionText({
			now: "2026-05-09T04:34:16.881Z",
			idleSince: "2026-05-09T03:34:16.881Z",
		});

		assert.match(text, /^<heartbeat local_time="[^"]+" idle_duration="[^"]+">\n/);
		assert.match(text, /this is your time now/);
		assert.match(text, /HEARTBEAT\.md has the menu/);
		assert.doesNotMatch(text, /uid:/);
		assert.doesNotMatch(text, /author/i);
		assert.doesNotMatch(text, /name="/i);
	});

	it("decides heartbeat due state from idle timing and intervals", () => {
		assert.equal(
			isHeartbeatDue({
				now: 35 * 60 * 1000,
				lastUserInteractionAt: 20 * 60 * 1000,
				idleThresholdMs: 10 * 60 * 1000,
				intervalMs: 15 * 60 * 1000,
			}),
			true,
		);
		assert.equal(
			isHeartbeatDue({
				now: 29 * 60 * 1000,
				lastUserInteractionAt: 20 * 60 * 1000,
				idleThresholdMs: 10 * 60 * 1000,
				intervalMs: 15 * 60 * 1000,
			}),
			false,
		);
		const base = Date.parse("2026-05-13T00:00:00.000Z");
		assert.equal(
			isHeartbeatDue({
				now: base + 60 * 60 * 1000,
				lastUserInteractionAt: base + 20 * 60 * 1000,
				lastHeartbeatAt: new Date(base + 50 * 60 * 1000).toISOString(),
				idleThresholdMs: 10 * 60 * 1000,
				intervalMs: 15 * 60 * 1000,
			}),
			false,
		);
		assert.equal(
			isHeartbeatDue({
				now: base + 60 * 60 * 1000,
				lastUserInteractionAt: base + 20 * 60 * 1000,
				lastHeartbeatAt: new Date(base + 35 * 60 * 1000).toISOString(),
				idleThresholdMs: 10 * 60 * 1000,
				intervalMs: 15 * 60 * 1000,
			}),
			true,
		);
	});

	it("treats interval as repeat cadence after the first idle-threshold fire", () => {
		const minute = 60 * 1000;
		const base = Date.parse("2026-05-13T00:00:00.000Z");
		assert.equal(
			isHeartbeatDue({
				now: base + 60 * minute,
				lastUserInteractionAt: base,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			true,
		);
		assert.equal(
			isHeartbeatDue({
				now: base + 240 * minute,
				lastUserInteractionAt: base,
				lastHeartbeatAt: new Date(base + 60 * minute).toISOString(),
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			false,
		);
		assert.equal(
			isHeartbeatDue({
				now: base + 300 * minute,
				lastUserInteractionAt: base,
				lastHeartbeatAt: new Date(base + 60 * minute).toISOString(),
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			true,
		);
	});

	it("uses persisted heartbeat time across restarts", () => {
		const minute = 60 * 1000;
		const lastUserInteractionAt = Date.parse("2026-05-13T00:00:00.000Z");
		const lastHeartbeatAt = "2026-05-13T01:00:00.000Z";

		assert.equal(
			isHeartbeatDue({
				now: lastUserInteractionAt + 120 * minute,
				lastUserInteractionAt,
				lastHeartbeatAt,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			false,
		);
		assert.equal(
			isHeartbeatDue({
				now: lastUserInteractionAt + 300 * minute,
				lastUserInteractionAt,
				lastHeartbeatAt,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			true,
		);
	});

	it("waits one interval after a cold-start seeded fire when the user stays silent", () => {
		const minute = 60 * 1000;
		const lastUserInteractionAt = Date.parse("2026-05-13T00:00:00.000Z");
		const lastHeartbeatAt = "2026-05-13T04:00:00.000Z";

		assert.equal(
			isHeartbeatDue({
				now: Date.parse("2026-05-13T07:00:00.000Z"),
				lastUserInteractionAt,
				lastHeartbeatAt,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			false,
		);
		assert.equal(
			isHeartbeatDue({
				now: Date.parse("2026-05-13T08:00:00.000Z"),
				lastUserInteractionAt,
				lastHeartbeatAt,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			true,
		);
	});

	it("falls back to first-fire after cold-start when the user replies during the window", () => {
		const minute = 60 * 1000;
		// Cold start seeded lastFiredAt at 04:00, then the user replied at 05:00.
		const lastHeartbeatAt = "2026-05-13T04:00:00.000Z";
		const lastUserInteractionAt = Date.parse("2026-05-13T05:00:00.000Z");

		assert.equal(
			isHeartbeatDue({
				now: lastUserInteractionAt + 30 * minute,
				lastUserInteractionAt,
				lastHeartbeatAt,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			false,
		);
		assert.equal(
			isHeartbeatDue({
				now: lastUserInteractionAt + 60 * minute,
				lastUserInteractionAt,
				lastHeartbeatAt,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			true,
		);
	});

	it("resets heartbeat first-fire eligibility after a later user reply", () => {
		const minute = 60 * 1000;
		const lastUserInteractionAt = Date.parse("2026-05-13T03:00:00.000Z");

		assert.equal(
			isHeartbeatDue({
				now: lastUserInteractionAt + 60 * minute,
				lastUserInteractionAt,
				lastHeartbeatAt: "2026-05-13T01:00:00.000Z",
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			true,
		);
	});

	it("builds cron envelopes without user identity fields", () => {
		const job: CronJobConfig = {
			name: "daily-review",
			enabled: true,
			frequency: "daily",
			deliveryMode: "queue",
			time: "09:00",
			prompt: "Review priorities.",
		};
		const text = buildCronInjectionText({ job, now: "2026-05-13T09:00:00", graceMs: 300_000 });

		assert.match(text, /^<cron name="daily-review" local_time="[^"]+">\n/);
		assert.match(text, /Review priorities/);
		assert.doesNotMatch(text, /uid:/);
		assert.doesNotMatch(text, /author/i);
		assert.doesNotMatch(text, /missed/);

		// fired hours past its slot because the box was down, not because the tick ran long
		const late = { job, now: "2026-05-13T13:20:00", graceMs: 300_000 };
		assert.match(buildCronInjectionText({ ...late, state: { lastFiredAt: "2026-05-12T09:00:00Z" } }), / missed="4h 20m">/);
		// a job seeded but never fired is just as late when the box was down across its first slot
		assert.match(buildCronInjectionText({ ...late, state: { lastFiredSlot: "daily:2026-05-12T09:00" } }), / missed="4h 20m">/);
		// within grace, and a job with no record has no schedule to be late on
		assert.doesNotMatch(buildCronInjectionText({ ...late, now: "2026-05-13T09:04:00", state: { lastFiredAt: "x" } }), /missed/);
		assert.doesNotMatch(buildCronInjectionText(late), /missed/);
	});

	it("computes due cron slots and suppresses repeats by slot", () => {
		const daily: CronJobConfig = {
			name: "daily-review",
			enabled: true,
			frequency: "daily",
			deliveryMode: "queue",
			time: "09:00",
			prompt: "Review priorities.",
		};
		const slot = dueCronSlot(daily, undefined, new Date(2026, 4, 13, 9, 5));
		assert.equal(slot, "daily:2026-05-13T09:00");
		assert.equal(dueCronSlot(daily, { lastFiredSlot: slot }, new Date(2026, 4, 13, 9, 10)), undefined);
		assert.equal(
			dueCronSlot(daily, { lastFiredSlot: slot }, new Date(2026, 4, 14, 9, 0)),
			"daily:2026-05-14T09:00",
		);
	});

	it("seeds a new or rescheduled recurring job so it waits for its next slot", () => {
		const base = { enabled: true, deliveryMode: "queue", prompt: "p" } as const;
		const fire = (job: CronJobConfig, created: Date, later: Date) => {
			const state = seedCronState(job, undefined, created);
			return { created: dueCronSlot(job, state, created), later: dueCronSlot(job, state, later) };
		};
		// Friday 11:38: last Sunday's 10:00 is behind it, next Sunday's is the first owed
		const weekly: CronJobConfig = { ...base, name: "w", frequency: "weekly", weekday: 0, time: "10:00" };
		assert.deepEqual(fire(weekly, new Date(2026, 9, 9, 11, 38), new Date(2026, 9, 11, 10, 0)), {
			created: undefined,
			later: "weekly:2026-10-11T10:00",
		});
		const daily: CronJobConfig = { ...base, name: "d", frequency: "daily", time: "12:00" };
		assert.deepEqual(fire(daily, new Date(2026, 9, 9, 11, 0), new Date(2026, 9, 9, 12, 0)), {
			created: undefined,
			later: "daily:2026-10-09T12:00",
		});
		const hourly: CronJobConfig = { ...base, name: "h", frequency: "hourly", minute: 15 };
		assert.deepEqual(fire(hourly, new Date(2026, 9, 9, 11, 30), new Date(2026, 9, 9, 12, 15)), {
			created: undefined,
			later: "hourly:2026-10-09T12:15",
		});

		// a record kept under the same schedule stands, so downtime still catches up
		const kept = { ...seedCronState(daily, undefined, new Date(2026, 9, 8, 13)), lastFiredAt: "2026-10-08T05:00:00Z" };
		assert.equal(seedCronState(daily, kept, new Date(2026, 9, 10, 15)), undefined);
		assert.equal(dueCronSlot(daily, kept, new Date(2026, 9, 10, 15)), "daily:2026-10-10T12:00");
		// a timing change starts afresh but remembers when it last ran
		const moved = { ...daily, time: "08:00" };
		const reseeded = seedCronState(moved, kept, new Date(2026, 9, 9, 9));
		assert.equal(reseeded?.lastFiredAt, kept.lastFiredAt);
		assert.equal(dueCronSlot(moved, reseeded, new Date(2026, 9, 9, 9)), undefined);
		// once jobs and parked jobs are left alone
		assert.equal(seedCronState({ ...daily, enabled: false }, undefined, new Date(2026, 9, 9, 13)), undefined);
		const once: CronJobConfig = { ...base, name: "o", frequency: "once", runAt: "2026-10-09 10:00" };
		assert.equal(seedCronState(once, undefined, new Date(2026, 9, 9, 13)), undefined);
	});

	it("supports one-time, hourly, weekly, and monthly cron slots", () => {
		assert.equal(
			dueCronSlot(
				{
					name: "once",
					enabled: true,
					frequency: "once",
					deliveryMode: "queue",
					runAt: "2026-05-13 09:00",
					prompt: "once",
				},
				undefined,
				new Date(2026, 4, 13, 8, 59),
			),
			undefined,
		);
		assert.equal(
			dueCronSlot(
				{
					name: "hourly",
					enabled: true,
					frequency: "hourly",
					deliveryMode: "follow_up",
					minute: 15,
					prompt: "hourly",
				},
				undefined,
				new Date(2026, 4, 13, 10, 14),
			),
			"hourly:2026-05-13T09:15",
		);
		assert.equal(
			dueCronSlot(
				{
					name: "weekly",
					enabled: true,
					frequency: "weekly",
					deliveryMode: "queue",
					weekday: 3,
					time: "09:30",
					prompt: "weekly",
				},
				undefined,
				new Date(2026, 4, 13, 9, 30),
			),
			"weekly:2026-05-13T09:30",
		);
		assert.equal(
			dueCronSlot(
				{
					name: "monthly",
					enabled: true,
					frequency: "monthly",
					deliveryMode: "queue",
					day: 31,
					time: "20:00",
					prompt: "monthly",
				},
				undefined,
				new Date(2026, 3, 30, 20, 0),
			),
			"monthly:2026-04-30T20:00",
		);
	});
});
