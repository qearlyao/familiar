import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOneBotUrl, createOneBotClient } from "../src/qq/onebot.js";

class FakeWebSocket extends EventTarget {
	static OPEN = 1;
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	readonly url: string;

	constructor(url: string) {
		super();
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}

	open(): void {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}

	receive(payload: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
	}

	static latest(): FakeWebSocket {
		const instance = FakeWebSocket.instances.at(-1);
		if (!instance) throw new Error("no FakeWebSocket instance");
		return instance;
	}

	static reset(): void {
		FakeWebSocket.instances = [];
	}
}

const WebSocketImpl = FakeWebSocket as unknown as typeof WebSocket;

function startClient(options: { onEvent?: (event: Record<string, unknown>) => void; accessToken?: string } = {}) {
	FakeWebSocket.reset();
	const client = createOneBotClient({
		wsUrl: "ws://127.0.0.1:3001",
		accessToken: options.accessToken,
		onEvent: options.onEvent ?? (() => {}),
		WebSocketImpl,
	});
	return client;
}

describe("onebot client", () => {
	it("appends access_token as a query parameter", () => {
		assert.equal(buildOneBotUrl("ws://h:3001", "s3cret/+"), "ws://h:3001?access_token=s3cret%2F%2B");
		assert.equal(buildOneBotUrl("ws://h:3001?a=b", "t"), "ws://h:3001?a=b&access_token=t");
		assert.equal(buildOneBotUrl("ws://h:3001"), "ws://h:3001");

		const client = startClient({ accessToken: "tok" });
		assert.equal(FakeWebSocket.latest().url, "ws://127.0.0.1:3001?access_token=tok");
		client.stop();
	});

	it("correlates action responses by echo and surfaces retcode errors raw", async (t) => {
		const client = startClient();
		t.after(() => client.stop());
		const socket = FakeWebSocket.latest();
		socket.open();

		const first = client.callAction<{ user_id: number }>("get_login_info");
		const second = client.callAction("send_private_msg", { user_id: 42, message: [] });
		const sent = socket.sent.map((raw) => JSON.parse(raw) as { action: string; echo: string; params: unknown });
		assert.deepEqual(
			sent.map((frame) => frame.action),
			["get_login_info", "send_private_msg"],
		);
		assert.notEqual(sent[0]?.echo, sent[1]?.echo);

		socket.receive({ status: "failed", retcode: 1400, message: "bad request", echo: sent[1]?.echo });
		socket.receive({ status: "ok", retcode: 0, data: { user_id: 10001 }, echo: sent[0]?.echo });

		assert.deepEqual(await first, { user_id: 10001 });
		await assert.rejects(second, /send_private_msg failed: retcode 1400 \(bad request\)/);
	});

	it("rejects actions while disconnected", async (t) => {
		const client = startClient();
		t.after(() => client.stop());
		await assert.rejects(client.callAction("get_login_info"), /socket is not connected/);
	});

	it("times out actions after 15s", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const client = startClient();
		t.after(() => client.stop());
		FakeWebSocket.latest().open();
		const pending = client.callAction("get_login_info");
		t.mock.timers.tick(15_000);
		await assert.rejects(pending, /get_login_info failed: timed out/);
	});

	it("dispatches message events and ignores meta events", async (t) => {
		const events: Record<string, unknown>[] = [];
		const client = startClient({ onEvent: (event) => events.push(event) });
		t.after(() => client.stop());
		const socket = FakeWebSocket.latest();
		socket.open();
		socket.receive({ post_type: "meta_event", meta_event_type: "heartbeat" });
		socket.receive({ post_type: "message", message_type: "private", message: [] });
		assert.equal(events.length, 1);
		assert.equal(events[0]?.message_type, "private");
	});

	it("reconnects with backoff after close, rejects in-flight actions, and stays down after stop", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const client = startClient();
		const socket = FakeWebSocket.latest();
		socket.open();
		const inflight = client.callAction("get_login_info");
		socket.close();
		await assert.rejects(inflight, /connection closed/);

		assert.equal(FakeWebSocket.instances.length, 1);
		t.mock.timers.tick(5_000);
		assert.equal(FakeWebSocket.instances.length, 2);
		FakeWebSocket.latest().close();
		t.mock.timers.tick(5_000);
		assert.equal(FakeWebSocket.instances.length, 2, "second retry doubles to 10s");
		t.mock.timers.tick(5_000);
		assert.equal(FakeWebSocket.instances.length, 3);

		client.stop();
		FakeWebSocket.latest().close();
		t.mock.timers.tick(120_000);
		assert.equal(FakeWebSocket.instances.length, 3, "no reconnect after stop");
	});
});
