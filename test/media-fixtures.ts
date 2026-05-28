import { randomFillSync } from "node:crypto";

import sharp from "sharp";

export function pngBytes(): Buffer {
	return Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154012a0b0000000049454e44ae426082",
		"hex",
	);
}

export function mp4Bytes(): Buffer {
	return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypmp42", "ascii"), Buffer.alloc(16)]);
}

export async function noisyPngBytes(size = 1600): Promise<Buffer> {
	const raw = Buffer.alloc(size * size * 3);
	randomFillSync(raw);
	return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}
