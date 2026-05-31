import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";

import { loadOwnerIdentity, ownerIdentityPath, saveOwnerIdentity } from "../src/owner-identity.js";
import { createTempDataDir } from "./helpers.js";

test("owner identity round-trips through persisted cache", async (t) => {
	const dataDir = await createTempDataDir(t);
	const identity = { botUserId: "bot-1", dmChannelId: "dm-1" };

	await saveOwnerIdentity(dataDir, identity);

	assert.deepEqual(await loadOwnerIdentity(dataDir), identity);
});

test("owner identity load returns null when cache is missing", async (t) => {
	const dataDir = await createTempDataDir(t);

	assert.equal(await loadOwnerIdentity(dataDir), null);
});

test("owner identity load returns null when cache is corrupt", async (t) => {
	const dataDir = await createTempDataDir(t);
	await writeFile(ownerIdentityPath(dataDir), "{ not json", "utf8");

	assert.equal(await loadOwnerIdentity(dataDir), null);
});

test("owner identity load returns null when cache shape is invalid", async (t) => {
	const dataDir = await createTempDataDir(t);
	await writeFile(ownerIdentityPath(dataDir), '{"botUserId":""}', "utf8");

	assert.equal(await loadOwnerIdentity(dataDir), null);
});
