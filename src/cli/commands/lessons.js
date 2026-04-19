import { out, die, COMMAND_DEFAULTS } from "../utils.js";
import { addLesson, listLessons } from "../../core/lessons.js";

export async function lessonsCmd(argv, flags, sub2) {
  if (sub2 === "add") {
    const text = argv.filter(a => !a.startsWith("-")).slice(2).join(" ");
    if (!text) die("Usage: kairos lessons add <text>");
    addLesson(text, [], { pinned: false, role: null });
    out({ saved: true, rule: text, outcome: "manual", role: null });
  } else {
    const limit = flags.limit ? parseInt(flags.limit) : COMMAND_DEFAULTS.LESSONS_LIMIT;
    out(listLessons({ limit }));
  }
}
