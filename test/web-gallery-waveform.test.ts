import assert from "node:assert/strict";
import { test } from "node:test";
import { waveformPeaks } from "../web/src/components/gallery/waveformPeaks.js";

test("waveform keeps silence and the temporal order of loud and quiet passages", () => {
  assert.deepEqual(waveformPeaks([new Float32Array([0, 0, 1, -1, 0.5, -0.5, 0, 0])], 4), [0, 1, 0.5, 0]);
});

test("waveform combines channels without cancelling opposite-phase audio", () => {
  assert.deepEqual(waveformPeaks([new Float32Array([1, -1]), new Float32Array([-1, 1])], 2), [1, 1]);
});

test("empty or silent recordings have no fabricated peaks", () => {
  assert.deepEqual(waveformPeaks([], 3), [0, 0, 0]);
  assert.deepEqual(waveformPeaks([new Float32Array(9)], 3), [0, 0, 0]);
});
