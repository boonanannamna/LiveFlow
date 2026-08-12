import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("ไม่พบ DATABASE_URL");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  const tables = await client.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema LIKE 'neon_auth%'
    ORDER BY table_schema, table_name
  `);
  const originColumns = await client.query(`
    SELECT table_schema, table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema LIKE 'neon_auth%'
      AND (column_name ILIKE '%origin%' OR column_name ILIKE '%url%' OR column_name ILIKE '%config%')
    ORDER BY table_schema, table_name, ordinal_position
  `);
  console.log(JSON.stringify({ tables: tables.rows, originColumns: originColumns.rows }));
} finally {
  await client.end();
}
