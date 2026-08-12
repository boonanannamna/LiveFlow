import fs from "node:fs/promises";
import pg from "pg";

const migrationPath = process.argv[2];
if (!migrationPath) throw new Error("กรุณาระบุไฟล์ migration");
if (!process.env.DATABASE_URL) throw new Error("ไม่พบ DATABASE_URL");

const sql = await fs.readFile(migrationPath, "utf8");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(sql);
  console.log(JSON.stringify({ applied: true, migration: migrationPath }));
} finally {
  await client.end();
}
