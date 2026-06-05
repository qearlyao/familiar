import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { huggedWidth } from "../web/src/lib/hugLines.js";

describe("huggedWidth", () => {
  it("returns the rightmost edge relative to the container left, rounded up", () => {
    // two lines starting at the container left (100); widest extends to 512.2
    assert.equal(huggedWidth([{ right: 512.2 }, { right: 288.6 }], 100), 413);
  });

  it("is zero for no line boxes", () => {
    assert.equal(huggedWidth([], 100), 0);
  });

  it("hugs an indented line by its right edge, not its bare width", () => {
    // a list item indented 24px from the container left, ending at 500
    assert.equal(huggedWidth([{ right: 400 }, { right: 500 }], 100), 400);
  });

  it("never returns negative when content sits left of the container origin", () => {
    assert.equal(huggedWidth([{ right: 90 }], 100), 0);
  });

  it("caps the hugged width to the available parent width", () => {
    assert.equal(huggedWidth([{ right: 980 }], 100, 640), 640);
  });

  it("lets non-text content boxes participate in the same right-edge model", () => {
    assert.equal(huggedWidth([{ right: 260 }, { right: 620 }], 100, 640), 520);
  });

  it("accepts an array-like (DOMRectList) shape", () => {
    const rects = { length: 2, 0: { right: 200 }, 1: { right: 405.4 } };
    assert.equal(huggedWidth(rects as unknown as ArrayLike<{ right: number }>, 100), 306);
  });
});
