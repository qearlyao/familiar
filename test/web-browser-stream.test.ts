import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { attachWebSocketBrowser, findBrowserStream } from "../src/web/browser-stream.js";
import { acceptWebSocket, decodeFrames, encodeFrame } from "../src/web/events.js";
import type { TestAfter } from "./helpers.js";

async function listen(t: TestAfter, server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	return (server.address() as AddressInfo).port;
}

/** Reads messages in order; a listener per read would miss two that arrive in one packet. */
function reader(socket: WebSocket): () => Promise<string> {
	const arrived: string[] = [];
	const waiting: ((message: string) => void)[] = [];
	socket.addEventListener("message", (event) => {
		const take = waiting.shift();
		if (take) take(String(event.data));
		else arrived.push(String(event.data));
	});
	return () =>
		new Promise((resolve) => {
			const message = arrived.shift();
			if (message === undefined) waiting.push(resolve);
			else resolve(message);
		});
}

const closed = (socket: WebSocket): Promise<void> =>
	new Promise((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));

describe("web browser stream", () => {
	it("finds the newest live session's stream port, and nothing when no browser is open", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "familiar-browser-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		assert.equal(await findBrowserStream(dir), undefined);
		assert.equal(await findBrowserStream(join(dir, "missing")), undefined);
		await writeFile(join(dir, "default.pid"), "4242");
		await writeFile(join(dir, "old.stream"), "1111");
		await writeFile(join(dir, "default.stream"), "2222\n");
		await utimes(join(dir, "old.stream"), new Date(1000), new Date(1000));
		assert.partialDeepStrictEqual(await findBrowserStream(dir), { session: "default", port: 2222 });
	});

	it("pipes frames down and input up, behind auth", async (t) => {
		// stands in for agent-browser's stream: greets with a frame, echoes what it is sent
		const upstream = createServer();
		upstream.on("upgrade", (request, raw) => {
			const socket = raw as Socket;
			// an upgraded socket has left the server's hands, so closing the server would not end it
			t.after(() => socket.destroy());
			assert.equal(request.url, "/?pacing=ack");
			acceptWebSocket(request, socket);
			socket.write(encodeFrame(JSON.stringify({ type: "frame", seq: 1 })));
			socket.on("data", (chunk: Buffer) => {
				for (const message of decodeFrames(chunk).messages) socket.write(encodeFrame(`echo:${message}`));
			});
		});
		let stream: { session: string; port: number } | undefined = { session: "main", port: await listen(t, upstream) };
		let authorized = true;
		const pageCommands: string[] = [];
		const server = createServer();
		attachWebSocketBrowser(server, {
			authorize: async () => authorized,
			findStream: async () => stream,
			// the page's real size, which the stream's own frames get wrong on a cloud browser
			viewport: async (session) => (session === "main" ? { width: 1536, height: 643 } : undefined),
			page: async (session, command) => {
				pageCommands.push(`${session}:${command.type}:${command.url ?? ""}`);
			},
		});
		const url = `ws://127.0.0.1:${await listen(t, server)}/api/web/browser`;

		const socket = new WebSocket(url);
		const next = reader(socket);
		const first = [await next(), await next()].sort();
		assert.deepEqual(first, ['{"type":"frame","seq":1}', '{"type":"viewport","width":1536,"height":643}']);
		socket.send('{"type":"input_mouse"}');
		assert.equal(await next(), 'echo:{"type":"input_mouse"}');
		// the address bar's asks stop here; the stream never hears them
		socket.send('{"type":"page_open","url":"https://example.com"}');
		socket.send('{"type":"input_keyboard"}');
		assert.equal(await next(), 'echo:{"type":"input_keyboard"}');
		assert.deepEqual(pageCommands, ["main:page_open:https://example.com"]);
		socket.close();

		authorized = false;
		await closed(new WebSocket(url));
		authorized = true;
		stream = undefined;
		await closed(new WebSocket(url));
	});
});
