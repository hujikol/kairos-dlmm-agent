import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTokenCorrelation } from "../src/core/correlation.js";

const pos = (base_mint) => ({ base_mint });

test("default max is 1 — exceeds at count 1", () => {
  const r = checkTokenCorrelation([pos("A")], "A");
  assert.equal(r.max, 1);
  assert.equal(r.exceeds, true);
});

test("custom maxPerToken=2 — not exceeded at count 1, exceeded at count 2", () => {
  const one = checkTokenCorrelation([pos("A")], "A", 2);
  assert.equal(one.count, 1);
  assert.equal(one.max, 2);
  assert.equal(one.exceeds, false);

  const two = checkTokenCorrelation([pos("A"), pos("A")], "A", 2);
  assert.equal(two.count, 2);
  assert.equal(two.exceeds, true);
});

test("zero positions — exceeds false, count 0", () => {
  const r = checkTokenCorrelation([], "A");
  assert.deepEqual(r, { count: 0, max: 1, exceeds: false });
});

test("filters only matching base_mint", () => {
  const r = checkTokenCorrelation([pos("B"), pos("C"), pos("B")], "A", 2);
  assert.deepEqual(r, { count: 0, max: 2, exceeds: false });
});
