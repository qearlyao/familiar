import { registerImagesApiProvider } from "@earendil-works/pi-ai/compat";

import { generateImages as generateGoogleImages } from "./google-images.js";
import { generateImages as generateOpenAIImages } from "./openai-images.js";

/**
 * Image APIs beyond the one pi-ai ships. pi-ai dispatches `generateImages`
 * through this registry keyed on `model.api`, so registering here is all it
 * takes for `image_gen` to reach a provider's native image endpoint —
 * `image_gen.apis` picks the wire style per provider, and the existing
 * `models.base_urls` / `models.api_key_envs` tables supply the endpoint and
 * credentials, custom deployments included.
 */
export function registerImageApis(): void {
	registerImagesApiProvider({ api: "openai-images", generateImages: generateOpenAIImages });
	registerImagesApiProvider({ api: "google-images", generateImages: generateGoogleImages });
}
