import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Activity, CalendarDays, ChevronLeft, ChevronRight, CreditCard, ExternalLink, KeyRound, LogOut, Mail, Megaphone, PackageCheck, Pencil, Phone, RefreshCw, Save, Search, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import generatePromptPayPayload from "promptpay-qr";
import { QRCodeSVG } from "qrcode.react";
import { authErrorMessage, computeAccessStatus, ensureProfile, neon, type LiveFlowProfileRow } from "../lib/neon";

export type AuthUser = {
  id: string;
  displayName: string;
  email: string;
  phone?: string | null;
  role: "admin" | "user";
  isActive: boolean;
  planCode: string;
  accessStartsAt?: string | null;
  accessExpiresAt?: string | null;
  keyboardRuleLimit: number;
  accessStatus: "active" | "not_started" | "expired";
  createdAt: string;
  lastLoginAt?: string | null;
};

type AuthSession = { sessionToken: string; user: AuthUser };
type AuthMode = "login" | "register" | "forgot" | "reset";

const MEMBERSHIP_PACKAGES = [
  { code: "starter", legacyCode: "1-month", name: "แพ็กเกจเริ่มต้น", months: 1, price: 40, limit: 10, description: "เหมาะสำหรับเริ่มใช้งาน" },
  { code: "creator", legacyCode: "2-month", name: "แพ็กเกจครีเอเตอร์", months: 2, price: 70, limit: 25, description: "เหมาะสำหรับไลฟ์เป็นประจำ" },
  { code: "pro", legacyCode: "3-month", name: "แพ็กเกจโปร", months: 3, price: 100, limit: 50, description: "ใช้งานเต็มรูปแบบ คุ้มที่สุด" },
  { code: "unlimited", legacyCode: "unlimited", name: "แพ็กเกจ Unlimited", months: 0, price: 0, limit: -1, description: "สร้างกฎคีย์บอร์ดได้ไม่จำกัด" },
] as const;

