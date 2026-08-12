import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Activity, Bell, CreditCard, Gift, Heart, Image, Keyboard, Link2, LogIn, Megaphone, MessageCircle, Pause, Play, Plus, RefreshCw, Settings, Share2, ShieldCheck, Sparkles, Trash2, Users, Volume2, Wifi, Zap } from "lucide-react";
import "./styles.css";
import { GiftJarOverlay } from "./components/GiftJarOverlay";
import { AdminPage, AuthPortal, SubscriptionPage, UserAccountPage, profileToAuthUser, type Announcement, type AuthUser, type SystemUpdateInfo } from "./components/AuthPages";
import { ensureProfile, neon, type LiveFlowProfileRow } from "./lib/neon";

type EventType = "gift" | "comment" | "chat" | "follow" | "like" | "share" | "join";
type ActionType = "keyboard" | "sound" | "overlay" | "webhook";
type OverlayLinkType = "gift" | "alert" | "score" | "chat";
type OverlayRuleMode = "jar" | "image" | "video" | "text";
type LiveEvent = { id: number; type: EventType; user: string; text: string; time: string; gift?: string; image?: string };
type KeyRule = {
  gift: string;
  giftId?: string;
  triggerType?: EventType;
  bindingType: "keyboard" | "overlay" | "none";
  bindingLabel: string;
  action: string;
  enabled: boolean;
  overlayMode?: OverlayRuleMode;
  overlayLinkType?: OverlayLinkType;
};
type CustomSound = { name: string; url: string };
type JarStyle = "classic" | "tall" | "hex" | "cute";
type JarGiftCounts = Record<JarStyle, number>;
type OverlayPublicConfig = {
  selectedGift: string;
  jarStyle: JarStyle;
  count: number;
  capacity: number;
  scale: number;
  showUser: boolean;
  showCoins: boolean;
  text: string;
  animation: "drop" | "bounce" | "fade";
};

type LiveFlowSnapshot = {
  username?: string;
  selectedGift?: string;
  action?: ActionType;
  selectedKeys?: string[];
  keyboardLanguage?: "en" | "th";
  selectedSound?: string;
  customSounds?: CustomSound[];
  overlayApiUrl?: string;
  overlayPublicUrls?: Partial<Record<OverlayLinkType, string>>;
  overlayRuleMode?: OverlayRuleMode;
  overlayLinkType?: OverlayLinkType;
  overlayMaxItems?: number;
  overlayGiftScale?: number;
  overlayShowUser?: boolean;
  overlayShowCoins?: boolean;
  overlayAnimation?: "drop" | "bounce" | "fade";
  overlayAssetUrl?: string;
  overlayText?: string;
  jarStyle?: JarStyle;
  overlayGiftCounts?: JarGiftCounts;
  webhookUrl?: string;
  likeCountMode?: "exact" | "threshold";
  likeThreshold?: number;
  followMode?: "repeat" | "round" | "permanent";
  commentMatch?: string;
  commentMatchMode?: "exact" | "contains";
  keyRules?: KeyRule[];
  giftValues?: Record<string, number>;
  liveStats?: { gifts: number; giftCoins: number; comments: number; follows: number; likes: number; shares: number; joins: number };
  latestLiveUser?: string;
  latestLiveGiftName?: string;
  latestLiveGiftCount?: number;
};

type ChatLogRow = {
  id: number;
  event_type: string;
  username: string;
  message: string;
  gift_name?: string | null;
  repeat_count: number;
  created_at: string;
};

type NotificationItem = {
  id: number;
  kind: "system" | EventType | "connection" | "debug";
  title: string;
  message: string;
  detail?: string;
  user?: string;
  gift?: string;
  time: string;
};

type ConnectorTraceItem = {
  id: number;
  stage: string;
  message: string;
  detail: string;
  time: string;
};

type LiveTrafficStatus = "online" | "connecting" | "error" | "no_chat";
type RecentChatLimit = 30 | 50 | 100;

const MAX_JAR_ITEM_COUNT = 1000;
const MAX_STORED_CHAT_EVENTS = 100;

const giftImages = import.meta.glob("./assets/gifts/*", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const giftUrl = (name: string) => giftImages[`./assets/gifts/${name}.png`] ?? giftImages["./assets/gifts/Rose.png"];
const giftNames = Object.keys(giftImages).map((path) => path.replace("./assets/gifts/", "").replace(/\.png$/, "")).sort((a, b) => a.localeCompare(b));
const overlayLinkStorageKey = "liveflow.overlayPublicUrls";
const liveflowSnapshotStorageKey = "liveflow.state.snapshot";
const followPermanentStorageKey = "liveflow.follow.permanent.users";
const recentChatLimitStorageKey = "liveflow.realtime.chat.limit";
const authSessionStorageKey = "liveflow.auth.session";

const normalizeGiftMatchKey = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function loadPersistedSnapshot(storageKey = liveflowSnapshotStorageKey) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LiveFlowSnapshot;
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function loadPersistedStringSet(storageKey: string) {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((item) => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set<string>();
  }
}

function savePersistedStringSet(storageKey: string, values: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(Array.from(values)));
  } catch {
    // ignore persistence failures
  }
}

const actions: { id: ActionType; label: string; description: string; icon: ReactNode }[] = [
  { id: "keyboard", label: "กดคีย์บอร์ด", description: "ส่ง Hotkey ไปยังโปรแกรม", icon: <Keyboard /> },
  { id: "sound", label: "เล่นเสียง", description: "เล่นไฟล์เสียงแจ้งเตือน", icon: <Play /> },
  { id: "overlay", label: "แสดง Overlay", description: "แสดงภาพหรือวิดีโอ", icon: <Sparkles /> },
  { id: "webhook", label: "ส่ง Webhook", description: "เชื่อมต่อบริการภายนอก", icon: <Zap /> },
];
const englishKeys = ["CTRL", "ALT", "SHIFT", "WIN", "SPACE", "ENTER", "TAB", "ESC", "BACKSPACE", "UP", "DOWN", "LEFT", "RIGHT", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", ..."1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];
const thaiKeys = ["ๆ", "ไ", "ำ", "พ", "ะ", "ั", "ี", "ร", "น", "ย", "บ", "ล", "ฃ", "ฟ", "ห", "ก", "ด", "เ", "้", "่", "า", "ส", "ว", "ง", "ผ", "ป", "แ", "อ", "ิ", "ท", "ม", "ใ", "ฝ", "จ", "ข", "ช", "ง", "ค", "ต", "ย", "น", "บ", "ล", "ว", "อ", "ฮ"];
const soundPresets = [{ id: "ding", label: "Ding", description: "เสียงแจ้งเตือนสั้น", frequency: 880 }, { id: "coin", label: "Coin", description: "เสียงเหรียญสะสม", frequency: 1047 }, { id: "success", label: "Success", description: "เสียงสำเร็จ", frequency: 660 }, { id: "pop", label: "Pop", description: "เสียงป๊อปสั้น", frequency: 520 }, { id: "alert", label: "Alert", description: "เสียงเตือน", frequency: 330 }];
const legacyOverlayDefaults = {
  jarCapacity: 500,
  resetWhenFull: true,
  showCounter: false,
  overlayBackground: "transparent",
  animationSpeed: "normal" as const,
};

function parseJarStyle(value: string | null): JarStyle | null {
  return value === "classic" || value === "tall" || value === "hex" || value === "cute" ? value : null;
}

function clampInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function clampFloat(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function loadOverlayPublicConfigFromUrl(): Partial<OverlayPublicConfig> | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (!params.size) return null;
  return {
    selectedGift: params.get("gift") || params.get("selectedGift") || "Rose",
    jarStyle: parseJarStyle(params.get("jarStyle")) ?? "tall",
    count: clampInt(params.get("count"), 0, 0, MAX_JAR_ITEM_COUNT),
    capacity: clampInt(params.get("capacity"), legacyOverlayDefaults.jarCapacity, 1, MAX_JAR_ITEM_COUNT),
    scale: clampFloat(params.get("scale"), 1, 0.7, 1.6),
    showUser: params.get("showUser") ? params.get("showUser") !== "0" : true,
    showCoins: params.get("showCoins") ? params.get("showCoins") !== "0" : true,
    text: params.get("text") || "ขอบคุณสำหรับของขวัญ!",
    animation: (params.get("animation") as "drop" | "bounce" | "fade" | null) || "drop",
  };
}

