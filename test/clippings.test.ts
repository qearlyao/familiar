import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { ensureGeneratedAttachmentsDir, publicAttachmentPath } from "../src/media/generated-media.js";
import type { WebAuth } from "../src/web/auth.js";
import { clippingSpan, editClipping, keepClipping, listClippings, removeClipping } from "../src/web/clippings.js";
import { createWebRouteRegistry } from "../src/web/routes.js";
import type { WebMessage } from "../src/web/types.js";
import { clippingQuote, clippingQuoteCitation, QUOTE_CHARS, QUOTE_MESSAGE_CHARS } from "../web/src/lib/clippingQuote.js";
import { configWithDataDir, createTempDataDir, FakeResponse, jsonRequest } from "./helpers.js";

type TestConfig = Awaited<ReturnType<typeof configWithDataDir>>;

async function get(config: TestConfig, path: string): Promise<FakeResponse> {
	const registry = createWebRouteRegistry(config, { authorize: async () => true } as unknown as WebAuth);
	const response = new FakeResponse();
	const finished = new Promise<void>((done) => {
		const end = response.end.bind(response);
		response.end = (chunk?: string | Buffer) => {
			end(chunk);
			done();
		};
	});
	await registry.handleApi(jsonRequest({}, "GET"), response as unknown as ServerResponse, new URL(`http://localhost${path}`));
	await finished;
	return response;
}

function message(id: string, extra: Partial<WebMessage> = {}): WebMessage {
	return { id, role: "assistant", who: "them", text: id, ts: 1, ...extra };
}

describe("clippings", () => {
	it("keeps the span between two messages with thoughts and without tool calls", () => {
		const messages = [
			message("a"),
			message("b", {
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
				tools: [{ id: "t", name: "bash", status: "completed" }],
				steps: [
					{ kind: "thinking", id: "s1", text: "hm", startedAt: 0 },
					{ kind: "tool", id: "t", tool: { id: "t", name: "bash", status: "completed" } },
					{ kind: "text", id: "s2", text: "hello" },
				],
			}),
			message("c"),
			message("d"),
		];

		// either order names the same span
		const span = clippingSpan(messages, "c", "b");

		assert.deepEqual(span?.map((kept) => kept.id), ["b", "c"]);
		assert.deepEqual(span?.[0]?.steps?.map((step) => step.kind), ["thinking", "text"]);
		assert.equal(span?.[0]?.tools, undefined);
		assert.equal(span?.[0]?.usage, undefined);
		assert.equal(clippingSpan(messages, "a", "gone"), undefined);
	});

	it("copies media in, serves only its own files, and lets go", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const picture = resolve(await ensureGeneratedAttachmentsDir(config), "sketch.png");
		await writeFile(picture, "png bytes", "utf8");
		const remote = "https://cdn.example/elsewhere.png";

		const kept = await keepClipping(
			config,
			[
				message("a", {
					attachments: [
						{ id: "1", name: "sketch.png", url: publicAttachmentPath(config, picture) },
						{ id: "2", name: "gone.png", url: "/api/web/attachments/gone.png" },
						{ id: "3", name: "elsewhere.png", url: remote },
					],
				}),
			],
			"  this one  ",
		);

		assert.equal(kept.note, "this one");
		const [copied, gone, elsewhere] = kept.messages[0]!.attachments!;
		assert.equal(copied?.url, `/api/web/library/clippings/${kept.id}/0.png`);
		assert.equal(gone?.url, undefined);
		assert.equal(elsewhere?.url, remote);
		// what comes back off disk is what was returned, less the fields json drops
		assert.deepEqual(await listClippings(config), [JSON.parse(JSON.stringify(kept))]);

		const served = await get(config, copied!.url!);
		assert.equal(served.statusCode, 200);
		assert.equal(served.body, "png bytes");
		assert.equal((await get(config, `/api/web/library/clippings/${kept.id}/..%2Fclipping.json`)).statusCode, 404);
		assert.equal((await get(config, `/api/web/library/clippings/${kept.id}/clipping.json`)).statusCode, 404);
		assert.equal((await get(config, "/api/web/library/clippings/..%2F..%2Fx/0.png")).statusCode, 404);

		// a title and a line of your own can be set later, and cleared by emptying them
		assert.equal((await editClipping(config, kept.id, { title: " pastry " }))?.title, "pastry");
		const edited = await editClipping(config, kept.id, { note: "" });
		assert.equal(edited?.title, "pastry");
		assert.equal(edited?.note, undefined);
		assert.deepEqual((await listClippings(config))[0]?.messages, JSON.parse(JSON.stringify(kept.messages)));
		assert.equal(await editClipping(config, "ffffffffffff", { title: "x" }), undefined);

		assert.equal(await removeClipping(config, kept.id), true);
		assert.equal(await removeClipping(config, kept.id), false);
		assert.deepEqual(await listClippings(config), []);
	});
});

describe("clipping quote", () => {
	const turn = (id: string, who: string, text: string, role: "user" | "assistant" = "assistant") => ({
		id,
		role,
		who,
		ts: Date.UTC(2026, 10, 3, 12),
		steps: [
			{ kind: "thinking" as const, id: `${id}-t`, text: "private", startedAt: 0 },
			{ kind: "text" as const, id: `${id}-x`, text },
		],
	});

	it("quotes what was said, one line a turn, without thoughts", () => {
		const quote = clippingQuote([turn("a", "you", "hi\nthere", "user"), turn("b", "june", "hello")]);
		const lines = quote.split("\n>\n");

		assert.deepEqual(lines.slice(0, 2), ["> you: hi there", "> june: hello"]);
		assert.match(lines[2]!, /^> — .*2026/);
		assert.doesNotMatch(quote, /private/);
		// the chat folds the quote behind its last line; an ordinary quote has no such line
		assert.match(clippingQuoteCitation(quote.replace(/^> ?/gm, "")) ?? "", /^kept from .*2026$/);
		assert.equal(clippingQuoteCitation("just a quoted line\n— a person"), undefined);
	});

	it("trims a long turn and stops at the whole-quote limit", () => {
		const long = "x".repeat(QUOTE_MESSAGE_CHARS + 50);
		const quote = clippingQuote(Array.from({ length: 12 }, (_, index) => turn(`m${index}`, "june", long)));
		const lines = quote.split("\n>\n");

		assert.equal(lines[0], `> june: ${"x".repeat(QUOTE_MESSAGE_CHARS)}…`);
		assert.equal(lines.at(-2), "> …");
		assert.ok(quote.length < QUOTE_CHARS + 100);
	});
});
