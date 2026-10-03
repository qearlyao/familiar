import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createGeneratedMediaSink } from "../src/media/generated-media.js";
import { findKeptFile, listKeptFiles, removeKeptFile } from "../src/media/kept-files.js";
import { createSendFileTool } from "../src/media/send-file.js";
import type { WebAuth } from "../src/web/auth.js";
import { createWebRouteRegistry } from "../src/web/routes.js";
import { configWithDataDir, createTempDataDir, FakeResponse, jsonRequest } from "./helpers.js";

async function setup(t: Parameters<typeof configWithDataDir>[0]) {
	const config = await configWithDataDir(t, await createTempDataDir(t));
	const tool = createSendFileTool(config, createGeneratedMediaSink());
	return { config, tool };
}

async function get(config: Awaited<ReturnType<typeof setup>>["config"], path: string): Promise<FakeResponse> {
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

describe("kept files", () => {
	it("keeps documents sent with send_file on the library shelf", async (t) => {
		const { config, tool } = await setup(t);
		await mkdir(resolve(config.workspacePath, "out"), { recursive: true });
		await writeFile(resolve(config.workspacePath, "out", "notes.md"), "# hello", "utf8");

		await tool.execute("call", { path: "out/notes.md" });

		const [kept] = await listKeptFiles(config);
		assert.equal(kept?.name, "notes.md");
		assert.equal(kept?.mimeType, "text/markdown");
		assert.equal(kept?.source, "out/notes.md");
		assert.equal(kept?.size, 7);
		assert.match(kept!.url, /^\/api\/web\/library\/kept\/[a-f0-9]{12}\/notes\.md\?v=\d+$/);
		const found = await findKeptFile(config, kept!.id);
		assert.equal(await readFile(found!.path, "utf8"), "# hello");
	});

	it("replaces the kept copy when the same file is sent again", async (t) => {
		const { config, tool } = await setup(t);
		const source = resolve(config.workspacePath, "page.html");
		await writeFile(source, "<p>one</p>", "utf8");
		await tool.execute("call", { path: "page.html" });
		const [first] = await listKeptFiles(config);

		await writeFile(source, "<p>two, longer</p>", "utf8");
		await tool.execute("call", { path: "page.html", name: "final.html" });

		const files = await listKeptFiles(config);
		assert.equal(files.length, 1);
		assert.equal(files[0]?.id, first?.id);
		assert.equal(files[0]?.name, "final.html");
		assert.equal(files[0]?.createdAt, first?.createdAt);
		assert.ok(files[0]!.updatedAt > first!.updatedAt);
		assert.notEqual(files[0]?.url, first?.url);
		assert.equal(await readFile((await findKeptFile(config, first!.id))!.path, "utf8"), "<p>two, longer</p>");
	});

	it("leaves pictures and sounds to makings", async (t) => {
		const { config, tool } = await setup(t);
		await writeFile(resolve(config.workspacePath, "chart.png"), "png", "utf8");

		await tool.execute("call", { path: "chart.png" });

		assert.deepEqual(await listKeptFiles(config), []);
	});

	it("serves only the recorded file and removes entries", async (t) => {
		const { config, tool } = await setup(t);
		await writeFile(resolve(config.workspacePath, "report.txt"), "kept words", "utf8");
		await tool.execute("call", { path: "report.txt" });
		const [kept] = await listKeptFiles(config);

		const served = await get(config, kept!.url);
		assert.equal(served.statusCode, 200);
		assert.equal(served.headers?.["content-type"], "text/plain; charset=utf-8");
		assert.equal(served.body, "kept words");

		assert.equal((await get(config, `/api/web/library/kept/${kept!.id}/record.json`)).statusCode, 404);
		assert.equal((await get(config, `/api/web/library/kept/${kept!.id}/..%2Frecord.json`)).statusCode, 404);
		assert.equal((await get(config, "/api/web/library/kept/..%2F..%2Fx/report.txt")).statusCode, 404);

		assert.equal(await removeKeptFile(config, kept!.id), true);
		assert.equal(await removeKeptFile(config, kept!.id), false);
		assert.deepEqual(await listKeptFiles(config), []);
	});
});