function App() {
  const overlayPathParts = typeof window !== "undefined" ? window.location.pathname.split("/").filter(Boolean) : [];
  const isPublicOverlayPage = overlayPathParts[0] === "overlay";
  const initialPublicOverlayConfig = isPublicOverlayPage ? loadOverlayPublicConfigFromUrl() : null;
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authSessionToken, setAuthSessionToken] = useState(() => typeof window === "undefined" ? "" : window.localStorage.getItem(authSessionStorageKey) || "");
  const [authChecking, setAuthChecking] = useState(!isPublicOverlayPage);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [systemUpdate, setSystemUpdate] = useState<SystemUpdateInfo | null>(null);
  const [dismissedModalAnnouncement, setDismissedModalAnnouncement] = useState<number | null>(null);
  const userSnapshotStorageKey = authUser ? `${liveflowSnapshotStorageKey}.user.${authUser.id}` : `${liveflowSnapshotStorageKey}.anonymous`;
  const userOverlayStorageKey = authUser ? `${overlayLinkStorageKey}.user.${authUser.id}` : `${overlayLinkStorageKey}.anonymous`;
  const userFollowStorageKey = authUser ? `${followPermanentStorageKey}.user.${authUser.id}` : `${followPermanentStorageKey}.anonymous`;
  const [username, setUsername] = useState(() => {
    if (typeof window === "undefined") return "@username";
    return "@username";
  });
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [recentChatLimit, setRecentChatLimit] = useState<RecentChatLimit>(() => {
    if (typeof window === "undefined") return 30;
    const stored = Number(window.localStorage.getItem(recentChatLimitStorageKey));
    return stored === 50 || stored === 100 ? stored : 30;
  });
  const [eventType, setEventType] = useState<EventType>("gift");
  const [selectedGift, setSelectedGift] = useState(initialPublicOverlayConfig?.selectedGift ?? "Rose");
  const [action, setAction] = useState<ActionType>("keyboard");
  const [selectedKeys, setSelectedKeys] = useState<string[]>(["SPACE"]);
  const keyBinding = selectedKeys.join(" + ");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardLanguage, setKeyboardLanguage] = useState<"en" | "th">("en");
  const [selectedSound, setSelectedSound] = useState("ding");
  const [customSounds, setCustomSounds] = useState<CustomSound[]>([]);
  const [overlayApiUrl, setOverlayApiUrl] = useState("");
  const [overlayPublicUrls, setOverlayPublicUrls] = useState<Partial<Record<OverlayLinkType, string>>>({});
  const [overlayLinkCreating, setOverlayLinkCreating] = useState(false);
  const [overlayRuleMode, setOverlayRuleMode] = useState<OverlayRuleMode>("jar");
  const [overlayMaxItems, setOverlayMaxItems] = useState(initialPublicOverlayConfig?.capacity ?? legacyOverlayDefaults.jarCapacity);
  const [overlayGiftScale, setOverlayGiftScale] = useState(initialPublicOverlayConfig?.scale ?? 1);
  const [overlayShowUser, setOverlayShowUser] = useState(initialPublicOverlayConfig?.showUser ?? true);
  const [overlayShowCoins, setOverlayShowCoins] = useState(initialPublicOverlayConfig?.showCoins ?? true);
  const [overlayAnimation, setOverlayAnimation] = useState<"drop" | "bounce" | "fade">(initialPublicOverlayConfig?.animation ?? "drop");
  const [overlayAssetUrl, setOverlayAssetUrl] = useState("");
  const [overlayText, setOverlayText] = useState(initialPublicOverlayConfig?.text ?? "ขอบคุณสำหรับของขวัญ!");
  const [jarStyle, setJarStyle] = useState<JarStyle>(initialPublicOverlayConfig?.jarStyle ?? "tall");
  const [overlayGiftCounts, setOverlayGiftCounts] = useState<JarGiftCounts>({
    classic: initialPublicOverlayConfig?.jarStyle === "classic" ? initialPublicOverlayConfig.count ?? 0 : 0,
    tall: initialPublicOverlayConfig?.jarStyle === "tall" ? initialPublicOverlayConfig.count ?? 0 : 0,
    hex: initialPublicOverlayConfig?.jarStyle === "hex" ? initialPublicOverlayConfig.count ?? 0 : 0,
    cute: initialPublicOverlayConfig?.jarStyle === "cute" ? initialPublicOverlayConfig.count ?? 0 : 0,
  });
  const overlayLinks = {
    gift: "http://localhost:1420/overlay/gift",
    alert: "http://localhost:1420/overlay/alert",
    score: "http://localhost:1420/overlay/score",
    chat: "http://localhost:1420/overlay/chat",
  } as const;
  const overlayLinkItems = [
    { id: "gift", label: "โหลใหม่", description: "ใช้กับโหลใหม่สำหรับโยนของขวัญ" },
    { id: "alert", label: "ข้อความแจ้งเตือน", description: "แสดงข้อความสั้น ๆ บนจอ" },
    { id: "score", label: "แสดงคะแนน", description: "แสดงสถิติคะแนนและยอดรวม" },
    { id: "chat", label: "คอมเมนต์บนจอ", description: "แสดงคอมเมนต์ของผู้ชม" },
  ] as const;
  const overlayLinkTypeByMode: Record<OverlayRuleMode, OverlayLinkType> = {
    jar: "gift",
    image: "alert",
    video: "score",
    text: "chat",
  };
  const overlayModeByLinkType: Record<OverlayLinkType, OverlayRuleMode> = {
    gift: "jar",
    alert: "image",
    score: "video",
    chat: "text",
  };
  const [overlayLinkType, setOverlayLinkType] = useState<OverlayLinkType>("gift");
  const selectedOverlayLink = overlayLinks[overlayLinkType];
  const getOverlayUrl = (type: OverlayLinkType) => overlayPublicUrls[type] ?? overlayLinks[type];
  const selectedOverlayPublicUrl = getOverlayUrl(overlayLinkType);
  const currentJarGiftCount = overlayGiftCounts[jarStyle] ?? 0;
  const [jarDropTrigger, setJarDropTrigger] = useState(0);
  const [liveStats, setLiveStats] = useState({ gifts: 0, giftCoins: 0, comments: 0, follows: 0, likes: 0, shares: 0, joins: 0 });
  const [latestLiveUser, setLatestLiveUser] = useState("");
  const [latestLiveGiftName, setLatestLiveGiftName] = useState("");
  const [latestLiveGiftCount, setLatestLiveGiftCount] = useState(0);
  const setCurrentJarGiftCount = (nextValue: number | ((current: number) => number)) => {
    setOverlayGiftCounts((current) => {
      const currentValue = current[jarStyle] ?? 0;
      const resolved = typeof nextValue === "function" ? nextValue(currentValue) : nextValue;
      return {
        ...current,
        [jarStyle]: Math.max(0, Math.min(MAX_JAR_ITEM_COUNT, resolved)),
      };
    });
  };
  const publicOverlayType = (overlayPathParts[1] as OverlayLinkType | undefined) ?? overlayLinkType;
  useEffect(() => {
    setOverlayLinkType(overlayLinkTypeByMode[overlayRuleMode]);
  }, [overlayRuleMode]);
  useEffect(() => {
    try {
      if (authUser) window.localStorage.setItem(userOverlayStorageKey, JSON.stringify(overlayPublicUrls));
    } catch {
      // ignore storage failures
    }
  }, [overlayPublicUrls, authUser?.id, userOverlayStorageKey]);
  useEffect(() => {
    if (isPublicOverlayPage || !authUser || !authSessionToken) return;
    let cancelled = false;

    const restoreSnapshot = async () => {
      try {
        const { data, error } = await neon.from("liveflow_user_state").select("state_json").eq("auth_user_id", authUser.id).maybeSingle();
        if (error) throw new Error(error.message);
        const snapshot = (data?.state_json || {}) as LiveFlowSnapshot;
        if (!cancelled && snapshot && typeof snapshot === "object") {
          applyLiveFlowSnapshot(snapshot);
          window.localStorage.setItem(userSnapshotStorageKey, JSON.stringify(snapshot));
        }
      } catch {
        const fallback = loadPersistedSnapshot(userSnapshotStorageKey);
        if (!cancelled && fallback) {
          applyLiveFlowSnapshot(fallback);
        }
      }
    };

    void restoreSnapshot();
    return () => {
      cancelled = true;
    };
  }, [isPublicOverlayPage, authUser?.id, authSessionToken, userSnapshotStorageKey]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [likeCountMode, setLikeCountMode] = useState<"exact" | "threshold">("exact");
  const [likeThreshold, setLikeThreshold] = useState(10);
  const [followMode, setFollowMode] = useState<"repeat" | "round" | "permanent">("repeat");
  const [commentMatch, setCommentMatch] = useState("jump");
  const [commentMatchMode, setCommentMatchMode] = useState<"exact" | "contains">("exact");
  const [keyRules, setKeyRules] = useState<KeyRule[]>([]);
  const [giftValues, setGiftValues] = useState<Record<string, number>>({});
  const [liveGiftValues, setLiveGiftValues] = useState<Record<string, number>>({});
  const [liveGiftIds, setLiveGiftIds] = useState<Record<string, string>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [lastAction, setLastAction] = useState("");
  const [testingRuleGift, setTestingRuleGift] = useState("");
  const [activeNav, setActiveNav] = useState<"overview" | "rules" | "gifts" | "sound" | "overlay" | "webhook" | "notifications" | "settings" | "account" | "admin" | "subscription">("overview");
  const [giftSearch, setGiftSearch] = useState("");
  const [chatLogs, setChatLogs] = useState<ChatLogRow[]>([]);
  const [chatLogsLoading, setChatLogsLoading] = useState(false);
  const [chatLogsError, setChatLogsError] = useState("");
  const [notificationFeed, setNotificationFeed] = useState<NotificationItem[]>([]);
  const [connectorDebugStage, setConnectorDebugStage] = useState("รอเริ่มเชื่อมต่อ TikTok LIVE");
  const [connectorDebugDetail, setConnectorDebugDetail] = useState("เปิดหน้า Notifications เพื่อดูสถานะเรียลไทม์");
  const [connectorTrace, setConnectorTrace] = useState<ConnectorTraceItem[]>([]);
  const notificationsFeedRef = useRef<HTMLDivElement>(null);
  const liveChatFeedRef = useRef<HTMLDivElement>(null);
  const realtimeChatFeedRef = useRef<HTMLDivElement>(null);
  const seenTikTokEventIdsRef = useRef<Set<string>>(new Set());
   const liveChatItems = useMemo(() => notificationFeed.filter((item) => item.kind === "comment" || item.kind === "chat"), [notificationFeed]);
  const systemFeedItems = useMemo(
    () => notificationFeed.filter((item) => item.kind !== "comment" && item.kind !== "chat"),
    [notificationFeed],
  );
  const liveTrafficStatus = useMemo<LiveTrafficStatus>(() => {
    const debugText = `${connectorDebugStage} ${connectorDebugDetail}`.toLowerCase();
    const recentError = notificationFeed.some((item) => item.kind === "debug" && /error|ผิดพลาด|failed|disconnect|ตัดการเชื่อมต่อ/i.test(`${item.title} ${item.message} ${item.detail ?? ""}`));
    if (recentError || /error|ผิดพลาด|failed/.test(debugText)) return "error";
    if (/connecting|เริ่มเชื่อมต่อ|รอ connector|กำลังเชื่อมต่อ|กำลังเริ่มงาน|รอยืนยัน/.test(debugText)) return "connecting";
    if (connected && liveChatItems.length === 0) return "no_chat";
    if (connected || liveChatItems.length > 0) return "online";
    return "no_chat";
  }, [connected, connectorDebugDetail, connectorDebugStage, liveChatItems.length, notificationFeed]);
  const liveTrafficLabel = useMemo(() => {
    switch (liveTrafficStatus) {
      case "online":
        return "Online";
      case "connecting":
        return "Connecting";
      case "error":
        return "Error";
      case "no_chat":
      default:
        return "No chat";
    }
  }, [liveTrafficStatus]);
  const liveTrafficDescription = useMemo(() => {
    switch (liveTrafficStatus) {
      case "online":
        return connected ? "เชื่อมต่อและมี event ไลฟ์เข้ามาแล้ว" : "มีแชตหรืออีเวนต์เข้ามาแล้ว";
      case "connecting":
        return "กำลังเริ่มเชื่อมต่อกับ TikTok LIVE";
      case "error":
        return "พบปัญหาระหว่างเชื่อมต่อหรือรับ event";
      case "no_chat":
      default:
        return connected ? "เชื่อมต่อแล้วแต่ยังไม่มีแชตเข้ามา" : "ยังไม่มีการเชื่อมต่อหรือไม่มีแชต";
    }
  }, [connected, liveTrafficStatus]);
  const followRoundSeenRef = useRef<Set<string>>(new Set());
  const followPermanentSeenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!authUser) return;
    followPermanentSeenRef.current = loadPersistedStringSet(userFollowStorageKey);
  }, [authUser?.id, userFollowStorageKey]);

  useEffect(() => {
    if (isPublicOverlayPage) return;
    void neon.auth.getSession()
      .then(async (session: Awaited<ReturnType<typeof neon.auth.getSession>>) => {
        if (!session.data?.user) throw new Error("no session");
        const profile = await ensureProfile();
        const user = profileToAuthUser(profile);
        setAuthSessionToken(user.id);
        setAuthUser(user);
        window.localStorage.setItem(authSessionStorageKey, user.id);
      })
      .catch(() => {
        window.localStorage.removeItem(authSessionStorageKey);
        setAuthSessionToken("");
        setAuthUser(null);
      })
      .finally(() => setAuthChecking(false));
  }, [isPublicOverlayPage]);

  useEffect(() => {
    if (!authUser || !authSessionToken) return;
    let cancelled = false;
    const refreshSystemMessages = async () => {
      try {
        const [announcementResult, updateResult] = await Promise.all([
          neon.from("liveflow_auth_announcements").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(20),
          neon.from("liveflow_auth_system_update").select("*").eq("id", 1).single(),
        ]);
        if (announcementResult.error) throw announcementResult.error;
        if (updateResult.error) throw updateResult.error;
        const nextAnnouncements = (announcementResult.data || []).map((row: any) => ({ id: row.id, title: row.title, message: row.message, imageUrl: row.image_url, displayMode: row.display_mode, startsAt: row.starts_at, endsAt: row.ends_at, createdAt: row.created_at })) as Announcement[];
        const updateRow: any = updateResult.data;
        const nextUpdate: SystemUpdateInfo = { currentVersion: "0.1.9", requiredVersion: updateRow.required_version, forceUpdate: updateRow.force_update, updateUrl: updateRow.update_url, message: updateRow.message };
        if (!cancelled) { setAnnouncements(nextAnnouncements); setSystemUpdate(nextUpdate); }
      } catch { /* retain the last successfully loaded system message */ }
    };
    void refreshSystemMessages();
    const timer = window.setInterval(() => void refreshSystemMessages(), 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [authUser?.id, authSessionToken]);

  const handleAuthenticated = (session: { sessionToken: string; user: AuthUser }) => {
    window.localStorage.setItem(authSessionStorageKey, session.sessionToken);
    setAuthSessionToken(session.sessionToken);
    setAuthUser(session.user);
    setActiveNav(session.user.role === "admin" ? "admin" : session.user.accessStatus === "active" ? "overview" : "subscription");
  };

  useEffect(() => {
    if (authUser && authUser.role !== "admin" && authUser.accessStatus !== "active") setActiveNav("subscription");
  }, [authUser?.id, authUser?.accessStatus]);

  const logout = async () => {
    const token = authSessionToken;
    window.localStorage.removeItem(authSessionStorageKey);
    setAuthSessionToken("");
    setAuthUser(null);
    setActiveNav("overview");
    if (token) { try { await neon.auth.signOut(); } catch { /* local logout still succeeds */ } }
  };

  const buildLiveFlowSnapshot = (): LiveFlowSnapshot => ({
    username,
    selectedGift,
    action,
    selectedKeys,
    keyboardLanguage,
    selectedSound,
    customSounds,
    overlayApiUrl,
    overlayPublicUrls,
    overlayRuleMode,
    overlayLinkType,
    overlayMaxItems,
    overlayGiftScale,
    overlayShowUser,
    overlayShowCoins,
    overlayAnimation,
    overlayAssetUrl,
    overlayText,
    jarStyle,
    overlayGiftCounts,
    webhookUrl,
    likeCountMode,
    likeThreshold,
    followMode,
    commentMatch,
    commentMatchMode,
    keyRules,
    giftValues,
    liveStats,
    latestLiveUser,
    latestLiveGiftName,
    latestLiveGiftCount,
  });

  const applyLiveFlowSnapshot = (snapshot: LiveFlowSnapshot) => {
    if (snapshot.username) setUsername(snapshot.username);
    if (snapshot.selectedGift) setSelectedGift(snapshot.selectedGift);
    if (snapshot.action) setAction(snapshot.action);
    if (Array.isArray(snapshot.selectedKeys) && snapshot.selectedKeys.length > 0) setSelectedKeys(snapshot.selectedKeys);
    if (snapshot.keyboardLanguage === "en" || snapshot.keyboardLanguage === "th") setKeyboardLanguage(snapshot.keyboardLanguage);
    if (snapshot.selectedSound) setSelectedSound(snapshot.selectedSound);
    if (Array.isArray(snapshot.customSounds)) setCustomSounds(snapshot.customSounds);
    if (snapshot.overlayApiUrl !== undefined) setOverlayApiUrl(snapshot.overlayApiUrl);
    if (snapshot.overlayPublicUrls) setOverlayPublicUrls(snapshot.overlayPublicUrls);
    if (snapshot.overlayRuleMode) setOverlayRuleMode(snapshot.overlayRuleMode);
    if (snapshot.overlayLinkType) setOverlayLinkType(snapshot.overlayLinkType);
    if (typeof snapshot.overlayMaxItems === "number") setOverlayMaxItems(snapshot.overlayMaxItems);
    if (typeof snapshot.overlayGiftScale === "number") setOverlayGiftScale(snapshot.overlayGiftScale);
    if (typeof snapshot.overlayShowUser === "boolean") setOverlayShowUser(snapshot.overlayShowUser);
    if (typeof snapshot.overlayShowCoins === "boolean") setOverlayShowCoins(snapshot.overlayShowCoins);
    if (snapshot.overlayAnimation) setOverlayAnimation(snapshot.overlayAnimation);
    if (snapshot.overlayAssetUrl !== undefined) setOverlayAssetUrl(snapshot.overlayAssetUrl);
    if (snapshot.overlayText !== undefined) setOverlayText(snapshot.overlayText);
    if (snapshot.jarStyle) setJarStyle(snapshot.jarStyle);
    if (snapshot.overlayGiftCounts) setOverlayGiftCounts(snapshot.overlayGiftCounts);
    if (snapshot.webhookUrl !== undefined) setWebhookUrl(snapshot.webhookUrl);
    if (snapshot.likeCountMode) setLikeCountMode(snapshot.likeCountMode);
    if (typeof snapshot.likeThreshold === "number") setLikeThreshold(snapshot.likeThreshold);
    if (snapshot.followMode) setFollowMode(snapshot.followMode);
    if (snapshot.commentMatch !== undefined) setCommentMatch(snapshot.commentMatch);
    if (snapshot.commentMatchMode) setCommentMatchMode(snapshot.commentMatchMode);
    if (Array.isArray(snapshot.keyRules)) setKeyRules(snapshot.keyRules);
    if (snapshot.giftValues) setGiftValues(snapshot.giftValues);
    if (snapshot.liveStats) setLiveStats(snapshot.liveStats);
    if (typeof snapshot.latestLiveUser === "string") setLatestLiveUser(snapshot.latestLiveUser);
    if (typeof snapshot.latestLiveGiftName === "string") setLatestLiveGiftName(snapshot.latestLiveGiftName);
    if (typeof snapshot.latestLiveGiftCount === "number") setLatestLiveGiftCount(snapshot.latestLiveGiftCount);
  };

  const persistLiveFlowSnapshot = async (snapshot: LiveFlowSnapshot, message?: string) => {
    try {
      if (authUser?.id) {
        const { error } = await neon.from("liveflow_user_state").upsert({ auth_user_id: authUser.id, state_json: snapshot, updated_at: new Date().toISOString() }, { onConflict: "auth_user_id" });
        if (error) throw new Error(error.message);
      }
      try {
        await fetch("/api/liveflow-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        });
      } catch {
        // keep local persistence as the fallback
      }
      window.localStorage.setItem(userSnapshotStorageKey, JSON.stringify(snapshot));
      if (message) {
        setLastAction(message);
        pushSystemNotification("บันทึกสถานะระบบ", message, "บันทึกค่าปัจจุบันลง snapshot เรียบร้อย");
      }
    } catch (error) {
      window.localStorage.setItem(userSnapshotStorageKey, JSON.stringify(snapshot));
      if (message) {
        const text = `${message} (บันทึกบางส่วนไม่สำเร็จ: ${String(error)})`;
        setLastAction(text);
        pushSystemNotification("บันทึกสถานะระบบไม่สำเร็จ", text, "ยังเก็บข้อมูลสำรองไว้ในเครื่อง");
      }
    }
  };

  const pushNotification = (item: Omit<NotificationItem, "id" | "time"> & { time?: string }) => {
    const time = item.time ?? new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    setNotificationFeed((current) => [{ id: Date.now() + Math.random(), time, ...item }, ...current].slice(0, 120));
  };

  const pushConnectorTrace = (stage: string, message: string, detail: string) => {
    const time = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    setConnectorTrace((current) => [{ id: Date.now() + Math.random(), stage, message, detail, time }, ...current].slice(0, 12));
  };

  const pushSystemNotification = (title: string, message: string, detail?: string) => {
    pushNotification({ kind: "system", title, message, detail });
  };

  const pushConnectionNotification = (title: string, message: string, detail?: string) => {
    pushConnectorTrace(title, message, detail ?? message);
    pushNotification({ kind: "connection", title, message, detail });
  };

  const pushDebugNotification = (title: string, message: string, detail?: string) => {
    setConnectorDebugStage(message);
    setConnectorDebugDetail(detail ?? message);
    pushConnectorTrace(title, message, detail ?? message);
    pushNotification({ kind: "debug", title, message, detail });
  };

  const sendTestLiveComment = async () => {
    const normalized = username.trim().replace(/^@/, "");
    const testUsername = normalized || "tester";
    const testMessage = "สวัสดีจากโหมดทดสอบแชตสด";
    setActiveNav("notifications");
    setConnectorDebugStage("กำลังส่ง comment ทดสอบผ่าน backend");
    setConnectorDebugDetail(`@${testUsername}: ${testMessage}`);
    try {
      await invoke<string>("emit_test_tiktok_comment", {
        username: testUsername,
        message: testMessage,
      });
      pushSystemNotification("ทดสอบแชตสด", "ส่ง comment ทดสอบผ่าน backend แล้ว", `@${testUsername}: ${testMessage}`);
    } catch (error) {
      const text = `ส่ง comment ทดสอบไม่สำเร็จ: ${String(error)}`;
      setConnectorDebugStage("ส่ง comment ทดสอบไม่สำเร็จ");
      setConnectorDebugDetail(text);
      pushSystemNotification("ทดสอบแชตสดไม่สำเร็จ", text, "ตรวจสอบว่าแอปเปิดใน Tauri Desktop แล้ว");
    }
  };

  useEffect(() => {
    if (activeNav !== "notifications") return;
    notificationsFeedRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeNav, notificationFeed]);

  useEffect(() => {
    if (activeNav !== "notifications") return;
    liveChatFeedRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeNav, liveChatItems]);

  useEffect(() => {
    if (activeNav !== "overview") return;
    realtimeChatFeedRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeNav, events]);

  const loadChatLogsFromDb = async () => {
    setChatLogsLoading(true);
    setChatLogsError("");
    try {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      if (authUser?.id) {
        const { error: cleanupError } = await neon
          .from("liveflow_auth_chat_logs")
          .delete()
          .eq("auth_user_id", authUser.id)
          .lt("created_at", since);
        if (cleanupError) throw new Error(cleanupError.message);
      }
      const { data: rows, error } = await neon.from("liveflow_auth_chat_logs").select("id,event_type,username,message,gift_name,repeat_count,created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(300);
      if (error) throw new Error(error.message);
      const normalizedRows = Array.isArray(rows)
        ? [...rows].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
        : [];
      setChatLogs(normalizedRows);
      pushSystemNotification("โหลดแชตย้อนหลัง", `โหลดแชตจาก Neon สำเร็จ ${Array.isArray(rows) ? rows.length : 0} รายการ`, "แสดงย้อนหลังช่วง 10 นาทีล่าสุด");
    } catch (error) {
      setChatLogsError(`โหลด log ไม่สำเร็จ: ${String(error)}`);
      setChatLogs([]);
    } finally {
      setChatLogsLoading(false);
    }
  };

  useEffect(() => {
    if (!isPublicOverlayPage) return;

    const { body, documentElement } = document;
    const prevBodyBg = body.style.background;
    const prevHtmlBg = documentElement.style.background;
    const prevBodyMargin = body.style.margin;
    const prevBodyOverflow = body.style.overflow;

    body.style.background = "transparent";
    documentElement.style.background = "transparent";
    body.style.margin = "0";
    body.style.overflow = "hidden";

    return () => {
      body.style.background = prevBodyBg;
      documentElement.style.background = prevHtmlBg;
      body.style.margin = prevBodyMargin;
      body.style.overflow = prevBodyOverflow;
    };
  }, [isPublicOverlayPage]);

  useEffect(() => {
    if (activeNav !== "settings") return;
    void loadChatLogsFromDb();
    const timer = window.setInterval(() => {
      void loadChatLogsFromDb();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [activeNav]);

  useEffect(() => {
    if (!isPublicOverlayPage) return;

    let cancelled = false;

    const syncOverlaySnapshot = async () => {
      try {
        const response = await fetch("/api/liveflow-state", { cache: "no-store" });
        if (!response.ok) return;
        const snapshot = (await response.json()) as LiveFlowSnapshot;
        if (!cancelled && snapshot && typeof snapshot === "object") {
          applyLiveFlowSnapshot(snapshot);
        }
      } catch {
        // keep the most recent visible state if polling is unavailable
      }
    };

    void syncOverlaySnapshot();
    const timer = window.setInterval(() => {
      void syncOverlaySnapshot();
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isPublicOverlayPage]);
  const openActionPage = (nextAction: Extract<ActionType, "sound" | "overlay" | "webhook">) => {
    setAction(nextAction);
    setActiveNav(nextAction);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const filteredGifts = useMemo(() => giftNames.filter((name) => name.toLowerCase().includes(giftSearch.toLowerCase())).sort((a, b) => (giftValues[a] ?? Number.MAX_SAFE_INTEGER) - (giftValues[b] ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)), [giftSearch, giftValues]);
  const jarStyleOptions: { id: JarStyle; label: string; description: string }[] = [
    { id: "classic", label: "โหลแก้วเดิม", description: "ทรงมาตรฐาน อ่านง่าย ปากมีเกลียวสูง หลายชั้น" },
    { id: "tall", label: "โหลทรงยาว", description: "ทรงสูง แคบ และเด่นชัด" },
    { id: "hex", label: "โหลคริสตัล", description: "ทรงหกเหลี่ยม ดูพรีเมียมและเด่นขึ้น" },
    { id: "cute", label: "โหลน่ารัก", description: "ทรงมน โทนอุ่นและนุ่ม" },
  ];
  const overlayRuleModeOptions: { id: OverlayRuleMode; label: string; description: string; icon: ReactNode }[] = [
    { id: "jar", label: "โหลใหม่", description: "โยนของขวัญลงโหลใหม่แบบเรียลไทม์", icon: "🏺" },
    { id: "image", label: "ภาพ Overlay", description: "แสดงภาพเมื่อเกิด Event", icon: "🖼️" },
    { id: "video", label: "วิดีโอ Overlay", description: "เล่นวิดีโอเมื่อมี Action", icon: "🎬" },
    { id: "text", label: "ข้อความแจ้งเตือน", description: "แสดงข้อความและชื่อผู้ชม", icon: "💬" },
  ];
  const overlayRuleLabel = overlayRuleModeOptions.find((item) => item.id === overlayRuleMode)?.label ?? "โหลใหม่";

  const normalizeBindingKey = (key: string) => {
    const trimmed = key.trim();
    const lowered = trimmed.toLowerCase();
    if (!trimmed) return "";
    if (lowered === "ctrl" || lowered === "control") return "Control";
    if (lowered === "cmd" || lowered === "command" || lowered === "meta") return "Meta";
    if (lowered === "alt" || lowered === "option") return "Alt";
    if (lowered === "shift") return "Shift";
    if (lowered === "space") return "Space";
    if (trimmed === " ") return "Space";
    return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
  };

  const parseBindingKeys = (bindingLabel: string) => bindingLabel.split("+").map((key) => normalizeBindingKey(key)).filter(Boolean);

  const formatBindingKeys = (bindingLabel: string) => parseBindingKeys(bindingLabel).join(" + ");

  const matchesKeyboardBinding = (event: KeyboardEvent, bindingLabel: string) => {
    const requiredKeys = parseBindingKeys(bindingLabel);
    if (requiredKeys.length === 0) return false;
    const pressedKeys = new Set<string>();
    if (event.ctrlKey) pressedKeys.add("Control");
    if (event.shiftKey) pressedKeys.add("Shift");
    if (event.altKey) pressedKeys.add("Alt");
    if (event.metaKey) pressedKeys.add("Meta");
    const mainKey = normalizeBindingKey(event.key);
    if (mainKey && !["Control", "Shift", "Alt", "Meta"].includes(mainKey)) pressedKeys.add(mainKey);
    return requiredKeys.length === pressedKeys.size && requiredKeys.every((key) => pressedKeys.has(key));
  };

  const toggleKeyRule = (gift: string) => setKeyRules((current) => current.map((rule) => rule.gift === gift ? { ...rule, enabled: !rule.enabled } : rule));
  const deleteKeyRule = (gift: string) => { if (window.confirm(`ลบคำสั่งของขวัญ ${gift} ออกจากกฎการทำงานหรือไม่?`)) setKeyRules((current) => current.filter((rule) => rule.gift !== gift)); };
  const sendKeyboardSequence = async (sequence: string, source: "ทดสอบ" | "กดจริง", ruleLabel: string) => {
    if (authUser?.role !== "admin" && authUser?.accessStatus !== "active") {
      setLastAction("แพ็กเกจยังไม่เริ่มใช้งานหรือหมดอายุแล้ว กรุณาต่ออายุแพ็กเกจ");
      setActiveNav("subscription");
      return;
    }
    const normalized = formatBindingKeys(sequence);
    if (!normalized) {
      setLastAction(`กฎ "${ruleLabel}" ยังไม่มีชุดปุ่มให้ส่ง`);
      return false;
    }

    const invokeTauri = await getTauriInvoke();
    if (!invokeTauri) {
      setLastAction(`${source}กฎ "${ruleLabel}" → ${normalized} (preview เท่านั้น)`);
      return false;
    }

    try {
      await invokeTauri("send_keyboard_sequence", { sequence: normalized });
      setLastAction(`${source}กฎ "${ruleLabel}" → ${normalized}`);
      return true;
    } catch (error) {
      setLastAction(`ส่งคีย์บอร์ดไม่สำเร็จสำหรับ "${ruleLabel}": ${String(error)}`);
      return false;
    }
  };
  const runKeyboardRulePreview = async (rule: KeyRule, source: "ทดสอบ" | "กดจริง") => {
    if (rule.bindingType !== "keyboard") {
      setLastAction(`กฎ "${rule.gift}" ยังไม่ได้ตั้งค่าการกดปุ่ม`);
      return;
    }
    await sendKeyboardSequence(rule.bindingLabel, source, rule.gift);
  };
  const testKeyRule = async (rule: KeyRule) => {
    if (testingRuleGift === rule.gift) return;
    if (!rule.enabled) {
      setLastAction(`กฎ "${rule.gift}" ถูกหยุดอยู่ จึงทดสอบไม่ได้`);
      return;
    }
    setTestingRuleGift(rule.gift);
    if (rule.bindingType === "keyboard") {
      await runKeyboardRulePreview(rule, "ทดสอบ");
    } else if (rule.bindingType === "overlay") {
      setLastAction(`ทดสอบกฎ Overlay "${rule.gift}" → ${rule.action}`);
    } else {
      setLastAction(`กฎ "${rule.gift}" ยังไม่ได้ตั้งค่าการกดปุ่ม`);
    }
    window.setTimeout(() => {
      setTestingRuleGift((current) => (current === rule.gift ? "" : current));
    }, 800);
  };
  const toggleKey = (key: string) => setSelectedKeys((current) => current.includes(key) ? (current.length === 1 ? current : current.filter((item) => item !== key)) : [...current, key]);
  const getTauriInvoke = async () => {
    if (typeof window === "undefined") return null;
    if (!isTauri()) return null;
    return invoke;
  };
  const playSoundPreview = (frequency: number) => {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    oscillator.type = "sine";
    gain.gain.setValueAtTime(0.18, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.28);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.3);
  };
  const handleSoundUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const added = files.map((file) => ({ name: file.name, url: URL.createObjectURL(file) }));
    setCustomSounds((current) => [...current, ...added]);
    event.target.value = "";
  };
  const dispatchKeyboardRulesForEvent = async (eventType: EventType, payload: { gift?: string; giftId?: string; username?: string; message?: string; repeatCount?: number; likeCount?: number }) => {
    const liveTypeRules = keyRules.filter((rule) => rule.enabled && rule.bindingType === "keyboard" && (rule.triggerType ?? "gift") === eventType);
    if (liveTypeRules.length === 0) return;

    if (eventType === "gift") {
      const currentGiftId = (payload.giftId ?? "").trim();
      const currentGiftKey = normalizeGiftMatchKey(payload.gift ?? "");
      const matchedRules = liveTypeRules.filter((rule) => {
        const ruleGiftId = (rule.giftId ?? liveGiftIds[rule.gift] ?? "").trim();
        if (currentGiftId && ruleGiftId) return currentGiftId === ruleGiftId;
        return Boolean(currentGiftKey) && normalizeGiftMatchKey(rule.gift) === currentGiftKey;
      });
      if (matchedRules.length === 0) {
        pushDebugNotification(
          "GIFT ไม่ตรงกับกฎ",
          `ไม่พบกฎสำหรับ ${payload.gift || `Gift ID ${currentGiftId || "unknown"}`}`,
          `incoming_id=${currentGiftId || "none"} | incoming_name=${payload.gift || "none"}`,
        );
      }
      for (const rule of matchedRules) {
        const repeats = Math.max(1, payload.repeatCount ?? 1);
        for (let index = 0; index < repeats; index += 1) {
          // eslint-disable-next-line no-await-in-loop
          await runKeyboardRulePreview(rule, "กดจริง");
        }
      }
      return;
    }

    if (eventType === "comment") {
      const normalizedMessage = (payload.message ?? "").trim().toLowerCase();
      const normalizedMatch = commentMatch.trim().toLowerCase();
      const matched =
        normalizedMatch.length > 0 &&
        (commentMatchMode === "exact" ? normalizedMessage === normalizedMatch : normalizedMessage.includes(normalizedMatch));
      if (!matched) return;
      for (const rule of liveTypeRules) {
        // eslint-disable-next-line no-await-in-loop
        await runKeyboardRulePreview(rule, "กดจริง");
      }
      return;
    }

    if (eventType === "like") {
      if (likeCountMode === "threshold") {
        const likeCount = payload.likeCount ?? 0;
        if (likeCount < likeThreshold || likeCount % likeThreshold !== 0) return;
      }
      for (const rule of liveTypeRules) {
        // eslint-disable-next-line no-await-in-loop
        await runKeyboardRulePreview(rule, "กดจริง");
      }
      return;
    }

    if (eventType === "follow") {
      const normalizedUser = (payload.username ?? "").trim().toLowerCase();
      if (followMode === "round") {
        if (!normalizedUser || followRoundSeenRef.current.has(normalizedUser)) return;
        followRoundSeenRef.current.add(normalizedUser);
      }
      if (followMode === "permanent") {
        if (!normalizedUser || followPermanentSeenRef.current.has(normalizedUser)) return;
        followPermanentSeenRef.current.add(normalizedUser);
        savePersistedStringSet(userFollowStorageKey, followPermanentSeenRef.current);
      }
      for (const rule of liveTypeRules) {
        // eslint-disable-next-line no-await-in-loop
        await runKeyboardRulePreview(rule, "กดจริง");
      }
      return;
    }

    for (const rule of liveTypeRules) {
      // eslint-disable-next-line no-await-in-loop
      await runKeyboardRulePreview(rule, "กดจริง");
    }
  };
  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.repeat) return;
      const matchedRule = keyRules.find((rule) => rule.enabled && rule.bindingType === "keyboard" && matchesKeyboardBinding(event, rule.bindingLabel));
      if (!matchedRule) return;
      runKeyboardRulePreview(matchedRule, "กดจริง");
    };

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [keyRules]);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    const handleTikTokPayload = (payload: Record<string, unknown>) => {
      const eventId = String(payload._event_id ?? "");
      if (eventId && seenTikTokEventIdsRef.current.has(eventId)) return;
      if (eventId) {
        seenTikTokEventIdsRef.current.add(eventId);
        if (seenTikTokEventIdsRef.current.size > 2_000) {
          const oldestId = seenTikTokEventIdsRef.current.values().next().value;
          if (oldestId) seenTikTokEventIdsRef.current.delete(oldestId);
        }
      }
      const type = String(payload.type ?? payload.event_type ?? payload.eventType ?? payload.kind ?? "").trim().toLowerCase();
      const liveType = type === "chat" ? "comment" : type;
      if (type === "gift_catalog") {
        const catalog = Array.isArray(payload.gifts) ? payload.gifts as Array<{ name?: string; gift_id?: string; coin_value?: number | null }> : [];
        const liveValues = Object.fromEntries(catalog.filter((item) => item.name && typeof item.coin_value === "number").map((item) => [item.name as string, item.coin_value as number]));
        const liveIds = Object.fromEntries(catalog.filter((item) => item.name && item.gift_id).map((item) => [item.name as string, String(item.gift_id)]));
        setLiveGiftValues(liveValues);
        setGiftValues(liveValues);
        setLiveGiftIds(liveIds);
        setConnectorDebugStage("โหลดรายการของขวัญจาก connector แล้ว");
        setConnectorDebugDetail(`พบของขวัญ ${catalog.length} รายการ`);
        pushSystemNotification("อัปเดตรายการของขวัญ", `โหลดรายการของขวัญจาก LIVE แล้ว ${catalog.length} รายการ`);
      }
      if (type === "worker_starting") {
        setConnected(false);
        setConnectorDebugStage("connector กำลังเริ่มงาน");
        setConnectorDebugDetail(`@${username.replace(/^@/, "") || "unknown"} กำลังเตรียมตัวเชื่อมต่อ`);
        pushConnectionNotification("กำลังเริ่มงาน", `connector กำลังเริ่มงานกับ @${username.replace(/^@/, "") || "unknown"}`, "รอ worker ส่งสัญญาณเริ่ม");
      }
      if (type === "worker_started") {
        setConnectorDebugStage("connector เริ่มทำงานแล้ว");
        setConnectorDebugDetail(`worker พร้อมรับ event จาก @${username.replace(/^@/, "") || "unknown"}`);
        pushConnectionNotification("worker started", `connector เริ่มทำงานกับ @${username.replace(/^@/, "") || "unknown"}`, "กำลังรอ TikTok LIVE ยืนยันการเชื่อมต่อ");
      }
      if (type === "connecting") {
        setConnected(false);
        setConnectorDebugStage("connector กำลังเริ่มเชื่อมต่อ");
        setConnectorDebugDetail(`กำลังติดต่อ TikTok LIVE ของ @${username.replace(/^@/, "") || "unknown"}`);
        pushConnectionNotification("กำลังเชื่อมต่อ", `กำลังเชื่อมต่อกับ TikTok LIVE ของ @${username.replace(/^@/, "") || "unknown"}`, "รอการตอบกลับจากตัวเชื่อมต่อ");
      }
      if (type === "connect" || type === "connected") {
        setConnected(true);
        setConnectorDebugStage("connector เชื่อมต่อสำเร็จ");
        setConnectorDebugDetail(`พร้อมรับ event จาก @${username.replace(/^@/, "") || "unknown"}`);
        pushConnectionNotification("เชื่อมต่อสำเร็จ", `เชื่อมต่อ TikTok LIVE สำเร็จกับ @${username.replace(/^@/, "") || "unknown"}`, "เริ่มรับ comment, gift, follow และ event อื่น ๆ");
      }
      if (type === "connected") {
        // handled above
      }
      if (type === "disconnect" || type === "disconnected" || type === "worker_stopped") {
        setConnected(false);
        setConnectorDebugStage("connector หยุดรับ event");
        setConnectorDebugDetail(String(payload.reason ?? "หยุดทำงานแล้ว"));
        pushConnectionNotification("ตัดการเชื่อมต่อ", String(payload.reason ?? "หยุดทำงานแล้ว"), "ระบบจะหยุดรับ event ชั่วคราว");
      }
      if (type === "worker_error") {
        const errorMessage = `TikTok worker error: ${String(payload.message ?? "เกิดข้อผิดพลาด")}`;
        setConnected(false);
        setLastAction(errorMessage);
        setConnectorDebugStage("worker error");
        setConnectorDebugDetail(errorMessage);
        pushSystemNotification("worker error", errorMessage, "ตรวจสอบ log ของ Python connector");
      }
      if (type === "error") {
        const errorMessage = `TikTok connector: ${String(payload.message ?? "เกิดข้อผิดพลาด")}`;
        setConnected(false);
        setLastAction(errorMessage);
        setConnectorDebugStage("connector เกิดข้อผิดพลาด");
        setConnectorDebugDetail(errorMessage);
        pushSystemNotification("เกิดข้อผิดพลาด", errorMessage, "ตรวจสอบการเชื่อมต่อกับ TikTok LIVE");
      }
      if (type === "heartbeat") {
        pushDebugNotification("HEARTBEAT", "worker ยังทำงานอยู่", `@${username.replace(/^@/, "") || "unknown"}`);
      }
      if (type === "debug") {
        const debugMessage = String(payload.message ?? "debug");
        const debugDetail = String(payload.detail ?? payload.stage ?? debugMessage);
        setConnectorDebugStage(String(payload.stage ?? debugMessage));
        setConnectorDebugDetail(debugDetail);
        pushDebugNotification("CONNECTOR DEBUG", debugMessage, debugDetail);
      }
      if (["gift", "comment", "chat", "follow", "like", "share", "join"].includes(type)) {
        const normalizedLiveType = liveType as Exclude<EventType, "chat">;
        const username = String(payload.username ?? ""); 
        const gift = String(payload.gift_name ?? "");
        const giftId = String(payload.gift_id ?? payload.gift_type ?? "");
        const message = String(payload.message ?? "");
        const repeatCount = Math.max(1, Number(payload.repeat_count ?? 1) || 1);
        const now = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
        pushConnectorTrace(
          normalizedLiveType,
          normalizedLiveType === "gift"
            ? `gift ${gift || "unknown"} x${repeatCount}`
            : normalizedLiveType === "comment"
              ? `comment จาก @${username || "viewer"}`
              : normalizedLiveType === "follow"
                ? `follow จาก @${username || "viewer"}`
                : normalizedLiveType === "like"
                  ? `like จาก @${username || "viewer"}`
                  : normalizedLiveType === "share"
                    ? `share จาก @${username || "viewer"}`
                    : `join จาก @${username || "viewer"}`,
          normalizedLiveType === "gift"
            ? `${gift || "unknown"} | repeat=${repeatCount}`
            : normalizedLiveType === "comment"
              ? message || "(ไม่มีข้อความ)"
              : String(payload.nickname ?? payload.user_id ?? payload.userId ?? "viewer"),
        );
        if (normalizedLiveType === "gift") {
          const coinValue = giftValues[gift] ?? liveGiftValues[gift] ?? 0;
          const nextStats = {
            ...liveStats,
            gifts: liveStats.gifts + repeatCount,
            giftCoins: liveStats.giftCoins + (coinValue * repeatCount),
          };
          const nextGiftCounts = (["classic", "tall", "hex", "cute"] as JarStyle[]).reduce<JarGiftCounts>((next, style) => {
            next[style] = Math.min(MAX_JAR_ITEM_COUNT, (overlayGiftCounts[style] ?? 0) + repeatCount);
            return next;
          }, { ...overlayGiftCounts });
          setLiveStats(nextStats);
          setLatestLiveUser(username);
          setLatestLiveGiftName(gift);
          setLatestLiveGiftCount(repeatCount);
          setOverlayGiftCounts(nextGiftCounts);
          void dispatchKeyboardRulesForEvent("gift", { gift, giftId, username, repeatCount });
          void persistLiveFlowSnapshot(
            {
              ...buildLiveFlowSnapshot(),
              liveStats: nextStats,
              latestLiveUser: username,
              latestLiveGiftName: gift,
              latestLiveGiftCount: repeatCount,
              overlayGiftCounts: nextGiftCounts,
            },
            `รับของขวัญ ${gift} x${repeatCount}`
          );
        }
        if (normalizedLiveType === "comment") {
          const nextStats = { ...liveStats, comments: liveStats.comments + 1 };
          setLiveStats(nextStats);
          setConnectorDebugStage("ได้รับ comment จาก TikTok LIVE");
          setConnectorDebugDetail(`@${username || "viewer"}: ${message || "(ไม่มีข้อความ)"}`);
          const normalizedMessage = message.trim().toLowerCase();
          const normalizedMatch = commentMatch.trim().toLowerCase();
          const matched = commentMatchMode === "exact" ? normalizedMessage === normalizedMatch : normalizedMessage.includes(normalizedMatch);
          if (normalizedMatch && matched) setLastAction(`คอมเมนต์ตรงเงื่อนไข → เตรียมกด ${keyBinding}`);
          if (matched) void dispatchKeyboardRulesForEvent("comment", { message, username });
          void persistLiveFlowSnapshot({ ...buildLiveFlowSnapshot(), liveStats: nextStats });
        }
        if (normalizedLiveType === "follow") {
          const nextStats = { ...liveStats, follows: liveStats.follows + 1 };
          setLiveStats(nextStats);
          void dispatchKeyboardRulesForEvent("follow", { username });
          void persistLiveFlowSnapshot({ ...buildLiveFlowSnapshot(), liveStats: nextStats });
        }
        if (normalizedLiveType === "like") {
          const nextStats = { ...liveStats, likes: liveStats.likes + 1 };
          setLiveStats(nextStats);
          void dispatchKeyboardRulesForEvent("like", { likeCount: nextStats.likes, username });
          void persistLiveFlowSnapshot({ ...buildLiveFlowSnapshot(), liveStats: nextStats });
        }
        if (normalizedLiveType === "share") {
          const nextStats = { ...liveStats, shares: liveStats.shares + 1 };
          setLiveStats(nextStats);
          void dispatchKeyboardRulesForEvent("share", { username });
          void persistLiveFlowSnapshot({ ...buildLiveFlowSnapshot(), liveStats: nextStats });
        }
        if (normalizedLiveType === "join") {
          const nextStats = { ...liveStats, joins: liveStats.joins + 1 };
          setLiveStats(nextStats);
          void dispatchKeyboardRulesForEvent("join", { username });
          void persistLiveFlowSnapshot({ ...buildLiveFlowSnapshot(), liveStats: nextStats });
        }
        if (normalizedLiveType === "comment") {
          setEvents((current) => [{
            id: Date.now(),
            type: "comment" as const,
            user: username || "viewer",
            text: message || "(ไม่มีข้อความ)",
            time: now,
          }, ...current.filter((item) => item.type === "comment")].slice(0, MAX_STORED_CHAT_EVENTS));
        }
        pushNotification({
          kind: normalizedLiveType,
          title:
            normalizedLiveType === "gift"
              ? "Gift"
              : normalizedLiveType === "comment"
                ? "Comment"
                : normalizedLiveType === "follow"
                  ? "Follow"
                  : normalizedLiveType === "like"
                    ? "Like"
                    : normalizedLiveType === "share"
                      ? "Share"
                      : "Join",
          message:
            normalizedLiveType === "gift"
              ? `${username || "viewer"} ส่ง ${gift || "Gift"} x${repeatCount}`
              : `${username || "viewer"}: ${message || (normalizedLiveType === "comment" ? "คอมเมนต์" : normalizedLiveType === "follow" ? "กดติดตาม" : normalizedLiveType === "like" ? "กดถูกใจ" : normalizedLiveType === "share" ? "แชร์" : "เข้าห้อง")}`,
          detail:
            normalizedLiveType === "gift"
              ? `มูลค่า ${((giftValues[gift] ?? liveGiftValues[gift] ?? 0) * repeatCount).toLocaleString()} Coins`
              : "บันทึกจาก TikTok LIVE แบบเรียลไทม์",
          user: username || "viewer",
          gift: gift || undefined,
        });
        if (normalizedLiveType === "comment") {
          pushDebugNotification(
            "DEBUG COMMENT",
            `รับ comment จาก @${username || "viewer"}`,
            message || "ข้อความว่าง"
          );
        }
        setChatLogs((current) => [
          {
            id: Date.now(),
            event_type: normalizedLiveType,
            username: username || "viewer",
            message: normalizedLiveType === "gift" ? `ส่ง ${gift} x${repeatCount}` : message || (normalizedLiveType === "comment" ? "คอมเมนต์" : normalizedLiveType === "follow" ? "กดติดตาม" : normalizedLiveType === "like" ? "กดถูกใจ" : normalizedLiveType === "share" ? "แชร์" : "เข้าห้อง"),
            gift_name: gift || null,
            repeat_count: repeatCount,
            created_at: new Date().toISOString(),
          },
          ...current,
        ].slice(0, 300));
        if (authUser?.id) {
          void neon.from("liveflow_auth_chat_logs").insert({
            auth_user_id: authUser.id,
            event_type: normalizedLiveType,
            username: username || "viewer",
            message: normalizedLiveType === "gift"
              ? `ส่ง ${gift || "Gift"} x${repeatCount}`
              : message || (normalizedLiveType === "comment" ? "คอมเมนต์" : normalizedLiveType === "follow" ? "กดติดตาม" : normalizedLiveType === "like" ? "กดถูกใจ" : normalizedLiveType === "share" ? "แชร์" : "เข้าห้อง"),
            gift_name: gift || null,
            repeat_count: repeatCount,
            raw_json: payload,
          }).then(({ error }) => {
            if (error) pushDebugNotification("NEON LOG ERROR", "บันทึกกิจกรรมสดไม่สำเร็จ", error.message);
          });
        }
      }
    };

    void listen<Record<string, unknown>>("tiktok-event", (event) => {
      handleTikTokPayload(event.payload);
    }).then((unlisten) => { unsubscribe = unlisten; }).catch(() => undefined);

    const runningInTauri = isTauri();
    const pollQueuedEvents = () => {
      if (!runningInTauri) return;
      void invoke<Record<string, unknown>[]>("drain_tiktok_events")
        .then((events) => events.forEach(handleTikTokPayload))
        .catch(() => undefined);
    };
    pollQueuedEvents();
    const pollingTimer = window.setInterval(pollQueuedEvents, 250);

    return () => {
      unsubscribe?.();
      window.clearInterval(pollingTimer);
    };
  }, [commentMatch, commentMatchMode, keyBinding, giftValues, liveGiftValues, liveGiftIds, userFollowStorageKey, authUser?.id]);

  const connect = async () => {
    const normalized = username.trim().replace(/^@/, "");
    if (!normalized) return;
    setUsername(`@${normalized}`);
    setActiveNav("overview");
    setConnectorDebugStage("กำลังส่งคำสั่งเริ่มเชื่อมต่อ");
    setConnectorDebugDetail(`target @${normalized}`);
    pushConnectionNotification("เริ่มเชื่อมต่อ", `ส่งคำสั่งเชื่อมต่อไปยัง TikTok LIVE ของ @${normalized}`, "ระบบกำลังเริ่มต้นตัวเชื่อมต่อ");
    try {
      const invokeTauri = await getTauriInvoke();
      if (!invokeTauri) {
        setLastAction("ต้องเปิดใน Tauri Desktop app ก่อนถึงจะเชื่อมต่อ TikTok LIVE ได้");
        pushSystemNotification("เชื่อมต่อไม่สำเร็จ", "ต้องเปิดใน Tauri Desktop app ก่อนถึงจะเชื่อมต่อ TikTok LIVE ได้");
        return;
      }
      await invokeTauri("start_tiktok_connector", { username: normalized });
      setConnected(false);
      setConnectorDebugStage("สั่งเริ่มเชื่อมต่อแล้ว รอ connector ยืนยัน");
      setConnectorDebugDetail(`@${normalized} กำลังรอ event connected จาก TikTok LIVE`);
    } catch (error) {
      console.warn("Tauri connector unavailable in browser preview:", error);
      setConnectorDebugStage("ส่งคำสั่งเริ่มเชื่อมต่อไม่สำเร็จ");
      setConnectorDebugDetail(String(error));
      pushSystemNotification("เชื่อมต่อไม่สำเร็จ", `เกิดข้อผิดพลาดระหว่างเริ่มเชื่อมต่อ: ${String(error)}`);
    }
  };

  const disconnect = async () => {
    pushConnectionNotification("สั่งหยุดทำงาน", "กำลังส่งคำสั่งหยุดไปยังตัวเชื่อมต่อ TikTok LIVE", "หยุดรับ event ชั่วคราว");
    try {
      const invokeTauri = await getTauriInvoke();
      if (!invokeTauri) {
        setLastAction("ต้องเปิดใน Tauri Desktop app ก่อนถึงจะหยุด TikTok LIVE ได้");
        pushSystemNotification("หยุดทำงานไม่สำเร็จ", "ต้องเปิดใน Tauri Desktop app ก่อนถึงจะหยุด TikTok LIVE ได้");
        return;
      }
      await invokeTauri("stop_tiktok_connector");
      setConnected(false);
      setLastAction("ส่งคำสั่งหยุดไปยัง TikTok LIVE แล้ว");
      setConnectorDebugStage("ส่งคำสั่งหยุด connector แล้ว");
      setConnectorDebugDetail("รอการหยุดจาก Python connector");
      pushConnectionNotification("หยุดทำงานแล้ว", "ระบบหยุดรับ event จาก TikTok LIVE เรียบร้อยแล้ว", "รอคำสั่งเชื่อมต่อใหม่");
    } catch (error) {
      console.warn("Tauri stop connector unavailable in browser preview:", error);
      setConnected(false);
      setConnectorDebugStage("หยุด connector ไม่สำเร็จ");
      setConnectorDebugDetail(String(error));
      pushSystemNotification("หยุดทำงานไม่สำเร็จ", `ส่งคำสั่งหยุดไม่สำเร็จ: ${String(error)}`);
    }
  };

  const saveRuleToTable = async () => {
    const existingRule = keyRules.find((rule) => rule.gift === selectedGift);
    const currentKeyboardRules = keyRules.filter((rule) => rule.bindingType === "keyboard").length;
    const resultingKeyboardRules = currentKeyboardRules
      - (existingRule?.bindingType === "keyboard" ? 1 : 0)
      + (action === "keyboard" ? 1 : 0);
    if (authUser?.role !== "admin" && (authUser?.keyboardRuleLimit ?? 0) >= 0 && resultingKeyboardRules > (authUser?.keyboardRuleLimit ?? 0)) {
      setLastAction(`แพ็กเกจนี้ใช้ KEYBOARD MAPPING ได้สูงสุด ${authUser?.keyboardRuleLimit ?? 0} รายการ`);
      setActiveNav("subscription");
      return;
    }
    const overlayLinkLabel = overlayLinkItems.find((item) => item.id === overlayLinkType)?.label ?? overlayLinkType;
    const actionLabel =
      action === "keyboard"
        ? "กดคีย์บอร์ด"
        : action === "sound"
          ? "เล่นเสียงแจ้งเตือน"
          : action === "overlay"
            ? "แสดง Overlay"
            : "ส่ง Webhook";
    const bindingType: KeyRule["bindingType"] =
      action === "keyboard"
        ? "keyboard"
        : action === "overlay"
        ? "overlay"
        : "none";
    const bindingLabel =
      action === "keyboard"
        ? keyBinding
        : action === "overlay"
          ? `${overlayRuleLabel} · ${overlayLinkLabel}`
          : action === "sound"
            ? soundPresets.find((sound) => sound.id === selectedSound)?.label ?? "เสียงแจ้งเตือน"
            : webhookUrl || "Webhook";

    const nextKeyRules: KeyRule[] = [
      {
        gift: selectedGift,
        giftId: liveGiftIds[selectedGift] || undefined,
        triggerType: eventType,
        bindingType,
        bindingLabel,
        action: actionLabel,
        enabled: true,
        overlayMode: action === "overlay" ? overlayRuleMode : undefined,
        overlayLinkType: action === "overlay" ? overlayLinkType : undefined,
      },
      ...keyRules.filter((rule) => rule.gift !== selectedGift),
    ];

    setKeyRules(nextKeyRules);

    const snapshot = {
      ...buildLiveFlowSnapshot(),
      keyRules: nextKeyRules,
    };
    await persistLiveFlowSnapshot(snapshot, `บันทึกกฎ "${selectedGift}" ลง Neon เรียบร้อยแล้ว`);
  };

  const testJarGiftDrop = () => {
    const nextGiftCounts = {
      ...overlayGiftCounts,
      [jarStyle]: Math.min(MAX_JAR_ITEM_COUNT, (overlayGiftCounts[jarStyle] ?? 0) + 1),
    };
    setOverlayGiftCounts(nextGiftCounts);
    void persistLiveFlowSnapshot(
      {
        ...buildLiveFlowSnapshot(),
        overlayGiftCounts: nextGiftCounts,
      },
      `โยนของขวัญทดสอบลงโหล: ${selectedGift}`
    );
    setJarDropTrigger((count) => count + 1);
  };

  const loadRuleFromDb = async () => {
    try {
      if (!authUser?.id) throw new Error("กรุณาเข้าสู่ระบบก่อน");
      const { data, error } = await neon.from("liveflow_user_state").select("state_json").eq("auth_user_id", authUser.id).maybeSingle();
      if (error) throw new Error(error.message);
      const snapshot = (data?.state_json || {}) as LiveFlowSnapshot;
      if (snapshot && typeof snapshot === "object") {
        applyLiveFlowSnapshot(snapshot);
        window.localStorage.setItem(userSnapshotStorageKey, JSON.stringify(snapshot));
        setLastAction("โหลดค่าจาก Neon กลับมาเรียบร้อยแล้ว");
      } else {
        setLastAction("ยังไม่มีข้อมูลใน Neon ให้โหลดกลับ");
      }
    } catch (error) {
      const fallback = loadPersistedSnapshot(userSnapshotStorageKey);
      if (fallback) {
        applyLiveFlowSnapshot(fallback);
        setLastAction(`โหลดจาก Neon ไม่สำเร็จ แต่ใช้ข้อมูลสำรองได้: ${String(error)}`);
      } else {
        setLastAction(`โหลดกลับไม่สำเร็จ: ${String(error)}`);
      }
    }
  };

  const buildOverlayPublicUrl = (baseUrl: string, type: OverlayLinkType) => {
    const url = new URL(baseUrl);
    const params = url.searchParams;
    if (type === "gift") {
      params.set("gift", selectedGift);
      params.set("jarStyle", jarStyle);
      params.set("count", String(currentJarGiftCount));
      params.set("capacity", String(overlayMaxItems));
      params.set("scale", String(overlayGiftScale));
      params.set("showUser", overlayShowUser ? "1" : "0");
      params.set("showCoins", overlayShowCoins ? "1" : "0");
      params.set("animation", overlayAnimation);
    }
    if (type === "alert") {
      params.set("text", overlayText);
    }
    if (type === "score") {
      params.set("count", String(currentJarGiftCount));
    }
    return url.toString();
  };

  const createRealOverlayLink = async () => {
    setOverlayLinkCreating(true);
    try {
      const invokeTauri = await getTauriInvoke();
      if (!invokeTauri) {
        const existingUrl = overlayPublicUrls[overlayLinkType];
        setLastAction(
          existingUrl
            ? `ตอนนี้อยู่ใน Browser Preview จึงสร้างลิงก์จริงไม่ได้ แต่ลิงก์ที่บันทึกไว้ยังใช้ได้: ${existingUrl}`
            : "ตอนนี้อยู่ใน Browser Preview จึงสร้างลิงก์จริงไม่ได้ ต้องเปิด Tauri Desktop app ก่อน"
        );
        return;
      }
      const url = await invokeTauri<string>("create_overlay_tunnel", {
        request: {
          local_url: "http://localhost:1420",
          public_path: `overlay/${overlayLinkType}`,
        },
      });
      const nextPublicUrls = { ...overlayPublicUrls, [overlayLinkType]: buildOverlayPublicUrl(url, overlayLinkType) };
      setOverlayPublicUrls(nextPublicUrls);
      const nextSnapshot = {
        ...buildLiveFlowSnapshot(),
        overlayPublicUrls: nextPublicUrls,
      };
      if (authUser?.id) {
        const { error } = await neon.from("liveflow_user_state").upsert({ auth_user_id: authUser.id, state_json: nextSnapshot, updated_at: new Date().toISOString() }, { onConflict: "auth_user_id" });
        if (error) throw new Error(error.message);
      }
      window.localStorage.setItem(userSnapshotStorageKey, JSON.stringify(nextSnapshot));
      setLastAction(`สร้างลิงก์ Overlay สำเร็จ: ${overlayLinkType}`);
    } catch (error) {
      setLastAction(`สร้างลิงก์ Overlay จริงไม่สำเร็จ: ${String(error)}`);
    } finally {
      setOverlayLinkCreating(false);
    }
  };

  const renderOverlayStagePreview = () => {
    if (overlayRuleMode === "image") {
      return (
        <div className="overlay-media-preview overlay-media-preview-image">
          {overlayAssetUrl ? (
            <img src={overlayAssetUrl} alt="Overlay preview" />
          ) : (
            <div className="overlay-media-placeholder">
              <Image size={28} />
              <strong>ตัวอย่างภาพ Overlay</strong>
              <small>ใส่ URL รูปภาพด้านบนเพื่อแสดงภาพจริง</small>
            </div>
          )}
        </div>
      );
    }

    if (overlayRuleMode === "video") {
      return (
        <div className="overlay-media-preview overlay-media-preview-video">
          {overlayAssetUrl ? (
            <video src={overlayAssetUrl} autoPlay muted loop playsInline />
          ) : (
            <div className="overlay-media-placeholder">
              <Play size={28} />
              <strong>ตัวอย่างวิดีโอ Overlay</strong>
              <small>ใส่ URL วิดีโอด้านบนเพื่อแสดงตัวอย่าง</small>
            </div>
          )}
        </div>
      );
    }

    if (overlayRuleMode === "text") {
      return (
        <div className="overlay-text-preview">
          <strong>{overlayText}</strong>
          <small>ข้อความนี้จะแสดงเมื่อเกิด Action</small>
        </div>
      );
    }

    return (
      <div className="overlay-live-jar-preview">
        <GiftJarOverlay
          count={currentJarGiftCount}
          jarStyle={jarStyle}
          giftName={selectedGift}
          giftScale={overlayGiftScale}
          capacity={overlayMaxItems}
          userName={latestLiveUser}
          coins={latestLiveGiftCount * (giftValues[latestLiveGiftName] ?? liveGiftValues[latestLiveGiftName] ?? 0)}
          totalCoins={liveStats.giftCoins}
          dropTrigger={jarDropTrigger}
          showUser={overlayShowUser}
          showCoins={overlayShowCoins}
        />
      </div>
    );
  };

  if (isPublicOverlayPage) {
    return (
      <div className="public-overlay-shell">
        {publicOverlayType === "gift" && (
          <section className="overlay-preview-page public-overlay-view">
            <div className="overlay-stage">
              <GiftJarOverlay
                count={currentJarGiftCount}
                jarStyle={jarStyle}
                giftName={selectedGift}
                giftScale={overlayGiftScale}
                capacity={overlayMaxItems}
                userName={latestLiveUser}
                coins={latestLiveGiftCount * (giftValues[latestLiveGiftName] ?? liveGiftValues[latestLiveGiftName] ?? 0)}
                totalCoins={liveStats.giftCoins}
                dropTrigger={jarDropTrigger}
                showUser={overlayShowUser}
                showCoins={overlayShowCoins}
              />
            </div>
          </section>
        )}

        {publicOverlayType === "alert" && (
          <section className="overlay-preview-page public-overlay-view">
            <div className="public-alert-card">
              <Sparkles size={40} />
              <strong>{overlayText}</strong>
              <span>{selectedOverlayPublicUrl || selectedOverlayLink}</span>
            </div>
          </section>
        )}

        {publicOverlayType === "score" && (
          <section className="overlay-preview-page public-overlay-view">
                <div className="public-score-card" />
              </section>
            )}

        {publicOverlayType === "chat" && (
          <section className="overlay-preview-page public-overlay-view">
            <div className="public-chat-card">
              {events.slice(0, 5).map((event) => (
                <div key={event.id} className="event-row">
                  <div className={`event-icon ${event.type}`}>{event.image ? <img src={event.image} alt="" /> : <MessageCircle />}</div>
                  <div className="event-details">
                    <strong>@{event.user}</strong>
                    <span>{event.text}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  if (authChecking) {
    return <main className="auth-loading-screen"><div className="auth-logo"><Activity size={24} /></div><strong>กำลังตรวจสอบบัญชี LiveFlow...</strong></main>;
  }

  if (!authUser) {
    return <AuthPortal onAuthenticated={handleAuthenticated} />;
  }

  const updateRequired = authUser.role !== "admin" && Boolean(systemUpdate?.forceUpdate)
    && systemUpdate?.requiredVersion !== systemUpdate?.currentVersion;
  if (updateRequired) {
    return <main className="forced-update-screen"><section><RefreshCw size={42} /><p className="eyebrow">UPDATE REQUIRED</p><h1>จำเป็นต้องอัปเดต LiveFlow</h1><p>{systemUpdate?.message || `กรุณาติดตั้งเวอร์ชัน ${systemUpdate?.requiredVersion} ก่อนใช้งาน`}</p><div><span>เวอร์ชันปัจจุบัน {systemUpdate?.currentVersion}</span><span>เวอร์ชันที่กำหนด {systemUpdate?.requiredVersion}</span></div>{systemUpdate?.updateUrl ? <button onClick={() => window.open(systemUpdate.updateUrl, "_blank", "noopener,noreferrer")}>ดาวน์โหลดเวอร์ชันใหม่</button> : <small>กรุณาติดต่อผู้ดูแลระบบเพื่อรับไฟล์อัปเดต</small>}<button className="forced-update-logout" onClick={() => void logout()}>ออกจากระบบ</button></section></main>;
  }

  const tickerAnnouncements = announcements.filter((item) => item.displayMode === "ticker");
  const bannerAnnouncements = announcements.filter((item) => item.displayMode === "banner");
  const imageAnnouncements = announcements.filter((item) => item.displayMode === "image" && item.imageUrl);
  const modalAnnouncement = announcements.find((item) => item.displayMode === "modal" && item.id !== dismissedModalAnnouncement);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={19} /></div><span>LiveFlow</span><small>MVP</small></div>
      <nav><button className={`nav-item ${activeNav === "overview" ? "active" : ""}`} onClick={() => { setActiveNav("overview"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><Activity size={18} /> ภาพรวม</button><button className={`nav-item ${activeNav === "rules" ? "active" : ""}`} onClick={() => { setActiveNav("rules"); document.getElementById("key-rules-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><Zap size={18} /> กฎการทำงาน</button><button className={`nav-item ${activeNav === "gifts" ? "active" : ""}`} onClick={() => setActiveNav("gifts")}><Gift size={18} /> ของขวัญ</button><button className={`nav-item ${activeNav === "sound" ? "active" : ""}`} onClick={() => openActionPage("sound")}><Volume2 size={18} /> เสียงแจ้งเตือน</button><button className={`nav-item ${activeNav === "overlay" ? "active" : ""}`} onClick={() => openActionPage("overlay")}><Image size={18} /> Overlay</button><button className={`nav-item ${activeNav === "webhook" ? "active" : ""}`} onClick={() => openActionPage("webhook")}><Link2 size={18} /> Webhook</button><button className={`nav-item ${activeNav === "notifications" ? "active" : ""}`} onClick={() => setActiveNav("notifications")}><Bell size={18} /> การแจ้งเตือน</button></nav>
      <div className="sidebar-bottom">
        {authUser.role === "admin" && <button className={`nav-item ${activeNav === "admin" ? "active" : ""}`} onClick={() => setActiveNav("admin")}><ShieldCheck size={18} /> Admin</button>}
        <button className={`nav-item ${activeNav === "subscription" ? "active" : ""}`} onClick={() => setActiveNav("subscription")}><CreditCard size={18} /> แพ็กเกจ</button>
        <button className={`nav-item ${activeNav === "account" ? "active" : ""}`} onClick={() => setActiveNav("account")}><Users size={18} /> บัญชีของฉัน</button>
        <button className={`nav-item ${activeNav === "settings" ? "active" : ""}`} onClick={() => setActiveNav("settings")}><Settings size={18} /> ตั้งค่า</button>
        <div className="sidebar-user"><strong>{authUser.displayName}</strong><span>{authUser.email}</span></div>
        <div className="version">TikTok LIVE Connector<br /><span>v0.1.0 MVP</span></div>
      </div>
    </aside>
    <main className={`main-content ${activeNav === "sound" || activeNav === "overlay" || activeNav === "webhook" || activeNav === "settings" || activeNav === "notifications" || activeNav === "account" || activeNav === "admin" || activeNav === "subscription" ? "dedicated-mode" : ""}`}>
      {tickerAnnouncements.length > 0 && <div className="announcement-ticker"><Megaphone size={15} /><div><span>{tickerAnnouncements.map((item) => `${item.title}: ${item.message}`).join("     •     ")}</span></div></div>}
      {bannerAnnouncements.map((item) => <article className="announcement-banner" key={item.id}>{item.imageUrl && <img src={item.imageUrl} alt="" />}<div><strong>{item.title}</strong><p>{item.message}</p></div></article>)}
      {imageAnnouncements.map((item) => <article className="announcement-image-card" key={item.id}><img src={item.imageUrl || ""} alt={item.title} /><div><strong>{item.title}</strong><p>{item.message}</p></div></article>)}
      {activeNav === "account" && <UserAccountPage user={authUser} onBack={() => setActiveNav("overview")} onLogout={() => void logout()} />}
      {activeNav === "admin" && authUser.role === "admin" && <AdminPage sessionToken={authSessionToken} currentUser={authUser} onBack={() => setActiveNav("overview")} />}
      {activeNav === "subscription" && <SubscriptionPage user={authUser} onBack={() => setActiveNav("overview")} />}
      {activeNav === "notifications" && (
        <section className="dedicated-page notifications-page">
          <div className="dedicated-page-header">
            <div>
              <p className="eyebrow">NOTIFICATIONS</p>
              <h2>การแจ้งเตือนทั่วไป</h2>
              <p className="page-copy">แสดงทุกเหตุการณ์ที่เข้ามาระหว่าง LIVE แบบแยกหน้า ดูย้อนหลังและตรวจสอบได้ง่าย</p>
            </div>
            <button className="ghost-btn" onClick={() => setActiveNav("overview")}>
              <Activity size={14} /> กลับหน้าภาพรวม
            </button>
          </div>

          <section className="panel notifications-summary-panel">
            <div className="panel-heading">
              <div>
                <h3>สรุปการแจ้งเตือน</h3>
                <p className="page-copy">รวม event ล่าสุด, สถานะการเชื่อมต่อ และข้อความจากระบบ</p>
              </div>
            </div>
            <div className={`traffic-light-banner status-${liveTrafficStatus}`}>
              <div className="traffic-light-icon" aria-hidden="true">
                <span className="traffic-dot red" />
                <span className="traffic-dot yellow" />
                <span className="traffic-dot green" />
              </div>
              <div className="traffic-light-copy">
                <strong>{liveTrafficLabel}</strong>
                <span>{liveTrafficDescription}</span>
              </div>
              <div className="traffic-light-chip">{connected ? "LIVE" : "WAIT"}</div>
            </div>
            <div className="notifications-summary-grid">
              <div className="notification-summary-card">
                <strong>{notificationFeed.length}</strong>
                <span>ข้อความทั้งหมดในฟีด</span>
              </div>
              <div className="notification-summary-card">
                <strong>{connected ? "เชื่อมต่อแล้ว" : "ยังไม่เชื่อมต่อ"}</strong>
                <span>สถานะ TikTok LIVE Connector</span>
              </div>
              <div className="notification-summary-card">
                <strong>{lastAction || "ยังไม่มีข้อความล่าสุด"}</strong>
                <span>ข้อความแจ้งเตือนจากระบบ</span>
              </div>
            </div>
            <div className="connector-debug-banner">
              <div className="connector-debug-badge">
                <Activity size={14} />
                <span>CONNECTOR DEBUG</span>
              </div>
              <strong>{connectorDebugStage}</strong>
              <p>{connectorDebugDetail}</p>
            </div>
            <div className="connector-trace-panel">
              <div className="panel-heading connector-trace-heading">
                <div>
                  <p className="eyebrow">REAL-TIME TRACE</p>
                  <h3>ลำดับการเชื่อมต่อ connector</h3>
                  <p className="page-copy">ดูได้ว่าตอนนี้อยู่ขั้นไหน: สั่งเริ่ม, รอยืนยัน, เชื่อมต่อสำเร็จ, หรือมี error</p>
                </div>
                <div className={`connection-chip ${connected ? "online" : "offline"}`}>
                  <Activity size={13} />
                  {connected ? "ยืนยันแล้ว" : "ยังรอยืนยัน"}
                </div>
              </div>
              <div className="connector-trace-list">
                {connectorTrace.length === 0 ? (
                  <div className="chat-log-empty">ยังไม่มี trace จาก connector</div>
                ) : (
                  connectorTrace.map((item) => (
                    <div key={item.id} className="connector-trace-item">
                      <div className="connector-trace-top">
                        <strong>{item.stage}</strong>
                        <time>{item.time}</time>
                      </div>
                      <div className="connector-trace-message">{item.message}</div>
                      <div className="connector-trace-detail">{item.detail}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          <div className="notifications-layout">
            <div className="notifications-column">
              <section className="panel notifications-feed-panel notifications-live-chat-panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">LIVE CHAT</p>
                    <h3>แชตสดจาก TikTok LIVE</h3>
                    <p className="page-copy">ดึงข้อความคอมเมนต์ที่เข้ามาแบบเรียลไทม์จากตัวเชื่อมต่อ</p>
                  </div>
                <div className={`connection-chip ${connected ? "online" : "offline"}`}>
                  <MessageCircle size={13} />
                  {liveChatItems.length} ข้อความ
                </div>
                <button className="ghost-btn" onClick={() => void sendTestLiveComment()}>
                  <MessageCircle size={14} /> ทดสอบ comment สด
                </button>
              </div>
              <div className="notifications-feed" ref={liveChatFeedRef}>
                {liveChatItems.length === 0 ? (
                  <div className="chat-log-empty">ยังไม่มีแชตสดจาก LIVE</div>
                ) : (
                    liveChatItems.map((item) => <NotificationRow key={item.id} item={item} />)
                  )}
                </div>
              </section>

              <section className="panel notifications-feed-panel notifications-chat-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">SYSTEM CHAT</p>
                  <h3>แชตระบบและการเชื่อมต่อ</h3>
                  <p className="page-copy">รวมข้อความเชื่อมต่อ, error และ event LIVE อื่น ๆ ไว้ในฟีดเดียว</p>
                </div>
                <div className={`connection-chip ${connected ? "online" : "offline"}`}>
                  <Wifi size={13} />
                  {connected ? "ออนไลน์" : "ออฟไลน์"}
                </div>
              </div>
              <div className="notifications-feed" ref={notificationsFeedRef}>
                {systemFeedItems.length === 0 ? (
                  <div className="chat-log-empty">ยังไม่มีข้อความจากระบบ</div>
                ) : (
                  systemFeedItems.map((item) => <NotificationRow key={item.id} item={item} />)
                )}
              </div>
            </section>
            </div>

            <section className="panel notifications-feed-panel notifications-history-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">LIVE HISTORY</p>
                  <h3>แชตย้อนหลังจาก Neon</h3>
                  <p className="page-copy">ข้อความจาก Python และ event LIVE ย้อนหลัง 10 นาที</p>
                </div>
                <button className="ghost-btn" onClick={() => void loadChatLogsFromDb()} disabled={chatLogsLoading}>
                  {chatLogsLoading ? "กำลังโหลด..." : "รีเฟรช log"}
                </button>
              </div>
              {chatLogsError && <div className="settings-banner">{chatLogsError}</div>}
              <div className="chat-log-list">
                {chatLogs.length === 0 ? (
                  <div className="chat-log-empty">ยังไม่มี log ในช่วง 10 นาทีล่าสุด</div>
                ) : (
                  chatLogs.map((row) => {
                    const eventLabel =
                      row.event_type === "gift"
                        ? "ของขวัญ"
                        : row.event_type === "comment"
                          ? "คอมเมนต์"
                          : row.event_type === "follow"
                            ? "ติดตาม"
                            : row.event_type === "like"
                              ? "ถูกใจ"
                              : row.event_type === "share"
                                ? "แชร์"
                                : "เข้าห้อง";
                    const avatar =
                      row.event_type === "gift"
                        ? "🎁"
                        : row.event_type === "comment"
                          ? "💬"
                          : row.event_type === "follow"
                            ? "👤"
                            : row.event_type === "like"
                              ? "❤️"
                              : row.event_type === "share"
                                ? "🔄"
                                : "🏠";
                    const message =
                      row.event_type === "gift"
                        ? `${row.username} ส่ง ${row.gift_name ?? "Gift"}${row.repeat_count > 1 ? ` x${row.repeat_count}` : ""}`
                        : row.message || row.event_type;

                    return (
                      <div key={row.id} className={`chat-log-row ${row.event_type}`}>
                        <div className="chat-log-avatar">{avatar}</div>
                        <div className="chat-log-bubble">
                          <div className="chat-log-top">
                            <strong>{row.username || "ไม่ระบุชื่อ"}</strong>
                            <time>{row.created_at}</time>
                          </div>
                          <div className="chat-log-message">{message}</div>
                          <div className="chat-log-meta">
                            <span className={`chat-tag ${row.event_type}`}>{eventLabel}</span>
                            {row.event_type === "gift" && row.gift_name && <span className="chat-tag subtle">Gift: {row.gift_name}</span>}
                            {row.repeat_count > 1 && <span className="chat-tag subtle">x{row.repeat_count}</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </section>
      )}
      {activeNav === "settings" && (
        <section className="dedicated-page settings-page">
          <div className="dedicated-page-header">
            <div>
              <p className="eyebrow">SYSTEM SETTINGS</p>
              <h2>ตั้งค่าระบบ</h2>
              <p className="page-copy">จัดการการตั้งค่าทั่วไปของแอป</p>
            </div>
            <button className="ghost-btn" onClick={() => setActiveNav("overview")}>
              <Activity size={14} /> กลับหน้าภาพรวม
            </button>
          </div>
          <section className="panel system-settings-panel">
            <div className="panel-heading">
              <div>
                <h3>ตั้งค่าระบบ</h3>
                <p className="page-copy">จัดการการตั้งค่าทั่วไปของแอป</p>
              </div>
            </div>
            <div className="system-settings-grid">
              <div className="system-setting-card">
                <strong>ข้อมูลระบบ</strong>
                <p>เวอร์ชัน MVP และสถานะการเชื่อมต่อจะแสดงที่แถบด้านซ้ายกับหน้า Overview</p>
              </div>
              <div className="system-setting-card">
                <strong>การเชื่อมต่อ</strong>
                <p>ตั้งค่า TikTok LIVE, Overlay และ Webhook ได้จากเมนูเฉพาะของแต่ละหน้า</p>
              </div>
            </div>
          </section>
        </section>
      )}
      {activeNav === "overlay" && (
        <section className="overlay-config-panel panel">
          <div className="overlay-config-header">
            <div>
              <p className="eyebrow">OVERLAY BUILDER</p>
              <h2>ตั้งค่า Overlay</h2>
              <p className="page-copy">ออกแบบหน้าจอแสดงผลสำหรับ Gift, Follow, Like, Comment และ Event อื่น ๆ</p>
            </div>
            <button className="ghost-btn" onClick={() => setLastAction("ทดสอบ Overlay แล้ว")}>▶ ทดสอบ Overlay</button>
          </div>

          <div className="overlay-builder-section">
            <div className="settings-title">
              <Sparkles size={15} />
              <strong>เลือกรูปแบบ Overlay</strong>
            </div>
            <div className="overlay-mode-grid">
              <button className={overlayRuleMode === "jar" ? "selected" : ""} onClick={() => setOverlayRuleMode("jar")}>
                <span>🏺</span>
                <strong>โหลใหม่</strong>
                <small>โยนของขวัญลงโหลใหม่แบบเรียลไทม์</small>
              </button>
              <button className={overlayRuleMode === "image" ? "selected" : ""} onClick={() => setOverlayRuleMode("image")}>
                <span>🖼️</span>
                <strong>ภาพ Overlay</strong>
                <small>แสดงภาพเมื่อเกิด Event</small>
              </button>
              <button className={overlayRuleMode === "video" ? "selected" : ""} onClick={() => setOverlayRuleMode("video")}>
                <span>🎬</span>
                <strong>วิดีโอ Overlay</strong>
                <small>เล่นวิดีโอเมื่อมี Action</small>
              </button>
              <button className={overlayRuleMode === "text" ? "selected" : ""} onClick={() => setOverlayRuleMode("text")}>
                <span>💬</span>
                <strong>ข้อความแจ้งเตือน</strong>
                <small>แสดงข้อความและชื่อผู้ชม</small>
              </button>
            </div>
          </div>

          <div className="overlay-builder-section">
            {(overlayRuleMode === "jar" || overlayRuleMode === "text") && (
              <>
                <div className="settings-title">
                  <Gift size={15} />
                  <strong>{overlayRuleMode === "jar" ? "ตั้งค่าโหลใหม่" : "ตั้งค่าข้อความแจ้งเตือน"}</strong>
                </div>
                {overlayRuleMode === "jar" ? (
                  <>
                    <div className="overlay-field-grid">
                      <label>
                        จำนวนของขวัญสูงสุด
                        <input type="number" min="1" max={MAX_JAR_ITEM_COUNT} value={overlayMaxItems} onChange={(e) => setOverlayMaxItems(Math.max(1, Math.min(MAX_JAR_ITEM_COUNT, Number(e.target.value))))} />
                      </label>
                      <label>
                        รูปแบบแอนิเมชัน
                        <select value={overlayAnimation} onChange={(e) => setOverlayAnimation(e.target.value as "drop" | "bounce" | "fade")}>
                          <option value="drop">ตกลงโหล</option>
                          <option value="bounce">เด้ง</option>
                          <option value="fade">จางเข้า</option>
                        </select>
                      </label>
                      <label>
                        ขนาดลูกบอลของขวัญ
                        <input
                          type="range"
                          min="0.7"
                          max="1.6"
                          step="0.05"
                          value={overlayGiftScale}
                          onChange={(e) => setOverlayGiftScale(Number(e.target.value))}
                        />
                        <small>ย่อหรือขยายลูกบอลในโหลได้</small>
                      </label>
                      <label>
                        จำนวนของขวัญสำหรับทดสอบ
                        <input
                          type="number"
                          min="0"
                          max={MAX_JAR_ITEM_COUNT}
                          value={currentJarGiftCount}
                          onChange={(e) => setCurrentJarGiftCount(Math.max(0, Math.min(MAX_JAR_ITEM_COUNT, Number(e.target.value))))}
                        />
                        <small>มากกว่าความจุโหล = ของขวัญจะล้นออกมาที่พื้น</small>
                      </label>
                    </div>
                    <div className="overlay-checks">
                      <label><input type="checkbox" checked={overlayShowUser} onChange={(e) => setOverlayShowUser(e.target.checked)} /> แสดงชื่อผู้ส่ง</label>
                      <label><input type="checkbox" checked={overlayShowCoins} onChange={(e) => setOverlayShowCoins(e.target.checked)} /> แสดง Coins</label>
                    </div>
                    <div className="overlay-test-row">
                      <button className="overlay-action-btn" type="button" onClick={testJarGiftDrop}>🎁 โยน Gift ทดสอบลงโหล</button>
                      <button className="ghost-btn" type="button" onClick={() => setCurrentJarGiftCount(0)}>↻ รีเซ็ตโหลทดสอบ</button>
                    </div>
                  </>
                ) : (
                  <label className="overlay-wide-field">
                    ข้อความที่แสดง
                    <input value={overlayText} onChange={(e) => setOverlayText(e.target.value)} placeholder="เช่น ขอบคุณสำหรับของขวัญ!" />
                  </label>
                )}
              </>
            )}
          </div>

          <div className="overlay-builder-section">
            {(overlayRuleMode === "image" || overlayRuleMode === "video") && (
              <>
                <div className="settings-title">
                  <Image size={15} />
                  <strong>{overlayRuleMode === "image" ? "ไฟล์ภาพ Overlay" : "ไฟล์วิดีโอ Overlay"}</strong>
                </div>
                <label className="overlay-wide-field">
                  URL ไฟล์ หรือ URL จาก API
                  <input value={overlayAssetUrl} onChange={(e) => setOverlayAssetUrl(e.target.value)} placeholder={overlayRuleMode === "image" ? "https://example.com/overlay.png" : "https://example.com/overlay.mp4"} />
                </label>
                <label className="upload-btn">
                  <Plus size={14} /> เลือกไฟล์จากเครื่อง
                  <input type="file" accept={overlayRuleMode === "image" ? "image/*" : "video/*"} />
                </label>
              </>
            )}
          </div>

          {overlayRuleMode === "jar" && (
            <div className="overlay-builder-section">
              <div className="settings-title">
                <Gift size={15} />
                <strong>เลือกแบบโหล</strong>
              </div>
              <div className="jar-style-grid">
                {jarStyleOptions.map((option) => (
                  <button
                    key={option.id}
                    className={`jar-style-card ${jarStyle === option.id ? "selected" : ""}`}
                    onClick={() => {
                      setJarStyle(option.id);
                      setLastAction("");
                    }}
                    type="button"
                  >
                    <div className={`jar-style-mini jar-style-${option.id}`} aria-hidden="true">
                      <span className="jar-mini-lid" />
                      <span className="jar-mini-body" />
                    </div>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="overlay-builder-section overlay-link-panel">
            <div className="settings-title">
              <Link2 size={15} />
              <strong>ลิงก์ใช้งานโหลใหม่</strong>
            </div>
            <div className="overlay-link-grid">
              {overlayLinkItems.map((item) => (
                <button
                  key={item.id}
                  className={`overlay-link-card ${overlayLinkType === item.id ? "selected" : ""}`}
                  onClick={() => {
                    setOverlayLinkType(item.id);
                    setOverlayRuleMode(overlayModeByLinkType[item.id]);
                  }}
                >
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </button>
              ))}
            </div>
            <div className="overlay-link-result">
              <code>{selectedOverlayPublicUrl || selectedOverlayLink}</code>
              <button onClick={() => navigator.clipboard?.writeText(selectedOverlayPublicUrl || selectedOverlayLink)}>คัดลอกลิงก์</button>
              <button onClick={() => window.open(selectedOverlayPublicUrl || selectedOverlayLink, "_blank", "noopener,noreferrer")}>เปิด</button>
            </div>
            <button className="overlay-action-btn" onClick={createRealOverlayLink} disabled={overlayLinkCreating}>
              {overlayLinkCreating ? "กำลังสร้างลิงก์..." : "สร้างลิงก์จริงสำหรับโหลใหม่ / TikTok Studio"}
            </button>
            <small>เลือกประเภทลิงก์ที่ต้องการแล้วกดสร้างทีละอัน ลิงก์นี้ใช้กับ OBS / TikTok Studio ได้</small>
          </div>

          <div className="overlay-builder-section overlay-placement">
            <div className="settings-title">
              <Settings size={15} />
              <strong>การแสดงผล</strong>
            </div>
            <div className="overlay-field-grid">
              <label>
                ตำแหน่ง
                <select defaultValue="center">
                  <option value="center">กึ่งกลาง</option>
                  <option value="top">ด้านบน</option>
                  <option value="bottom">ด้านล่าง</option>
                </select>
              </label>
              <label>
                ขนาด
                <select defaultValue="medium">
                  <option value="small">เล็ก</option>
                  <option value="medium">กลาง</option>
                  <option value="large">ใหญ่</option>
                </select>
              </label>
            </div>
            <small>การตั้งค่านี้จะถูกใช้เมื่อเรียก Overlay จากกฎการทำงาน</small>
          </div>
        </section>
      )}
      {activeNav === "overlay" && (
        <section className="overlay-preview-page overlay-preview-static">
          <div className="overlay-preview-top">
            <div>
              <p className="overlay-kicker">กระปุกออมสิน <span>PRO</span></p>
              <p className="overlay-description">ชมโหลที่เต็มไปด้วยของขวัญขณะดู LIVE ของคุณ เพิ่มความสนุกและความชัดเจนให้กับ Overlay</p>
              <p className="overlay-gift-note">ของขวัญที่เลือกจากกฎการทำงาน: <strong>{selectedGift}</strong></p>
            </div>
            <div className="overlay-preview-actions">
              <button type="button" onClick={() => setCurrentJarGiftCount(0)}>↻ รีเซ็ต Jar</button>
              <button type="button" onClick={() => window.open(selectedOverlayPublicUrl || selectedOverlayLink, "_blank", "noopener,noreferrer")}>↗</button>
            </div>
          </div>
          <div className="overlay-url-row">
            <input
              value={selectedOverlayPublicUrl || selectedOverlayLink}
              readOnly
            />
              <button onClick={() => navigator.clipboard?.writeText(selectedOverlayPublicUrl || selectedOverlayLink)}>คัดลอก URL</button>
            <button type="button" onClick={() => setCurrentJarGiftCount((count) => Math.min(MAX_JAR_ITEM_COUNT, count + 1))}>› ทดสอบ</button>
            <button type="button" onClick={() => setOverlayRuleMode(overlayRuleMode === "jar" ? "image" : "jar")}>⚙ ปรับแต่ง</button>
          </div>
          <div className="overlay-stage">
            {renderOverlayStagePreview()}
          </div>
        </section>
      )}
      {activeNav === "overlay" && <div className="overlay-style-picker"><strong>รูปแบบ Overlay</strong><button className={overlayRuleMode === "jar" ? "selected" : ""} onClick={() => setOverlayRuleMode("jar")}>🏺 โหลแก้ว</button><button className={overlayRuleMode === "image" ? "selected" : ""} onClick={() => setOverlayRuleMode("image")}>🖼️ ภาพ</button><button className={overlayRuleMode === "video" ? "selected" : ""} onClick={() => setOverlayRuleMode("video")}>🎬 วิดีโอ</button><button className={overlayRuleMode === "text" ? "selected" : ""} onClick={() => setOverlayRuleMode("text")}>💬 ข้อความ</button></div>}
      {activeNav === "overlay" && <section className="panel api-settings-page"><div className="settings-title"><Link2 size={15} /><strong>Overlay API URL</strong></div><input className="webhook-input" value={overlayApiUrl} onChange={(e) => setOverlayApiUrl(e.target.value)} placeholder="https://api.example.com/overlay" /><small>ระบบจะใช้ API URL ของคุณโดยตรง</small></section>}
      {(activeNav === "sound" || activeNav === "overlay" || activeNav === "webhook") && (
        <section className="dedicated-page panel">
          <div className="dedicated-page-header">
            <div>
              <p className="eyebrow">ACTION SETTINGS</p>
              <h2>
                {activeNav === "sound" ? "ตั้งค่าเสียงแจ้งเตือน" : activeNav === "overlay" ? "ตั้งค่า Overlay" : "ตั้งค่า Webhook"}
              </h2>
              <p className="page-copy">ตั้งค่าเฉพาะของเมนูนี้ แล้วนำไปผูกกับกฎการทำงานภายหลัง</p>
            </div>
            <button className="ghost-btn" onClick={() => setActiveNav("overview")}>
              <Activity size={14} /> กลับหน้าภาพรวม
            </button>
          </div>

          {activeNav === "sound" && (
            <div className="action-settings sound-settings dedicated-settings">
              <div className="settings-title">
                <Volume2 size={15} />
                <strong>เลือกเสียงแจ้งเตือน</strong>
              </div>
              <div className="sound-list">
                {soundPresets.map((sound) => (
                  <button
                    key={sound.id}
                    className={`sound-option ${selectedSound === sound.id ? "selected" : ""}`}
                    onClick={() => {
                      setSelectedSound(sound.id);
                      playSoundPreview(sound.frequency);
                    }}
                  >
                    <span className="sound-play">
                      <Play size={12} />
                    </span>
                    <div>
                      <strong>{sound.label}</strong>
                      <small>{sound.description}</small>
                    </div>
                  </button>
                ))}
              </div>
              <label className="upload-btn">
                <Plus size={14} /> เพิ่มไฟล์เสียงของฉัน
                <input type="file" accept="audio/*" multiple onChange={handleSoundUpload} />
              </label>
              {customSounds.length > 0 && (
                <div className="custom-sound-list">
                  {customSounds.map((sound) => (
                    <div className="custom-sound" key={`${sound.name}-${sound.url}`}>
                      <strong>{sound.name}</strong>
                      <audio controls src={sound.url} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeNav === "overlay" && (
            <>
              <div className="overlay-rule-settings action-settings">
                <div className="settings-title">
                  <Sparkles size={15} />
                  <strong>รูปแบบ Overlay</strong>
                </div>
                <div className="overlay-rule-grid">
                  {overlayRuleModeOptions.map((option) => (
                    <button
                      key={option.id}
                      className={`overlay-rule-card ${overlayRuleMode === option.id ? "selected" : ""}`}
                      onClick={() => setOverlayRuleMode(option.id)}
                    >
                      <span className="overlay-rule-icon">{option.icon}</span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </button>
                  ))}
                </div>
                <div className="overlay-rule-preview">
                  <div className="overlay-rule-preview-copy">
                    <strong>{overlayRuleLabel}</strong>
                    <span>{selectedGift} จะถูกผูกกับ Overlay นี้</span>
                  </div>
                  <div className={`overlay-rule-mini overlay-rule-mini-${overlayRuleMode}`}>
                    <span>{overlayRuleMode === "jar" ? "🏺" : overlayRuleMode === "image" ? "🖼️" : overlayRuleMode === "video" ? "🎬" : "💬"}</span>
                  </div>
                </div>
                <div className="overlay-gift-link">
                  <div className="settings-title">
                    <Gift size={15} />
                    <strong>ของขวัญที่เลือกจากหน้า กฎการทำงาน</strong>
                  </div>
                  <div className="overlay-gift-link-row">
                    <div className="selected-gift-preview overlay-mini-gift">
                      <img src={giftUrl(selectedGift)} alt={selectedGift} />
                      <div>
                        <strong>{selectedGift}</strong>
                        <small>ใช้งานร่วมกับ Overlay นี้</small>
                      </div>
                    </div>
                    <select className="overlay-gift-select" value={selectedGift} onChange={(e) => setSelectedGift(e.target.value)}>
                      {giftNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <small>ของขวัญที่เลือกจะถูกใช้กับ Overlay และบันทึกลงตารางกฎเดียวกัน</small>
                </div>
                <div className="overlay-link-panel overlay-link-panel-compact">
                  <div className="settings-title">
                    <Link2 size={15} />
                    <strong>สร้างลิงก์จริงสำหรับโหลใหม่ / TikTok Studio</strong>
                  </div>
                  <div className="overlay-link-result overlay-link-result-compact">
                    <select
                      className="overlay-link-select"
                      value={overlayLinkType}
                      onChange={(e) => {
                        const nextType = e.target.value as OverlayLinkType;
                        setOverlayLinkType(nextType);
                        setOverlayRuleMode(overlayModeByLinkType[nextType]);
                      }}
                    >
                      {overlayLinkItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                    <code>{selectedOverlayPublicUrl || selectedOverlayLink}</code>
                    <button onClick={() => navigator.clipboard?.writeText(selectedOverlayPublicUrl || selectedOverlayLink)}>คัดลอกลิ้ง</button>
                    <button onClick={() => window.open(selectedOverlayPublicUrl || selectedOverlayLink, "_blank", "noopener,noreferrer")}>เปิด</button>
                  </div>
                  <button className="overlay-action-btn" onClick={createRealOverlayLink} disabled={overlayLinkCreating}>
                    {overlayLinkCreating ? "กำลังสร้างลิงก์..." : "สร้างลิงก์จริงสำหรับโหลใหม่ / TikTok Studio"}
                  </button>
                  <small>เลือกประเภทลิงก์ที่ต้องการแล้วกดสร้างทีละอัน ลิงก์นี้ใช้กับ OBS / TikTok Studio ได้</small>
                </div>
                <div className="overlay-builder-section overlay-placement">
                  <div className="settings-title">
                    <Settings size={15} />
                    <strong>การแสดงผล</strong>
                  </div>
                  <div className="overlay-field-grid">
                    <label>
                      ตำแหน่ง
                      <select defaultValue="center">
                        <option value="center">กึ่งกลาง</option>
                        <option value="top">ด้านบน</option>
                        <option value="bottom">ด้านล่าง</option>
                      </select>
                    </label>
                    <label>
                      ขนาด
                      <select defaultValue="medium">
                        <option value="small">เล็ก</option>
                        <option value="medium">กลาง</option>
                        <option value="large">ใหญ่</option>
                      </select>
                    </label>
                  </div>
                  <small>การตั้งค่านี้จะถูกใช้เมื่อเรียก Overlay จากกฎการทำงาน</small>
                </div>
              </div>
            </>
          )}

          {activeNav === "webhook" && (
            <div className="action-settings webhook-settings dedicated-settings">
              <div className="settings-title">
                <Link2 size={15} />
                <strong>Webhook URL</strong>
              </div>
              <input className="webhook-input" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://your-worker.workers.dev/gift" />
              <button className="webhook-test" onClick={() => setLastAction(webhookUrl ? `เตรียมส่ง Webhook ไปที่ ${webhookUrl}` : "กรุณาใส่ Webhook URL ก่อนทดสอบ")}>
                <Zap size={13} /> ทดสอบ Webhook
              </button>
            </div>
          )}
        </section>
      )}
      <section className="hero-card"><div><p className="eyebrow light">TIKTOK LIVE CONNECTION</p><h2>{connected ? `กำลังติดตาม ${username}` : "เชื่อมต่อกับ TikTok LIVE"}</h2><p className="hero-copy">ใส่ username ของช่องที่กำลัง LIVE เพื่อรับ Comment, Gift และ Follow แบบเรียลไทม์</p></div><div className="connect-form"><div className="input-wrap"><span>@</span><input value={username.replace(/^@/, "")} onChange={(e) => setUsername(e.target.value)} placeholder="username ของคุณ" /></div><div className="connect-actions"><button className="primary-btn" onClick={connect}><Wifi size={17} />{connected ? "เชื่อมต่ออยู่" : "เชื่อมต่อ LIVE"}</button><button className="ghost-btn danger-btn" onClick={disconnect} disabled={!connected}><Pause size={16} /> หยุดทำงาน</button></div></div></section>
      <section className="stats-grid"><Stat icon={<Gift />} label="ของขวัญวันนี้" value={liveStats.gifts.toString()} tone="pink" /><Stat icon={<MessageCircle />} label="คอมเมนต์" value={liveStats.comments.toString()} tone="blue" /><Stat icon={<Users />} label="ผู้ติดตามใหม่" value={liveStats.follows.toString()} tone="purple" /><Stat icon={<Heart />} label="ไลก์ทั้งหมด" value={liveStats.likes.toString()} tone="orange" /></section>
      <div className="content-grid">
        <section className="panel events-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">REALTIME</p><h3>กิจกรรมล่าสุด</h3></div>
            <div className="realtime-heading-actions">
              <span className={`realtime-live-status ${connected ? "online" : "waiting"}`}>
                <span className="realtime-live-dot" />
                {connected ? "แชตสด" : "รอเชื่อมต่อ"}
              </span>
              <span className="table-hint">แสดง {recentChatLimit} แชตล่าสุด</span>
              <select
                className="realtime-limit-select"
                value={recentChatLimit}
                onChange={(event) => {
                  const nextLimit = Number(event.target.value) as RecentChatLimit;
                  setRecentChatLimit(nextLimit);
                  window.localStorage.setItem(recentChatLimitStorageKey, String(nextLimit));
                }}
                aria-label="เลือกจำนวนแชตล่าสุด"
              >
                <option value={30}>30 แชต</option>
                <option value={50}>50 แชต</option>
                <option value={100}>100 แชต</option>
              </select>
            </div>
          </div>
          <div className="event-list" ref={realtimeChatFeedRef}>{events.slice(0, recentChatLimit).map((event) => <EventRow key={event.id} event={event} />)}{events.length === 0 && <div className="empty-state">{connected ? "เชื่อมต่อแล้ว กำลังรอแชตจาก TikTok LIVE" : "เชื่อมต่อ LIVE เพื่อเริ่มแสดงแชตแบบเรียลไทม์"}</div>}</div>
        </section>
        <section className="panel rules-panel"><div className="panel-heading"><div><p className="eyebrow">AUTOMATION</p><h3>สร้างกฎการทำงาน</h3></div><button className="icon-btn"><Plus size={18} /></button></div>
          <div className="rule-step"><span>1</span><div><strong>เลือก Action</strong><small>สิ่งที่ต้องการให้เกิดขึ้น</small></div></div>
          <div className="action-picker">{actions.map((item) => <button key={item.id} className={`action-card ${action === item.id ? "selected" : ""}`} onClick={() => setAction(item.id)}><div className="action-card-icon">{item.icon}</div><div><strong>{item.label}</strong><small>{item.description}</small></div></button>)}</div>
          {action === "sound" && <div className="action-settings sound-settings"><div className="settings-title"><Volume2 size={15} /><strong>เลือกเสียงแจ้งเตือน</strong></div><div className="sound-list">{soundPresets.map((sound) => <button key={sound.id} className={`sound-option ${selectedSound === sound.id ? "selected" : ""}`} onClick={() => { setSelectedSound(sound.id); playSoundPreview(sound.frequency); }}><span className="sound-play"><Play size={12} /></span><div><strong>{sound.label}</strong><small>{sound.description}</small></div></button>)}</div><label className="upload-btn"><Plus size={14} /> เพิ่มไฟล์เสียงของฉัน<input type="file" accept="audio/*" multiple onChange={handleSoundUpload} /></label>{customSounds.length > 0 && <div className="custom-sound-list">{customSounds.map((sound) => <div className="custom-sound" key={`${sound.name}-${sound.url}`}><strong>{sound.name}</strong><audio controls src={sound.url} /></div>)}</div>}</div>}
          {action === "webhook" && <div className="action-settings webhook-settings"><div className="settings-title"><Link2 size={15} /><strong>Webhook URL</strong></div><input className="webhook-input" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://your-worker.workers.dev/gift" /><button className="webhook-test" onClick={() => setLastAction(webhookUrl ? `เตรียมส่ง Webhook ไปที่ ${webhookUrl}` : "กรุณาใส่ Webhook URL ก่อนทดสอบ")}><Zap size={13} /> ทดสอบ Webhook</button></div>}
          {action === "overlay" && <div className="overlay-rule-settings action-settings"><div className="settings-title"><Sparkles size={15} /><strong>แสดง Overlay</strong></div><div className="overlay-rule-grid">{overlayRuleModeOptions.map((option) => <button key={option.id} className={`overlay-rule-card ${overlayRuleMode === option.id ? "selected" : ""}`} onClick={() => setOverlayRuleMode(option.id)}><span className="overlay-rule-icon">{option.icon}</span><strong>{option.label}</strong><small>{option.description}</small></button>)}</div><div className="overlay-rule-preview"><div className="overlay-rule-preview-copy"><strong>{overlayRuleLabel}</strong><span>{selectedGift} จะถูกผูกกับ Overlay นี้</span></div><div className={`overlay-rule-mini overlay-rule-mini-${overlayRuleMode}`}><span>{overlayRuleMode === "jar" ? "🏺" : overlayRuleMode === "image" ? "🖼️" : overlayRuleMode === "video" ? "🎬" : "💬"}</span></div></div><div className="overlay-gift-link"><div className="settings-title"><Gift size={15} /><strong>เลือกของขวัญที่ใช้ร่วมกัน</strong></div><div className="overlay-gift-link-row"><div className="selected-gift-preview overlay-mini-gift"><img src={giftUrl(selectedGift)} alt={selectedGift} /><div><strong>{selectedGift}</strong><small>ใช้งานร่วมกับ Overlay นี้</small></div></div><select className="overlay-gift-select" value={selectedGift} onChange={(e) => setSelectedGift(e.target.value)}>{giftNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></div><small>ของขวัญที่เลือกจะถูกใช้กับ Overlay และบันทึกลงตารางกฎเดียวกัน</small></div><div className="overlay-link-panel overlay-link-panel-compact"><div className="settings-title"><Link2 size={15} /><strong>สร้างลิงก์จริงสำหรับ TikTok Studio</strong></div><div className="overlay-link-result overlay-link-result-compact"><select className="overlay-link-select" value={overlayLinkType} onChange={(e) => setOverlayLinkType(e.target.value as OverlayLinkType)}>{overlayLinkItems.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><code>{selectedOverlayPublicUrl || selectedOverlayLink}</code><button onClick={() => navigator.clipboard?.writeText(selectedOverlayPublicUrl || selectedOverlayLink)}>คัดลอกลิ้ง</button><button onClick={() => window.open(selectedOverlayPublicUrl || selectedOverlayLink, "_blank", "noopener,noreferrer")}>เปิด</button></div><button className="overlay-action-btn" onClick={createRealOverlayLink} disabled={overlayLinkCreating}>{overlayLinkCreating ? "กำลังสร้างลิงก์..." : "สร้างลิงก์จริงสำหรับ TikTok Studio"}</button><small>เลือกประเภทลิงก์ที่ต้องการแล้วกดสร้างทีละอัน ลิงก์นี้ใช้กับ OBS / TikTok Studio ได้</small></div></div>}
          {action === "keyboard" && <div className="key-binding"><label>ชุดปุ่มที่จะกด <span className="key-binding-preview">{keyBinding}</span></label><button className="keyboard-open-btn" onClick={() => setKeyboardOpen(true)}><Keyboard size={15} /> เปิดคีย์บอร์ดเพื่อเลือกปุ่ม</button><small>เลือกได้หลายปุ่ม และเลือกตัวอักษรภาษาไทยหรือ English ได้</small></div>}
          <div className="rule-step"><span>2</span><div><strong>เลือกของขวัญ (Event)</strong><small>เลือก Gift ที่จะเรียก Action</small></div></div>
          <div className="event-picker">{(["gift", "like", "follow", "comment", "share", "join"] as EventType[]).map((type) => <button key={type} className={`event-choice ${eventType === type ? "selected" : ""}`} onClick={() => setEventType(type)}>{type === "gift" ? <Gift /> : type === "like" ? <Heart /> : type === "follow" ? <Users /> : type === "comment" ? <MessageCircle /> : type === "share" ? <Share2 /> : <LogIn />}<span>{type === "gift" ? "ของขวัญ" : type === "like" ? "กดถูกใจ" : type === "follow" ? "กดติดตาม" : type === "comment" ? "คอมเมนต์" : type === "share" ? "แชร์" : "เข้าห้อง"}</span></button>)}</div>
          {eventType === "gift" && <div className="gift-choice"><label>เลือกของขวัญ</label><div className="selected-gift-preview"><img src={giftUrl(selectedGift)} alt={selectedGift} /><div><strong>{selectedGift}</strong><small>Gift ที่เลือกสำหรับกฎนี้</small></div></div><div className="gift-search"><Gift size={15} /><input value={giftSearch} onChange={(e) => setGiftSearch(e.target.value)} placeholder="พิมพ์ค้นหาชื่อของขวัญ..." /></div><div className="gift-grid compact">{filteredGifts.map((name) => <button key={name} className={`gift-card ${selectedGift === name ? "selected" : ""}`} onClick={() => setSelectedGift(name)}><img src={giftUrl(name)} alt={name} /><span>{name}</span></button>)}</div>{filteredGifts.length === 0 && <div className="empty-gifts">ไม่พบของขวัญที่ค้นหา</div>}</div>}
          {eventType === "like" && <div className="like-count-settings"><div className="settings-title"><Heart size={15} /><strong>โหมดการนับไลก์</strong></div><button className={`count-mode ${likeCountMode === "exact" ? "selected" : ""}`} onClick={() => setLikeCountMode("exact")}><span className="radio-dot" /><div><strong>ตามจำนวนจริง</strong><small>ไลก์เข้าเท่าไร กดคีย์บอร์ดตามจำนวนนั้น</small></div></button><button className={`count-mode ${likeCountMode === "threshold" ? "selected" : ""}`} onClick={() => setLikeCountMode("threshold")}><span className="radio-dot" /><div><strong>ยิงตามรอบ Threshold</strong><small>ครบจำนวนที่กำหนด ยิงคีย์บอร์ด 1 ครั้ง</small></div></button>{likeCountMode === "threshold" && <label className="threshold-input">จำนวนไลก์ต่อการยิง 1 ครั้ง<input type="number" min="1" value={likeThreshold} onChange={(e) => setLikeThreshold(Math.max(1, Number(e.target.value)))} /><small>เช่น 10 = ครบทุก 10 ไลก์ยิง 1 ครั้ง, 100 = ครบ 100 ไลก์ยิง 1 ครั้ง</small></label>}</div>}
          {eventType === "follow" && <div className="follow-settings"><div className="settings-title"><Users size={15} /><strong>โหมดติดตาม</strong></div><button className={`count-mode ${followMode === "repeat" ? "selected" : ""}`} onClick={() => setFollowMode("repeat")}><span className="radio-dot" /><div><strong>กดติดตามซ้ำได้</strong><small>ผู้ชมเดิมติดตามซ้ำ ระบบทำงานทุกครั้งที่ได้รับ Event</small></div></button><button className={`count-mode ${followMode === "round" ? "selected" : ""}`} onClick={() => setFollowMode("round")}><span className="radio-dot" /><div><strong>กันซ้ำเฉพาะรอบ</strong><small>ผู้ชมแต่ละคนทำงานได้ครั้งเดียวต่อการ LIVE รอบนี้</small></div></button><button className={`count-mode ${followMode === "permanent" ? "selected" : ""}`} onClick={() => setFollowMode("permanent")}><span className="radio-dot" /><div><strong>กันซ้ำแบบถาวร</strong><small>ผู้ชมคนเดิมจะไม่ทำงานซ้ำ แม้เริ่ม LIVE รอบใหม่</small></div></button></div>}
          {eventType === "comment" && <div className="comment-settings"><div className="settings-title"><MessageCircle size={15} /><strong>เงื่อนไขการจับคอมเมนต์</strong></div><label>ข้อความที่ต้องการจับ</label><input className="comment-input" value={commentMatch} onChange={(e) => setCommentMatch(e.target.value)} placeholder="เช่น jump หรือ go" /><div className="comment-mode-row"><button className={`comment-mode ${commentMatchMode === "exact" ? "selected" : ""}`} onClick={() => setCommentMatchMode("exact")}>ตรงทั้งหมด</button><button className={`comment-mode ${commentMatchMode === "contains" ? "selected" : ""}`} onClick={() => setCommentMatchMode("contains")}>มีคำนี้อยู่</button></div><small className="comment-help">เมื่อคอมเมนต์ของผู้ชม {commentMatchMode === "exact" ? "ตรงกับ" : "มีคำว่า"} “{commentMatch || "..."}” ระบบจึงจะเรียก Action คีย์บอร์ด</small></div>}
          <div className="rule-save-row">
            <button className="save-btn secondary" onClick={() => void saveRuleToTable()}><Zap size={15} /> บันทึก</button>
            <button className="save-btn secondary" onClick={() => void loadRuleFromDb()}><Activity size={15} /> โหลดกลับ</button>
          </div>
          {lastAction && <div className="action-feedback">{lastAction}</div>}
          <div className="saved-rule">
            <div className="rule-icon"><Keyboard size={17} /></div>
            <div>
              <strong>Gift: {keyRules[0]?.gift ?? selectedGift}</strong>
              <span>
                {keyRules[0]?.bindingType === "keyboard"
                  ? `กดปุ่ม ${keyRules[0]?.bindingLabel}`
                  : keyRules[0]?.bindingType === "overlay"
                    ? `Overlay ${keyRules[0]?.bindingLabel}`
                    : keyRules[0]?.action ?? `กดปุ่ม ${keyBinding}`}
              </span>
            </div>
            <span className="rule-state">{keyRules[0]?.enabled === false ? "หยุดชั่วคราว" : "เปิดใช้"}</span>
          </div>
        </section>
      </div>
      <section id="key-rules-panel" className="panel key-rules-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">KEYBOARD MAPPING</p>
            <h3>ตารางการกดปุ่ม</h3>
          </div>
          <span className="table-hint">Gift → Action / Overlay</span>
        </div>
        <div className="rules-table-wrap">
          <table className="rules-table">
            <thead>
              <tr>
                <th>ของขวัญ</th>
                <th>ชุดปุ่ม / รูปแบบ</th>
                <th>การทำงาน</th>
                <th>สถานะ</th>
                <th>จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {keyRules.map((rule) => {
                const overlayModeLabel = overlayRuleModeOptions.find((item) => item.id === rule.overlayMode)?.label ?? rule.overlayMode ?? "";
                const overlayLinkLabel = overlayLinkItems.find((item) => item.id === rule.overlayLinkType)?.label ?? "";
                return (
                  <tr key={`${rule.gift}-${rule.action}`}>
                    <td>
                      <div className="gift-cell">
                        <img src={giftUrl(rule.gift)} alt="" />
                        <strong>{rule.gift}</strong>
                      </div>
                    </td>
                    <td>
                      {rule.bindingType === "keyboard" ? (
                        <div className="key-chips">
                          {rule.bindingLabel.split("+").map((key) => <span key={key}>{key.trim()}</span>)}
                        </div>
                      ) : rule.bindingType === "overlay" ? (
                        <div className="overlay-binding-chip">
                          <strong>{overlayModeLabel || "Overlay"}</strong>
                          <small>{overlayLinkLabel}</small>
                        </div>
                      ) : (
                        <span className="rule-empty">—</span>
                      )}
                    </td>
                    <td>
                      <div className="rule-action-stack">
                        <strong>{rule.action}</strong>
                        {rule.bindingType === "overlay" && <small>{overlayRuleModeOptions.find((item) => item.id === rule.overlayMode)?.description}</small>}
                      </div>
                    </td>
                    <td>
                      <span className={`rule-state ${rule.enabled ? "" : "disabled"}`}>{rule.enabled ? "กำลังทำงาน" : "หยุดชั่วคราว"}</span>
                    </td>
                    <td>
                      <div className="rule-actions">
                        <button
                          className="table-action test"
                          title="ทดสอบกฎนี้: จำลองการทำงานของปุ่ม/โหลนี้ทันที"
                          aria-label="ทดสอบกฎนี้"
                          onClick={() => testKeyRule(rule)}
                          disabled={testingRuleGift === rule.gift}
                        >
                          {testingRuleGift === rule.gift ? <Zap size={14} className="spin-fast" /> : <Zap size={14} />}
                        </button>
                        <button className="table-action pause" title={rule.enabled ? "หยุดทำงาน" : "ทำงานต่อ"} onClick={() => toggleKeyRule(rule.gift)}>
                          {rule.enabled ? <Pause size={14} /> : <Play size={14} />}
                        </button>
                        <button className="table-action delete" title="ลบคำสั่ง" onClick={() => deleteKeyRule(rule.gift)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {activeNav === "gifts" && <section className="gift-page"><div className="gift-page-header"><div><p className="eyebrow">GIFT CATALOG</p><h2 className="page-title">ของขวัญทั้งหมด</h2><p className="page-copy">แสดงเฉพาะมูลค่าที่มาจาก LIVE จริง หากยังไม่เชื่อมต่อจะรอข้อมูลจาก TikTok</p></div><button className="ghost-btn" onClick={() => setActiveNav("overview")}><Activity size={14} /> กลับหน้าภาพรวม</button></div><div className="gift-search page-search"><Gift size={16} /><input value={giftSearch} onChange={(e) => setGiftSearch(e.target.value)} placeholder="ค้นหาของขวัญ..." /></div><div className="gift-catalog-grid">{filteredGifts.map((name) => <button key={name} className={`catalog-gift-card ${selectedGift === name ? "selected" : ""}`} onClick={() => setSelectedGift(name)}><img className="catalog-gift-image" src={giftUrl(name)} alt={name} /><strong>{name}</strong><span className="catalog-value">{giftValues[name] !== undefined ? `${giftValues[name].toLocaleString()} Coins` : "รอข้อมูลจาก LIVE"}</span></button>)}</div>{filteredGifts.length === 0 && <div className="empty-gifts">ไม่พบของขวัญที่ค้นหา</div>}</section>}
      {keyboardOpen && <div className="keyboard-modal-backdrop" onClick={() => setKeyboardOpen(false)}><div className="keyboard-modal" onClick={(e) => e.stopPropagation()}><div className="keyboard-modal-header"><div><p className="eyebrow">KEYBOARD PICKER</p><h3>เลือกปุ่มคีย์บอร์ด</h3></div><button className="modal-close" onClick={() => setKeyboardOpen(false)}>×</button></div><div className="language-tabs"><button className={keyboardLanguage === "en" ? "active" : ""} onClick={() => setKeyboardLanguage("en")}>English</button><button className={keyboardLanguage === "th" ? "active" : ""} onClick={() => setKeyboardLanguage("th")}>ภาษาไทย</button></div><div className="modal-selected-keys">{selectedKeys.map((key) => <span key={key}>{key}</span>)}</div><div className="modal-key-grid">{(keyboardLanguage === "en" ? englishKeys : thaiKeys).map((key) => <button key={key} className={`${selectedKeys.includes(key) ? "pressed" : ""} ${key.length >= 5 ? "wide" : ""}`} onClick={() => toggleKey(key)}>{key}</button>)}</div><button className="modal-done" onClick={() => setKeyboardOpen(false)}>เสร็จสิ้น</button></div></div>}
      {modalAnnouncement && <div className="system-announcement-modal"><article>{modalAnnouncement.imageUrl && <img src={modalAnnouncement.imageUrl} alt="" />}<Megaphone size={28} /><h2>{modalAnnouncement.title}</h2><p>{modalAnnouncement.message}</p><button onClick={() => setDismissedModalAnnouncement(modalAnnouncement.id)}>รับทราบ</button></article></div>}
    </main>
  </div>;
}

function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: string }) { return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>; }
function NotificationRow({ item }: { item: NotificationItem }) {
  const icon =
    item.kind === "gift"
      ? <Gift />
      : item.kind === "comment"
        ? <MessageCircle />
        : item.kind === "follow"
          ? <Users />
          : item.kind === "like"
              ? <Heart />
              : item.kind === "share"
                ? <Share2 />
                : item.kind === "connection"
                  ? <Wifi />
                  : item.kind === "debug"
                    ? <Activity />
                  : <Bell />;
  const label =
    item.kind === "gift"
      ? "ของขวัญ"
      : item.kind === "comment"
        ? "คอมเมนต์"
        : item.kind === "follow"
          ? "ติดตาม"
          : item.kind === "like"
            ? "ถูกใจ"
            : item.kind === "share"
            ? "แชร์"
              : item.kind === "connection"
                ? "ระบบเชื่อมต่อ"
                : item.kind === "debug"
                  ? "DEBUG"
                : "ระบบ";
  return (
    <div className={`notification-row ${item.kind}`}>
      <div className="notification-avatar">{icon}</div>
      <div className="notification-bubble">
        <div className="notification-top">
          <strong>{item.title}</strong>
          <time>{item.time}</time>
        </div>
        <div className="notification-message">{item.message}</div>
        {item.detail && <div className="notification-detail">{item.detail}</div>}
        <div className="notification-meta">
          <span className={`notification-chip ${item.kind}`}>{label}</span>
          {item.user && <span className="notification-chip subtle">@{item.user}</span>}
          {item.gift && <span className="notification-chip subtle">Gift: {item.gift}</span>}
        </div>
      </div>
    </div>
  );
}
function EventRow({ event }: { event: LiveEvent }) { const icon = event.type === "gift" ? <Gift /> : event.type === "comment" ? <MessageCircle /> : event.type === "follow" ? <Users /> : <Heart />; return <div className="event-row"><div className={`event-icon ${event.type}`}>{event.image ? <img src={event.image} alt="" /> : icon}</div><div className="event-details"><strong>@{event.user}</strong><span>{event.text}</span></div>{event.type === "gift" && <span className="event-tag">GIFT</span>}<time>{event.time}</time></div>; }

export default App;
