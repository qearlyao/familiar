import sharp from "sharp";

// Print-formatted EPUBs ship scene-break ornaments as white-ground raster
// images, which render as opaque white patches on the reader's tinted page.
// Detect them (small, grayscale, white ground, real ink) and re-encode as
// black ink on transparency: compositing black at alpha = 1 - luminance over
// any background is exactly multiply-blending the original, with no CSS blend
// mode required. Converted assets get an "-ornament.png" name so the reader
// can invert just these in dark mode.
const MAX_ORNAMENT_BYTES = 128 * 1024;
const MAX_ORNAMENT_PIXELS = 400_000;
const WHITE_GROUND_MEAN = 210;
const INK_MIN = 96;
const GRAY_CHANNEL_SPREAD = 12;

export async function convertOrnamentAssets(assets: Map<string, Uint8Array>): Promise<Map<string, string>> {
	const renames = new Map<string, string>();
	await Promise.all(
		[...assets].map(async ([name, bytes]) => {
			if (!/\.(?:png|jpe?g|gif|webp)$/i.test(name) || bytes.length > MAX_ORNAMENT_BYTES) return;
			const ink = await ornamentInk(bytes).catch(() => undefined);
			if (!ink) return;
			const inkName = `${name.replace(/\.[^.]+$/, "")}-ornament.png`;
			assets.delete(name);
			assets.set(inkName, ink);
			renames.set(name, inkName);
		}),
	);
	return renames;
}

async function ornamentInk(bytes: Uint8Array): Promise<Buffer | undefined> {
	const image = sharp(bytes, { animated: false, limitInputPixels: MAX_ORNAMENT_PIXELS });
	const metadata = await image.metadata();
	if (metadata.hasAlpha || (metadata.pages ?? 1) > 1 || !metadata.width || !metadata.height) return undefined;
	if (metadata.width * metadata.height > MAX_ORNAMENT_PIXELS) return undefined;
	const color = (await image.stats()).channels.slice(0, 3);
	const means = color.map((channel) => channel.mean);
	if (Math.max(...means) - Math.min(...means) > GRAY_CHANNEL_SPREAD) return undefined;
	const mean = means.reduce((sum, value) => sum + value, 0) / means.length;
	const ink = Math.min(...color.map((channel) => channel.min));
	if (mean < WHITE_GROUND_MEAN || ink > INK_MIN) return undefined;
	const { data, info } = await sharp(bytes).grayscale().raw().toBuffer({ resolveWithObject: true });
	const rgba = Buffer.alloc(info.width * info.height * 4);
	for (let index = 0; index < data.length; index++) rgba[index * 4 + 3] = 255 - data[index]!;
	return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
		.png()
		.toBuffer();
}
