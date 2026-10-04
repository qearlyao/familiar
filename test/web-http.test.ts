import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { createWebRequestListener, HttpError, MAX_BODY_BYTES, readJsonBody, sendText } from "../src/web/http.js";
import { serveStatic } from "../src/web/static.js";
import { attachWebSocketStream } from "../src/web/stream.js";

it("rejects malformed URLs and contains request failures without losing the web server", async (t) => {
	const warnings = t.mock.method(console, "warn", () => {});
	const errors = t.mock.method(console, "error", () => {});
	const failure = new Error("private server detail");
	const server = createServer(
		createWebRequestListener(async (_request, response, url) => {
			if (url.pathname === "/fail") throw failure;
			if (url.pathname === "/partial") {
				response.writeHead(200);
				response.write("partial");
				throw failure;
			}
			if (await serveStatic(response, url.pathname)) return;
			sendText(response, 404, "Not found");
		}),
	);
	t.after(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	);
	const unused = () => assert.fail("malformed upgrades must not reach stream handlers");
	attachWebSocketStream(server, {
		authorize: unused,
		eventHub: undefined as never,
		getRuntime: unused,
		abort: unused,
		retry: unused,
		deleteLatest: unused,
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	const get = async (path: string) => {
		const response = await fetch(`http://127.0.0.1:${port}${path}`);
		return { status: response.status, body: await response.text() };
	};
	const raw = (head: string) =>
		new Promise<string>((resolve, reject) => {
			const socket = connect(port, "127.0.0.1", () => socket.write(`${head}\r\nHost: [\r\n\r\n`));
			let reply = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				reply += chunk;
			});
			socket.on("close", () => resolve(reply));
			socket.on("error", reject);
		});
	for (const path of ["/%", "/%GG", "/%E0%A4%A", "/api/web/attachments/%FF", "/api/web/books/assets/%"]) {
		assert.deepEqual(await get(path), { status: 400, body: "Malformed request URL" });
	}
	assert.match(await raw("GET / HTTP/1.1\r\nConnection: close"), /^HTTP\/1\.1 400 /);
	const upgrade = await raw("GET /api/web/stream HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket");
	assert.match(upgrade, /^HTTP\/1\.1 400 /);
	assert.deepEqual(await get("/fail?token=secret"), { status: 500, body: "Internal server error" });
	await assert.rejects(get("/partial"));
	assert.equal((await get("/")).status, 200);
	assert.equal((await get("/100%25")).status, 200);
	assert.equal(warnings.mock.calls.length, 6);
	assert.equal(errors.mock.calls.length, 2);
	assert.deepEqual(errors.mock.calls[0]?.arguments, ["Web request GET /fail failed", failure]);
});

function body(...parts: (Buffer | string)[]): AsyncIterable<Buffer | string> {
	return Readable.from(parts);
}

describe("readJsonBody", () => {
	it("parses a valid JSON body", async () => {
		assert.deepEqual(await readJsonBody(body('{"a":1}')), { a: 1 });
	});

	it("returns an empty object for an empty body", async () => {
		assert.deepEqual(await readJsonBody(body("")), {});
		assert.deepEqual(await readJsonBody(body("   ")), {});
	});

	it("rejects malformed JSON with a 400", async () => {
		await assert.rejects(readJsonBody(body("{not json")), (error: unknown) => {
			assert.ok(error instanceof HttpError);
			assert.equal(error.status, 400);
			return true;
		});
	});

	it("rejects an oversized body with a 413", async () => {
		const oversized = "a".repeat(MAX_BODY_BYTES + 1);
		await assert.rejects(readJsonBody(body(oversized)), (error: unknown) => {
			assert.ok(error instanceof HttpError);
			assert.equal(error.status, 413);
			return true;
		});
	});
});
