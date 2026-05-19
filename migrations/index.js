import * as m001 from "./001_initial_schema.js";
import * as m002 from "./002_add_missing_columns.js";
import * as m003 from "./003_decision_log.js";
import * as m004 from "./004_sizing_matrix.js";
import * as m005 from "./005_conviction_column.js";
import * as m006 from "./006_evolver_state.js";
import * as m007 from "./007_strategy_library.js";
import * as m008 from "./008_cycle_outcomes.js";

export const MIGRATIONS = [
  { id: 1, name: "initial_schema",     fn: m001.migrate },
  { id: 2, name: "add_missing_columns", fn: m002.migrate },
  { id: 3, name: "decision_log",      fn: m003.migrate },
  { id: 4, name: "sizing_matrix",     fn: m004.migrate },
  { id: 5, name: "conviction_column",  fn: m005.migrate },
  { id: 6, name: "evolver_state",     fn: m006.migrate },
  { id: 7, name: "strategy_library",  fn: m007.migrate },
  { id: 8, name: "cycle_outcomes_and_rejected_and_snapshots", fn: m008.migrate },
];