import { tableHasColumn } from "../src/core/db.js";

export function up(db) {
  if (!tableHasColumn(db, "strategies", "bb_params")) {
    db.exec("ALTER TABLE strategies ADD COLUMN bb_params TEXT");
  }
}

export function migrate(db) {
  up(db);
}
