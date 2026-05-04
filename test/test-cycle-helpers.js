import { describe, it } from "node:test";
import assert from "node:assert";
import { escapeHTMLLocal, computeBinsBelow } from "../src/core/cycle-helpers.js";

describe("cycle-helpers", () => {
  describe("escapeHTMLLocal", () => {
    it("escapes & character", () => {
      const result = escapeHTMLLocal("foo & bar");
      assert.strictEqual(result, "foo &amp; bar");
    });

    it("escapes < and > characters", () => {
      const result = escapeHTMLLocal("<div>test</div>");
      assert.strictEqual(result, "&lt;div&gt;test&lt;/div&gt;");
    });

    it("escapes double quotes", () => {
      const result = escapeHTMLLocal('say "hello"');
      assert.strictEqual(result, "say &quot;hello&quot;");
    });

    it("escapes single quotes", () => {
      const result = escapeHTMLLocal("it's working");
      assert.strictEqual(result, "it&#039;s working");
    });

    it("returns null/undefined as-is", () => {
      assert.strictEqual(escapeHTMLLocal(null), null);
      assert.strictEqual(escapeHTMLLocal(undefined), undefined);
    });

    it("escapes mixed special characters", () => {
      const result = escapeHTMLLocal('A < B & "C" > \'D\'');
      assert.strictEqual(result, "A &lt; B &amp; &quot;C&quot; &gt; &#039;D&#039;");
    });
  });

  describe("computeBinsBelow", () => {
    it("returns 35 for volatility 0", () => {
      const result = computeBinsBelow(0);
      assert.strictEqual(result, 35);
    });

    it("returns clamped max of 69 for high volatility", () => {
      const result = computeBinsBelow(10);
      // round(35 + (10/5)*34) = round(35 + 68) = 103, clamped to 69
      assert.strictEqual(result, 69);
    });

    it("returns clamped min of 35 for negative volatility", () => {
      const result = computeBinsBelow(-5);
      assert.strictEqual(result, 35);
    });

    it("returns correct value for mid-range volatility", () => {
      // round(35 + (2.5/5)*34) = round(35 + 17) = 52
      const result = computeBinsBelow(2.5);
      assert.strictEqual(result, 52);
    });

    it("handles volatility at boundary (volatility = 5 gives exactly 69)", () => {
      // round(35 + (5/5)*34) = round(35 + 34) = 69
      const result = computeBinsBelow(5);
      assert.strictEqual(result, 69);
    });
  });
});