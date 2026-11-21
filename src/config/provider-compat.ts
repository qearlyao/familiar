import { CompatSchemasByApi, type ProviderCompat } from "@earendil-works/pi-ai/providers/compat-schema";
import { compile, type Validator } from "@earendil-works/pi-schema";
import { assertKnownKeys, readConfigTable } from "./readers.js";

type CompatApi = keyof typeof CompatSchemasByApi;

interface CompatReader {
	/** snake_case config key -> pi's camelCase compat field */
	fields: Map<string, string>;
	validator: Validator;
}

const readers = new Map<string, CompatReader>();

function toSnakeCase(key: string): string {
	return key
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase();
}

function isCompatApi(api: string): api is CompatApi {
	return Object.hasOwn(CompatSchemasByApi, api);
}

function compatReader(api: CompatApi): CompatReader {
	let reader = readers.get(api);
	if (!reader) {
		const schema = CompatSchemasByApi[api];
		const fields = new Map(Object.keys(schema.properties as object).map((field) => [toSnakeCase(field), field]));
		reader = { fields, validator: compile(schema) };
		readers.set(api, reader);
	}
	return reader;
}

/**
 * Reads a custom provider's `compat` table against pi's compat schema for its wire protocol.
 * Top-level keys are pi's field names in snake_case; nested values pass through as pi expects them.
 */
export function readProviderCompat(value: unknown, path: string, api: string | undefined): ProviderCompat | undefined {
	if (value === undefined) return undefined;
	const table = readConfigTable(value, path);
	if (api === undefined) throw new Error(`Config value ${path} needs the provider's api to be set`);
	if (!isCompatApi(api)) throw new Error(`Config value ${path} is not supported for api "${api}"`);
	const { fields, validator } = compatReader(api);
	assertKnownKeys(table, path, [...fields.keys()]);
	const compat = Object.fromEntries(Object.entries(table).map(([key, entry]) => [fields.get(key), entry]));
	const result = validator.validate(compat);
	if (!result.ok) {
		const [error] = result.errors;
		const [field = "", ...rest] = error.path.split("/").slice(1);
		const where = [toSnakeCase(field), ...rest].filter(Boolean).join(".");
		throw new Error(`Config value ${path}${where ? `.${where}` : ""} is invalid: ${error.message}`);
	}
	return compat as ProviderCompat;
}
