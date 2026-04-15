#!/usr/bin/env node
import { execSync } from "child_process";

console.log("Setting up PM2 auto-start...");

try {
  // Save current process list
  execSync("pm2 save", { stdio: "inherit" });
  console.log("✓ PM2 state saved.");

  // Generate and install startup script
  execSync("pm2 startup", { stdio: "inherit" });
  console.log("✓ PM2 startup hook installed.");
  console.log("\nPM2 will now auto-start on system reboot.");
} catch (e) {
  console.error("✗ Failed to setup PM2 startup:", e.message);
  console.error("Run these manually after fixing permissions:");
  console.error("  pm2 save");
  console.error("  pm2 startup");
  process.exit(1);
}
