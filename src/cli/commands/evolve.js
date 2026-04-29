import { out } from "../utils.js";
import { config } from "../../config.js";
import { evolveThresholds } from "../../core/lessons.js";

export async function evolveCmd(_argv, _flags) {
  const fs2 = await import("fs");
  const lessonsFile = "./lessons.json";
  let perfData = [];
  if (fs2.existsSync(lessonsFile)) {
    try { perfData = JSON.parse(fs2.readFileSync(lessonsFile, "utf8")).performance || []; } catch { /* no data */ }
  }
  const result = evolveThresholds(perfData, config);
  if (!result) {
    out({ evolved: false, reason: `Need at least 5 closed positions (have ${perfData.length})` });
  } else {
    out({ evolved: Object.keys(result.changes).length > 0, changes: result.changes, rationale: result.rationale });
  }
}
