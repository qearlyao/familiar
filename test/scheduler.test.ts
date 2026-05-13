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
		assert.equal(
			isHeartbeatDue({
				now: 60 * 60 * 1000,
				lastUserInteractionAt: 20 * 60 * 1000,
				lastHeartbeatAt: 50 * 60 * 1000,
				idleThresholdMs: 10 * 60 * 1000,
				intervalMs: 15 * 60 * 1000,
			}),
			false,
		);
		assert.equal(
			isHeartbeatDue({
				now: 60 * 60 * 1000,
				lastUserInteractionAt: 20 * 60 * 1000,
				lastHeartbeatAt: 35 * 60 * 1000,
				idleThresholdMs: 10 * 60 * 1000,
				intervalMs: 15 * 60 * 1000,
			}),
			true,
		);
	});

	it("treats interval as repeat cadence after the first idle-threshold fire", () => {
		const minute = 60 * 1000;
		assert.equal(
			isHeartbeatDue({
				now: 60 * minute,
				lastUserInteractionAt: 0,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			true,
		);
		assert.equal(
			isHeartbeatDue({
				now: 240 * minute,
				lastUserInteractionAt: 0,
				lastHeartbeatAt: 60 * minute,
				idleThresholdMs: 60 * minute,
				intervalMs: 240 * minute,
			}),
			false,
		);
		assert.equal(
			isHeartbeatDue({
				now: 300 * minute,
				lastUserInteractionAt: 0,
				lastHeartbeatAt: 60 * minute,
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
