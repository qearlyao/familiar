import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDiscordClient, DISCORD_REST_REQUEST_TIMEOUT_MS } from "../src/discord/client.js";

describe("discord client", () => {
	it("uses a REST timeout long enough for generated media uploads", () => {
		const client = createDiscordClient();
		try {
			assert.equal(client.options.rest?.timeout, DISCORD_REST_REQUEST_TIMEOUT_MS);
		} finally {
			client.destroy();
		}
	});
});
