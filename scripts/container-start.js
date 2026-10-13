import { copyFileSync, constants, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const configPath = process.env.KAIROS_USER_CONFIG_PATH || "/data/user-config.json";
mkdirSync(dirname(configPath), { recursive: true });
try {
  copyFileSync(new URL("../profiles/high-volume-paper.json", import.meta.url), configPath, constants.COPYFILE_EXCL);
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}
await import("../src/index.js");
