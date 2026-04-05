import { config } from "../config.js";

const MAX_PER_TOKEN = config.risk.maxPositionsPerToken ?? 1;

export function checkTokenCorrelation(positions, baseMint) {
  const existingExposure = positions.filter(p => p.base_mint === baseMint);
  return {
    count: existingExposure.length,
    max: MAX_PER_TOKEN,
    exceeds: existingExposure.length >= MAX_PER_TOKEN,
  };
}
