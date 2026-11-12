import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpHub } from "../tools/mcp.js";
import { acceptWebSocket, decodeFrames, encodeFrame } from "./events.js";
import { parseRequestUrl } from "./http.js";

export const WEB_BROWSER_PATH = "/api/web/browser";

/** Where agent-browser keeps its per-session files; the same lookup order as its CLI. */
function agentBrowserDir(): string {
	const { AGENT_BROWSER_SOCKET_DIR, XDG_RUNTIME_DIR } = process.env;
	if (AGENT_BROWSER_SOCKET_DIR) return AGENT_BROWSER_SOCKET_DIR;
	return XDG_RUNTIME_DIR ? join(XDG_RUNTIME_DIR, "agent-browser") : join(homedir(), ".agent-browser");
}

export type BrowserStream = { session: string; port: number };
export type BrowserViewport = { width: number; height: number };

/**
 * agent-browser writes `<session>.stream`, the port of its localhost viewport stream, while that
 * session's browser is open. Reading the file keeps this passive: asking the CLI would launch a browser.
 */
export async function findBrowserStream(dir = agentBrowserDir()): Promise<BrowserStream | undefined> {
	let newest: (BrowserStream & { mtime: number }) | undefined;
	for (const name of await readdir(dir).catch(() => [] as string[])) {
		if (!name.endsWith(".stream")) continue;
		const path = join(dir, name);
		const found = await Promise.all([readFile(path, "utf8"), stat(path)]).catch(() => undefined);
		if (!found) continue;
		const port = Number(found[0]);
		const mtime = found[1].mtimeMs;
		if (Number.isInteger(port) && port > 0 && (!newest || mtime > newest.mtime))
			newest = { session: name.slice(0, -".stream".length), port, mtime };
	}
	return newest;
}

/** One of agent-browser's tools on the server the agent already has connected. */
function browserTool(mcp: McpHub, name: string) {
	const named = new RegExp(`agent[_-]browser.*${name}$`);
	return mcp
		.servers()
		.flatMap((server) => (server.status === "connected" ? server.tools : []))
		.find((tool) => named.test(tool.name));
}

/**
 * The page's real size, asked through the browser tools already connected. The stream itself reports
 * the size agent-browser asked for, which a cloud browser ignores, and clicks land by the real one.
 * It has to go through the connected server: the CLI from here, without that server's env, relaunches the browser.
 */
export async function browserViewport(mcp: McpHub, session: string): Promise<BrowserViewport | undefined> {
	const result = await browserTool(mcp, "eval")?.execute("browser-viewport", {
		script: "innerWidth + 'x' + innerHeight",
		session,
	});
	const text = result?.content.map((part) => (part.type === "text" ? part.text : "")).join(" ") ?? "";
	const size = /(\d+)x(\d+)/.exec(text);
	return size ? { width: Number(size[1]), height: Number(size[2]) } : undefined;
}

export type BrowserPageCommand = { type: string; url?: unknown };

const PAGE_SCRIPTS: Record<string, string> = {
	page_back: "history.back()",
	page_forward: "history.forward()",
	page_reload: "location.reload()",
};

/** What the viewer's address bar asks for; the stream only carries pointer and keys, so these go through the tools too. */
export async function browserPageCommand(mcp: McpHub, session: string, command: BrowserPageCommand): Promise<void> {
	if (command.type === "page_open") {
		if (typeof command.url !== "string" || !/^https?:\/\//i.test(command.url)) return;
		await browserTool(mcp, "open")?.execute("browser-page", { url: command.url, session });
		return;
	}
	const script = PAGE_SCRIPTS[command.type];
	if (script) await browserTool(mcp, "eval")?.execute("browser-page", { script, session });
}

function refuse(socket: Socket, status: string): void {
	if (socket.destroyed) return;
	socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
	socket.destroy();
}

/** Pipes the WebUI to the live browser's stream: frames come down, clicks and keys go up. */
export function attachWebSocketBrowser(
	server: Server,
	options: {
		authorize(request: IncomingMessage, pathname: string): Promise<boolean>;
		viewport?: (session: string) => Promise<BrowserViewport | undefined>;
		page?: (session: string, command: BrowserPageCommand) => Promise<void>;
		findStream?: () => Promise<BrowserStream | undefined>;
	},
): void {
	const findStream = options.findStream ?? findBrowserStream;
	server.on("upgrade", (request, rawSocket) => {
		const socket = rawSocket as Socket;
		// The stream listener answers malformed upgrades.
		const url = parseRequestUrl(request);
		if (url?.pathname !== WEB_BROWSER_PATH) return;
		void options
			.authorize(request, url.pathname)
			.then(async (authorized) => {
				if (!authorized) return refuse(socket, "401 Unauthorized");
				const stream = await findStream();
				if (!stream) return refuse(socket, "404 Not Found");
				// ack pacing: one frame in flight, so a slow phone never drains a backlog of stale pages
				const upstream = new WebSocket(`ws://127.0.0.1:${stream.port}/?pacing=ack`);
				let accepted = false;
				upstream.addEventListener("close", () => (accepted ? socket.destroy() : refuse(socket, "502 Bad Gateway")));
				upstream.addEventListener("message", (event) => {
					if (typeof event.data === "string") socket.write(encodeFrame(event.data));
				});
				upstream.addEventListener("open", () => {
					if (socket.destroyed || !acceptWebSocket(request, socket)) return upstream.close();
					accepted = true;
					socket.setNoDelay(true);
					void options
						.viewport?.(stream.session)
						.then((size) => {
							if (size && !socket.destroyed)
								socket.write(encodeFrame(JSON.stringify({ type: "viewport", ...size })));
						})
						.catch((error) => console.error("Web browser viewport lookup failed", error));
					let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
					socket.on("data", (chunk: Buffer) => {
						try {
							const decoded = decodeFrames(Buffer.concat([frameBuffer, chunk]));
							frameBuffer = decoded.remaining;
							for (const raw of decoded.messages) {
								const message = JSON.parse(raw) as { type?: unknown };
								// page_* is ours; everything else is the stream's own vocabulary
								if (typeof message.type !== "string" || !message.type.startsWith("page_")) upstream.send(raw);
								else
									void options
										.page?.(stream.session, message as BrowserPageCommand)
										.catch((error) => console.error("Web browser page command failed", error));
							}
							if (decoded.close) socket.destroy();
						} catch {
							socket.destroy();
						}
					});
					socket.on("close", () => upstream.close());
					socket.on("error", () => upstream.close());
				});
			})
			.catch((error) => {
				console.error("Web browser stream failed", error);
				refuse(socket, "502 Bad Gateway");
			});
	});
}
