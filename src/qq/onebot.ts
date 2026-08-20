const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const ACTION_TIMEOUT_MS = 15_000;

export interface OneBotClientOptions {
	wsUrl: string;
	accessToken?: string;
	onEvent: (event: Record<string, unknown>) => void;
	onOpen?: () => void;
	/** Test seam only; defaults to the platform WebSocket. */
	WebSocketImpl?: typeof WebSocket;
}

export interface OneBotClient {
	callAction<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
	stop(): void;
}

interface PendingAction {
	action: string;
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export function buildOneBotUrl(wsUrl: string, accessToken?: string): string {
	if (!accessToken) return wsUrl;
	return `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`;
}

export function createOneBotClient(options: OneBotClientOptions): OneBotClient {
	const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
	const url = buildOneBotUrl(options.wsUrl, options.accessToken);
	const pending = new Map<string, PendingAction>();
	let socket: WebSocket | undefined;
	let stopped = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let reconnectDelayMs = RECONNECT_MIN_MS;
	let nextEcho = 1;

	const failPending = (reason: string): void => {
		for (const [echo, entry] of pending) {
			pending.delete(echo);
			clearTimeout(entry.timer);
			entry.reject(new Error(`OneBot ${entry.action} failed: ${reason}`));
		}
	};

	const scheduleReconnect = (): void => {
		if (stopped || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, reconnectDelayMs);
		reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
	};

	const handleMessage = (raw: unknown): void => {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(String(raw)) as Record<string, unknown>;
		} catch {
			return;
		}
		if (typeof payload.echo === "string") {
			const entry = pending.get(payload.echo);
			if (!entry) return;
			pending.delete(payload.echo);
			clearTimeout(entry.timer);
			const retcode = Number(payload.retcode ?? -1);
			if (retcode !== 0) {
				const detail = [payload.message, payload.wording].filter(Boolean).join(" / ");
				entry.reject(new Error(`OneBot ${entry.action} failed: retcode ${retcode}${detail ? ` (${detail})` : ""}`));
				return;
			}
			entry.resolve(payload.data);
			return;
		}
		if (payload.post_type === undefined || payload.post_type === "meta_event") return;
		options.onEvent(payload);
	};

	const connect = (): void => {
		if (stopped) return;
		const ws = new WebSocketImpl(url);
		socket = ws;
		ws.addEventListener("open", () => {
			if (stopped || socket !== ws) return;
			reconnectDelayMs = RECONNECT_MIN_MS;
			options.onOpen?.();
		});
		ws.addEventListener("message", (event) => {
			if (socket === ws) handleMessage((event as MessageEvent).data);
		});
		ws.addEventListener("close", () => {
			if (socket !== ws) return;
			socket = undefined;
			failPending("connection closed");
			scheduleReconnect();
		});
		// A failed connect fires error then close; reconnect is handled on close.
		ws.addEventListener("error", () => {});
	};

	connect();

	return {
		callAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
			const ws = socket;
			if (!ws || ws.readyState !== WebSocketImpl.OPEN) {
				return Promise.reject(new Error(`OneBot ${action} failed: socket is not connected`));
			}
			const echo = String(nextEcho++);
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(echo);
					reject(new Error(`OneBot ${action} failed: timed out after ${ACTION_TIMEOUT_MS}ms`));
				}, ACTION_TIMEOUT_MS);
				pending.set(echo, { action, resolve: resolve as (data: unknown) => void, reject, timer });
				ws.send(JSON.stringify({ action, params, echo }));
			});
		},
		stop(): void {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			failPending("client stopped");
			socket?.close();
			socket = undefined;
		},
	};
}
