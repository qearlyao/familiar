import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { createGeneratedMediaSink, generatedAttachmentsDir, publicAttachmentPath } from "../src/media/generated-media.js";
import { createSendFileTool, sentFileMimeType } from "../src/media/send-file.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

async function setup(t: Parameters<typeof configWithDataDir>[0]) {
	const config = await configWithDataDir(t, await createTempDataDir(t));
	const sink = createGeneratedMediaSink();
	return { config, sink, tool: createSendFileTool(config, sink) };
}

describe("send_file tool", () => {
	it("copies a workspace file into generated attachments and queues it", async (t) => {
		const { config, sink, tool } = await setup(t);
		await mkdir(resolve(config.workspacePath, "out"), { recursive: true });
		await writeFile(resolve(config.workspacePath, "out", "deck.pptx"), "slides", "utf8");

		const result = await tool.execute("call", { path: "out/deck.pptx" });

		const [attachment] = sink.drain();
		assert.equal(attachment?.name, "deck.pptx");
		assert.equal(attachment?.kind, "file");
		assert.equal(attachment?.toolName, "send_file");
		assert.equal(attachment?.size, 6);
		assert.equal(
			attachment?.mimeType,
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		);
		assert.ok(attachment?.localPath?.startsWith(generatedAttachmentsDir(config)));
		assert.equal(await readFile(attachment!.localPath!, "utf8"), "slides");
		assert.match(publicAttachmentPath(config, attachment!.localPath!), /^\/api\/web\/attachments\/file_[^/]+\/deck\.pptx$/);
		assert.deepEqual(result.content, [{ type: "text", text: "Sent file attachment: deck.pptx" }]);
	});

	it("renames with a single safe path segment", async (t) => {
		const { config, sink, tool } = await setup(t);
		await writeFile(resolve(config.workspacePath, "chart.svg"), "<svg/>", "utf8");

		await tool.execute("call", { path: "chart.svg", name: "../../evil/report.svg" });

		const [attachment] = sink.drain();
		assert.equal(attachment?.name, "report.svg");
		assert.equal(attachment?.kind, "image");
		assert.ok(attachment?.localPath?.startsWith(generatedAttachmentsDir(config)));
	});

	it("rejects missing files and directories", async (t) => {
		const { config, sink, tool } = await setup(t);
		await mkdir(resolve(config.workspacePath, "folder"), { recursive: true });

		await assert.rejects(() => tool.execute("call", { path: "nope.html" }), /no file at nope\.html/);
		await assert.rejects(() => tool.execute("call", { path: "folder" }), /no file at folder/);
		assert.deepEqual(sink.drain(), []);
	});

	it("maps unknown extensions to octet-stream", () => {
		assert.equal(sentFileMimeType("page.HTML"), "text/html");
		assert.equal(sentFileMimeType("blob.bin"), "application/octet-stream");
	});
});
