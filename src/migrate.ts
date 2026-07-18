import fs from "fs";
import path from "path";
import { pool } from "./db";

async function main() {
  const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
  console.log("Database schema ensured.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
