// ═══════════════════════════════════════════════════════════════
//  SMART TOOLS — smart wallet tracking, pool memory, blacklists
// ═══════════════════════════════════════════════════════════════

export const SMART_TOOLS = [
  // ─── Smart Wallets ─────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "add_smart_wallet",
      description: `Add a wallet to the smart wallet tracker.
Use when the user says "add smart wallet", "track this wallet", "add to smart wallets", etc.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Label for this wallet (e.g. 'alpha-1', 'whale-sol')" },
          address: { type: "string", description: "Solana wallet address (base58)" }
        },
        required: ["name", "address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_smart_wallet",
      description: "Remove a wallet from the smart wallet tracker.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Wallet address to remove" }
        },
        required: ["address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_smart_wallets",
      description: "List all currently tracked smart wallets.",
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "check_smart_wallets_on_pool",
      description: `Check if any tracked smart wallets have an active position in a given pool.
Use this before deploying to gauge confidence — if smart wallets are in the pool it's a strong signal.
If no smart wallets are present, rely on fundamentals (fees, volume, organic score) as usual.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "Pool address to check" }
        },
        required: ["pool_address"]
      }
    }
  },

  // ─── Pool Memory ─────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_pool_memory",
      description: `Check your deploy history for a pool BEFORE deploying.
Returns all past deploys, PnL, win rate, and any notes you've added.

Call this tool before deploying to any pool — you may have been here before and it didn't work.
Also useful during screening to skip pools with a bad track record.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The pool address to look up"
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "add_pool_note",
      description: `Annotate a pool with a freeform note that persists across sessions.
Use when you observe something worth remembering about a specific pool:
- "volume dried up after 2h — avoid during off-hours"
- "consistently good during Asian session"
- "rugged base token — monitor closely"`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "Pool address to annotate"
          },
          note: {
            type: "string",
            description: "The note to save"
          }
        },
        required: ["pool_address", "note"]
      }
    }
  },

  // ─── Blacklists ───────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "add_to_blacklist",
      description: `Permanently blacklist a base token mint so it's never deployed into again.
Use when a token rugs, shows wash trading, or is otherwise unsafe.
Blacklisted tokens are filtered BEFORE the LLM even sees pool candidates.`,
      parameters: {
        type: "object",
        properties: {
          mint: {
            type: "string",
            description: "The base token mint address to blacklist"
          },
          symbol: {
            type: "string",
            description: "Token symbol (for readability)"
          },
          reason: {
            type: "string",
            description: "Why this token is being blacklisted"
          }
        },
        required: ["mint", "reason"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_from_blacklist",
      description: "Remove a token mint from the blacklist (e.g. if it was added by mistake).",
      parameters: {
        type: "object",
        properties: {
          mint: {
            type: "string",
            description: "The mint address to remove from the blacklist"
          }
        },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_blacklist",
      description: "List all blacklisted token mints with their reasons and timestamps.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  // ─── Blocked Deployers ───────────────────────────────────────

  {
    type: "function",
    function: {
      name: "block_deployer",
      description: "Block a deployer wallet address. Any token deployed by this wallet will be hard-filtered from screening before the LLM ever sees it.",
      parameters: {
        type: "object",
        properties: {
          wallet:  { type: "string", description: "Deployer wallet address (base58)" },
          label:   { type: "string", description: "Human-readable label (e.g. 'known rugger')" },
          reason:  { type: "string", description: "Why this deployer is being blocked" },
        },
        required: ["wallet"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "unblock_deployer",
      description: "Remove a deployer wallet from the blocklist.",
      parameters: {
        type: "object",
        properties: {
          wallet: { type: "string", description: "Deployer wallet address to unblock" },
        },
        required: ["wallet"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_blocked_deployers",
      description: "List all blocked deployer wallets.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
];
