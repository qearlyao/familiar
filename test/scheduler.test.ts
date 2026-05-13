import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildCronInjectionText,
	buildHeartbeatInjectionText,
	dueCronSlot,
	formatIdleDuration,
	formatLocalTimestamp,
	isHeartbeatDue,
	type CronJobConfig,
} from "../src/scheduler.js";

describe("scheduler helpers", () => {
	it("formats local timestamps in the runtime shape", () => {
		const text = formatLocalTimestamp("2026-05-09T03:34:16.881Z");
		assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[+-]\d{1,2}(?::\d{2})?$/);
	});

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

		assert.match(text, /^<heartbeat local_time="[^"]+" idle_duration="[^"]+" idle_minutes="\d+">\n/);
		assert.match(text, /Read HEARTBEAT\.md before replying/);
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
			id: "daily-review",
			enabled: true,
			frequency: "daily",
			deliveryMode: "queue",
			time: "09:00",
			prompt: "Review priorities.",
		};
		const text = buildCronInjectionText({
			job,
			slot: "daily-review:daily:2026-05-13T09:00",
			now: "2026-05-13T09:00:00",
		});

		assert.match(text, /^<cron id="daily-review" frequency="daily" delivery="queue" /);
		assert.match(text, /Review priorities/);
		assert.doesNotMatch(text, /uid:/);
		assert.doesNotMatch(text, /author/i);
	});

	it("computes due cron slots and suppresses repeats by slot", () => {
		const daily: CronJobConfig = {
			id: "daily-review",
			enabled: true,
			frequency: "daily",
			deliveryMode: "queue",
			time: "09:00",
			prompt: "Review priorities.",
		};
		const slot = dueCronSlot(daily, undefined, new Date(2026, 4, 13, 9, 5));
		assert.equal(slot, "daily-review:daily:2026-05-13T09:00");
		assert.equal(dueCronSlot(daily, { lastFiredSlot: slot }, new Date(2026, 4, 13, 9, 10)), undefined);
		assert.equal(
			dueCronSlot(daily, { lastFiredSlot: slot }, new Date(2026, 4, 14, 9, 0)),
			"daily-review:daily:2026-05-14T09:00",
		);
	});

	it("supports one-time, hourly, weekly, and monthly cron slots", () => {
		assert.equal(
			dueCronSlot(
				{
					id: "once",
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
					id: "hourly",
					enabled: true,
					frequency: "hourly",
					deliveryMode: "follow_up",
					minute: 15,
					prompt: "hourly",
				},
				undefined,
				new Date(2026, 4, 13, 10, 14),
			),
			"hourly:hourly:2026-05-13T09:15",
		);
		assert.equal(
			dueCronSlot(
				{
					id: "weekly",
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
			"weekly:weekly:2026-05-13T09:30",
		);
		assert.equal(
			dueCronSlot(
				{
					id: "monthly",
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
			"monthly:monthly:2026-04-30T20:00",
		);
	});
});
