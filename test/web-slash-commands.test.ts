import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	controlCommandCompletionQuery,
	matchingControlCommands,
	parseControlCommandText,
} from "../src/conversation/control-commands.js";
import { commandArgs } from "../src/web/payloads.js";

describe("web slash commands", () => {
	it("parses recognized slash command text", () => {
		assert.deepEqual(parseControlCommandText("/restart"), { command: "restart", args: "" });
		assert.deepEqual(parseControlCommandText("  /model anthropic/claude-opus-4-7  "), {
			command: "model",
			args: "anthropic/claude-opus-4-7",
		});
		assert.deepEqual(parseControlCommandText("/THINKING xhigh"), { command: "thinking", args: "xhigh" });
	});

	it("does not treat unknown or mid-sentence slashes as commands", () => {
		assert.equal(parseControlCommandText("/unknown"), undefined);
		assert.equal(parseControlCommandText("please /restart"), undefined);
	});

	it("matches completion candidates only while editing the command token", () => {
		assert.equal(controlCommandCompletionQuery("/re"), "re");
		assert.deepEqual(
			matchingControlCommands("/re").map((command) => command.name),
			["reload", "restart"],
		);
		assert.equal(controlCommandCompletionQuery("/model "), undefined);
	});

	it("passes raw control args through for web command posts", () => {
		assert.equal(commandArgs("model", "anthropic/claude-opus-4-7"), "anthropic/claude-opus-4-7");
		assert.equal(commandArgs("thinking", "xhigh"), "xhigh");
	});
});
