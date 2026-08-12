use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, SaltString};
use argon2::{Argon2, PasswordVerifier};
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct AppState;

impl Drop for AppState {
    fn drop(&mut self) {
        if let Ok(mut guard) = tiktok_connector_stdin().lock() {
            if let Some(mut stdin) = guard.take() {
                let _ = stdin.write_all(b"stop\n");
                let _ = stdin.flush();
            }
        }
    }
}

static OVERLAY_TUNNEL_URL: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static TIKTOK_CONNECTOR_STDIN: OnceLock<Mutex<Option<ChildStdin>>> = OnceLock::new();
static TIKTOK_EVENT_QUEUE: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
static ACTIVE_USER_ID: OnceLock<Mutex<Option<i64>>> = OnceLock::new();
static TIKTOK_EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TIKTOK_RUNTIME_LOG_FILE: &str = "liveflow-tiktok-runtime.log";

fn configured_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn active_user_id() -> &'static Mutex<Option<i64>> {
    ACTIVE_USER_ID.get_or_init(|| Mutex::new(None))
}

#[derive(serde::Deserialize)]
pub struct CloudflareDeployRequest {
    pub api_token: String,
    pub account_id: String,
    pub script_name: String,
    pub kind: String,
}

#[derive(serde::Deserialize)]
pub struct OverlayTunnelRequest {
    pub local_url: String,
    pub public_path: String,
}

#[derive(Deserialize, Clone)]
pub struct ChatLogEntry {
    pub event_type: String,
    pub username: Option<String>,
    pub message: Option<String>,
    pub gift_name: Option<String>,
    pub repeat_count: Option<i32>,
    pub raw_json: Option<Value>,
}

#[derive(Serialize)]
pub struct ChatLogRow {
    pub id: i64,
    pub event_type: String,
    pub username: String,
    pub message: String,
    pub gift_name: Option<String>,
    pub repeat_count: i32,
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub display_name: String,
    pub email: String,
    pub phone: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPasswordRequest {
    pub email: String,
    pub reset_code: String,
    pub new_password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdateUserRequest {
    pub session_token: String,
    pub user_id: i64,
    pub role: String,
    pub is_active: bool,
    pub plan_code: String,
    pub access_starts_at: Option<String>,
    pub access_expires_at: Option<String>,
    pub keyboard_rule_limit: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementRequest {
    pub session_token: String,
    pub title: String,
    pub message: String,
    pub image_url: Option<String>,
    pub display_mode: String,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    pub id: i64,
    pub title: String,
    pub message: String,
    pub image_url: Option<String>,
    pub display_mode: String,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSystemUpdateRequest {
    pub session_token: String,
    pub required_version: String,
    pub force_update: bool,
    pub update_url: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUpdateInfo {
    pub current_version: String,
    pub required_version: String,
    pub force_update: bool,
    pub update_url: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: i64,
    pub display_name: String,
    pub email: String,
    pub phone: Option<String>,
    pub role: String,
    pub is_active: bool,
    pub plan_code: String,
    pub access_starts_at: Option<String>,
    pub access_expires_at: Option<String>,
    pub keyboard_rule_limit: i32,
    pub access_status: String,
    pub created_at: String,
    pub last_login_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub session_token: String,
    pub user: AuthUser,
}

fn overlay_tunnel_cache() -> &'static Mutex<Option<String>> {
    OVERLAY_TUNNEL_URL.get_or_init(|| Mutex::new(None))
}

fn tiktok_connector_stdin() -> &'static Mutex<Option<ChildStdin>> {
    TIKTOK_CONNECTOR_STDIN.get_or_init(|| Mutex::new(None))
}

fn tiktok_event_queue() -> &'static Mutex<VecDeque<Value>> {
    TIKTOK_EVENT_QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn append_tiktok_runtime_log(event: &Value) {
    let path = std::env::temp_dir().join(TIKTOK_RUNTIME_LOG_FILE);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", event);
    }
}

fn publish_tiktok_event(app: &AppHandle, mut event: Value) {
    if let Some(object) = event.as_object_mut() {
        object.insert(
            "_event_id".to_string(),
            Value::String(
                TIKTOK_EVENT_SEQUENCE
                    .fetch_add(1, Ordering::Relaxed)
                    .to_string(),
            ),
        );
    }

    append_tiktok_runtime_log(&event);

    if let Ok(mut queue) = tiktok_event_queue().lock() {
        queue.push_back(event.clone());
        while queue.len() > 1_000 {
            queue.pop_front();
        }
    }

    let _ = app.emit("tiktok-event", event);
}

fn normalize_email(email: &str) -> Result<String, String> {
    let normalized = email.trim().to_lowercase();
    let valid = normalized.len() <= 254
        && normalized.contains('@')
        && !normalized.starts_with('@')
        && !normalized.ends_with('@');
    if valid {
        Ok(normalized)
    } else {
        Err("รูปแบบอีเมลไม่ถูกต้อง".to_string())
    }
}

fn validate_password(password: &str) -> Result<(), String> {
    let valid = password.chars().count() >= 8
        && password.chars().any(|ch| ch.is_ascii_uppercase())
        && password.chars().any(|ch| ch.is_ascii_lowercase())
        && password.chars().any(|ch| ch.is_ascii_digit())
        && password.chars().any(|ch| !ch.is_alphanumeric());
    if valid {
        Ok(())
    } else {
        Err("รหัสผ่านต้องมีอย่างน้อย 8 ตัว และมีตัวพิมพ์ใหญ่ ตัวพิมพ์เล็ก ตัวเลข และสัญลักษณ์".to_string())
    }
}

fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| format!("เข้ารหัสรหัสผ่านไม่สำเร็จ: {error}"))
}

fn verify_password(password: &str, password_hash: &str) -> bool {
    PasswordHash::new(password_hash)
        .ok()
        .and_then(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .ok()
        })
        .is_some()
}

fn generate_session_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn normalize_phone(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let has_country_code = trimmed.starts_with('+');
    let digits: String = trimmed
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect();
    if digits.len() < 8 || digits.len() > 15 {
        return Err("เบอร์โทรศัพท์ต้องมีตัวเลข 8–15 หลัก".to_string());
    }
    if trimmed.chars().any(|character| {
        !character.is_ascii_digit() && !matches!(character, '+' | ' ' | '-' | '(' | ')')
    }) {
        return Err("รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง".to_string());
    }
    Ok(if has_country_code {
        format!("+{digits}")
    } else {
        digits
    })
}

