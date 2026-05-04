import { triggerScreen } from "../../core/shared-handlers.js";
import { sendHTML } from "../../notifications/telegram.js";

export async function handleScreen() {
  triggerScreen();
  await sendHTML("🔍 <b>Manual Screening Started</b>");
}
