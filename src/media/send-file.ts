import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { Config } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { mimeTypeForPath } from "../util/mime.js";
import { MAX_SENT_FILE_BYTES } from "./attachment-limits.js";
import type { GeneratedMediaSink } from "./generated-media.js";
import { ensureGeneratedAttachmentsDir } from "./generated-media.js";

const SEND_FILE_NOTICE_PREFIX = "File attached to your reply:";

const sendFileSchema = Type.Object(
	{
		path: Type.String({
			description: "The file to send. Workspace-relative, absolute, or ~/ paths.",
		}),
		name: Type.Optional(
			Type.String({ description: "Optional. The file name they see; defaults to the file's own name." }),
		),
	},
	{ additionalProperties: false },
);

type SendFileToolInput = Static<typeof sendFileSchema>;

interface SendFileToolDetails {
	localPath: string;
}

function attachmentKind(mimeType: string): NonNullable<StoredAttachment["kind"]> {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	return "file";
}

function resolveSourcePath(config: Config, rawPath: string): string {
	if (rawPath === "~" || rawPath.startsWith("~/")) return resolve(homedir(), rawPath.slice(2));
	return isAbsolute(rawPath) ? resolve(rawPath) : resolve(config.workspacePath, rawPath);
}

/** a display name that is only ever one plain path segment */
function safeFileName(raw: string): string {
	const cleaned = basename(raw.replace(/\\/g, "/"))
		.replace(/[\u0000-\u001f<>:"|?*]/g, "_")
		.trim();
	return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

export function createSendFileTool(
	config: Config,
	mediaSink: GeneratedMediaSink,
): AgentTool<typeof sendFileSchema, SendFileToolDetails> {
	return {
		name: "send_file",
		label: "send_file",
		description: "attach a file (html, pdf, slides, anything) to your reply. it's copied, so resend after edits.",
		parameters: sendFileSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input: SendFileToolInput) {
			const rawPath = input.path.trim();
			if (!rawPath) throw new Error("send_file path is required.");
			const sourcePath = resolveSourcePath(config, rawPath);
			const sourceStat = await stat(sourcePath).catch(() => undefined);
			if (!sourceStat?.isFile()) throw new Error(`send_file: no file at ${rawPath}`);
			if (sourceStat.size > MAX_SENT_FILE_BYTES) {
				throw new Error(
					`send_file: ${rawPath} is too large (${sourceStat.size} bytes, limit ${MAX_SENT_FILE_BYTES}).`,
				);
			}

			const name = safeFileName(input.name?.trim() || basename(sourcePath));
			const id = `file_${randomUUID()}`;
			// each send gets its own folder so the served URL ends in the file's real name
			const dir = resolve(await ensureGeneratedAttachmentsDir(config), id);
			await mkdir(dir, { recursive: true });
			const localPath = resolve(dir, name);
			await copyFile(sourcePath, localPath);
			const mimeType = mimeTypeForPath(name);
			mediaSink.add({
				id,
				name,
				kind: attachmentKind(mimeType),
				mimeType,
				size: sourceStat.size,
				localPath,
				toolName: "send_file",
			});
			return {
				content: [{ type: "text", text: `${SEND_FILE_NOTICE_PREFIX} ${name}` }],
				details: { localPath },
			};
		},
	};
}
