// ═══════════════════════════════════════════════════════════════
//  POSITION TOOLS — deploy, manage, and close DLMM positions
// ═══════════════════════════════════════════════════════════════

export const POSITION_TOOLS = [
  // ─── Position Deployment ──────────────────────────────────────

  {
    type: "function",
    function: {
      name: "deploy_position",
      description: `Open a new DLMM position. Executes on-chain. Rules for strategy/bins are in the system prompt.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address to LP in"
          },
          amount_y: {
            type: "number",
            description: "Amount of quote token (usually SOL) to deposit."
          },
          amount_x: {
            type: "number",
            description: "Amount of base token to deposit (if doing dual-sided)."
          },
          amount_sol: {
            type: "number",
            description: "Alias for amount_y. For backward compatibility."
          },
          strategy: {
            type: "string",
            enum: ["bid_ask", "spot"],
            description: "DLMM strategy type. If user specifies, use exactly what they said. Otherwise use the active strategy's lp_strategy field."
          },
          bins_below: {
            type: "number",
            description: "Number of bins below active bin. If the user specifies a value, use it exactly. If they specify a % range (e.g. '-60% range'), convert using: bins = ceil(log(1 - pct) / log(1 + bin_step/10000)). Example: -60% range at bin_step 100 → ceil(log(0.40)/log(1.01)) = 92 bins. Otherwise choose based on volatility: 35–69 standard, 100–350 for wide-range strategies. Max 1400 total."
          },
          bins_above: {
            type: "number",
            description: "Number of bins above active bin. MUST be 0 for bid_ask strategy — placing bins above active bin defeats the purpose of bid-ask. Only set > 0 for spot/dual-sided strategies."
          },
          pool_name: { type: "string", description: "Human-readable pool name for record-keeping" },
          base_mint: { type: "string", description: "Base token mint address — used to prevent duplicate token exposure across pools" },
          bin_step: { type: "number", description: "Pool bin step (from discover_pools)" },
          base_fee: { type: "number", description: "Pool base fee percentage (from discover_pools)" },
          volatility: { type: "number", description: "Pool volatility at deploy time" },
          fee_tvl_ratio: { type: "number", description: "fee/TVL ratio at deploy time" },
          organic_score: { type: "number", description: "Base token organic score at deploy time" },
          initial_value_usd: { type: "number", description: "Estimated USD value being deployed" },
          conviction: {
            type: "string",
            enum: ["very_high", "high", "normal"],
            description: "Conviction level for sizing: very_high (LPers+smart_wallets+strong_fundamentals), high (good fundamentals), normal (passes filters)."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_wallet_positions",
      description: `Get all open DLMM positions for any Solana wallet address.
Use this when the user asks about another wallet's positions, wants to monitor a wallet,
or wants to copy/compare positions.

Returns the same structure as get_my_positions but for the given wallet:
position address, pool, bin range, in-range status, unclaimed fees, PnL, age.`,
      parameters: {
        type: "object",
        properties: {
          wallet_address: {
            type: "string",
            description: "The Solana wallet address (base58 public key) to check"
          }
        },
        required: ["wallet_address"]
      }
    }
  },

  // ─── Position Management ───────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_my_positions",
      description: `List all open DLMM positions for the agent wallet.
Returns positions grouped by pool, each with:
- position address
- pool address and token pair
- bin range (min/max bin IDs)
- whether currently in range
- unclaimed fees (in USD)
- total deposited value vs current value
- time since last rebalance

Use this at the start of every management cycle.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_position_pnl",
      description: `Get detailed PnL and real-time Fee/TVL metrics for an open position.
Use this during management to check if yield has dropped significantly.
Returns current feePerTvl24h which indicates the current APY of the pool.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "The pool address" },
          position_address: { type: "string", description: "The position public key" }
        },
        required: ["pool_address", "position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "claim_fees",
      description: `Claim accumulated swap fees from a specific position.
Only call when unclaimed fees > $5 to justify transaction costs.
Returns the transaction hash and amounts claimed.

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to claim fees from"
          }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "close_position",
      description: `Remove all liquidity and close a position.
This withdraws all tokens back to the wallet and closes the position account.
Use when:
- Position has been out of range for > 30 minutes
- IL exceeds accumulated fees
- Token shows danger signals (organic score drop, volume crash)
- Rebalancing (close old + open new)

WARNING: This executes a real on-chain transaction. Cannot be undone.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to close"
          },
          skip_swap: {
            type: "boolean",
            description: "Set to true if user explicitly wants to hold/keep the base token after closing. Default: false (auto-swaps base token back to SOL)."
          },
          reason: {
            type: "string",
            description: "Why this position is being closed. Include the rule that triggered it, e.g. 'low yield', 'stop loss', 'trailing TP', 'OOR'. Used for pool memory."
          }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "set_position_note",
      description: `Save a persistent instruction for a position that ALL future management cycles will respect.
Use this immediately whenever the user gives a specific instruction about a position:
- "hold until 5% profit"
- "don't close before fees hit $10"
- "close if it goes out of range"
- "hold for at least 2 hours"

The instruction is stored in state.json and injected into every management cycle prompt.
Pass null or empty string to clear an existing instruction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position address to attach the instruction to"
          },
          instruction: {
            type: "string",
            description: "The instruction to persist (e.g. 'hold until PnL >= 5%'). Pass empty string to clear."
          }
        },
        required: ["position_address", "instruction"]
      }
    }
  },
];
