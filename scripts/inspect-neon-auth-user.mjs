import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("ไม่พบ DATABASE_URL");
const email = String(process.env.LIVEFLOW_ADMIN_EMAIL || "").trim().toLowerCase();
if (!email) throw new Error("ไม่พบ LIVEFLOW_ADMIN_EMAIL");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  const user = await client.query(
    `SELECT id, email, "emailVerified" AS email_verified, "createdAt" AS created_at
     FROM neon_auth."user"
     WHERE lower(email) = $1
     LIMIT 1`,
    [email],
  );
  const account = user.rowCount
    ? await client.query(
        `SELECT "providerId" AS provider_id, password IS NOT NULL AS has_password
         FROM neon_auth.account
         WHERE "userId" = $1`,
        [user.rows[0].id],
      )
    : { rows: [] };
  const profile = user.rowCount
    ? await client.query(
        `SELECT role, is_active, plan_code
         FROM public.liveflow_profiles
         WHERE auth_user_id = $1`,
        [user.rows[0].id],
      )
    : { rows: [] };
  console.log(JSON.stringify({
    exists: user.rowCount === 1,
    emailVerified: user.rows[0]?.email_verified ?? false,
    accounts: account.rows,
    profile: profile.rows[0] ?? null,
  }));
} finally {
  await client.end();
}
