import * as m001 from "./001_initial_schema.js";
import * as m002 from "./002_add_missing_columns.js";

export const MIGRATIONS = [
  { id: 1, name: "initial_schema", fn: m001.migrate },
  { id: 2, name: "add_missing_columns", fn: m002.migrate },
];