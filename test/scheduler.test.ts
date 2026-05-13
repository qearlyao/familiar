import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildHeartbeatInjectionText,
	formatIdleDuration,
	formatLocalTimestamp,
	isHeartbeatDue,
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
});
