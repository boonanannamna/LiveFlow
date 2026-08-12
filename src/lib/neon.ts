import { createClient } from "@neondatabase/neon-js";

export const NEON_AUTH_URL = "https://ep-wispy-pine-a158hikw.neonauth.ap-southeast-1.aws.neon.tech/liveflow_db/auth";
export const NEON_DATA_API_URL = "https://ep-wispy-pine-a158hikw.apirest.ap-southeast-1.aws.neon.tech/liveflow_db/rest/v1";

export const neon = createClient({
  auth: { url: NEON_AUTH_URL },
  dataApi: { url: NEON_DATA_API_URL },
});

export type LiveFlowProfileRow = {
  auth_user_id: string;
  display_name: string;
  email: string;
  phone: string | null;
  role: "admin" | "user";
  is_active: boolean;
  plan_code: string;
  access_starts_at: string | null;
  access_expires_at: string | null;
  keyboard_rule_limit: number;
  created_at: string;
  last_login_at: string | null;
};

export function authErrorMessage(error: unknown): string {
  if (!error) return "ไม่สามารถยืนยันตัวตนได้";
  const message = typeof error === "string"
    ? error
    : typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  if (/invalid origin/i.test(message)) {
    return "ระบบยืนยันตัวตนยังไม่อนุญาตโปรแกรม LiveFlow กรุณาปิดโปรแกรมทั้งหมดแล้วเปิดเวอร์ชันล่าสุดอีกครั้ง";
  }
  return message;
}

export async function getAccessToken(): Promise<string> {
  const result = await neon.auth.getAccessToken();
  const token = typeof result === "string"
    ? result
    : (result as { data?: { token?: string; accessToken?: string } | string; token?: string; accessToken?: string } | null)?.token
      ?? (result as { accessToken?: string } | null)?.accessToken
      ?? (typeof (result as { data?: unknown } | null)?.data === "string" ? (result as { data: string }).data : undefined)
      ?? (result as { data?: { token?: string; accessToken?: string } } | null)?.data?.token
      ?? (result as { data?: { accessToken?: string } } | null)?.data?.accessToken;
  if (!token) throw new Error("ไม่พบ Access Token จาก Neon Auth");
  return token;
}

export function computeAccessStatus(row: Pick<LiveFlowProfileRow, "role" | "is_active" | "access_starts_at" | "access_expires_at">) {
  if (!row.is_active) return "expired" as const;
  if (row.role === "admin") return "active" as const;
  const now = Date.now();
  if (row.access_starts_at && new Date(row.access_starts_at).getTime() > now) return "not_started" as const;
  if (row.access_expires_at && new Date(row.access_expires_at).getTime() < now) return "expired" as const;
  return "active" as const;
}

export async function ensureProfile(input?: { displayName?: string; email?: string; phone?: string }) {
  const session = await neon.auth.getSession();
  if (session.error || !session.data?.user) throw new Error(authErrorMessage(session.error ?? "Session หมดอายุ"));
  const authUser = session.data.user as { id: string; name?: string; email?: string };
  const { data: existing, error: readError } = await neon.from("liveflow_profiles").select("*").eq("auth_user_id", authUser.id).maybeSingle();
  if (readError) throw new Error(readError.message);
  if (existing) return existing as LiveFlowProfileRow;
  const { data, error } = await neon.from("liveflow_profiles").insert({
    auth_user_id: authUser.id,
    display_name: input?.displayName || authUser.name || authUser.email?.split("@")[0] || "LiveFlow User",
    email: input?.email || authUser.email || "",
    phone: input?.phone || null,
  }).select("*").single();
  if (error) throw new Error(error.message);
  return data as LiveFlowProfileRow;
}
