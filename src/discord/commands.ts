import {
	type ApplicationCommandData,
	type ApplicationCommandOptionChoiceData,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	ApplicationIntegrationType,
	type AutocompleteInteraction,
	ChannelType,
	type ChatInputCommandInteraction,
	type Client,
	InteractionContextType,
	MessageFlags,
} from "discord.js";

import type { FamiliarAgent } from "../agent.js";
import type { Config } from "../config.js";
import type { ConversationRuntime, InboundMessageInput } from "../runtime.js";
import { type EffectiveSetting, formatSetting } from "../settings.js";
import { normalizeOutboundText } from "./send.js";

export const FAMILIAR_COMMAND_NAME = "familiar";
const THINKING_CHOICES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const CHANNEL_TRIGGER_CHOICES = ["mention", "always"] as const;
export const EPHEMERAL_REPLY = MessageFlags.Ephemeral;

export function getFamiliarApplicationCommand(): ApplicationCommandData {
	const modelOption = {
		name: "model",
		description: "Provider/model id",
		type: ApplicationCommandOptionType.String,
		required: false,
		autocomplete: true,
	} as const;
	return {
		name: FAMILIAR_COMMAND_NAME,
		description: "Control Familiar",
		type: ApplicationCommandType.ChatInput,
		contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
		integrationTypes: [ApplicationIntegrationType.GuildInstall],
		options: [
			{
				name: "status",
				description: "Show Familiar status for this channel",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "stop",
				description: "Stop current work and clear the queue",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "new",
				description: "Start a fresh agent transcript for this channel",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "reload",
				description: "Reload persona prompt files and live agent settings",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "restart",
				description: "Restart Familiar if this runtime has a restart handler",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "compact",
				description: "Show compaction status",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "model",
				description: "Show or set the model for this channel",
				type: ApplicationCommandOptionType.Subcommand,
				options: [modelOption],
			},
			{
				name: "thinking",
				description: "Show or set thinking level for this channel",
				type: ApplicationCommandOptionType.Subcommand,
				options: [
					{
						name: "level",
						description: "Thinking level",
						type: ApplicationCommandOptionType.String,
						required: false,
						choices: THINKING_CHOICES.map((level) => ({ name: level, value: level })),
					},
				],
			},
			{
				name: "channel-trigger",
				description: "Show or set when Familiar responds in this channel",
				type: ApplicationCommandOptionType.Subcommand,
				options: [
					{
						name: "trigger",
						description: "Channel trigger policy",
						type: ApplicationCommandOptionType.String,
						required: false,
						choices: CHANNEL_TRIGGER_CHOICES.map((trigger) => ({ name: trigger, value: trigger })),
					},
				],
			},
		],
	};
}

export async function registerFamiliarApplicationCommand(client: Client<true>): Promise<void> {
	const command = getFamiliarApplicationCommand();
	const commands = await client.application.commands.fetch({ force: true });
	const existing = commands.find(
		(candidate) => candidate.name === FAMILIAR_COMMAND_NAME && candidate.type === ApplicationCommandType.ChatInput,
	);
	if (existing) {
		if (!existing.equals(command)) {
			await client.application.commands.edit(existing.id, command);
			console.log(`Updated Discord /${FAMILIAR_COMMAND_NAME} command`);
		}
		return;
	}
	await client.application.commands.create(command);
	console.log(`Registered Discord /${FAMILIAR_COMMAND_NAME} command`);
}

export function commandTextFromInteraction(interaction: ChatInputCommandInteraction): string {
	const subcommand = interaction.options.getSubcommand(true);
	if (subcommand === "model") {
		const model = interaction.options.getString("model");
		return model ? `/model ${model}` : "/model";
	}
	if (subcommand === "thinking") {
		const level = interaction.options.getString("level");
		return level ? `/thinking ${level}` : "/thinking";
	}
	if (subcommand === "channel-trigger") {
		const trigger = interaction.options.getString("trigger");
		return trigger ? `/channel-trigger ${trigger}` : "/channel-trigger";
	}
	return `/${subcommand}`;
}

export function inboundInputFromInteraction(interaction: ChatInputCommandInteraction): InboundMessageInput {
	return {
		messageId: interaction.id,
		authorId: interaction.user.id,
		authorName: interaction.user.username,
		text: commandTextFromInteraction(interaction),
		isBot: false,
		mentionedBot: true,
		remoteTimestamp: new Date(interaction.createdTimestamp || Date.now()).toISOString(),
	};
}

export async function replyEphemeral(interaction: ChatInputCommandInteraction, text: string): Promise<string[]> {
	const content = normalizeOutboundText(text);
	if (interaction.deferred || interaction.replied) {
		await interaction.editReply({ content });
	} else {
		await interaction.reply({ content, flags: EPHEMERAL_REPLY });
	}
	const reply = await interaction.fetchReply().catch(() => undefined);
	return reply?.id ? [reply.id] : [];
}

export async function replyInteractionError(interaction: ChatInputCommandInteraction, error: unknown): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	console.error("Discord interaction handling failed", error);
	await replyEphemeral(interaction, `I hit an error while handling that command.\n${message}`);
}

export function formatCommandResponse(
	command: "status" | "compact",
	runtime: ConversationRuntime,
	familiarAgent: FamiliarAgent,
	channelTrigger: EffectiveSetting<Config["discord"]["channelTrigger"]>,
): string {
	if (command === "status") {
		return [
			runtime.formatStatus(),
			`model: ${formatSetting(familiarAgent.getModel(runtime.channelKey))}`,
			`thinking: ${formatSetting(familiarAgent.getThinkingLevel(runtime.channelKey))}`,
			`channel_trigger: ${formatSetting(channelTrigger)}`,
		].join("\n");
	}
	return "Compact is not wired for this runtime yet. I logged the command, but I won't run lossy compaction here.";
}

export function getAutocompleteChoices(
	config: Config,
	interaction: AutocompleteInteraction,
): ApplicationCommandOptionChoiceData[] {
	if (interaction.commandName !== FAMILIAR_COMMAND_NAME) return [];
	const subcommand = interaction.options.getSubcommand(false);
	const focused = interaction.options.getFocused(true);
	const value = String(focused.value ?? "").toLowerCase();
	if (subcommand !== "model" || focused.name !== "model") return [];
	const candidates = config.models.allow.length > 0 ? config.models.allow : [config.agent.model];
	return [...new Set(candidates)]
		.filter((model) => !value || model.toLowerCase().includes(value))
		.slice(0, 25)
		.map((model) => ({ name: model, value: model }));
}

export function isAllowedInteractionChannel(
	config: Config,
	interaction: ChatInputCommandInteraction | AutocompleteInteraction,
): boolean {
	if (interaction.user.id !== config.discord.ownerId) return false;
	const channel = interaction.channel;
	if (!channel) return false;
	if (channel.type === ChannelType.DM) return true;
	return interaction.channelId ? config.discord.allowedChannels.includes(interaction.channelId) : false;
}