async fn ensure_auth_schema(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS liveflow_users (
            id BIGSERIAL PRIMARY KEY,
            display_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            phone TEXT,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            plan_code TEXT NOT NULL DEFAULT 'free',
            access_starts_at TIMESTAMPTZ,
            access_expires_at TIMESTAMPTZ,
            keyboard_rule_limit INTEGER NOT NULL DEFAULT 10,
            failed_login_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_login_at TIMESTAMPTZ
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("สร้างตารางสมาชิกไม่สำเร็จ: {error}"))?;

    sqlx::query("ALTER TABLE liveflow_users ADD COLUMN IF NOT EXISTS phone TEXT")
        .execute(pool)
        .await
        .map_err(|error| format!("เพิ่มข้อมูลเบอร์โทรศัพท์ไม่สำเร็จ: {error}"))?;
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS liveflow_users_phone_unique ON liveflow_users (phone) WHERE phone IS NOT NULL")
        .execute(pool)
        .await
        .map_err(|error| format!("สร้างดัชนีเบอร์โทรศัพท์ไม่สำเร็จ: {error}"))?;
    sqlx::query("ALTER TABLE liveflow_users ADD COLUMN IF NOT EXISTS plan_code TEXT NOT NULL DEFAULT 'free'")
        .execute(pool).await.map_err(|error| format!("เพิ่มข้อมูลแพ็กเกจไม่สำเร็จ: {error}"))?;
    sqlx::query("ALTER TABLE liveflow_users ADD COLUMN IF NOT EXISTS access_starts_at TIMESTAMPTZ")
        .execute(pool)
        .await
        .map_err(|error| format!("เพิ่มวันเริ่มใช้งานไม่สำเร็จ: {error}"))?;
    sqlx::query(
        "ALTER TABLE liveflow_users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("เพิ่มวันหมดอายุไม่สำเร็จ: {error}"))?;
    sqlx::query("ALTER TABLE liveflow_users ADD COLUMN IF NOT EXISTS keyboard_rule_limit INTEGER NOT NULL DEFAULT 10")
        .execute(pool).await.map_err(|error| format!("เพิ่มโควตากฎไม่สำเร็จ: {error}"))?;
    sqlx::query("ALTER TABLE liveflow_users ALTER COLUMN keyboard_rule_limit SET DEFAULT 10")
        .execute(pool)
        .await
        .map_err(|error| format!("กำหนดโควตาเริ่มต้นไม่สำเร็จ: {error}"))?;
    sqlx::query("UPDATE liveflow_users SET keyboard_rule_limit = 10, updated_at = NOW() WHERE plan_code = 'free' AND keyboard_rule_limit = 3")
        .execute(pool).await.map_err(|error| format!("ปรับโควตาบัญชีเริ่มต้นไม่สำเร็จ: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS liveflow_sessions (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES liveflow_users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("สร้างตาราง session ไม่สำเร็จ: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS liveflow_password_resets (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES liveflow_users(id) ON DELETE CASCADE,
            code_hash TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("สร้างตาราง reset password ไม่สำเร็จ: {error}"))?;

    sqlx::query("ALTER TABLE liveflow_password_resets ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await
        .map_err(|error| format!("อัปเดตตาราง reset password ไม่สำเร็จ: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS liveflow_announcements (
            id BIGSERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            image_url TEXT,
            display_mode TEXT NOT NULL DEFAULT 'banner',
            starts_at TIMESTAMPTZ,
            ends_at TIMESTAMPTZ,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_by BIGINT REFERENCES liveflow_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("สร้างตารางประกาศไม่สำเร็จ: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS liveflow_system_update (
            id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            required_version TEXT NOT NULL DEFAULT '0.1.0',
            force_update BOOLEAN NOT NULL DEFAULT FALSE,
            update_url TEXT NOT NULL DEFAULT '',
            message TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("สร้างการตั้งค่าอัปเดตไม่สำเร็จ: {error}"))?;
    sqlx::query("INSERT INTO liveflow_system_update (id) VALUES (1) ON CONFLICT (id) DO NOTHING")
        .execute(pool)
        .await
        .map_err(|error| format!("ตั้งค่าเวอร์ชันเริ่มต้นไม่สำเร็จ: {error}"))?;

    sqlx::query("DELETE FROM liveflow_sessions WHERE expires_at <= NOW()")
        .execute(pool)
        .await
        .map_err(|error| format!("ล้าง session หมดอายุไม่สำเร็จ: {error}"))?;
    sqlx::query(
        "DELETE FROM liveflow_password_resets WHERE expires_at <= NOW() OR used_at IS NOT NULL",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("ล้าง reset code หมดอายุไม่สำเร็จ: {error}"))?;

    if let (Some(admin_email), Some(admin_password)) = (
        configured_value("LIVEFLOW_ADMIN_EMAIL"),
        configured_value("LIVEFLOW_ADMIN_PASSWORD"),
    ) {
        let email = normalize_email(&admin_email)?;
        let existing_id =
            sqlx::query_scalar::<_, i64>("SELECT id FROM liveflow_users WHERE email = $1")
                .bind(&email)
                .fetch_optional(pool)
                .await
                .map_err(|error| format!("ตรวจบัญชี Admin ไม่สำเร็จ: {error}"))?;
        if let Some(user_id) = existing_id {
            sqlx::query("UPDATE liveflow_users SET role = 'admin', is_active = TRUE, updated_at = NOW() WHERE id = $1")
                .bind(user_id)
                .execute(pool)
                .await
                .map_err(|error| format!("อัปเดตสิทธิ์ Admin ไม่สำเร็จ: {error}"))?;
        } else {
            validate_password(&admin_password)?;
            let password_hash = hash_password(&admin_password)?;
            sqlx::query(
                "INSERT INTO liveflow_users (display_name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')",
            )
            .bind("LiveFlow Admin")
            .bind(email)
            .bind(password_hash)
            .execute(pool)
            .await
            .map_err(|error| format!("สร้างบัญชี Admin ไม่สำเร็จ: {error}"))?;
        }
    }

    Ok(())
}

fn auth_user_from_row(row: &sqlx::postgres::PgRow) -> AuthUser {
    AuthUser {
        id: row.get::<i64, _>("id"),
        display_name: row.get::<String, _>("display_name"),
        email: row.get::<String, _>("email"),
        phone: row.try_get::<String, _>("phone").ok(),
        role: row.get::<String, _>("role"),
        is_active: row.get::<bool, _>("is_active"),
        plan_code: row.get::<String, _>("plan_code"),
        access_starts_at: row.try_get::<String, _>("access_starts_at").ok(),
        access_expires_at: row.try_get::<String, _>("access_expires_at").ok(),
        keyboard_rule_limit: row.get::<i32, _>("keyboard_rule_limit"),
        access_status: row.get::<String, _>("access_status"),
        created_at: row.get::<String, _>("created_at"),
        last_login_at: row.try_get::<String, _>("last_login_at").ok(),
    }
}

async fn authenticate_session(pool: &PgPool, session_token: &str) -> Result<AuthUser, String> {
    let hash = token_hash(session_token.trim());
    let row = sqlx::query(
        r#"
        SELECT u.id, u.display_name, u.email, u.phone, u.role, u.is_active,
               u.plan_code, u.keyboard_rule_limit,
               u.access_starts_at::text AS access_starts_at,
               u.access_expires_at::text AS access_expires_at,
               CASE
                   WHEN u.role = 'admin' THEN 'active'
                   WHEN u.access_starts_at IS NOT NULL AND u.access_starts_at > NOW() THEN 'not_started'
                   WHEN u.access_expires_at IS NOT NULL AND u.access_expires_at < NOW() THEN 'expired'
                   ELSE 'active'
               END AS access_status,
               u.created_at::text AS created_at,
               u.last_login_at::text AS last_login_at
        FROM liveflow_sessions s
        JOIN liveflow_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE
        "#,
    )
    .bind(hash)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("ตรวจสอบ session ไม่สำเร็จ: {error}"))?
    .ok_or_else(|| "Session หมดอายุ กรุณาเข้าสู่ระบบใหม่".to_string())?;
    let user = auth_user_from_row(&row);
    if let Ok(mut active_id) = active_user_id().lock() {
        *active_id = Some(user.id);
    }
    Ok(user)
}

fn send_reset_email(recipient: &str, reset_code: &str) -> Result<(), String> {
    let host = configured_value("SMTP_HOST").ok_or_else(|| "ยังไม่ได้ตั้งค่า SMTP_HOST".to_string())?;
    let port = configured_value("SMTP_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(587);
    let username =
        configured_value("SMTP_USERNAME").ok_or_else(|| "ยังไม่ได้ตั้งค่า SMTP_USERNAME".to_string())?;
    let password = configured_value("SMTP_PASSWORD")
        .ok_or_else(|| "ยังไม่ได้ตั้งค่า SMTP_PASSWORD".to_string())?
        .replace(' ', "");
    let from_email = configured_value("SMTP_FROM_EMAIL").unwrap_or_else(|| username.clone());
    let from_name = configured_value("SMTP_FROM_NAME").unwrap_or_else(|| "LiveFlow".to_string());
    let from: Mailbox = format!("{from_name} <{from_email}>")
        .parse()
        .map_err(|error| format!("อีเมลผู้ส่งไม่ถูกต้อง: {error}"))?;
    let to: Mailbox = recipient
        .parse()
        .map_err(|error| format!("อีเมลผู้รับไม่ถูกต้อง: {error}"))?;
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject("รหัสตั้งรหัสผ่านใหม่สำหรับ LiveFlow")
        .body(format!(
            "รหัสสำหรับตั้งรหัสผ่านใหม่คือ: {reset_code}\n\nรหัสนี้มีอายุ 15 นาที หากคุณไม่ได้ขอเปลี่ยนรหัสผ่าน สามารถละเว้นอีเมลนี้ได้"
        ))
        .map_err(|error| format!("สร้างอีเมลไม่สำเร็จ: {error}"))?;
    let mailer = SmtpTransport::starttls_relay(&host)
        .map_err(|error| format!("ตั้งค่า SMTP ไม่สำเร็จ: {error}"))?
        .port(port)
        .credentials(Credentials::new(username, password))
        .build();
    mailer
        .send(&message)
        .map_err(|error| format!("ส่งอีเมลไม่สำเร็จ: {error}"))?;
    Ok(())
}

async fn connect_database() -> Result<PgPool, String> {
    let database_url = configured_value("DATABASE_URL")
        .ok_or_else(|| "ยังไม่ได้ตั้งค่า DATABASE_URL ใน Backend".to_string())?;

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .map_err(|error| format!("เชื่อมต่อ Neon ไม่สำเร็จ: {error}"))?;

    ensure_auth_schema(&pool).await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS liveflow_app_state (
            state_key TEXT PRIMARY KEY,
            state_json TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(&pool)
    .await
    .map_err(|error| format!("สร้างตาราง Neon ไม่สำเร็จ: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS liveflow_chat_logs (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT REFERENCES liveflow_users(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            message TEXT NOT NULL DEFAULT '',
            gift_name TEXT,
            repeat_count INTEGER NOT NULL DEFAULT 1,
            raw_json TEXT NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(&pool)
    .await
    .map_err(|error| format!("สร้างตาราง log ไม่สำเร็จ: {error}"))?;

    sqlx::query("ALTER TABLE liveflow_chat_logs ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES liveflow_users(id) ON DELETE CASCADE")
        .execute(&pool).await.map_err(|error| format!("แยกเจ้าของ log ไม่สำเร็จ: {error}"))?;
    sqlx::query("CREATE INDEX IF NOT EXISTS liveflow_chat_logs_user_time ON liveflow_chat_logs (user_id, created_at DESC)")
        .execute(&pool).await.map_err(|error| format!("สร้างดัชนี log สมาชิกไม่สำเร็จ: {error}"))?;

    Ok(pool)
}

async fn purge_old_chat_logs(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        DELETE FROM liveflow_chat_logs
        WHERE created_at < NOW() - INTERVAL '10 minutes'
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("ล้าง log เก่าไม่สำเร็จ: {error}"))?;

    Ok(())
}

async fn persist_chat_log(entry: ChatLogEntry) -> Result<(), String> {
    let pool = connect_database().await?;
    let owner_id = active_user_id()
        .lock()
        .map_err(|_| "อ่านเจ้าของ log ไม่สำเร็จ".to_string())?
        .ok_or_else(|| "ยังไม่มีสมาชิกเข้าสู่ระบบ จึงไม่บันทึก log".to_string())?;
    let raw_json = entry
        .raw_json
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string()))
        .unwrap_or_else(|| "{}".to_string());

    sqlx::query(
        r#"
        INSERT INTO liveflow_chat_logs (
            user_id,
            event_type,
            username,
            message,
            gift_name,
            repeat_count,
            raw_json,
            created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        "#,
    )
    .bind(owner_id)
    .bind(entry.event_type)
    .bind(entry.username.unwrap_or_default())
    .bind(entry.message.unwrap_or_default())
    .bind(entry.gift_name)
    .bind(entry.repeat_count.unwrap_or(1).max(1))
    .bind(raw_json)
    .execute(&pool)
    .await
    .map_err(|error| format!("บันทึก log ไม่สำเร็จ: {error}"))?;

    purge_old_chat_logs(&pool).await?;

    Ok(())
}

fn extract_trycloudflare_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let candidate = &line[start..];
    let end = candidate
        .find(char::is_whitespace)
        .unwrap_or(candidate.len());
    let url = candidate[..end].trim_matches('"').trim_matches('\'');
    if url.contains("trycloudflare.com") {
        Some(url.to_string())
    } else {
        None
    }
}

fn build_chat_log_entry(event: &Value) -> Option<ChatLogEntry> {
    let event_type = event.get("type")?.as_str()?.to_string();
    let normalized_event_type = match event_type.as_str() {
        "chat" => "comment".to_string(),
        other => other.to_string(),
    };
    match normalized_event_type.as_str() {
        "comment" | "gift" | "follow" | "like" | "share" | "join" => {
            let username = event
                .get("username")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| {
                    event
                        .get("user")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                });
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| {
                    event
                        .get("gift_name")
                        .and_then(Value::as_str)
                        .map(|gift| format!("ส่งของขวัญ {gift}"))
                });
            let gift_name = event
                .get("gift_name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let repeat_count = event
                .get("repeat_count")
                .and_then(Value::as_i64)
                .map(|value| value as i32)
                .or_else(|| {
                    event
                        .get("repeat_count")
                        .and_then(Value::as_u64)
                        .map(|value| value as i32)
                });

            Some(ChatLogEntry {
                event_type: normalized_event_type,
                username,
                message,
                gift_name,
                repeat_count,
                raw_json: Some(event.clone()),
            })
        }
        _ => None,
    }
}

async fn is_overlay_tunnel_alive(base_url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    match client.get(base_url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[cfg(target_os = "windows")]
mod keyboard_sender {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_BACK, VK_CONTROL,
        VK_DOWN, VK_ESCAPE, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6,
        VK_F7, VK_F8, VK_F9, VK_LEFT, VK_LWIN, VK_MENU, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE,
        VK_TAB, VK_UP,
    };

    fn make_vk_input(vk: VIRTUAL_KEY, key_up: bool) -> INPUT {
        let flags = if key_up {
            KEYEVENTF_KEYUP
        } else {
            KEYBD_EVENT_FLAGS(0)
        };
        let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) as u16 };
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn make_unicode_input(ch: u16, key_up: bool) -> INPUT {
        let flags = if key_up {
            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        } else {
            KEYEVENTF_UNICODE
        };
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: ch,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn token_to_vk(token: &str) -> Option<VIRTUAL_KEY> {
        match token.trim().to_uppercase().as_str() {
            "CTRL" | "CONTROL" => Some(VK_CONTROL),
            "ALT" => Some(VK_MENU),
            "SHIFT" => Some(VK_SHIFT),
            "WIN" | "WINDOWS" | "META" => Some(VK_LWIN),
            "SPACE" => Some(VK_SPACE),
            "ENTER" | "RETURN" => Some(VK_RETURN),
            "TAB" => Some(VK_TAB),
            "ESC" | "ESCAPE" => Some(VK_ESCAPE),
            "BACKSPACE" => Some(VK_BACK),
            "UP" => Some(VK_UP),
            "DOWN" => Some(VK_DOWN),
            "LEFT" => Some(VK_LEFT),
            "RIGHT" => Some(VK_RIGHT),
            "F1" => Some(VK_F1),
            "F2" => Some(VK_F2),
            "F3" => Some(VK_F3),
            "F4" => Some(VK_F4),
            "F5" => Some(VK_F5),
            "F6" => Some(VK_F6),
            "F7" => Some(VK_F7),
            "F8" => Some(VK_F8),
            "F9" => Some(VK_F9),
            "F10" => Some(VK_F10),
            "F11" => Some(VK_F11),
            "F12" => Some(VK_F12),
            value if value.len() == 1 => {
                let byte = value.as_bytes()[0];
                if byte.is_ascii_digit() {
                    Some(VIRTUAL_KEY(0x30 + (byte - b'0') as u16))
                } else if byte.is_ascii_alphabetic() {
                    Some(VIRTUAL_KEY(
                        0x41 + (byte.to_ascii_uppercase() - b'A') as u16,
                    ))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn parse_sequence(sequence: &str) -> Result<(Vec<VIRTUAL_KEY>, Vec<String>), String> {
        let tokens: Vec<String> = sequence
            .split('+')
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
            .collect();
        if tokens.is_empty() {
            return Err("ยังไม่มีชุดปุ่มให้ส่ง".to_string());
        }

        let mut modifiers = Vec::new();
        let mut mains = Vec::new();
        for token in tokens {
            match token.trim().to_uppercase().as_str() {
                "CTRL" | "CONTROL" => modifiers.push(VK_CONTROL),
                "ALT" => modifiers.push(VK_MENU),
                "SHIFT" => modifiers.push(VK_SHIFT),
                "WIN" | "WINDOWS" | "META" => modifiers.push(VK_LWIN),
                _ => mains.push(token),
            }
        }

        Ok((modifiers, mains))
    }

    fn send_inputs(inputs: &[INPUT]) -> Result<(), String> {
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            Err(format!("ส่งคีย์ได้ไม่ครบ ({sent}/{})", inputs.len()))
        }
    }

    pub fn send_sequence(sequence: &str) -> Result<String, String> {
        let (modifiers, mains) = parse_sequence(sequence)?;
        let mut inputs = Vec::new();

        for modifier in &modifiers {
            inputs.push(make_vk_input(*modifier, false));
        }

        for token in mains {
            if let Some(vk) = token_to_vk(&token) {
                inputs.push(make_vk_input(vk, false));
                inputs.push(make_vk_input(vk, true));
                continue;
            }

            let mut chars = token.chars();
            let ch = chars.next().ok_or_else(|| format!("อ่านปุ่มไม่ได้: {token}"))?;
            if chars.next().is_some() {
                return Err(format!("รองรับทีละอักขระเท่านั้นสำหรับคำสั่งพิมพ์: {token}"));
            }

            let code = ch as u32;
            if code > u16::MAX as u32 {
                return Err(format!("อักขระไม่รองรับ: {token}"));
            }
            inputs.push(make_unicode_input(code as u16, false));
            inputs.push(make_unicode_input(code as u16, true));
        }

        for modifier in modifiers.iter().rev() {
            inputs.push(make_vk_input(*modifier, true));
        }

        send_inputs(&inputs)?;
        Ok(format!("sent: {}", sequence))
    }
}

#[cfg(not(target_os = "windows"))]
mod keyboard_sender {
    pub fn send_sequence(sequence: &str) -> Result<String, String> {
        Err(format!("รองรับการส่งคีย์จริงเฉพาะ Windows: {sequence}"))
    }
}

mod commands {
    use super::*;

    #[tauri::command]
    pub async fn database_status() -> Result<String, String> {
        let pool = connect_database().await?;

        sqlx::query("select 1")
            .execute(&pool)
            .await
            .map_err(|error| format!("ทดสอบ Neon ไม่สำเร็จ: {error}"))?;

        Ok("Neon connected".to_string())
    }

    #[tauri::command]
    pub async fn save_liveflow_state(
        session_token: String,
        snapshot: Value,
    ) -> Result<String, String> {
        let pool = connect_database().await?;
        let user = authenticate_session(&pool, &session_token).await?;
        if user.role != "admin" && user.access_status != "active" {
            return Err("แพ็กเกจยังไม่เริ่มใช้งานหรือหมดอายุแล้ว กรุณาต่ออายุแพ็กเกจ".to_string());
        }
        let keyboard_rule_count = snapshot
            .get("keyRules")
            .and_then(Value::as_array)
            .map(|rules| {
                rules
                    .iter()
                    .filter(|rule| {
                        rule.get("bindingType").and_then(Value::as_str) == Some("keyboard")
                    })
                    .count() as i32
            })
            .unwrap_or(0);
        if user.role != "admin"
            && user.keyboard_rule_limit >= 0
            && keyboard_rule_count > user.keyboard_rule_limit
        {
            return Err(format!(
                "แพ็กเกจนี้ใช้กฎคีย์บอร์ดได้สูงสุด {} รายการ กรุณาต่ออายุหรืออัปเกรดแพ็กเกจ",
                user.keyboard_rule_limit
            ));
        }
        let state_json = serde_json::to_string(&snapshot)
            .map_err(|error| format!("แปลงข้อมูลสำหรับบันทึกไม่สำเร็จ: {error}"))?;
        let state_key = format!("user:{}:snapshot", user.id);

        sqlx::query(
            r#"
            INSERT INTO liveflow_app_state (state_key, state_json, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (state_key)
            DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()
            "#,
        )
        .bind(&state_key)
        .bind(&state_json)
        .execute(&pool)
        .await
        .map_err(|error| format!("บันทึกลง Neon ไม่สำเร็จ: {error}"))?;

        Ok("saved".to_string())
    }

    #[tauri::command]
    pub async fn load_liveflow_state(session_token: String) -> Result<Value, String> {
        let pool = connect_database().await?;
        let user = authenticate_session(&pool, &session_token).await?;
        let state_key = format!("user:{}:snapshot", user.id);

        let row = sqlx::query_scalar::<_, String>(
            r#"
            SELECT state_json
            FROM liveflow_app_state
            WHERE state_key = $1
            "#,
        )
        .bind(&state_key)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("โหลดจาก Neon ไม่สำเร็จ: {error}"))?;

        match row {
            Some(state_json) => serde_json::from_str::<Value>(&state_json)
                .map_err(|error| format!("อ่านข้อมูลจาก Neon ไม่สำเร็จ: {error}")),
            None => Ok(serde_json::json!({})),
        }
    }

    #[tauri::command]
    pub async fn load_chat_logs(session_token: String) -> Result<Vec<ChatLogRow>, String> {
        let pool = connect_database().await?;
        let user = authenticate_session(&pool, &session_token).await?;
        purge_old_chat_logs(&pool).await?;
        let rows = sqlx::query(
            r#"
            SELECT
                id,
                event_type,
                COALESCE(username, '') AS username,
                COALESCE(message, '') AS message,
                gift_name,
                COALESCE(repeat_count, 1) AS repeat_count,
                created_at::text AS created_at
            FROM liveflow_chat_logs
            WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '10 minutes'
            ORDER BY created_at ASC, id ASC
            LIMIT 300
            "#,
        )
        .bind(user.id)
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("โหลด log ไม่สำเร็จ: {error}"))?;

        Ok(rows
            .into_iter()
            .map(|row| ChatLogRow {
                id: row.get::<i64, _>("id"),
                event_type: row.get::<String, _>("event_type"),
                username: row.get::<String, _>("username"),
                message: row.get::<String, _>("message"),
                gift_name: row.try_get::<String, _>("gift_name").ok(),
                repeat_count: row.get::<i32, _>("repeat_count"),
                created_at: row.get::<String, _>("created_at"),
            })
            .collect())
    }

    #[tauri::command]
    pub async fn auth_register(request: RegisterRequest) -> Result<AuthSession, String> {
        let display_name = request.display_name.trim();
        if display_name.chars().count() < 2 || display_name.chars().count() > 80 {
            return Err("ชื่อผู้ใช้ต้องมี 2–80 ตัวอักษร".to_string());
        }
        let email = normalize_email(&request.email)?;
        let phone = normalize_phone(&request.phone)?;
        validate_password(&request.password)?;
        let password_hash = hash_password(&request.password)?;
        let pool = connect_database().await?;
        let user_id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO liveflow_users (display_name, email, phone, password_hash, role)
            VALUES ($1, $2, $3, $4, 'user')
            RETURNING id
            "#,
        )
        .bind(display_name)
        .bind(&email)
        .bind(&phone)
        .bind(password_hash)
        .fetch_one(&pool)
        .await
        .map_err(|error| {
            if error.to_string().contains("liveflow_users_phone_unique") {
                "เบอร์โทรศัพท์นี้ถูกสมัครสมาชิกแล้ว".to_string()
            } else if error.to_string().contains("unique") {
                "อีเมลนี้ถูกสมัครสมาชิกแล้ว".to_string()
            } else {
                format!("สมัครสมาชิกไม่สำเร็จ: {error}")
            }
        })?;

        let session_token = generate_session_token();
        sqlx::query("INSERT INTO liveflow_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')")
            .bind(user_id)
            .bind(token_hash(&session_token))
            .execute(&pool)
            .await
            .map_err(|error| format!("สร้าง session ไม่สำเร็จ: {error}"))?;
        let user = authenticate_session(&pool, &session_token).await?;
        Ok(AuthSession {
            session_token,
            user,
        })
    }

    #[tauri::command]
    pub async fn auth_login(request: LoginRequest) -> Result<AuthSession, String> {
        let email = normalize_email(&request.email)?;
        let pool = connect_database().await?;
        let row = sqlx::query(
            r#"
            SELECT id, password_hash, is_active,
                   (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked
            FROM liveflow_users
            WHERE email = $1
            "#,
        )
        .bind(&email)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("เข้าสู่ระบบไม่สำเร็จ: {error}"))?
        .ok_or_else(|| "อีเมลหรือรหัสผ่านไม่ถูกต้อง".to_string())?;

        let user_id = row.get::<i64, _>("id");
        if !row.get::<bool, _>("is_active") {
            return Err("บัญชีนี้ถูกระงับการใช้งาน".to_string());
        }
        if row.get::<bool, _>("is_locked") {
            return Err("บัญชีถูกล็อกชั่วคราว กรุณารอ 15 นาทีแล้วลองใหม่".to_string());
        }
        if !verify_password(&request.password, &row.get::<String, _>("password_hash")) {
            sqlx::query(
                r#"
                UPDATE liveflow_users
                SET failed_login_attempts = failed_login_attempts + 1,
                    locked_until = CASE WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END,
                    updated_at = NOW()
                WHERE id = $1
                "#,
            )
            .bind(user_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("บันทึกการเข้าสู่ระบบไม่สำเร็จ: {error}"))?;
            return Err("อีเมลหรือรหัสผ่านไม่ถูกต้อง".to_string());
        }

        sqlx::query("UPDATE liveflow_users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("อัปเดตการเข้าสู่ระบบไม่สำเร็จ: {error}"))?;
        let session_token = generate_session_token();
        sqlx::query("INSERT INTO liveflow_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')")
            .bind(user_id)
            .bind(token_hash(&session_token))
            .execute(&pool)
            .await
            .map_err(|error| format!("สร้าง session ไม่สำเร็จ: {error}"))?;
        let user = authenticate_session(&pool, &session_token).await?;
        Ok(AuthSession {
            session_token,
            user,
        })
    }

    #[tauri::command]
    pub async fn auth_current_user(session_token: String) -> Result<AuthUser, String> {
        let pool = connect_database().await?;
        authenticate_session(&pool, &session_token).await
    }

    #[tauri::command]
    pub async fn auth_logout(session_token: String) -> Result<String, String> {
        let pool = connect_database().await?;
        sqlx::query("DELETE FROM liveflow_sessions WHERE token_hash = $1")
            .bind(token_hash(&session_token))
            .execute(&pool)
            .await
            .map_err(|error| format!("ออกจากระบบไม่สำเร็จ: {error}"))?;
        if let Ok(mut active_id) = active_user_id().lock() {
            *active_id = None;
        }
        Ok("ออกจากระบบแล้ว".to_string())
    }

    #[tauri::command]
    pub async fn auth_request_password_reset(email: String) -> Result<String, String> {
        let email = normalize_email(&email)?;
        let pool = connect_database().await?;
        let user_id = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM liveflow_users WHERE email = $1 AND is_active = TRUE",
        )
        .bind(&email)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("ขอรีเซ็ตรหัสผ่านไม่สำเร็จ: {error}"))?;
        let Some(user_id) = user_id else {
            return Ok("หากอีเมลนี้อยู่ในระบบ เราจะส่งรหัสตั้งรหัสผ่านใหม่ให้".to_string());
        };
        let recently_sent = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM liveflow_password_resets WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 minute')",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .map_err(|error| format!("ตรวจสอบคำขอ reset ไม่สำเร็จ: {error}"))?;
        if recently_sent {
            return Err("กรุณารอ 1 นาทีก่อนขอรหัสใหม่".to_string());
        }
        let reset_code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000));
        sqlx::query("UPDATE liveflow_password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL")
            .bind(user_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("ยกเลิกรหัสเดิมไม่สำเร็จ: {error}"))?;
        sqlx::query("INSERT INTO liveflow_password_resets (user_id, code_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')")
            .bind(user_id)
            .bind(token_hash(&reset_code))
            .execute(&pool)
            .await
            .map_err(|error| format!("สร้างรหัส reset ไม่สำเร็จ: {error}"))?;
        let recipient = email.clone();
        let code = reset_code.clone();
        tauri::async_runtime::spawn_blocking(move || send_reset_email(&recipient, &code))
            .await
            .map_err(|error| format!("ระบบส่งอีเมลหยุดทำงาน: {error}"))??;
        Ok("ส่งรหัส 6 หลักไปยังอีเมลแล้ว รหัสมีอายุ 15 นาที".to_string())
    }

    #[tauri::command]
    pub async fn auth_reset_password(request: ResetPasswordRequest) -> Result<String, String> {
        let email = normalize_email(&request.email)?;
        validate_password(&request.new_password)?;
        if request.reset_code.trim().len() != 6
            || !request.reset_code.chars().all(|ch| ch.is_ascii_digit())
        {
            return Err("รหัสตั้งรหัสผ่านใหม่ต้องเป็นตัวเลข 6 หลัก".to_string());
        }
        let password_hash = hash_password(&request.new_password)?;
        let pool = connect_database().await?;
        let row = sqlx::query(
            r#"
            SELECT r.id AS reset_id, r.user_id
            FROM liveflow_password_resets r
            JOIN liveflow_users u ON u.id = r.user_id
            WHERE u.email = $1 AND r.code_hash = $2 AND r.used_at IS NULL AND r.expires_at > NOW() AND r.attempts < 5
            ORDER BY r.created_at DESC
            LIMIT 1
            "#,
        )
        .bind(&email)
        .bind(token_hash(request.reset_code.trim()))
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("ตรวจรหัส reset ไม่สำเร็จ: {error}"))?
        .ok_or_else(|| "รหัสไม่ถูกต้องหรือหมดอายุแล้ว".to_string());
        let row = match row {
            Ok(row) => row,
            Err(error) => {
                let _ = sqlx::query(
                    r#"
                    UPDATE liveflow_password_resets
                    SET attempts = attempts + 1
                    WHERE id = (
                        SELECT r.id FROM liveflow_password_resets r
                        JOIN liveflow_users u ON u.id = r.user_id
                        WHERE u.email = $1 AND r.used_at IS NULL AND r.expires_at > NOW()
                        ORDER BY r.created_at DESC LIMIT 1
                    )
                    "#,
                )
                .bind(&email)
                .execute(&pool)
                .await;
                return Err(error);
            }
        };
        let reset_id = row.get::<i64, _>("reset_id");
        let user_id = row.get::<i64, _>("user_id");
        let mut transaction = pool
            .begin()
            .await
            .map_err(|error| format!("เริ่มบันทึกรหัสผ่านไม่สำเร็จ: {error}"))?;
        sqlx::query("UPDATE liveflow_users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $2")
            .bind(password_hash)
            .bind(user_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("ตั้งรหัสผ่านใหม่ไม่สำเร็จ: {error}"))?;
        sqlx::query("UPDATE liveflow_password_resets SET used_at = NOW() WHERE id = $1")
            .bind(reset_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("ปิดรหัส reset ไม่สำเร็จ: {error}"))?;
        sqlx::query("DELETE FROM liveflow_sessions WHERE user_id = $1")
            .bind(user_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("ล้าง session เดิมไม่สำเร็จ: {error}"))?;
        transaction
            .commit()
            .await
            .map_err(|error| format!("บันทึกรหัสผ่านไม่สำเร็จ: {error}"))?;
        Ok("ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว กรุณาเข้าสู่ระบบ".to_string())
    }

    #[tauri::command]
    pub async fn auth_admin_list_users(session_token: String) -> Result<Vec<AuthUser>, String> {
        let pool = connect_database().await?;
        let admin = authenticate_session(&pool, &session_token).await?;
        if admin.role != "admin" {
            return Err("ไม่มีสิทธิ์เข้าหน้า Admin".to_string());
        }
        let rows = sqlx::query(
            r#"
            SELECT id, display_name, email, phone, role, is_active,
                   plan_code, keyboard_rule_limit,
                   access_starts_at::text AS access_starts_at,
                   access_expires_at::text AS access_expires_at,
                   CASE
                       WHEN role = 'admin' THEN 'active'
                       WHEN access_starts_at IS NOT NULL AND access_starts_at > NOW() THEN 'not_started'
                       WHEN access_expires_at IS NOT NULL AND access_expires_at < NOW() THEN 'expired'
                       ELSE 'active'
                   END AS access_status,
                   created_at::text AS created_at,
                   last_login_at::text AS last_login_at
            FROM liveflow_users
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("โหลดสมาชิกไม่สำเร็จ: {error}"))?;
        Ok(rows.iter().map(auth_user_from_row).collect())
    }

    #[tauri::command]
    pub async fn auth_admin_update_user(request: AdminUpdateUserRequest) -> Result<String, String> {
        let pool = connect_database().await?;
        let admin = authenticate_session(&pool, &request.session_token).await?;
        if admin.role != "admin" {
            return Err("ไม่มีสิทธิ์จัดการสมาชิก".to_string());
        }
        if request.user_id == admin.id && (!request.is_active || request.role != "admin") {
            return Err("ไม่สามารถระงับหรือลดสิทธิ์บัญชี Admin ที่กำลังใช้งาน".to_string());
        }
        if request.role != "admin" && request.role != "user" {
            return Err("สิทธิ์สมาชิกไม่ถูกต้อง".to_string());
        }
        if request.keyboard_rule_limit < -1 || request.keyboard_rule_limit > 10_000 {
            return Err("จำนวนกฎคีย์บอร์ดต้องเป็น -1 (ไม่จำกัด) หรืออยู่ระหว่าง 0–10,000 รายการ".to_string());
        }
        let starts_at = request.access_starts_at.unwrap_or_default();
        let expires_at = request.access_expires_at.unwrap_or_default();
        sqlx::query(
            r#"
            UPDATE liveflow_users
            SET role = $1,
                is_active = $2,
                plan_code = $3,
                access_starts_at = CASE WHEN $4 = '' THEN NULL ELSE $4::date END,
                access_expires_at = CASE WHEN $5 = '' THEN NULL ELSE $5::date + INTERVAL '1 day' - INTERVAL '1 second' END,
                keyboard_rule_limit = $6,
                updated_at = NOW()
            WHERE id = $7
            "#,
        )
            .bind(&request.role)
            .bind(request.is_active)
            .bind(request.plan_code.trim())
            .bind(starts_at)
            .bind(expires_at)
            .bind(request.keyboard_rule_limit)
            .bind(request.user_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("อัปเดตสมาชิกไม่สำเร็จ: {error}"))?;
        if !request.is_active {
            sqlx::query("DELETE FROM liveflow_sessions WHERE user_id = $1")
                .bind(request.user_id)
                .execute(&pool)
                .await
                .map_err(|error| format!("ปิด session สมาชิกไม่สำเร็จ: {error}"))?;
        }
        Ok("อัปเดตสมาชิกเรียบร้อยแล้ว".to_string())
    }

    #[tauri::command]
    pub async fn list_announcements(session_token: String) -> Result<Vec<Announcement>, String> {
        let pool = connect_database().await?;
        authenticate_session(&pool, &session_token).await?;
        let rows = sqlx::query(
            r#"
            SELECT id, title, message, image_url, display_mode,
                   starts_at::text AS starts_at, ends_at::text AS ends_at,
                   created_at::text AS created_at
            FROM liveflow_announcements
            WHERE is_active = TRUE
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (ends_at IS NULL OR ends_at >= NOW())
            ORDER BY created_at DESC
            LIMIT 20
            "#,
        )
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("โหลดประกาศไม่สำเร็จ: {error}"))?;
        Ok(rows
            .iter()
            .map(|row| Announcement {
                id: row.get("id"),
                title: row.get("title"),
                message: row.get("message"),
                image_url: row.try_get::<String, _>("image_url").ok(),
                display_mode: row.get("display_mode"),
                starts_at: row.try_get::<String, _>("starts_at").ok(),
                ends_at: row.try_get::<String, _>("ends_at").ok(),
                created_at: row.get("created_at"),
            })
            .collect())
    }

    #[tauri::command]
    pub async fn admin_create_announcement(request: AnnouncementRequest) -> Result<String, String> {
        let pool = connect_database().await?;
        let admin = authenticate_session(&pool, &request.session_token).await?;
        if admin.role != "admin" {
            return Err("ไม่มีสิทธิ์จัดการประกาศ".to_string());
        }
        if request.title.trim().is_empty() {
            return Err("กรุณากรอกหัวข้อประกาศ".to_string());
        }
        if request.message.trim().is_empty()
            && request.image_url.as_deref().unwrap_or("").trim().is_empty()
        {
            return Err("กรุณากรอกข้อความหรือเพิ่มรูปภาพประกาศ".to_string());
        }
        if !matches!(
            request.display_mode.as_str(),
            "banner" | "ticker" | "modal" | "image"
        ) {
            return Err("รูปแบบประกาศไม่ถูกต้อง".to_string());
        }
        sqlx::query(
            r#"
            INSERT INTO liveflow_announcements
                (title, message, image_url, display_mode, starts_at, ends_at, created_by)
            VALUES ($1, $2, NULLIF($3, ''), $4,
                    CASE WHEN $5 = '' THEN NULL ELSE $5::date END,
                    CASE WHEN $6 = '' THEN NULL ELSE $6::date + INTERVAL '1 day' - INTERVAL '1 second' END,
                    $7)
            "#,
        )
        .bind(request.title.trim()).bind(request.message.trim())
        .bind(request.image_url.unwrap_or_default()).bind(request.display_mode)
        .bind(request.starts_at.unwrap_or_default()).bind(request.ends_at.unwrap_or_default())
        .bind(admin.id)
        .execute(&pool).await.map_err(|error| format!("สร้างประกาศไม่สำเร็จ: {error}"))?;
        Ok("เผยแพร่ประกาศเรียบร้อยแล้ว".to_string())
    }

    #[tauri::command]
    pub async fn admin_list_announcements(
        session_token: String,
    ) -> Result<Vec<Announcement>, String> {
        let pool = connect_database().await?;
        let admin = authenticate_session(&pool, &session_token).await?;
        if admin.role != "admin" {
            return Err("ไม่มีสิทธิ์จัดการประกาศ".to_string());
        }
        let rows = sqlx::query(
            r#"
            SELECT id, title, message, image_url, display_mode,
                   starts_at::text AS starts_at, ends_at::text AS ends_at,
                   created_at::text AS created_at
            FROM liveflow_announcements
            WHERE is_active = TRUE
            ORDER BY created_at DESC
            LIMIT 100
            "#,
        )
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("โหลดรายการประกาศไม่สำเร็จ: {error}"))?;
        Ok(rows
            .iter()
            .map(|row| Announcement {
                id: row.get("id"),
                title: row.get("title"),
                message: row.get("message"),
                image_url: row.try_get::<String, _>("image_url").ok(),
                display_mode: row.get("display_mode"),
                starts_at: row.try_get::<String, _>("starts_at").ok(),
                ends_at: row.try_get::<String, _>("ends_at").ok(),
                created_at: row.get("created_at"),
            })
            .collect())
    }

    #[tauri::command]
    pub async fn admin_delete_announcement(
        session_token: String,
        announcement_id: i64,
    ) -> Result<String, String> {
        let pool = connect_database().await?;
        let admin = authenticate_session(&pool, &session_token).await?;
        if admin.role != "admin" {
            return Err("ไม่มีสิทธิ์ลบประกาศ".to_string());
        }
        sqlx::query("UPDATE liveflow_announcements SET is_active = FALSE WHERE id = $1")
            .bind(announcement_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("ลบประกาศไม่สำเร็จ: {error}"))?;
        Ok("ลบประกาศเรียบร้อยแล้ว".to_string())
    }

    #[tauri::command]
    pub async fn get_system_update(session_token: String) -> Result<SystemUpdateInfo, String> {
        let pool = connect_database().await?;
        authenticate_session(&pool, &session_token).await?;
        let row = sqlx::query("SELECT required_version, force_update, update_url, message FROM liveflow_system_update WHERE id = 1")
            .fetch_one(&pool).await.map_err(|error| format!("โหลดข้อมูลอัปเดตไม่สำเร็จ: {error}"))?;
        Ok(SystemUpdateInfo {
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            required_version: row.get("required_version"),
            force_update: row.get("force_update"),
            update_url: row.get("update_url"),
            message: row.get("message"),
        })
    }

    #[tauri::command]
    pub async fn admin_update_system(request: AdminSystemUpdateRequest) -> Result<String, String> {
        let pool = connect_database().await?;
        let admin = authenticate_session(&pool, &request.session_token).await?;
        if admin.role != "admin" {
            return Err("ไม่มีสิทธิ์ตั้งค่าการอัปเดต".to_string());
        }
        if request.required_version.trim().is_empty() {
            return Err("กรุณาระบุเวอร์ชัน".to_string());
        }
        sqlx::query(
            "UPDATE liveflow_system_update SET required_version = $1, force_update = $2, update_url = $3, message = $4, updated_at = NOW() WHERE id = 1"
        )
        .bind(request.required_version.trim()).bind(request.force_update)
        .bind(request.update_url.trim()).bind(request.message.trim())
        .execute(&pool).await.map_err(|error| format!("บันทึกการอัปเดตไม่สำเร็จ: {error}"))?;
        Ok("บันทึกนโยบายอัปเดตเรียบร้อยแล้ว".to_string())
    }

    #[tauri::command]
    pub fn open_facebook_payment() -> Result<String, String> {
        let url = "https://www.facebook.com/tabaa.boonanan/";
        #[cfg(target_os = "windows")]
        {
            let mut candidates = Vec::new();
            if let Ok(program_files) = std::env::var("PROGRAMFILES") {
                candidates.push(
                    std::path::PathBuf::from(program_files)
                        .join("Google/Chrome/Application/chrome.exe"),
                );
            }
            if let Ok(program_files_x86) = std::env::var("PROGRAMFILES(X86)") {
                candidates.push(
                    std::path::PathBuf::from(program_files_x86)
                        .join("Google/Chrome/Application/chrome.exe"),
                );
            }
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                candidates.push(
                    std::path::PathBuf::from(local_app_data)
                        .join("Google/Chrome/Application/chrome.exe"),
                );
            }
            for chrome in candidates {
                if chrome.exists() {
                    Command::new(chrome)
                        .arg("--new-window")
                        .arg(url)
                        .spawn()
                        .map_err(|error| format!("เปิด Google Chrome ไม่สำเร็จ: {error}"))?;
                    return Ok("เปิด Facebook ใน Google Chrome แล้ว".to_string());
                }
            }
            Command::new("cmd")
                .args(["/C", "start", "", url])
                .spawn()
                .map_err(|error| format!("เปิดหน้า Facebook ไม่สำเร็จ: {error}"))?;
            return Ok("เปิด Facebook ในเบราว์เซอร์เริ่มต้นแล้ว".to_string());
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err("รองรับการเปิด Google Chrome อัตโนมัติบน Windows".to_string())
        }
    }

    #[tauri::command]
    pub fn send_keyboard_sequence(sequence: String) -> Result<String, String> {
        keyboard_sender::send_sequence(sequence.trim())
    }

    #[tauri::command]
    pub fn normalize_username(username: String) -> String {
        let value = username.trim().trim_start_matches('@');
        format!("@{value}")
    }

    #[tauri::command]
    pub async fn deploy_cloudflare_worker(
        request: CloudflareDeployRequest,
    ) -> Result<String, String> {
        let api_token = if request.api_token.trim().is_empty() {
            configured_value("CLOUDFLARE_API_TOKEN")
                .or_else(|| configured_value("CLOUDFLARE_TOKEN"))
                .ok_or_else(|| "ยังไม่ได้ตั้งค่า Cloudflare API Token ใน Backend".to_string())?
        } else {
            request.api_token.trim().to_string()
        };
        let account_id = if request.account_id.trim().is_empty() {
            configured_value("CLOUDFLARE_ACCOUNT_ID")
                .ok_or_else(|| "ยังไม่ได้ตั้งค่า Cloudflare Account ID ใน Backend".to_string())?
        } else {
            request.account_id.trim().to_string()
        };
        let script_name = request.script_name.trim().to_lowercase().replace(' ', "-");
        let worker_code = if request.kind == "overlay" {
            "export default { async fetch(request) { return new Response(JSON.stringify({ok:true,type:'overlay',event:'gift'}), {headers:{'content-type':'application/json'}}); } }"
        } else {
            "export default { async fetch(request) { if (request.method !== 'POST') return new Response('LiveFlow webhook is ready'); const event = await request.json().catch(() => ({})); console.log('LiveFlow event', event); return Response.json({ok:true,received:event}); } }"
        };
        let client = reqwest::Client::new();
        let endpoint = format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}",
            account_id, script_name
        );
        let upload = client
            .put(&endpoint)
            .bearer_auth(api_token.clone())
            .header("content-type", "application/javascript")
            .body(worker_code)
            .send()
            .await
            .map_err(|e| format!("อัปโหลด Worker ไม่สำเร็จ: {e}"))?;
        if !upload.status().is_success() {
            return Err(format!(
                "Cloudflare ปฏิเสธการอัปโหลด: {}",
                upload.text().await.unwrap_or_default()
            ));
        }
        let subdomain_endpoint = format!("{}/subdomain", endpoint);
        let _ = client
            .post(&subdomain_endpoint)
            .bearer_auth(api_token.clone())
            .json(&serde_json::json!({"enabled":true}))
            .send()
            .await;
        let subdomain_endpoint = format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/workers/subdomain",
            account_id
        );
        let subdomain: Value = client
            .get(subdomain_endpoint)
            .bearer_auth(api_token)
            .send()
            .await
            .map_err(|e| format!("อ่าน workers.dev ไม่สำเร็จ: {e}"))?
            .json()
            .await
            .map_err(|e| format!("อ่านข้อมูล Cloudflare ไม่สำเร็จ: {e}"))?;
        let host = subdomain["result"]["subdomain"]
            .as_str()
            .ok_or_else(|| "ยังไม่ได้เปิด workers.dev ในบัญชี Cloudflare".to_string())?;
        Ok(format!("https://{}.{}.workers.dev", script_name, host))
    }

    #[tauri::command]
    pub async fn create_overlay_tunnel(request: OverlayTunnelRequest) -> Result<String, String> {
        let public_path = request
            .public_path
            .trim()
            .trim_start_matches('/')
            .to_string();
        let cached_url = overlay_tunnel_cache()
            .lock()
            .map_err(|_| "อ่านแคชลิงก์ Overlay ไม่ได้".to_string())?
            .clone();
        if let Some(base_url) = cached_url {
            if is_overlay_tunnel_alive(&base_url).await {
                return Ok(if public_path.is_empty() {
                    base_url
                } else {
                    format!("{}/{}", base_url.trim_end_matches('/'), public_path)
                });
            }
            if let Ok(mut cache) = overlay_tunnel_cache().lock() {
                *cache = None;
            }
        }

        let local_url = if request.local_url.trim().is_empty() {
            "http://localhost:1420".to_string()
        } else {
            request.local_url.trim().to_string()
        };
        let binary =
            std::env::var("CLOUDFLARED_PATH").unwrap_or_else(|_| "cloudflared".to_string());
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();

        thread::spawn(move || {
            let mut child = match Command::new(binary)
                .args([
                    "tunnel",
                    "--url",
                    &local_url,
                    "--no-autoupdate",
                    "--loglevel",
                    "info",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    let _ = ready_tx.send(Err(format!("เปิด cloudflared ไม่สำเร็จ: {error}")));
                    return;
                }
            };

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let (line_tx, line_rx) = mpsc::channel::<String>();
            let spawn_reader = |stream: std::process::ChildStdout| {
                let line_tx = line_tx.clone();
                thread::spawn(move || {
                    for line in BufReader::new(stream).lines().map_while(Result::ok) {
                        let _ = line_tx.send(line);
                    }
                });
            };
            let spawn_err_reader = |stream: std::process::ChildStderr| {
                let line_tx = line_tx.clone();
                thread::spawn(move || {
                    for line in BufReader::new(stream).lines().map_while(Result::ok) {
                        let _ = line_tx.send(line);
                    }
                });
            };

            if let Some(stream) = stdout {
                spawn_reader(stream);
            }
            if let Some(stream) = stderr {
                spawn_err_reader(stream);
            }

            let mut reported = false;
            for line in line_rx {
                if !reported {
                    if let Some(base_url) = extract_trycloudflare_url(&line) {
                        if let Ok(mut cache) = overlay_tunnel_cache().lock() {
                            *cache = Some(base_url.clone());
                        }
                        let result = if public_path.is_empty() {
                            base_url
                        } else {
                            format!("{}/{}", base_url.trim_end_matches('/'), public_path)
                        };
                        let _ = ready_tx.send(Ok(result));
                        reported = true;
                    }
                }
            }

            let _ = child.wait();
        });

        ready_rx
            .recv_timeout(std::time::Duration::from_secs(25))
            .map_err(|_| "cloudflared ยังไม่ส่งลิงก์กลับมา ลองกดสร้างอีกครั้ง".to_string())?
    }

    #[tauri::command]
    pub fn start_tiktok_connector(app: AppHandle, username: String) -> Result<String, String> {
        let development_connector_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("connector")
            .join("TikTokLive-master");
        let development_exe = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("liveflow-tiktok-connector.exe");
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| format!("เปิดโฟลเดอร์ทรัพยากรไม่สำเร็จ: {error}"))?;
        let bundled_candidates = [
            resource_dir
                .join("resources")
                .join("liveflow-tiktok-connector.exe"),
            resource_dir.join("liveflow-tiktok-connector.exe"),
        ];
        let standalone_connector = bundled_candidates
            .iter()
            .find(|path| path.exists())
            .cloned()
            .or_else(|| development_exe.exists().then_some(development_exe));

        let (mut command, working_dir) = if let Some(executable) = standalone_connector {
            let mut command = Command::new(&executable);
            command.arg("--username").arg(username);
            (
                command,
                executable.parent().unwrap_or(&resource_dir).to_path_buf(),
            )
        } else {
            let connector = development_connector_dir.join("tiktok_connector.py");
            let python = if cfg!(windows) {
                development_connector_dir
                    .join(".venv")
                    .join("Scripts")
                    .join("python.exe")
            } else {
                development_connector_dir
                    .join(".venv")
                    .join("bin")
                    .join("python")
            };
            if !connector.exists() || !python.exists() {
                return Err(
                    "ไม่พบ TikTok connector ที่รวมมากับโปรแกรม กรุณาติดตั้ง LiveFlow ใหม่".to_string(),
                );
            }
            let mut command = Command::new(&python);
            command
                .arg("-u")
                .arg(&connector)
                .arg("--username")
                .arg(username);
            (command, development_connector_dir.clone())
        };

        command
            .current_dir(working_dir)
            .env("PYTHONUTF8", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8:replace")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .map_err(|error| format!("เปิด TikTok connector ไม่สำเร็จ: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "อ่าน input ของ connector ไม่ได้".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "อ่าน output ของ connector ไม่ได้".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "อ่าน error output ของ connector ไม่ได้".to_string())?;

        if let Ok(mut current_stdin) = tiktok_connector_stdin().lock() {
            if let Some(mut previous_stdin) = current_stdin.take() {
                let _ = previous_stdin.write_all(b"stop\n");
                let _ = previous_stdin.flush();
            }
            *current_stdin = Some(stdin);
        }

        let stderr_app = app.clone();
        let stderr_reader = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    publish_tiktok_event(&stderr_app, event);
                } else if !line.trim().is_empty() {
                    publish_tiktok_event(
                        &stderr_app,
                        serde_json::json!({
                            "type": "debug",
                            "stage": "stderr",
                            "message": line,
                        }),
                    );
                }
            }
        });

        let stdout_app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    if let Some(entry) = build_chat_log_entry(&event) {
                        tauri::async_runtime::spawn(async move {
                            let _ = persist_chat_log(entry).await;
                        });
                    }
                    publish_tiktok_event(&stdout_app, event);
                }
            }
            let _ = child.wait();
            let _ = stderr_reader.join();
        });

        Ok("TikTok connector started".to_string())
    }

    #[tauri::command]
    pub fn stop_tiktok_connector() -> Result<String, String> {
        let mut guard = tiktok_connector_stdin()
            .lock()
            .map_err(|_| "หยุด TikTok connector ไม่สำเร็จ: mutex lock failed".to_string())?;

        let mut stdin = guard
            .take()
            .ok_or_else(|| "ไม่มี TikTok connector ที่กำลังทำงาน".to_string())?;

        stdin
            .write_all(b"stop\n")
            .map_err(|error| format!("ส่งคำสั่งหยุดไปยัง TikTok connector ไม่สำเร็จ: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("flush คำสั่งหยุดไม่สำเร็จ: {error}"))?;

        Ok("ส่งคำสั่งหยุดไปยัง TikTok connector แล้ว".to_string())
    }

    #[tauri::command]
    pub fn drain_tiktok_events() -> Result<Vec<Value>, String> {
        let mut queue = tiktok_event_queue()
            .lock()
            .map_err(|_| "อ่านคิว TikTok event ไม่สำเร็จ".to_string())?;
        Ok(queue.drain(..).collect())
    }

    #[tauri::command]
    pub fn emit_test_tiktok_comment(
        app: AppHandle,
        username: String,
        message: String,
    ) -> Result<String, String> {
        let normalized_username = username.trim().trim_start_matches('@').to_string();
        let display_username = if normalized_username.is_empty() {
            "tester".to_string()
        } else {
            normalized_username
        };
        let display_message = if message.trim().is_empty() {
            "สวัสดีจากโหมดทดสอบแชตสด".to_string()
        } else {
            message.trim().to_string()
        };
        let event = serde_json::json!({
            "type": "comment",
            "username": display_username,
            "message": display_message,
        });

        let app_for_emit = app.clone();
        let event_for_persist = event.clone();
        tauri::async_runtime::spawn(async move {
            let entry = ChatLogEntry {
                event_type: "comment".to_string(),
                username: event_for_persist
                    .get("username")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                message: event_for_persist
                    .get("message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                gift_name: None,
                repeat_count: Some(1),
                raw_json: Some(event_for_persist),
            };
            let _ = persist_chat_log(entry).await;
        });

        publish_tiktok_event(&app_for_emit, event);
        Ok("ส่ง comment ทดสอบไปยังระบบแชตสดแล้ว".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();
    let _ = fs::write(std::env::temp_dir().join(TIKTOK_RUNTIME_LOG_FILE), "");

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let username =
                configured_value("TIKTOK_USERNAME").unwrap_or_else(|| "ivklmiban".to_string());
            thread::spawn(move || {
                thread::sleep(std::time::Duration::from_millis(1_200));
                append_tiktok_runtime_log(&serde_json::json!({
                    "type": "debug",
                    "stage": "backend-auto-connect-start",
                    "username": username,
                }));
                if let Err(error) = commands::start_tiktok_connector(app_handle.clone(), username) {
                    publish_tiktok_event(
                        &app_handle,
                        serde_json::json!({
                            "type": "error",
                            "stage": "backend-auto-connect",
                            "message": error,
                        }),
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::database_status,
            commands::save_liveflow_state,
            commands::load_liveflow_state,
            commands::load_chat_logs,
            commands::auth_register,
            commands::auth_login,
            commands::auth_current_user,
            commands::auth_logout,
            commands::auth_request_password_reset,
            commands::auth_reset_password,
            commands::auth_admin_list_users,
            commands::auth_admin_update_user,
            commands::list_announcements,
            commands::admin_create_announcement,
            commands::admin_list_announcements,
            commands::admin_delete_announcement,
            commands::get_system_update,
            commands::admin_update_system,
            commands::open_facebook_payment,
            commands::send_keyboard_sequence,
            commands::normalize_username,
            commands::start_tiktok_connector,
            commands::stop_tiktok_connector,
            commands::drain_tiktok_events,
            commands::emit_test_tiktok_comment,
            commands::deploy_cloudflare_worker,
            commands::create_overlay_tunnel
        ])
        .run(tauri::generate_context!())
        .expect("error while running LiveFlow");
}
