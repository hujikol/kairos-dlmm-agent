import { out, die, COMMAND_DEFAULTS } from "../utils.js";
import { studyTopLPers } from "../../integrations/lpagent.js";

export async function studyCmd(argv, flags) {
  if (!flags.pool) die("Usage: kairos study --pool <addr> [--limit 4]");
  const limit = flags.limit ? parseInt(flags.limit) : COMMAND_DEFAULTS.STUDY_LIMIT;
  out(await studyTopLPers({ pool_address: flags.pool, limit }));
}
