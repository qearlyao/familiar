import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { Model, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProviderStreamFn } from "../src/agent/provider-stream.js";
import { flushPayloadLog, writePayloadLog } from "../src/agent/transcript-log.js";
import { configWithDataDir, createTempDataDir, type TestAfter } from "./helpers.js";

const model = { id: "test-model", provider: "test", api: "openai-completions" } as Model<any>;

async function readPayloadRecords(dataDir: string): Promise<Record<string, unknown>[]> {
	await flushPayloadLog();
	const dir = resolve(dataDir, "payloads");
	const files = await readdir(dir).catch(() => [] as string[]);
	const lines: Record<string, unknown>[] = [];
	for (const file of files.sort()) {
		const text = await readFile(resolve(dir, file), "utf8");
		for (const line of text.split("\n")) if (line) lines.push(JSON.parse(line));
	}
	return lines;
}

// a runtime that only fires the payload and response hooks, the way a real request would
function fakeRuntime(payload: unknown): ModelRuntime {
	return {
		streamSimple: (_model: Model<any>, _context: unknown, options: Record<string, any>) => {
			options.onPayload(payload, model);
			options.onResponse({ status: 200, headers: { "x-request-id": "r1" } }, model);
			const stream = createAssistantMessageEventStream();
			stream.end();
			return stream;
		},
	} as unknown as ModelRuntime;
}

async function sendThroughProviderStream(t: TestAfter, enabled: boolean): Promise<Record<string, unknown>[]> {
	const dataDir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dataDir, { data: { payloads: { enabled } } });
	const streamFn = createProviderStreamFn(config, fakeRuntime({ messages: [] }), {
		sessionId: "s1",
		sessionKey: "discord:1",
	});
	await streamFn(model, { messages: [] } as unknown as TranscriptContext, {});
	return readPayloadRecords(dataDir);
}

describe("payload log", () => {
	it("logs only response metadata while payload logs are off", async (t) => {
		const records = await sendThroughProviderStream(t, false);

		assert.deepEqual(
			records.map((record) => record.direction),
			["response_meta"],
		);
	});

	it("logs the request too once payload logs are on", async (t) => {
		const records = await sendThroughProviderStream(t, true);

		assert.deepEqual(
			records.map((record) => record.direction),
			["request", "response_meta"],
		);
	});

	it("replaces base64 blobs with a fingerprint and keeps everything else", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const image = Buffer.alloc(3000, 7).toString("base64");
		const prose = "a long system prompt ".repeat(100);
		const payload = {
			system: prose,
			messages: [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: image } },
				{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
				{ type: "text", text: "short" },
			],
		};

		writePayloadLog(config, { direction: "request", payload });
		const [record] = await readPayloadRecords(dataDir);

		const logged = record?.payload as typeof payload;
		assert.equal(logged.system, prose);
		assert.match(
			(logged.messages[0] as { source: { data: string } }).source.data,
			/^\[base64 3000 bytes sha256:[0-9a-f]{12}\]$/,
		);
		assert.match(
			(logged.messages[1] as { image_url: { url: string } }).image_url.url,
			/^data:image\/jpeg;base64,\[base64 3000 bytes sha256:[0-9a-f]{12}\]$/,
		);
		assert.deepEqual(logged.messages[2], { type: "text", text: "short" });
		// the caller's payload is what goes on the wire, so it must stay untouched
		assert.equal(payload.messages[0]?.source?.data, image);
	});

	it("writes records in the order they were queued", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);

		for (let index = 0; index < 20; index++) writePayloadLog(config, { index });
		const records = await readPayloadRecords(dataDir);

		assert.deepEqual(
			records.map((record) => record.index),
			Array.from({ length: 20 }, (_, index) => index),
		);
	});
});
