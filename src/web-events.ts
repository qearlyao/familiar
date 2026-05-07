import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import type { WebStreamEvent } from "./web-types.js";

export interface WebSocketClient {
	socket: Socket;
	channelKey?: string;
	authed: boolean;
}

export function encodeFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x81, payload.length]);
	} else if (payload.length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	return Buffer.concat([header, payload]);
}

export function decodeFrames(buffer: Buffer): { messages: string[]; remaining: Buffer; close: boolean } {
	const messages: string[] = [];
	let offset = 0;
	let close = false;
	while (offset + 2 <= buffer.length) {
		const first = buffer[offset];
		const second = buffer[offset + 1];
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let length = second & 0x7f;
		let headerLength = 2;
		if (length === 126) {
			if (offset + 4 > buffer.length) break;
			length = buffer.readUInt16BE(offset + 2);
			headerLength = 4;
		} else if (length === 127) {
			if (offset + 10 > buffer.length) break;
			const bigLength = buffer.readBigUInt64BE(offset + 2);
			if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
			length = Number(bigLength);
			headerLength = 10;
		}
		const maskLength = masked ? 4 : 0;
		const frameEnd = offset + headerLength + maskLength + length;
		if (frameEnd > buffer.length) break;
		const payloadStart = offset + headerLength + maskLength;
		const payload = Buffer.from(buffer.subarray(payloadStart, frameEnd));
		if (masked) {
			const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
			for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
		}
		if (opcode === 0x8) close = true;
		if (opcode === 0x1) messages.push(payload.toString("utf8"));
		offset = frameEnd;
	}
	return { messages, remaining: buffer.subarray(offset), close };
}

export function acceptWebSocket(request: IncomingMessage, socket: Socket): boolean {
	const key = request.headers["sec-websocket-key"];
	if (typeof key !== "string") {
		socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
		socket.destroy();
		return false;
	}
	const responseKey = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
	socket.write(
		[
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${responseKey}`,
			"",
			"",
		].join("\r\n"),
	);
	return true;
}

export function replayEvents(
	client: WebSocketClient,
	events: WebStreamEvent[],
	lastEventId: string | null | undefined,
	onReplayWindowLost: () => WebStreamEvent,
): void {
	if (!lastEventId) {
		client.authed = true;
		return;
	}
	const index = events.findIndex((event) => event.eventId === lastEventId);
	if (index < 0) {
		client.authed = true;
		client.socket.write(encodeFrame(JSON.stringify(onReplayWindowLost())));
		return;
	}
	client.authed = true;
	for (const event of events.slice(index + 1)) {
		client.socket.write(encodeFrame(JSON.stringify(event)));
	}
}
