import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { widestLineWidth } from "../web/src/lib/hugLines.js";

describe("widestLineWidth", () => {
  it("returns the widest line, rounded up", () => {
    assert.equal(widestLineWidth([{ width: 412.2 }, { width: 188.6 }]), 413);
  });

  it("is zero for no line boxes", () => {
    assert.equal(widestLineWidth([]), 0);
  });

  it("handles a single line", () => {
    assert.equal(widestLineWidth([{ width: 240.1 }]), 241);
  });

  it("accepts an array-like (DOMRectList) shape", () => {
    const rects = { length: 2, 0: { width: 100 }, 1: { width: 305.4 } };
    assert.equal(widestLineWidth(rects as unknown as ArrayLike<{ width: number }>), 306);
  });
});
