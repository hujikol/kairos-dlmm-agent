export function checkTokenCorrelation(positions, baseMint) {
  const existingExposure = positions.filter(p => p.base_mint === baseMint);
  return {
    count: existingExposure.length,
    max: 1, // max positions per token (config override: risk.maxPositionsPerToken)
    exceeds: existingExposure.length >= 1,
  };
}
