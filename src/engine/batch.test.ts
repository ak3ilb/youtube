import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampBatchLimit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT } from "./batch.js";

describe("clampBatchLimit", () => {
  it("keeps casual calls cheap when no limit is given", () => {
    assert.equal(clampBatchLimit(undefined), DEFAULT_BATCH_LIMIT);
    assert.equal(clampBatchLimit(0), DEFAULT_BATCH_LIMIT);
    assert.equal(clampBatchLimit(-3), DEFAULT_BATCH_LIMIT);
    assert.equal(clampBatchLimit(Number.NaN), DEFAULT_BATCH_LIMIT);
  });

  it("passes through the 20-30 video packs agents actually ask for", () => {
    assert.equal(clampBatchLimit(20), 20);
    assert.equal(clampBatchLimit(25), 25);
    assert.equal(clampBatchLimit(30), 30);
    assert.equal(clampBatchLimit(MAX_BATCH_LIMIT), MAX_BATCH_LIMIT);
  });

  it("clamps rather than rejects above the ceiling", () => {
    assert.equal(MAX_BATCH_LIMIT, 50);
    assert.equal(clampBatchLimit(51), MAX_BATCH_LIMIT);
    assert.equal(clampBatchLimit(5000), MAX_BATCH_LIMIT);
  });

  it("floors fractional limits", () => {
    assert.equal(clampBatchLimit(30.9), 30);
  });
});
