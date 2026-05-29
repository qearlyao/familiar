export function encodeVector(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function decodeVector(buffer: Buffer, dimensions: number): Float32Array {
	if (buffer.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
		throw new Error(`Vector blob dimension mismatch: expected ${dimensions}, got ${buffer.byteLength / 4}`);
	}
	const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	return new Float32Array(bytes);
}

export function cosineDistance(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} !== ${b.length}`);
	let dot = 0;
	let aNorm = 0;
	let bNorm = 0;
	for (let index = 0; index < a.length; index++) {
		const av = a[index];
		const bv = b[index];
		dot += av * bv;
		aNorm += av * av;
		bNorm += bv * bv;
	}
	if (aNorm === 0 || bNorm === 0) return 1;
	return 1 - dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}
