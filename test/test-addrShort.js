/**
 * Unit tests for src/tools/addrShort.js
 * Uses Node's built-in test runner (node:test).
 *
 * Run: node --test test/test-addrShort.js
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { addrShort } from "../src/tools/addrShort.js";

describe("addrShort", () => {

  test("normal address is shortened correctly", () => {
    // addrShort: returns addr.slice(0,4) + '...' + addr.slice(-4)
    const addr = " abc123def456hijk";
    const result = addrShort(addr);
    assert.strictEqual(result, " abc...hijk");
  });

  test("exactly 8 character string is shortened", () => {
    const addr = "12345678";
    const result = addrShort(addr);
    // slice(0,4) = "1234", slice(-4) = "5678" → "1234...5678"
    assert.strictEqual(result, "1234...5678");
  });

  test("9 character string is shortened", () => {
    const addr = "123456789";
    const result = addrShort(addr);
    // slice(0,4) = "1234", slice(-4) = "56789" (last 4 chars)
    assert.strictEqual(result, "1234...6789");
  });

  test("7 character string is returned as-is (too short)", () => {
    const addr = "1234567";
    const result = addrShort(addr);
    assert.strictEqual(result, "1234567");
  });

  test("empty string returns empty string", () => {
    const result = addrShort("");
    assert.strictEqual(result, "");
  });

  test("null returns empty string", () => {
    const result = addrShort(null);
    assert.strictEqual(result, "");
  });

  test("undefined returns empty string", () => {
    const result = addrShort(undefined);
    assert.strictEqual(result, "");
  });

  test("non-string input is returned as-is when truthy", () => {
    // addrShort returns addr || '' for non-strings. Truthy values returned as-is.
    assert.strictEqual(addrShort(12345678), 12345678);
    // Empty object is truthy and returned as-is (not an empty string)
    assert.ok(typeof addrShort({}) === "object");
    // Empty array is truthy, returned as-is
    assert.ok(Array.isArray(addrShort([])));
  });

  test("string with special characters works", () => {
    const addr = "So1k3MnYwXh6mYu9L8P2qR4tU5vW7xY9zA";
    const result = addrShort(addr);
    // First 4: "So1k", last 4: "Y9zA"
    assert.strictEqual(result, "So1k...Y9zA");
  });

  test("Solana-style base58 address works", () => {
    // Normal Solana addresses are 32-44 chars
    const addr = "7EqY6dLMr1HbJkqMqzqJ4GJnD3QqkL3jCv8pES7hG7m";
    const result = addrShort(addr);
    // Last 4 chars: "hG7m"
    assert.strictEqual(result, "7EqY...hG7m");
  });
});
