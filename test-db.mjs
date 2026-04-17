import "dotenv/config";
import initSqlJs from "sql.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "kairos.db");

const SQL = await initSqlJs();
let data;
if (fs.existsSync(DB_PATH)) {
  data = fs.readFileSync(DB_PATH);
  console.log("DB file size:", data.length);
} else {
  console.log("DB file does NOT exist");
}

const db = new SQL.Database(data);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// Test raw prepare
const rawPrep = db.prepare.bind(db);
const stmt = rawPrep("SELECT 1 as a");
console.log("raw prepare OK:", stmt.step() ? stmt.getAsObject() : null);
stmt.free();

// Test extended prepare
const stmt2 = db.prepare("SELECT 1 as b");
console.log("extended prepare OK:", stmt2.step() ? stmt2.getAsObject() : null);
stmt2.free();

// Test _all helper
function _all(sql) {
  const stmt3 = rawPrep(sql);
  const rows = [];
  while (stmt3.step()) rows.push(stmt3.getAsObject());
  stmt3.free();
  return rows;
}
console.log("_all test:", _all("SELECT 1 as c"));

// Test transaction
console.log("Testing transaction...");
db.transaction(() => {
  db.prepare("CREATE TABLE IF NOT EXISTS test(x)").run();
  db.prepare("INSERT INTO test VALUES (1)").run();
})();
console.log("transaction OK");
