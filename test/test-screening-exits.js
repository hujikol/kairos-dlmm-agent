/**
 * Unit tests for screening exit filters in getTopCandidates().
 * Tests: TVL range, dedup, base_mint dedup, blockedLaunchpads.
 * Note: bin_step min/max filters are applied server-side by the Meteora API
 * (discoverPools) and cannot be tested without a real network connection.
 * The bundler/top10/launchpad filters are applied in the agent orchestration
 * layer, not in getTopCandidates — those are tested at integration level.
 *
 * Run: node --test test/test-screening-exits.js
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";

// ─── Test injection hooks ────────────────────────────────────────────────────────
import { _injectDiscovery } from "../src/screening/discovery.js";
import { _injectPositionsCache, _resetPositionsCache } from "../src/integrations/meteora/positions.js";
import { _injectOkx } from "../src/integrations/okx.js";

// ─── Pool factory ─────────────────────────────────────────────────────────────

function makeRawPool(overrides = {}) {
  return {
    pool_address: "PoolDefaultAddr",
    name: "TEST TOKEN / SOL",
    token_x: { symbol: "TEST", address: "TokenDefaultMint", organic_score: 80, warnings: [], market_cap: 500_000, dev: null },
    token_y: { symbol: "SOL", address: "So11111111111111111111111111111111111111112" },
    pool_type: "dlmm",
    dlmm_params: { bin_step: 100 },
    fee_pct: 0.01,
    active_tvl: 50_000,
    fee: 500,
    volume: 5_000,
    fee_active_tvl_ratio: 0.02,
    volatility: 3,
    base_token_holders: 1_000,
    active_positions: 10,
    active_positions_pct: 50,
    open_positions: 15,
    pool_price: 0.05,
    pool_price_change_pct: 2.1,
    price_trend: "up",
    min_price: 0.04,
    max_price: 0.06,
    volume_change_pct: 10,
    fee_change_pct: 5,
    swap_count: 100,
    unique_traders: 50,
    launchpad: null,
    // Condensed form returned by getTopCandidates:
    pool: "PoolDefaultAddr",
    name: "TEST TOKEN / SOL",
    base: { symbol: "TEST", mint: "TokenDefaultMint", organic: 80, warnings: 0 },
    quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
    pool_type: "dlmm",
    bin_step: 100,
    fee_pct: 0.01,
    active_tvl: 50_000,
    fee_window: 500,
    volume_window: 5_000,
    fee_active_tvl_ratio: 0.02,
    volatility: 3.00,
    holders: 1_000,
    mcap: 500_000,
    organic_score: 80,
    token_age_hours: null,
    dev: null,
    active_positions: 10,
    active_pct: 50.0,
    open_positions: 15,
    price: 0.05,
    price_change_pct: 2.1,
    price_trend: "up",
    min_price: 0.04,
    max_price: 0.06,
    volume_change_pct: 10,
    fee_change_pct: 5,
    swap_count: 100,
    unique_traders: 50,
    ...overrides,
  };
}

// ─── Pool normalisation (matches getTopCandidates internal shape) ──────────────
// getTopCandidates receives raw API pools from discoverPools, maps them to
// a condensed form before applying in-memory filters. Our injected pools must
// match that condensed shape:

function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: { symbol: p.token_x?.symbol, mint: p.token_x?.address, organic: Math.round(p.token_x?.organic_score || 0), warnings: p.token_x?.warnings?.length || 0 },
    quote: { symbol: p.token_y?.symbol, mint: p.token_y?.address },
    pool_type: p.pool_type,
    launchpad: p.launchpad || null,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,
    active_tvl: Math.round(p.active_tvl),
    fee_window: Math.round(p.fee),
    volume_window: Math.round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0 ? Number((p.fee_active_tvl_ratio).toFixed(4)) : (p.active_tvl > 0 ? Number(((p.fee / p.active_tvl) * 100).toFixed(4)) : 0),
    volatility: Number((p.volatility ?? 0).toFixed(2)),
    holders: p.base_token_holders,
    mcap: Math.round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000) : null,
    dev: p.token_x?.dev || null,
    active_positions: p.active_positions,
    active_pct: Number((p.active_positions_pct ?? 0).toFixed(1)),
    open_positions: p.open_positions,
    price: p.pool_price,
    price_change_pct: Number((p.pool_price_change_pct ?? 0).toFixed(1)),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,
    volume_change_pct: Number((p.volume_change_pct ?? 0).toFixed(1)),
    fee_change_pct: Number((p.fee_change_pct ?? 0).toFixed(1)),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

// ─── Test suite ────────────────────────────────────────────────────────────────

describe("getTopCandidates — exit filters", () => {

  beforeEach(() => {
    _injectDiscovery(null);
    _injectPositionsCache(null);
    _resetPositionsCache();
    _injectOkx(() => null); // default: no OKX data
  });

  test("1. filters out pools with TVL BELOW minTvl", async () => {
    const pools = [
      condensePool(makeRawPool({
        pool_address: "LowTvlPool",
        active_tvl: 1_000,
        token_x: { symbol: "LOWTVL", address: "LowTvlMint", organic_score: 80, warnings: [], market_cap: 500_000, dev: null },
      })),
    ];

    const { config } = await import("../src/config.js");
    const prev = config.screening.minTvl;
    config.screening.minTvl = 10_000;

    try {
      _injectDiscovery({ pools });
      _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

      const { getTopCandidates } = await import("../src/screening/discovery.js");
      const result = await getTopCandidates({ limit: 10 });
      const addresses = result.candidates.map((c) => c.pool);

      assert.ok(!addresses.includes("LowTvlPool"), "Pool with TVL below minTvl should be filtered out");
    } finally {
      config.screening.minTvl = prev;
    }
  });

  test("2. filters out pools with TVL ABOVE maxTvl", async () => {
    const pools = [
      condensePool(makeRawPool({
        pool_address: "HighTvlPool",
        active_tvl: 500_000,
        token_x: { symbol: "HIGHTVL", address: "HighTvlMint", organic_score: 80, warnings: [], market_cap: 500_000, dev: null },
      })),
    ];

    const { config } = await import("../src/config.js");
    const prev = config.screening.maxTvl;
    config.screening.maxTvl = 150_000;

    try {
      _injectDiscovery({ pools });
      _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

      const { getTopCandidates } = await import("../src/screening/discovery.js");
      const result = await getTopCandidates({ limit: 10 });
      const addresses = result.candidates.map((c) => c.pool);

      assert.ok(!addresses.includes("HighTvlPool"), "Pool with TVL above maxTvl should be filtered out");
    } finally {
      config.screening.maxTvl = prev;
    }
  });

  test("3. duplicate pool_address in API response appears only once in candidates", async () => {
    const dup = condensePool(makeRawPool({
      pool_address: "DupPoolAddr",
      token_x: { symbol: "DUP", address: "DupPoolMint", organic_score: 80, warnings: [], market_cap: 500_000, dev: null },
    }));
    const pools = [dup, { ...dup, pool_address: "DupPoolAddr", name: "DUP TOKEN 2" }];

    _injectDiscovery({ pools });
    _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

    const { getTopCandidates } = await import("../src/screening/discovery.js");
    const result = await getTopCandidates({ limit: 10 });
    const addresses = result.candidates.map((c) => c.pool);
    const dupCount = addresses.filter((a) => a === "DupPoolAddr").length;

    assert.strictEqual(dupCount, 1, "Duplicate pool_address should appear only once");
  });

  test("4. pool with base_mint matching wallet's existing position is excluded", async () => {
    const sharedMint = "WalletHoldsMint";
    const pools = [
      condensePool(makeRawPool({
        pool_address: "WalletPool",
        token_x: { symbol: "WALLET", address: sharedMint, organic_score: 80, warnings: [], market_cap: 500_000, dev: null },
      })),
      condensePool(makeRawPool({
        pool_address: "NewPool",
        token_x: { symbol: "WALLET", address: sharedMint, organic_score: 80, warnings: [], market_cap: 500_000, dev: null },
      })),
    ];

    _injectDiscovery({ pools });
    _injectPositionsCache({
      wallet: "TestWallet",
      total_positions: 1,
      positions: [{ position: "ExistingPos", pool: "WalletPool", base_mint: sharedMint }],
    });

    const { getTopCandidates } = await import("../src/screening/discovery.js");
    const result = await getTopCandidates({ limit: 10 });
    const addresses = result.candidates.map((c) => c.pool);

    assert.ok(!addresses.includes("NewPool"), "Second pool with duplicate base_mint should be excluded");
  });

  test("5. blockedLaunchpads config excludes pools from those launchpads", async () => {
    _injectOkx(() => null); // ensure OKX mock is active (beforeEach may not run in some test runners)
    const pools = [
      condensePool(makeRawPool({
        pool_address: "AllowedPool",
        launchpad: "raydium.io",
        token_x: { symbol: "ALLOWED", address: "AllowMint", organic_score: 80, warnings: [], market_cap: 500_000, dev: null },
      })),
      condensePool(makeRawPool({
        pool_address: "BlockedPool",
        launchpad: "pump.fun",
        token_x: { symbol: "BLOCKED", address: "BlockMint", organic_score: 80, warnings: [], market_cap: 500_000, dev: null },
      })),
    ];

    const { config } = await import("../src/config.js");
    const prev = config.screening.blockedLaunchpads;
    config.screening.blockedLaunchpads = ["pump.fun"];

    try {
      _injectDiscovery({ pools });
      _injectPositionsCache({ wallet: "TestWallet", total_positions: 0, positions: [] });

      const { getTopCandidates } = await import("../src/screening/discovery.js");
      const result = await getTopCandidates({ limit: 10 });
      const addresses = result.candidates.map((c) => c.pool);

      assert.ok(addresses.includes("AllowedPool"), "Pool from non-blocked launchpad should be included");
      assert.ok(!addresses.includes("BlockedPool"), "Pool from blocked launchpad (pump.fun) should be excluded");
    } finally {
      config.screening.blockedLaunchpads = prev;
    }
  });
});
