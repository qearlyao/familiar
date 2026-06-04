import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "../config/index.js";
import type { WebAuth } from "./auth.js";
import { errorMessage } from "./errors.js";
import { HttpError, sendJson } from "./http.js";
import { serveAttachment } from "./static.js";

export type WebRoute = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>;
export type RegisterWebRoute = (method: string, pathname: string, handler: WebRoute) => void;

export interface WebRouteRegistry {
	route: RegisterWebRoute;
	handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
}

export function createWebRouteRegistry(config: Config, auth: WebAuth): WebRouteRegistry {
	const webRoutes = new Map<string, WebRoute>();
	const route = (method: string, pathname: string, handler: WebRoute): void => {
		webRoutes.set(`${method} ${pathname}`, handler);
	};

	const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
		if (!url.pathname.startsWith("/api/web/")) return false;
		if (!(await auth.authorize(request, url.pathname))) {
			sendJson(response, 401, { error: "unauthorized" });
			return true;
		}
		try {
			if (request.method === "GET" && url.pathname.startsWith("/api/web/attachments/")) {
				return serveAttachment(config, response, url.pathname, request.headers.range);
			}
			const handler = webRoutes.get(`${request.method} ${url.pathname}`);
			// await is load-bearing: it keeps handler rejections inside this try so the catch maps HttpError to a status.
			if (handler) {
				await handler(request, response, url);
				return true;
			}
			sendJson(response, 404, { error: "not found" });
			return true;
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			const message = errorMessage(error);
			sendJson(response, status, { error: message });
			return true;
		}
	};

	return { route, handleApi };
}
