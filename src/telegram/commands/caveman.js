import { config } from "../../config.js";
import { sendHTML } from "../../notifications/telegram.js";
import { writeFileAtomic } from "../../utils/helpers.js";
import fs from "fs";
import { USER_CONFIG_PATH } from "../../config.js";
import { log } from "../../core/logger.js";

export async function handleCaveman() {
  try {
    config.cavemanEnabled = !config.cavemanEnabled;

    // Persist to user-config.json
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      cfg.cavemanEnabled = config.cavemanEnabled;
      await writeFileAtomic(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
    }

    await sendHTML(`🗣 Caveman mode: <b>${config.cavemanEnabled ? "ON" : "OFF"}</b>`);
  } catch (e) {
    log("warn", "telegram", `Caveman toggle failed: ${e?.message ?? e}`);
    await sendHTML(`Error toggling caveman mode: <code>${e?.message ?? e}</code>`);
  }
}
