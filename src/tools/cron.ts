import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { manageCron } from "../config/cron.js";
import { CRON_DELIVERY_MODES, CRON_FREQUENCIES } from "../config/enums.js";
import type { Config } from "../config/types.js";

const schema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("delete"),
		]),
		name: Type.Optional(
			Type.String({ description: "which job to update or delete. create reads job.name instead." }),
		),
		job: Type.Optional(
			Type.Object(
				{
					name: Type.Optional(
						Type.String({
							description: "letters, numbers, and . _ = -. required on create, fixed after.",
						}),
					),
					prompt: Type.Optional(Type.String()),
					enabled: Type.Optional(Type.Boolean()),
					frequency: Type.Optional(Type.Enum(CRON_FREQUENCIES)),
					deliveryMode: Type.Optional(
						Type.Enum(CRON_DELIVERY_MODES, {
							description: "follow_up folds into a turn already running, else behaves as queue.",
						}),
					),
					runAt: Type.Optional(
						Type.String({
							description: "iso timestamp with offset, or YYYY-MM-DD HH:MM server time.",
						}),
					),
					time: Type.Optional(Type.String({ description: "HH:MM server time." })),
					minute: Type.Optional(Type.Integer({ minimum: 0, maximum: 59 })),
					weekday: Type.Optional(Type.Integer({ minimum: 0, maximum: 6, description: "0=sunday." })),
					day: Type.Optional(
						Type.Integer({
							minimum: 1,
							maximum: 31,
							description: "clamped to month end.",
						}),
					),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export function createCronTool(config: Config): AgentTool<typeof schema> {
	return {
		name: "cron",
		label: "Manage cron jobs",
		description:
			'schedule prompts to fire back at you later. update patches the stored job — send just what changes. a fire delayed by downtime arrives marked missed="4h 20m" so you know how late you are.',
		parameters: schema,
		async execute(_toolCallId, input) {
			const snapshot = await manageCron(config, input);
			// echo the stored job back so the model sees the defaults it left out; the rest is an ack
			const name = input.name ?? input.job?.name;
			// timezone left out: user messages already carry it
			const result =
				input.action === "list"
					? { jobs: snapshot.jobs, state: snapshot.state }
					: (snapshot.jobs.find((job) => job.name === name) ?? { deleted: name });
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}
