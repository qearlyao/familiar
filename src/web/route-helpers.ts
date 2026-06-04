import { isRecord } from "../util/guards.js";

export function getChannelKeyFromRequest(url: URL, body?: unknown): string | undefined {
	const queryKey = url.searchParams.get("channelKey");
	if (queryKey) return queryKey;
	if (isRecord(body) && typeof body.channelKey === "string") return body.channelKey;
	return undefined;
}
