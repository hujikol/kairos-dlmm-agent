import { out } from "../utils.js";
import { updateRules } from "../../core/rule-memory.js";
export async function evolveCmd() { out(await updateRules()); }
