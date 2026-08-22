/**
 * Find-and-close helpers for SOLANA token accounts.
 *
 * ponytail: claimAndSweepSol was removed — it built SystemProgram.transfer FROM
 * the DLMM position PDA (a PDA cannot sign → the tx always failed). Position
 * rent is already reclaimed by the SDK's shouldClaimAndClose/closePosition
 * instructions during close. If a dedicated post-close sweep is ever needed,
 * add a Meteora SDK-supported close instruction here + a test-validator
 * integration test proving real rent refund before wiring any flag.
 */
