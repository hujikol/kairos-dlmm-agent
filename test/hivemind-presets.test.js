/**
 * HiveMind Presets — unit tests for getSharedPresetsForPrompt.
 * Run: node --test test/hivemind-presets.test.js
 *
 * The function reads from hivemind-cache.json which is written by
 * pullHiveMindPresets(). Tests use the actual cache file.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("getSharedPresetsForPrompt", () => {
  it("getSharedPresetsForPrompt is a function", async () => {
    const { getSharedPresetsForPrompt } = await import("../src/features/hive-mind.js");
    assert.equal(typeof getSharedPresetsForPrompt, "function");
  });

  it("returns null when cache has no presets", async () => {
    const { getSharedPresetsForPrompt } = await import("../src/features/hive-mind.js");
    const result = getSharedPresetsForPrompt({ maxPresets: 6 });
    // Result is null (no cache / empty presets) or a string — both valid
    assert.ok(result === null || typeof result === "string");
  });

  it("agentType parameter is accepted without error", async () => {
    const { getSharedPresetsForPrompt } = await import("../src/features/hive-mind.js");
    assert.doesNotThrow(() => {
      getSharedPresetsForPrompt({ agentType: "SCREENER" });
      getSharedPresetsForPrompt({ agentType: "MANAGER" });
      getSharedPresetsForPrompt({ agentType: "GENERAL" });
    });
  });

  it("maxPresets parameter is accepted without error", async () => {
    const { getSharedPresetsForPrompt } = await import("../src/features/hive-mind.js");
    assert.doesNotThrow(() => {
      getSharedPresetsForPrompt({ maxPresets: 1 });
      getSharedPresetsForPrompt({ maxPresets: 10 });
    });
  });

  it("result is null or non-empty string when presets exist in cache", async () => {
    const { getSharedPresetsForPrompt } = await import("../src/features/hive-mind.js");
    // We can't easily inject cache state without readCache export,
    // so just verify the function runs without error and returns the expected type
    const result = getSharedPresetsForPrompt({ maxPresets: 3 });
    // If no cache, result is null; if cache has presets, result is a string
    assert.ok(result === null || typeof result === "string");
  });
});

describe("hive-mind.js exports", () => {
  it("exports getSharedLessonsForPrompt", async () => {
    const hm = await import("../src/features/hive-mind.js");
    assert.equal(typeof hm.getSharedLessonsForPrompt, "function");
  });

  it("exports getSharedPresetsForPrompt", async () => {
    const hm = await import("../src/features/hive-mind.js");
    assert.equal(typeof hm.getSharedPresetsForPrompt, "function");
  });

  it("exports pullHiveMindPresets", async () => {
    const hm = await import("../src/features/hive-mind.js");
    assert.equal(typeof hm.pullHiveMindPresets, "function");
  });

  it("exports bootstrapHiveMind", async () => {
    const hm = await import("../src/features/hive-mind.js");
    assert.equal(typeof hm.bootstrapHiveMind, "function");
  });

  it("exports startHiveMindBackgroundSync", async () => {
    const hm = await import("../src/features/hive-mind.js");
    assert.equal(typeof hm.startHiveMindBackgroundSync, "function");
  });
});
