import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("ไม่พบ DATABASE_URL");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  const result = await client.query("SELECT trusted_origins FROM neon_auth.project_config LIMIT 1");
  const origins = Array.isArray(result.rows[0]?.trusted_origins) ? result.rows[0].trusted_origins : [];
  const required = ["http://tauri.localhost", "https://tauri.localhost", "http://localhost:1430", "http://127.0.0.1:1430"];
  console.log(JSON.stringify({ configured: required.every((origin) => origins.includes(origin)), origins }));
} finally {
  await client.end();
}
