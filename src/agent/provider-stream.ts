import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config/index.js";
import { resolveOpenRouterRouting } from "../models/openrouter-routing.js";
import { modelRuntimeEnv } from "../models/runtime.js";
import { normalizeProviderPayload } from "./payload-normalizers.js";
import { buildAnthropicMetadata } from "./session-helpers.js";
import { normalizeToolNameStream } from "./tool-name-compat.js";
import { writePayloadLog } from "./transcript-log.js";

const PROVIDER_MAX_RETRIES = 2;
const PROVIDER_MAX_RETRY_DELAY_MS = 60_000;

/** one session's path to the provider: normalizes and logs each request, logs response metadata,
    and maps tool names the model echoes back onto the declared ones */
export function createProviderStreamFn(
	config: Config,
	modelRuntime: ModelRuntime,
	session: { sessionId: string; sessionKey: string },
): StreamFn {
	const { sessionId, sessionKey } = session;
	return (streamModel, context, options) => {
		const stream = modelRuntime.streamSimple(streamModel, context, {
			...options,
			env: modelRuntimeEnv(config, streamModel),
			metadata: buildAnthropicMetadata(config, streamModel),
			cacheRetention: config.agent.cacheRetention,
			maxRetries: options?.maxRetries ?? PROVIDER_MAX_RETRIES,
			maxRetryDelayMs: options?.maxRetryDelayMs ?? PROVIDER_MAX_RETRY_DELAY_MS,
			onPayload: (payload, payloadModel) => {
				const routing = resolveOpenRouterRouting(config, payloadModel);
				const requestPayload = normalizeProviderPayload(payload, payloadModel, routing);
				writePayloadLog(config, {
					ts: new Date().toISOString(),
					direction: "request",
					sessionId,
					sessionKey,
					model: payloadModel.id,
					payload: requestPayload,
				});
				return requestPayload;
			},
			onResponse: (response, responseModel) => {
				writePayloadLog(config, {
					ts: new Date().toISOString(),
					direction: "response_meta",
					sessionId,
					sessionKey,
					model: responseModel.id,
					status: response.status,
					headers: response.headers,
				});
			},
		});
		return normalizeToolNameStream(stream, getCurrentTools(context.messages));
	};
}
