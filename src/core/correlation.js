export function checkTokenCorrelation(positions, baseMint, maxPerToken = 1) {
  const existingExposure = positions.filter(p => p.base_mint === baseMint);
  const max = maxPerToken;
  return {
    count: existingExposure.length,
    max,
    exceeds: existingExposure.length >= max,
  };
}
