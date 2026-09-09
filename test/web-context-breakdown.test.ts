import assert from "node:assert/strict";
import test from "node:test";
import { contextSegments } from "../web/src/lib/contextBreakdown.js";

test("context proportions preserve model-reported totals despite estimate differences", () => {
  const segments = contextSegments(74200, { other: 100, summaries: 200, pending: 300, fresh: 400 });
  assert.equal(segments.reduce((sum, segment) => sum + segment.tokens, 0), 74200);
  assert.deepEqual(segments.map((segment) => segment.tokens), [7420, 14840, 22260, 29680]);
  assert.deepEqual(segments.map((segment) => segment.start), [0, 7420, 22260, 44520]);
});

test("rounding preserves the reported total and zero-weight segments", () => {
  const segments = contextSegments(7, { other: 1, summaries: 1, pending: 0, fresh: 1 });
  assert.deepEqual(segments.map((segment) => segment.tokens), [2, 3, 0, 2]);
  assert.equal(contextSegments(0, { other: 1, summaries: 1, pending: 1, fresh: 1 }).reduce((sum, segment) => sum + segment.tokens, 0), 0);
});

test("missing or empty breakdown never fabricates proportions", () => {
  assert.deepEqual(contextSegments(74200), []);
  assert.deepEqual(contextSegments(74200, { other: 0, summaries: 0, pending: 0, fresh: 0 }), []);
});

test("invalid accounting is surfaced", () => {
  for (const other of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => contextSegments(100, { other, summaries: 1, pending: 1, fresh: 1 }), /Invalid context breakdown/);
  }
});
