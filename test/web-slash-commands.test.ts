import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	WEB_SLASH_COMMANDS,
	matchingSlashCommands,
	parseWebSlashCommand,
	slashCommandCompletionQuery,
} from "../web/src/lib/slashCommands.js";
import { CONTROL_COMMANDS, parseControlCommandText } from "../src/conversation/control-commands.js";
import { commandArgs } from "../src/web/payloads.js";

describe("web slash commands", () => {
	it("reuses the canonical runtime command definitions", () => {
		assert.equal(WEB_SLASH_COMMANDS, CONTROL_COMMANDS);
		assert.equal(parseWebSlashCommand, parseControlCommandText);
	});

	it("parses recognized slash command text", () => {
		assert.deepEqual(parseWebSlashCommand("/restart"), { command: "restart", args: "" });
		assert.deepEqual(parseWebSlashCommand("  /model anthropic/claude-opus-4-7  "), {
			command: "model",
			args: "anthropic/claude-opus-4-7",
		});
		assert.deepEqual(parseWebSlashCommand("/THINKING xhigh"), { command: "thinking", args: "xhigh" });
	});

	it("does not treat unknown or mid-sentence slashes as commands", () => {
		assert.equal(parseWebSlashCommand("/unknown"), undefined);
		assert.equal(parseWebSlashCommand("please /restart"), undefined);
	});

	it("matches completion candidates only while editing the command token", () => {
		assert.equal(slashCommandCompletionQuery("/re"), "re");
		assert.deepEqual(
			matchingSlashCommands("/re").map((command) => command.name),
			["reload", "restart"],
		);
		assert.equal(slashCommandCompletionQuery("/model "), undefined);
	});

	it("passes raw control args through for web command posts", () => {
		assert.equal(commandArgs("model", "anthropic/claude-opus-4-7"), "anthropic/claude-opus-4-7");
		assert.equal(commandArgs("thinking", "xhigh"), "xhigh");
	});
});
