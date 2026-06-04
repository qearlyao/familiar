import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

import sharp from "sharp";
import type { Config } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { attachmentsDir } from "./generated-media.js";

type DerivedImage = NonNullable<NonNullable<StoredAttachment["derived"]>["image"]>;

export const MAX_INLINE_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;

const DERIVED_IMAGE_MIME_TYPE = "image/webp";
const DERIVED_IMAGE_EXTENSION = ".webp";
const DERIVED_IMAGE_MAX_EDGE = 1600;
const DERIVED_IMAGE_QUALITY_STEPS = [82, 72, 62, 52] as const;
const DERIVED_IMAGE_EDGE_STEPS = [1600, 1400, 1200, 1000, 800, 640] as const;

interface ImageDerivativeSource {
	name: string;
	mimeType?: string;
	localPath?: string;
	size?: number;
	sha256?: string;
	derived?: StoredAttachment["derived"];
}

function safeDerivedStem(name: string): string {
	const base = basename(name, extname(name))
		.replace(/[^A-Za-z0-9._=-]+/g, "_")
		.slice(0, 96);
	return base || "image";
}

function derivedImagePath(config: Config, source: ImageDerivativeSource, fingerprint: string): string {
	return resolve(
		attachmentsDir(config),
		"derived",
		"image",
		`${safeDerivedStem(source.name)}-${fingerprint}${DERIVED_IMAGE_EXTENSION}`,
	);
}

async function sourceFingerprint(source: ImageDerivativeSource, localPath: string): Promise<string> {
	if (source.sha256) return source.sha256.slice(0, 16);
	const buffer = await readFile(localPath);
	return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

function inlineBase64Size(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}

async function outputWithinInlineLimit(path: string): Promise<boolean> {
	const fileStat = await stat(path).catch(() => undefined);
	return !!fileStat && inlineBase64Size(fileStat.size) <= MAX_INLINE_IMAGE_BASE64_BYTES;
}

function derivativeNote(width: number | undefined, height: number | undefined): string {
	const dimensions = width && height ? ` ${width}x${height}` : "";
	return `[Resized image${dimensions} for inline model input.]`;
}

export async function ensureInlineImageDerivative(
	config: Config,
	source: ImageDerivativeSource,
): Promise<DerivedImage | undefined> {
	const localPath = source.localPath;
	if (!localPath) return undefined;
	if (!source.mimeType?.startsWith("image/")) return undefined;
	if (source.derived?.image?.localPath && (await outputWithinInlineLimit(source.derived.image.localPath))) {
		return source.derived.image;
	}
	const sourceStat = await stat(localPath).catch(() => undefined);
	const sourceSize = source.size ?? sourceStat?.size;
	if (sourceSize !== undefined && inlineBase64Size(sourceSize) <= MAX_INLINE_IMAGE_BASE64_BYTES) return undefined;

	const fingerprint = await sourceFingerprint(source, localPath);
	const outputPath = derivedImagePath(config, source, fingerprint);
	if (await outputWithinInlineLimit(outputPath)) {
		const metadata = await sharp(outputPath).metadata();
		return {
			localPath: outputPath,
			mimeType: DERIVED_IMAGE_MIME_TYPE,
			size: (await stat(outputPath)).size,
			width: metadata.width,
			height: metadata.height,
			note: derivativeNote(metadata.width, metadata.height),
		};
	}

	const original = sharp(localPath, { animated: false, limitInputPixels: 64_000_000 }).rotate();
	let best:
		| {
				buffer: Buffer;
				width?: number;
				height?: number;
		  }
		| undefined;
	for (const edge of DERIVED_IMAGE_EDGE_STEPS) {
		if (edge > DERIVED_IMAGE_MAX_EDGE) continue;
		for (const quality of DERIVED_IMAGE_QUALITY_STEPS) {
			const output = await original
				.clone()
				.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
				.webp({ quality })
				.toBuffer({ resolveWithObject: true });
			best = { buffer: output.data, width: output.info.width, height: output.info.height };
			if (inlineBase64Size(output.data.length) <= MAX_INLINE_IMAGE_BASE64_BYTES) {
				await mkdir(dirname(outputPath), { recursive: true });
				await writeFile(outputPath, output.data);
				return {
					localPath: outputPath,
					mimeType: DERIVED_IMAGE_MIME_TYPE,
					size: output.data.length,
					width: output.info.width,
					height: output.info.height,
					note: derivativeNote(output.info.width, output.info.height),
				};
			}
		}
	}
	if (!best) return undefined;
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, best.buffer);
	return {
		localPath: outputPath,
		mimeType: DERIVED_IMAGE_MIME_TYPE,
		size: best.buffer.length,
		width: best.width,
		height: best.height,
		note: derivativeNote(best.width, best.height),
	};
}
