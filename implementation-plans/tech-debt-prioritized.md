# Tech Debt — Prioritized

| # | Item | Priority | Status | Location |
|---|------|----------|--------|----------|
| 1 | Migrate off `dotenv` + singletons | High | Open | `src/config.js`, `src/core/db.js` |
| 2 | Replace `node-cron` with native `setTimeout`/`setInterval` | High | Open | `src/core/scheduler.js` |
| 3 | Extract `updatePnlAndCheckExits` into isolated module | High | Open | `src/core/state.js` |
| 4 | Add structured logging ( Pino / structured JSON ) | Medium | Open | `src/core/logger.js` |
| 5 | WAL checkpointing on shutdown | Medium | Open | `src/core/db.js` |
| 6 | Per-pool cooldowns in `pool-memory` | Medium | Open | `src/features/pool-memory.js` |
| 7 | Split `state.js` into sub-modules | High | **DONE** | `src/core/state/` (registry, oor, events, pnl, sync) |