export function profileToAuthUser(row: LiveFlowProfileRow): AuthUser {
  return {
    id: row.auth_user_id,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    isActive: row.is_active,
    planCode: row.plan_code,
    accessStartsAt: row.access_starts_at,
    accessExpiresAt: row.access_expires_at,
    keyboardRuleLimit: row.keyboard_rule_limit,
    accessStatus: computeAccessStatus(row),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function packageByCode(code?: string | null) {
  return MEMBERSHIP_PACKAGES.find((item) => item.code === code || item.legacyCode === code);
}

function packageDisplayName(code?: string | null) {
  return packageByCode(code)?.name ?? (code && code !== "free" ? code : "แพ็กเกจฟรี");
}

export type Announcement = {
  id: number;
  title: string;
  message: string;
  imageUrl?: string | null;
  displayMode: "banner" | "ticker" | "modal" | "image";
  startsAt?: string | null;
  endsAt?: string | null;
  createdAt: string;
};

export type SystemUpdateInfo = {
  currentVersion: string;
  requiredVersion: string;
  forceUpdate: boolean;
  updateUrl: string;
  message: string;
};

export function AuthPortal({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const resetTokenFromUrl = new URLSearchParams(window.location.search).get("token") ?? "";
  const [mode, setMode] = useState<AuthMode>(resetTokenFromUrl ? "reset" : "login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetCode, setResetCode] = useState(resetTokenFromUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError("");
    setMessage("");
    setPassword("");
    setConfirmPassword("");
    if (nextMode === "register") {
      setEmail("");
      setDisplayName("");
      setPhone("");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!isTauri()) {
      setError("ระบบสมาชิกใช้งานผ่าน Tauri Desktop เท่านั้น");
      return;
    }
    if ((mode === "register" || mode === "reset") && password !== confirmPassword) {
      setError("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") {
        const result = await neon.auth.signIn.email({ email: email.trim().toLowerCase(), password });
        if (result.error) throw new Error(authErrorMessage(result.error));
        const profile = await ensureProfile({ email });
        if (!profile.is_active) { await neon.auth.signOut(); throw new Error("บัญชีนี้ถูกระงับการใช้งาน"); }
        onAuthenticated({ sessionToken: profile.auth_user_id, user: profileToAuthUser(profile) });
      } else if (mode === "register") {
        const result = await neon.auth.signUp.email({ email: email.trim().toLowerCase(), password, name: displayName.trim() });
        if (result.error) throw new Error(authErrorMessage(result.error));
        const current = await neon.auth.getSession();
        if (!current.data?.user) {
          setMessage("สมัครสำเร็จ กรุณายืนยันอีเมลแล้วกลับมาเข้าสู่ระบบ");
          setMode("login");
          return;
        }
        const profile = await ensureProfile({ displayName, email, phone });
        onAuthenticated({ sessionToken: profile.auth_user_id, user: profileToAuthUser(profile) });
      } else if (mode === "forgot") {
        const result = await neon.auth.requestPasswordReset({ email: email.trim().toLowerCase(), redirectTo: window.location.href.split("?")[0] });
        if (result.error) throw new Error(authErrorMessage(result.error));
        setMessage("ส่งลิงก์ตั้งรหัสผ่านใหม่ไปยังอีเมลแล้ว");
      } else {
        const result = await neon.auth.resetPassword({ newPassword: password, token: resetCode });
        if (result.error) throw new Error(authErrorMessage(result.error));
        setMessage("ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว");
        setMode("login");
        setResetCode("");
        setPassword("");
        setConfirmPassword("");
      }
    } catch (submitError) {
      setError(String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-brand-panel">
        <div className="auth-logo"><Activity size={25} /></div>
        <div>
          <span className="auth-kicker">LIVE AUTOMATION PLATFORM</span>
          <h1>LiveFlow</h1>
          <p>จัดการ TikTok LIVE, กฎการทำงาน และ Overlay</p>
        </div>
        <div className="auth-feature-list">
          <span><ShieldCheck size={17} /> รหัสผ่านเข้ารหัสด้วย Argon2</span>
          <span><KeyRound size={17} /> Session มีวันหมดอายุและเพิกถอนได้</span>
          <span><Mail size={17} /> ตั้งรหัสผ่านใหม่ผ่านอีเมล</span>
        </div>
      </section>
      <section className="auth-card">
        <div className="auth-card-icon">{mode === "register" ? <UserRound /> : mode === "forgot" || mode === "reset" ? <KeyRound /> : <ShieldCheck />}</div>
        <p className="eyebrow">LIVEFLOW ACCOUNT</p>
        <h2>{mode === "login" ? "เข้าสู่ระบบ" : mode === "register" ? "สมัครสมาชิก" : mode === "forgot" ? "ลืมรหัสผ่าน" : "ตั้งรหัสผ่านใหม่"}</h2>
        <p className="auth-copy">
          {mode === "login" ? "เข้าสู่ระบบเพื่อใช้งาน LiveFlow" : mode === "register" ? "สร้างบัญชีผู้ใช้ใหม่" : mode === "forgot" ? "กรอกอีเมลเพื่อรับลิงก์ตั้งรหัสผ่านใหม่" : "เปิดลิงก์จากอีเมลแล้วตั้งรหัสผ่านใหม่"}
        </p>
        <form key={mode} className="auth-form" onSubmit={submit} autoComplete={mode === "register" ? "off" : "on"}>
          {mode === "register" && <label>ชื่อที่แสดง<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required /></label>}
          <label>อีเมล<input key={`email-${mode}`} name={mode === "register" ? "new-member-email" : "email"} type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete={mode === "register" ? "off" : "email"} required /></label>
          {mode === "register" && <label>เบอร์โทรศัพท์<input type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" placeholder="เช่น 0812345678 หรือ +66812345678" required /></label>}
          {mode === "reset" && !resetTokenFromUrl && <label>โทเคนจากลิงก์อีเมล<input value={resetCode} onChange={(event) => setResetCode(event.target.value.trim())} required /></label>}
          {(mode === "login" || mode === "register" || mode === "reset") && <label>{mode === "reset" ? "รหัสผ่านใหม่" : "รหัสผ่าน"}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>}
          {(mode === "register" || mode === "reset") && <label>ยืนยันรหัสผ่าน<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required /></label>}
          {(mode === "register" || mode === "reset") && <small className="auth-password-help">อย่างน้อย 8 ตัว พร้อมตัวพิมพ์ใหญ่ พิมพ์เล็ก ตัวเลข และสัญลักษณ์</small>}
          {error && <div className="auth-alert error">{error}</div>}
          {message && <div className="auth-alert success">{message}</div>}
          <button className="auth-submit" disabled={busy}>{busy ? "กำลังดำเนินการ..." : mode === "login" ? "เข้าสู่ระบบ" : mode === "register" ? "สมัครสมาชิก" : mode === "forgot" ? "ส่งลิงก์ทางอีเมล" : "บันทึกรหัสผ่านใหม่"}</button>
        </form>
        <div className="auth-links">
          {mode === "login" && <><button onClick={() => switchMode("forgot")}>ลืมรหัสผ่าน</button><button onClick={() => switchMode("register")}>สมัครสมาชิก</button></>}
          {mode !== "login" && <button onClick={() => switchMode("login")}>กลับไปหน้าเข้าสู่ระบบ</button>}
          {mode === "reset" && <button onClick={() => switchMode("forgot")}>ขอรหัสใหม่</button>}
        </div>
      </section>
    </main>
  );
}

export function UserAccountPage({ user, onBack, onLogout }: { user: AuthUser; onBack: () => void; onLogout: () => void }) {
  return (
    <section className="dedicated-page account-page">
      <div className="dedicated-page-header">
        <div><p className="eyebrow">USER ACCOUNT</p><h2>บัญชีผู้ใช้</h2><p className="page-copy">ข้อมูลสมาชิกและสิทธิ์การใช้งาน LiveFlow</p></div>
        <button className="ghost-btn" onClick={onBack}><Activity size={14} /> กลับหน้าภาพรวม</button>
      </div>
      <section className="panel account-profile-card">
        <div className="account-avatar">{user.displayName.slice(0, 1).toUpperCase()}</div>
        <div><h3>{user.displayName}</h3><p>{user.email}</p>{user.phone && <p><Phone size={14} /> {user.phone}</p>}<span className={`account-role ${user.role}`}>{user.role === "admin" ? "ผู้ดูแลระบบ" : "สมาชิก"}</span></div>
      </section>
      <section className="panel account-details-grid">
        <div><span>สถานะบัญชี</span><strong>{user.isActive ? "เปิดใช้งาน" : "ระงับการใช้งาน"}</strong></div>
        <div><span>แพ็กเกจ</span><strong>{packageDisplayName(user.planCode)}</strong></div>
        <div><span>KEYBOARD MAPPING</span><strong>{user.keyboardRuleLimit < 0 ? "ไม่จำกัด" : `สูงสุด ${user.keyboardRuleLimit} รายการ`}</strong></div>
        <div><span>วันเริ่มใช้งาน</span><strong>{user.accessStartsAt ? user.accessStartsAt.slice(0, 10) : "ไม่กำหนด"}</strong></div>
        <div><span>วันหมดอายุ</span><strong>{user.accessExpiresAt ? user.accessExpiresAt.slice(0, 10) : "ไม่กำหนด"}</strong></div>
        <div><span>วันที่สมัคร</span><strong>{user.createdAt}</strong></div>
        <div><span>เข้าสู่ระบบล่าสุด</span><strong>{user.lastLoginAt || "ครั้งแรก"}</strong></div>
      </section>
      <button className="account-logout-btn" onClick={onLogout}><LogOut size={16} /> ออกจากระบบ</button>
    </section>
  );
}

function dateInputValue(value?: string | null) {
  return value ? value.slice(0, 10) : "";
}

function AdminUserCard({ user, currentUser, sessionToken: _sessionToken, onSaved, onClose }: { user: AuthUser; currentUser: AuthUser; sessionToken: string; onSaved: () => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(user);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => setDraft(user), [user]);

  const save = async () => {
    setSaving(true);
    setFeedback("");
    try {
      const { error } = await neon.from("liveflow_profiles").update({
        role: draft.role, is_active: draft.isActive, plan_code: draft.planCode || "free",
        access_starts_at: dateInputValue(draft.accessStartsAt) || null,
        access_expires_at: dateInputValue(draft.accessExpiresAt) ? `${dateInputValue(draft.accessExpiresAt)}T23:59:59Z` : null,
        keyboard_rule_limit: Number(draft.keyboardRuleLimit) || 0, updated_at: new Date().toISOString(),
      }).eq("auth_user_id", draft.id);
      if (error) throw new Error(error.message);
      setFeedback("บันทึกแล้ว");
      await onSaved();
      onClose();
    } catch (error) { setFeedback(String(error)); } finally { setSaving(false); }
  };

  const applyPackage = (months: number, planCode: string, limit: number) => {
    const starts = new Date();
    const expires = months > 0 ? new Date() : null;
    if (expires) expires.setMonth(expires.getMonth() + months);
    setDraft((current) => ({ ...current, planCode, keyboardRuleLimit: limit, isActive: true, accessStartsAt: starts.toISOString(), accessExpiresAt: expires?.toISOString() ?? null }));
  };

  return <article className="admin-member-card admin-member-editor">
    <div className="admin-member-head"><div><strong>ตั้งค่าสมาชิก: {draft.displayName}</strong><small>{draft.email}</small><small>{draft.phone || "ยังไม่มีเบอร์โทร"}</small></div><div className="admin-member-head-actions"><span className={`member-access ${draft.accessStatus}`}>{draft.accessStatus === "active" ? "ใช้งานได้" : draft.accessStatus === "expired" ? "หมดอายุ" : "ยังไม่เริ่ม"}</span><button className="admin-modal-close" onClick={onClose} title="ปิด"><X size={17} /></button></div></div>
    <div className="admin-member-fields">
      <label>สิทธิ์<select value={draft.role} disabled={draft.id === currentUser.id} onChange={(event) => setDraft({ ...draft, role: event.target.value as AuthUser["role"] })}><option value="user">User</option><option value="admin">Admin</option></select></label>
      <label>แพ็กเกจ<select value={packageByCode(draft.planCode)?.code ?? "free"} onChange={(event) => { const selected = packageByCode(event.target.value); setDraft({ ...draft, planCode: selected?.code ?? "free", keyboardRuleLimit: selected?.limit ?? 10 }); }}><option value="free">แพ็กเกจฟรี</option>{MEMBERSHIP_PACKAGES.map((item) => <option key={item.code} value={item.code}>{item.name}{item.months > 0 ? ` · ${item.months} เดือน · ${item.price} บาท` : " · ไม่จำกัด"}</option>)}</select></label>
      <label>วันเริ่มใช้<input type="date" value={dateInputValue(draft.accessStartsAt)} onChange={(event) => setDraft({ ...draft, accessStartsAt: event.target.value })} /></label>
      <label>วันหมดอายุ<input type="date" value={dateInputValue(draft.accessExpiresAt)} onChange={(event) => setDraft({ ...draft, accessExpiresAt: event.target.value })} /></label>
      <label>กฎคีย์บอร์ดสูงสุด<input type="number" min={-1} max={10000} value={draft.keyboardRuleLimit} onChange={(event) => setDraft({ ...draft, keyboardRuleLimit: Number(event.target.value) })} /><small>-1 หมายถึงไม่จำกัด</small></label>
    </div>
    <div className="admin-package-shortcuts">{MEMBERSHIP_PACKAGES.map((item) => <button key={item.code} className={packageByCode(draft.planCode)?.code === item.code ? "selected" : ""} onClick={() => applyPackage(item.months, item.code, item.limit)}>{item.name}{item.price > 0 ? ` · ${item.price} บาท` : " · ไม่จำกัด"}</button>)}</div>
    <div className="admin-member-actions"><button className={`admin-status-btn ${draft.isActive ? "active" : "blocked"}`} disabled={draft.id === currentUser.id} onClick={() => setDraft({ ...draft, isActive: !draft.isActive })}>{draft.isActive ? "บัญชีเปิดอยู่" : "ระงับบัญชี"}</button><button className="admin-save-btn" onClick={() => void save()} disabled={saving}><Save size={14} /> {saving ? "กำลังบันทึก" : "บันทึกสิทธิ์"}</button>{feedback && <small>{feedback}</small>}</div>
  </article>;
}

export function AdminPage({ sessionToken, currentUser, onBack }: { sessionToken: string; currentUser: AuthUser; onBack: () => void }) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [updateInfo, setUpdateInfo] = useState<SystemUpdateInfo>({ currentVersion: "0.1.8", requiredVersion: "0.1.8", forceUpdate: false, updateUrl: "", message: "" });
  const [announcementForm, setAnnouncementForm] = useState({ title: "", message: "", imageUrl: "", displayMode: "banner", startsAt: "", endsAt: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [memberFilter, setMemberFilter] = useState("all");
  const [memberPage, setMemberPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const membersPerPage = 10;

  const loadAdminData = async () => {
    setLoading(true); setError("");
    try {
      const [profilesResult, announcementsResult, updateResult] = await Promise.all([
        neon.from("liveflow_profiles").select("*").order("created_at", { ascending: false }),
        neon.from("liveflow_auth_announcements").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(100),
        neon.from("liveflow_auth_system_update").select("*").eq("id", 1).single(),
      ]);
      if (profilesResult.error) throw new Error(profilesResult.error.message);
      if (announcementsResult.error) throw new Error(announcementsResult.error.message);
      if (updateResult.error) throw new Error(updateResult.error.message);
      const nextUsers = (profilesResult.data || []).map((row) => profileToAuthUser(row as LiveFlowProfileRow));
      const nextAnnouncements = (announcementsResult.data || []).map((row: any) => ({ id: row.id, title: row.title, message: row.message, imageUrl: row.image_url, displayMode: row.display_mode, startsAt: row.starts_at, endsAt: row.ends_at, createdAt: row.created_at })) as Announcement[];
      const row: any = updateResult.data;
      const nextUpdate: SystemUpdateInfo = { currentVersion: "0.1.8", requiredVersion: row.required_version, forceUpdate: row.force_update, updateUrl: row.update_url, message: row.message };
      setUsers(nextUsers); setAnnouncements(nextAnnouncements); setUpdateInfo(nextUpdate);
    } catch (loadError) { setError(String(loadError)); } finally { setLoading(false); }
  };
  useEffect(() => { void loadAdminData(); }, [sessionToken]);

  const normalizedSearch = memberSearch.trim().toLocaleLowerCase("th");
  const filteredUsers = users.filter((user) => {
    const matchesSearch = !normalizedSearch || [user.displayName, user.email, user.phone || "", user.planCode || "free", packageDisplayName(user.planCode)].some((value) => value.toLocaleLowerCase("th").includes(normalizedSearch));
    const matchesFilter = memberFilter === "all" || (memberFilter === "active" && user.isActive && user.accessStatus === "active") || (memberFilter === "expired" && user.accessStatus === "expired") || (memberFilter === "suspended" && !user.isActive) || memberFilter === user.role;
    return matchesSearch && matchesFilter;
  });
  const memberPageCount = Math.max(1, Math.ceil(filteredUsers.length / membersPerPage));
  const safeMemberPage = Math.min(memberPage, memberPageCount);
  const visibleUsers = filteredUsers.slice((safeMemberPage - 1) * membersPerPage, safeMemberPage * membersPerPage);
  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;

  const publishAnnouncement = async () => {
    setError(""); setMessage("");
    try {
      const { error } = await neon.from("liveflow_auth_announcements").insert({ title: announcementForm.title, message: announcementForm.message, image_url: announcementForm.imageUrl || null, display_mode: announcementForm.displayMode, starts_at: announcementForm.startsAt || null, ends_at: announcementForm.endsAt ? `${announcementForm.endsAt}T23:59:59Z` : null });
      if (error) throw new Error(error.message);
      setMessage("เผยแพร่ประกาศเรียบร้อยแล้ว"); setAnnouncementForm({ title: "", message: "", imageUrl: "", displayMode: "banner", startsAt: "", endsAt: "" }); await loadAdminData();
    } catch (publishError) { setError(String(publishError)); }
  };

  const selectAnnouncementImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    if (!file.type.startsWith("image/")) { setError("กรุณาเลือกไฟล์รูปภาพเท่านั้น"); return; }
    if (file.size > 3 * 1024 * 1024) { setError("รูปภาพต้องมีขนาดไม่เกิน 3 MB"); return; }
    const reader = new FileReader();
    reader.onload = () => setAnnouncementForm((current) => ({ ...current, imageUrl: String(reader.result || ""), displayMode: current.displayMode === "ticker" ? "image" : current.displayMode }));
    reader.onerror = () => setError("อ่านไฟล์รูปภาพไม่สำเร็จ");
    reader.readAsDataURL(file);
  };

  const saveUpdatePolicy = async () => {
    setError(""); setMessage("");
    try {
      const { error } = await neon.from("liveflow_auth_system_update").update({ required_version: updateInfo.requiredVersion, force_update: updateInfo.forceUpdate, update_url: updateInfo.updateUrl, message: updateInfo.message, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) throw new Error(error.message);
      setMessage("บันทึกนโยบายอัปเดตเรียบร้อยแล้ว"); await loadAdminData();
    } catch (saveError) { setError(String(saveError)); }
  };

  return <section className="dedicated-page admin-page">
    <div className="dedicated-page-header"><div><p className="eyebrow">ADMIN CONTROL</p><h2>ศูนย์จัดการระบบ</h2><p className="page-copy">สมาชิก แพ็กเกจ ประกาศ และนโยบายอัปเดต</p></div><div className="admin-header-actions"><button className="ghost-btn" onClick={() => void loadAdminData()}><RefreshCw size={14} /> รีเฟรช</button><button className="ghost-btn" onClick={onBack}><Activity size={14} /> กลับหน้าภาพรวม</button></div></div>
    {error && <div className="auth-alert error">{error}</div>}{message && <div className="auth-alert success">{message}</div>}
    <section className="panel admin-summary"><div><span>สมาชิกทั้งหมด</span><strong>{users.length}</strong></div><div><span>เปิดใช้งาน</span><strong>{users.filter((user) => user.isActive && user.accessStatus === "active").length}</strong></div><div><span>หมดอายุ</span><strong>{users.filter((user) => user.accessStatus === "expired").length}</strong></div><div><span>Admin</span><strong>{users.filter((user) => user.role === "admin").length}</strong></div></section>

    <section className="panel admin-section admin-members-section">
      <div className="admin-section-title"><PackageCheck /><div><h3>จัดการสมาชิกและแพ็กเกจ</h3><p>ค้นหาสมาชิกจากตาราง แล้วเปิดแก้ไขเฉพาะคนที่ต้องการ</p></div></div>
      <div className="admin-member-toolbar">
        <label className="admin-member-search"><Search size={16} /><input value={memberSearch} onChange={(event) => { setMemberSearch(event.target.value); setMemberPage(1); }} placeholder="ค้นหาชื่อ อีเมล เบอร์โทร หรือแพ็กเกจ" /></label>
        <select value={memberFilter} onChange={(event) => { setMemberFilter(event.target.value); setMemberPage(1); }} aria-label="กรองสมาชิก"><option value="all">สมาชิกทั้งหมด</option><option value="active">ใช้งานได้</option><option value="expired">หมดอายุ</option><option value="suspended">ถูกระงับ</option><option value="user">User</option><option value="admin">Admin</option></select>
      </div>
      {loading ? <div className="auth-loading-inline">กำลังโหลดสมาชิก...</div> : <>
        <div className="admin-members-table-wrap"><table className="admin-members-table"><thead><tr><th>สมาชิก</th><th>สิทธิ์</th><th>แพ็กเกจ</th><th>วันหมดอายุ</th><th>กฎสูงสุด</th><th>สถานะ</th><th>จัดการ</th></tr></thead><tbody>{visibleUsers.map((user) => <tr key={user.id}><td><strong>{user.displayName}</strong><small>{user.email}</small><small>{user.phone || "ไม่มีเบอร์โทร"}</small></td><td><span className={`admin-role-pill ${user.role}`}>{user.role === "admin" ? "Admin" : "User"}</span></td><td>{packageDisplayName(user.planCode)}</td><td>{dateInputValue(user.accessExpiresAt) || "ไม่กำหนด"}</td><td>{user.keyboardRuleLimit < 0 ? "ไม่จำกัด" : user.keyboardRuleLimit}</td><td><span className={`member-access ${!user.isActive ? "suspended" : user.accessStatus}`}>{!user.isActive ? "ระงับ" : user.accessStatus === "active" ? "ใช้งานได้" : user.accessStatus === "expired" ? "หมดอายุ" : "ยังไม่เริ่ม"}</span></td><td><button className="admin-edit-member-btn" onClick={() => setSelectedUserId(user.id)}><Pencil size={14} /> จัดการ</button></td></tr>)}</tbody></table>{visibleUsers.length === 0 && <div className="admin-members-empty">ไม่พบสมาชิกที่ค้นหา</div>}</div>
        <div className="admin-members-pagination"><span>แสดง {visibleUsers.length} จาก {filteredUsers.length} คน</span><div><button disabled={safeMemberPage <= 1} onClick={() => setMemberPage((page) => Math.max(1, page - 1))} title="หน้าก่อนหน้า"><ChevronLeft size={15} /></button><b>หน้า {safeMemberPage} / {memberPageCount}</b><button disabled={safeMemberPage >= memberPageCount} onClick={() => setMemberPage((page) => Math.min(memberPageCount, page + 1))} title="หน้าถัดไป"><ChevronRight size={15} /></button></div></div>
      </>}
    </section>
    {selectedUser && <div className="admin-member-modal" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedUserId(null); }}><AdminUserCard user={selectedUser} currentUser={currentUser} sessionToken={sessionToken} onSaved={loadAdminData} onClose={() => setSelectedUserId(null)} /></div>}

    <section className="panel admin-section"><div className="admin-section-title"><Megaphone /><div><h3>Announcement Center</h3><p>อัปโหลดรูปจากเครื่อง หรือสร้างประกาศแบบแถบ ตัวหนังสือวิ่ง และหน้าต่างสำคัญ</p></div></div><div className="announcement-editor"><label>หัวข้อ<input value={announcementForm.title} onChange={(event) => setAnnouncementForm({ ...announcementForm, title: event.target.value })} /></label><label>รูปแบบ<select value={announcementForm.displayMode} onChange={(event) => setAnnouncementForm({ ...announcementForm, displayMode: event.target.value })}><option value="banner">แถบประกาศ</option><option value="ticker">ตัวหนังสือวิ่ง</option><option value="modal">หน้าต่างสำคัญ</option><option value="image">ประกาศเป็นรูปภาพ</option></select></label><label className="wide">ข้อความ<textarea value={announcementForm.message} onChange={(event) => setAnnouncementForm({ ...announcementForm, message: event.target.value })} /></label><label>อัปโหลดรูปภาพ<input type="file" accept="image/*" onChange={selectAnnouncementImage} /></label><label>หรือ URL รูปภาพ<input value={announcementForm.imageUrl.startsWith("data:") ? "อัปโหลดรูปจากเครื่องแล้ว" : announcementForm.imageUrl} onChange={(event) => setAnnouncementForm({ ...announcementForm, imageUrl: event.target.value })} placeholder="ไม่บังคับ" disabled={announcementForm.imageUrl.startsWith("data:")} /></label>{announcementForm.imageUrl && <div className="announcement-image-preview wide"><img src={announcementForm.imageUrl} alt="ตัวอย่างประกาศ" /><button onClick={() => setAnnouncementForm({ ...announcementForm, imageUrl: "" })}>เอารูปออก</button></div>}<label>เริ่มแสดง<input type="date" value={announcementForm.startsAt} onChange={(event) => setAnnouncementForm({ ...announcementForm, startsAt: event.target.value })} /></label><label>สิ้นสุด<input type="date" value={announcementForm.endsAt} onChange={(event) => setAnnouncementForm({ ...announcementForm, endsAt: event.target.value })} /></label></div><button className="admin-save-btn" onClick={() => void publishAnnouncement()}><Megaphone size={14} /> เผยแพร่ประกาศ</button><div className="announcement-list">{announcements.map((item) => <article key={item.id}>{item.imageUrl && <img src={item.imageUrl} alt="" />}<div><strong>{item.title}</strong><p>{item.message}</p><small>{item.displayMode} · {item.createdAt}</small></div><button title="ลบประกาศ" onClick={async () => { const { error } = await neon.from("liveflow_auth_announcements").update({ is_active: false }).eq("id", item.id); if (error) setError(error.message); await loadAdminData(); }}><Trash2 size={14} /></button></article>)}</div></section>

    <section className="panel admin-section"><div className="admin-section-title"><RefreshCw /><div><h3>บังคับอัปเดตโปรแกรม</h3><p>กำหนดเวอร์ชันขั้นต่ำและลิงก์ดาวน์โหลด Installer ใหม่</p></div></div><div className="update-policy-grid"><label>เวอร์ชันที่บังคับ<input value={updateInfo.requiredVersion} onChange={(event) => setUpdateInfo({ ...updateInfo, requiredVersion: event.target.value })} /></label><label>ลิงก์ดาวน์โหลด<input value={updateInfo.updateUrl} onChange={(event) => setUpdateInfo({ ...updateInfo, updateUrl: event.target.value })} /></label><label className="wide">ข้อความแจ้งอัปเดต<input value={updateInfo.message} onChange={(event) => setUpdateInfo({ ...updateInfo, message: event.target.value })} /></label><label className="update-force-toggle"><input type="checkbox" checked={updateInfo.forceUpdate} onChange={(event) => setUpdateInfo({ ...updateInfo, forceUpdate: event.target.checked })} /> บังคับให้ผู้ใช้ติดตั้งเวอร์ชันใหม่ก่อนใช้งาน</label></div><button className="admin-save-btn" onClick={() => void saveUpdatePolicy()}><Save size={14} /> บันทึกนโยบายอัปเดต</button></section>
  </section>;
}

export function SubscriptionPage({ user, onBack }: { user: AuthUser; onBack: () => void }) {
  const activePackage = packageByCode(user.planCode);
  const [selectedMonths, setSelectedMonths] = useState(activePackage?.months ?? 1);
  const selectedPackage = MEMBERSHIP_PACKAGES.find((item) => item.months === selectedMonths) ?? MEMBERSHIP_PACKAGES[0];
  const promptPayPayload = selectedPackage.price > 0 ? generatePromptPayPayload("0970219542", { amount: selectedPackage.price }) : generatePromptPayPayload("0970219542", {});
  const openFacebook = async () => {
    try {
      if (isTauri()) await invoke("open_facebook_payment");
      else window.open("https://www.facebook.com/tabaa.boonanan/", "_blank", "noopener,noreferrer");
    } catch {
      window.open("https://www.facebook.com/tabaa.boonanan/", "_blank", "noopener,noreferrer");
    }
  };
  return <section className="dedicated-page subscription-page"><div className="dedicated-page-header"><div><p className="eyebrow">LIVEFLOW PACKAGES</p><h2>ต่ออายุและเพิ่มจำนวนกฎ</h2><p className="page-copy">เลือกแพ็กเกจ สแกน PromptPay แล้วส่งสลิปให้ผู้ดูแลเปิดใช้งาน</p></div><button className="ghost-btn" onClick={onBack}><Activity size={14} /> กลับหน้าภาพรวม</button></div><section className="panel current-plan-card"><PackageCheck /><div><span>แพ็กเกจที่เลือก</span><strong>{selectedPackage.name}</strong><small>{selectedPackage.months > 0 ? `${selectedPackage.months} เดือน · ` : ""}KEYBOARD MAPPING {selectedPackage.limit < 0 ? "ไม่จำกัด" : `สูงสุด ${selectedPackage.limit} รายการ`}{selectedPackage.price > 0 ? ` · ${selectedPackage.price} บาท` : ""}</small><em>แพ็กเกจที่ใช้งานอยู่: {packageDisplayName(user.planCode)}{user.accessExpiresAt ? ` · หมดอายุ ${dateInputValue(user.accessExpiresAt)}` : ""}</em></div></section><div className="package-grid">{MEMBERSHIP_PACKAGES.map((item) => <article key={item.code} className={`package-card ${selectedMonths === item.months ? "selected" : ""}`}><CalendarDays /><h3>{item.name}</h3><small>{item.description}</small><strong>{item.price > 0 ? `${item.price} บาท` : "Unlimited"}</strong><span>{item.months > 0 ? `ระยะเวลา ${item.months} เดือน · ` : ""}รองรับกฎคีย์บอร์ด {item.limit < 0 ? "ไม่จำกัด" : `${item.limit} รายการ`}</span><button onClick={() => setSelectedMonths(item.months)}>{selectedMonths === item.months ? "เลือกแล้ว" : "เลือกแพ็กเกจนี้"}</button></article>)}</div><section className="panel promptpay-card promptpay-qr-card"><div className="promptpay-qr"><QRCodeSVG value={promptPayPayload} size={210} level="M" marginSize={2} title={selectedPackage.price > 0 ? `PromptPay ${selectedPackage.price} บาท` : "PromptPay"} /></div><div className="promptpay-detail"><CreditCard /><span>{selectedPackage.name}</span><strong>{selectedPackage.price > 0 ? `${selectedPackage.price} บาท` : "ติดต่อผู้ดูแล"}</strong><b>097-021-9542</b><p>{selectedPackage.price > 0 ? "QR นี้ระบุยอดเงินตามแพ็กเกจที่เลือกแล้ว" : "แพ็กเกจ Unlimited ให้ผู้ดูแลกำหนดราคาและเปิดสิทธิ์เป็นรายบัญชี"} หลังชำระกรุณาส่งสลิปพร้อมแจ้งอีเมลบัญชี LiveFlow</p><button className="facebook-slip-btn" onClick={() => void openFacebook()}><ExternalLink size={14} /> ส่งสลิปยืนยันทาง Facebook</button></div></section></section>;
}
