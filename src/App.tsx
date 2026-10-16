import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode
} from "react";
import {
  Archive,
  ArrowLeft,
  BellRinging,
  CaretDown,
  ChartLineUp,
  CheckCircle,
  ClockCounterClockwise,
  EnvelopeSimple,
  FloppyDisk,
  GearSix,
  LockKey,
  MagnifyingGlass,
  Mailbox as MailboxIcon,
  PencilSimple,
  Play,
  Plugs,
  QrCode,
  SealCheck,
  ShieldCheck,
  SignOut,
  SlidersHorizontal,
  Star,
  Trash,
  Warning,
  X
} from "@phosphor-icons/react";
import DOMPurify from "dompurify";
import QRCode from "qrcode";
import { api } from "./api";
import { parseEmailReadStateEvent } from "./app-events";
import { MarkdownContent } from "./MarkdownContent";
import { ModelUsagePage } from "./ModelUsagePage";
import { CalendarPage } from "./CalendarPage";
import { QqNotificationPanel } from "./QqNotificationPanel";
import {
  AI_PROVIDER_PRESETS,
  AI_PROTOCOL_OPTIONS,
  MULTIMODAL_PROTOCOL_OPTIONS,
  applyAiPreset,
  type AiProviderEditableField,
  updateAiProviderField as applyAiProviderFieldUpdate
} from "./ai-presets";
import { buildOptimisticPanelReadPatch } from "./read-state";
import { markdownToPlainText } from "./markdown";
import type {
  AiSettings,
  Dashboard,
  EmailListItem,
  MailCategory,
  Mailbox,
  NotificationDeliveryItem,
  NotificationDeliveryPage,
  NotificationDeliveryStatus,
  NotificationSettings,
  ProcessedEmail,
  ProcessingRun,
  SystemSettings,
  WeclawStatus
} from "./types";
import { extractWeclawQrUrl, shouldShowWeclawQr } from "./weclaw-ui";

type View = "calendar" | "mail" | "notifications" | "usage" | "settings";
type NotificationQueueStatus = NotificationDeliveryStatus | "failed";
type EmailContextMenu = {
  x: number;
  y: number;
  emailId: string;
  panelRead: boolean;
};

type BulkReadConfirmation = {
  category: MailCategory;
  mailboxId: string;
  mailboxLabel: string;
  unreadCount: number;
};

type BulkReadUndo = {
  operationId: string;
  expiresAt: string;
  category: MailCategory;
  mailboxId: string;
  updatedCount: number;
  loadedUnreadIds: string[];
  detailWasUnread: boolean;
};

type SettingsLayoutMode = "auto" | "two" | "one";
type SettingsSectionId = "ai" | "system" | "auth" | "wechat" | "qq" | "mailboxes";

const SETTINGS_LAYOUT_STORAGE_KEY = "auto-email-settings-layout";
const SETTINGS_SECTION_IDS: SettingsSectionId[] = ["ai", "system", "auth", "wechat", "qq", "mailboxes"];

function createSettingsSectionState(open: boolean): Record<SettingsSectionId, boolean> {
  return {
    ai: open,
    system: open,
    auth: open,
    wechat: open,
    qq: open,
    mailboxes: open
  };
}

function readSettingsLayoutMode(): SettingsLayoutMode {
  try {
    const saved = window.localStorage.getItem(SETTINGS_LAYOUT_STORAGE_KEY);
    return saved === "two" || saved === "one" ? saved : "auto";
  } catch {
    return "auto";
  }
}

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ??
  (window.location.port === "5173" ? "http://127.0.0.1:8787" : "");

const categoryMeta: Record<
  MailCategory,
  { label: string; short: string; helper: string; icon: typeof Warning }
> = {
  important: {
    label: "重要",
    short: "需要处理",
    helper: "回复、付款、合同、安全、截止时间",
    icon: Warning
  },
  secondary: {
    label: "次重要",
    short: "稍后阅读",
    helper: "通知、资料、无需立刻行动的信息",
    icon: Star
  },
  ignore: {
    label: "不用管",
    short: "已归档",
    helper: "营销、订阅、社交提醒、低价值通知",
    icon: Archive
  }
};

function shouldAutoMarkPanelRead(category: MailCategory) {
  return category === "important";
}

const defaultNotificationCategories: Record<MailCategory, boolean> = {
  important: true,
  secondary: true,
  ignore: false
};
const notificationCategoryOrder: MailCategory[] = ["important", "secondary", "ignore"];
const EMAIL_PAGE_SIZE = 40;
const EMAIL_WINDOW_LIMIT = 160;
const EMAIL_SCROLL_THRESHOLD = 420;

function normalizeNotifyCategories(categories?: Partial<Record<MailCategory, boolean>>) {
  return {
    ...defaultNotificationCategories,
    ...categories
  };
}

function notificationCategorySummary(categories: Record<MailCategory, boolean>) {
  const active = notificationCategoryOrder.filter((category) => categories[category]);
  if (!active.length) return "未选择分类";
  return active.map((category) => categoryMeta[category].label).join("、");
}

const emptyMailbox: Partial<Mailbox> = {
  name: "",
  email: "",
  protocol: "imap",
  host: "",
  port: 993,
  secure: true,
  username: "",
  password: "",
  folder: "INBOX",
  enabled: true
};

function formatTime(value?: string) {
  if (!value) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDay(value?: string) {
  if (!value) return "未知日期";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).format(new Date(value));
}

function senderName(email: EmailListItem | ProcessedEmail) {
  return email.fromName || email.fromAddress || "未知发件人";
}

const notificationStatusMeta: Record<NotificationDeliveryStatus, { label: string; className: string }> = {
  pending: { label: "QQ 待发送", className: "pending" },
  sending: { label: "QQ 发送中", className: "sending" },
  sent: { label: "QQ 已发送", className: "sent" },
  retry: { label: "QQ 重试中", className: "retry" },
  paused: { label: "QQ 已暂停", className: "paused" }
};

function qqNotificationLabel(email: EmailListItem | ProcessedEmail) {
  const notification = email.qqNotification;
  return notification ? notificationStatusMeta[notification.status] : { label: "QQ 未入队", className: "missing" };
}

function safeErrorLabel(value?: string) {
  if (!value) return "暂无失败原因";
  const lower = value.toLowerCase();
  if (lower.includes("relationship") || value.includes("无好友关系")) return "QQ 无好友关系";
  if (lower.includes("rate") || lower.includes("limit") || value.includes("限流")) return "QQ 接口限流，稍后重试";
  if (lower.includes("upload") || lower.includes("image") || value.includes("图片")) return "QQ 图片上传失败";
  if (lower.includes("authentication") || lower.includes("token")) return "QQ 鉴权失败";
  if (lower.includes("not bound") || value.includes("未绑定")) return "QQ 接收人未绑定";
  return value.slice(0, 96);
}

const blockedEmailTags = [
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "base",
  "meta"
];

const resourceAttributes = new Set(["src", "srcset", "poster", "background", "action", "formaction", "ping"]);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanInlineStyle(value: string) {
  return value
    .replace(/@import[^;]+;?/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/behavior\s*:[^;]+;?/gi, "")
    .replace(/-moz-binding\s*:[^;]+;?/gi, "")
    .trim();
}

function emailApiPath(path: string) {
  return `${API_BASE}${path}`;
}

function proxiedRemoteImageUrl(value: string, emailId: string, token: string) {
  const params = new URLSearchParams({ emailId, token, url: value });
  return emailApiPath(`/api/email-assets/image?${params.toString()}`);
}

function inlineImageUrl(emailId: string, cid: string, token: string) {
  const params = new URLSearchParams({ cid, token });
  return emailApiPath(`/api/emails/${encodeURIComponent(emailId)}/inline-image?${params.toString()}`);
}

function rewriteEmailImageSource(
  value: string,
  options: { emailId?: string; assetToken?: string; loadRemoteImages: boolean }
) {
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(value)) return value;
  if (!options.emailId || !options.assetToken) return "";
  if (/^cid:/i.test(value)) return inlineImageUrl(options.emailId, value.replace(/^cid:/i, ""), options.assetToken);
  if (options.loadRemoteImages && /^\/\//.test(value)) {
    return proxiedRemoteImageUrl(`https:${value}`, options.emailId, options.assetToken);
  }
  if (options.loadRemoteImages && /^https?:\/\//i.test(value)) {
    return proxiedRemoteImageUrl(value, options.emailId, options.assetToken);
  }
  return "";
}

function postProcessEmailHtml(
  html: string,
  options: { emailId?: string; assetToken?: string; loadRemoteImages: boolean }
) {
  const template = document.createElement("template");
  template.innerHTML = html;

  template.content.querySelectorAll("*").forEach((node) => {
    const element = node as HTMLElement;

    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        return;
      }

      if (name === "href" || name.endsWith(":href")) {
        element.removeAttribute(attribute.name);
        return;
      }

      if (resourceAttributes.has(name)) {
        const nextSource =
          name === "src" && element.tagName.toLowerCase() === "img"
            ? rewriteEmailImageSource(value, options)
            : "";

        if (nextSource) {
          element.setAttribute(attribute.name, nextSource);
        } else {
          element.removeAttribute(attribute.name);
        }
        return;
      }

      if (name === "style") {
        const safeStyle = cleanInlineStyle(value);
        if (safeStyle) {
          element.setAttribute("style", safeStyle);
        } else {
          element.removeAttribute(attribute.name);
        }
      }
    });
  });

  return template.innerHTML;
}

function textToSafeHtml(text: string) {
  return `<pre class="plain-email">${escapeHtml(text || "无可展示原文。")}</pre>`;
}

function createSafeEmailSrcDoc(
  sourceHtml: string,
  options: { emailId?: string; assetToken?: string; loadRemoteImages: boolean }
) {
  const sanitized = DOMPurify.sanitize(sourceHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: blockedEmailTags,
    FORBID_ATTR: ["autofocus", "srcdoc"],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: true
  });
  const body = postProcessEmailHtml(sanitized, options);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; frame-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';"
    />
    <style>
      :root {
        color-scheme: light;
        font-family: Aptos, "Segoe UI", system-ui, sans-serif;
        color: #151a19;
        background: #ffffff;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        min-height: 100%;
        background: #ffffff;
      }
      body {
        padding: 18px;
      }
      img {
        max-width: 100%;
        height: auto;
      }
      table {
        max-width: 100%;
        border-collapse: collapse;
      }
      a {
        color: inherit;
        text-decoration: underline;
        text-decoration-style: dotted;
      }
      .plain-email {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: 13px/1.65 "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      }
    </style>
  </head>
  <body>${body || textToSafeHtml("无可展示原文。")}</body>
</html>`;
}

function ConsoleApp({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useState<View>("calendar");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [activeCategory, setActiveCategory] = useState<MailCategory>("important");
  const [selectedMailbox, setSelectedMailbox] = useState("all");
  const [emails, setEmails] = useState<EmailListItem[]>([]);
  const [emailOffset, setEmailOffset] = useState(0);
  const [emailTotal, setEmailTotal] = useState(0);
  const [emailWindowLoading, setEmailWindowLoading] = useState<"newer" | "older" | null>(null);
  const [selectedEmailId, setSelectedEmailId] = useState<string>("");
  const [notificationStatus, setNotificationStatus] = useState<NotificationQueueStatus>("failed");
  const [notifications, setNotifications] = useState<NotificationDeliveryItem[]>([]);
  const [notificationPage, setNotificationPage] = useState<NotificationDeliveryPage | null>(null);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationActionBusy, setNotificationActionBusy] = useState("");
  const [detail, setDetail] = useState<ProcessedEmail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [bulkReadBusy, setBulkReadBusy] = useState(false);
  const [bulkReadConfirmation, setBulkReadConfirmation] = useState<BulkReadConfirmation | null>(null);
  const [bulkReadUndo, setBulkReadUndo] = useState<BulkReadUndo | null>(null);
  const [bulkReadUndoSeconds, setBulkReadUndoSeconds] = useState(0);
  const [bulkReadUndoBusy, setBulkReadUndoBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [detailWidth, setDetailWidth] = useState(640);
  const [detailOpen, setDetailOpen] = useState(false);
  const [singlePane, setSinglePane] = useState(() => window.matchMedia("(max-width: 1320px)").matches);
  const [contextMenu, setContextMenu] = useState<EmailContextMenu | null>(null);
  const [autoReadSuppressedId, setAutoReadSuppressedId] = useState<string | null>(null);
  const mailLayoutRef = useRef<HTMLElement | null>(null);
  const emailListRef = useRef<HTMLDivElement | null>(null);
  const emailsRef = useRef<EmailListItem[]>([]);
  const emailOffsetRef = useRef(0);
  const emailTotalRef = useRef(0);
  const emailRequestSeqRef = useRef(0);
  const emailWindowLoadingRef = useRef<"newer" | "older" | null>(null);
  const detailRequestSeqRef = useRef(0);
  const readStateRequestSeqRef = useRef(new Map<string, number>());
  const dashboardRefreshTimerRef = useRef<number | null>(null);

  const clampDetailWidth = useCallback((nextWidth: number) => {
    const layoutWidth = mailLayoutRef.current?.getBoundingClientRect().width;
    const minDetailWidth = 480;
    const maxDetailWidth = layoutWidth
      ? Math.max(minDetailWidth, Math.min(960, layoutWidth - 400))
      : 960;

    return Math.round(Math.min(Math.max(nextWidth, minDetailWidth), maxDetailWidth));
  }, []);

  const startDetailResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      document.body.classList.add("resizing-detail");

      const move = (moveEvent: PointerEvent) => {
        const bounds = mailLayoutRef.current?.getBoundingClientRect();
        if (!bounds) return;
        setDetailWidth(clampDetailWidth(bounds.right - moveEvent.clientX));
      };

      const stop = () => {
        document.body.classList.remove("resizing-detail");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [clampDetailWidth]
  );

  const nudgeDetailWidth = useCallback(
    (delta: number) => {
      setDetailWidth((current) => clampDetailWidth(current + delta));
    },
    [clampDetailWidth]
  );

  const mailLayoutStyle = useMemo(
    () => ({ "--detail-width": `${detailWidth}px` }) as CSSProperties,
    [detailWidth]
  );

  useEffect(() => {
    emailsRef.current = emails;
  }, [emails]);

  useEffect(() => {
    emailOffsetRef.current = emailOffset;
  }, [emailOffset]);

  useEffect(() => {
    emailTotalRef.current = emailTotal;
  }, [emailTotal]);

  useEffect(() => {
    emailWindowLoadingRef.current = emailWindowLoading;
  }, [emailWindowLoading]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1320px)");
    const update = () => setSinglePane(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setDetailOpen(false);
  }, [activeCategory, selectedMailbox]);

  useEffect(() => {
    if (view !== "mail") setDetailOpen(false);
  }, [view]);

  useEffect(() => {
    if (!detailOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailOpen]);

  useEffect(
    () => () => {
      if (dashboardRefreshTimerRef.current) {
        window.clearTimeout(dashboardRefreshTimerRef.current);
      }
    },
    []
  );

  const mailboxMap = useMemo(() => {
    const map = new Map<string, Mailbox>();
    dashboard?.mailboxes.forEach((mailbox) => map.set(mailbox.id, mailbox));
    return map;
  }, [dashboard]);

  const loadDashboard = useCallback(async () => {
    const next = await api.dashboard(selectedMailbox);
    setDashboard(next);
  }, [selectedMailbox]);

  const scheduleDashboardRefresh = useCallback(() => {
    if (dashboardRefreshTimerRef.current) {
      window.clearTimeout(dashboardRefreshTimerRef.current);
    }
    dashboardRefreshTimerRef.current = window.setTimeout(() => {
      dashboardRefreshTimerRef.current = null;
      void loadDashboard().catch(() => undefined);
    }, 250);
  }, [loadDashboard]);

  const captureEmailScrollAnchor = useCallback(() => {
    const node = emailListRef.current;
    if (!node) return null;

    const rows = Array.from(node.querySelectorAll<HTMLElement>("[data-email-id]"));
    const anchor = rows.find((row) => row.offsetTop + row.offsetHeight >= node.scrollTop + 8) ?? rows[0];
    if (!anchor) return null;

    return {
      id: anchor.dataset.emailId || "",
      top: anchor.getBoundingClientRect().top
    };
  }, []);

  const restoreEmailScrollAnchor = useCallback((anchor: { id: string; top: number } | null) => {
    if (!anchor?.id) return;
    window.requestAnimationFrame(() => {
      const node = emailListRef.current;
      const nextAnchor = node?.querySelector<HTMLElement>(`[data-email-id="${CSS.escape(anchor.id)}"]`);
      if (!node || !nextAnchor) return;
      node.scrollTop += nextAnchor.getBoundingClientRect().top - anchor.top;
    });
  }, []);

  const loadEmails = useCallback(async (silent = false) => {
    const requestSeq = ++emailRequestSeqRef.current;
    if (!silent) setLoading(true);
    try {
      const page = await api.emails(activeCategory, selectedMailbox, query, 0, EMAIL_PAGE_SIZE);
      if (requestSeq !== emailRequestSeqRef.current) return;
      setEmails(page.items);
      setEmailOffset(page.offset);
      setEmailTotal(page.total);
      setSelectedEmailId((current) => {
        if (current && page.items.some((item) => item.id === current)) return current;
        return page.items[0]?.id ?? "";
      });
      if (!silent) {
        window.requestAnimationFrame(() => {
          if (emailListRef.current) emailListRef.current.scrollTop = 0;
        });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeCategory, selectedMailbox, query]);

  const loadEmailWindow = useCallback(
    async (direction: "newer" | "older") => {
      if (loading || emailWindowLoadingRef.current) return;

      const currentItems = emailsRef.current;
      const currentOffset = emailOffsetRef.current;
      const currentTotal = emailTotalRef.current;
      if (direction === "newer" && currentOffset <= 0) return;
      if (direction === "older" && currentOffset + currentItems.length >= currentTotal) return;

      const requestSeq = emailRequestSeqRef.current;
      const nextOffset =
        direction === "newer"
          ? Math.max(0, currentOffset - EMAIL_PAGE_SIZE)
          : currentOffset + currentItems.length;
      const anchor = captureEmailScrollAnchor();

      emailWindowLoadingRef.current = direction;
      setEmailWindowLoading(direction);

      try {
        const page = await api.emails(activeCategory, selectedMailbox, query, nextOffset, EMAIL_PAGE_SIZE);
        if (requestSeq !== emailRequestSeqRef.current) return;

        const currentById = new Set(emailsRef.current.map((email) => email.id));
        const pageItems = page.items.filter((email) => !currentById.has(email.id));
        let merged =
          direction === "newer" ? [...pageItems, ...emailsRef.current] : [...emailsRef.current, ...pageItems];
        let mergedOffset = direction === "newer" ? page.offset : emailOffsetRef.current;

        if (merged.length > EMAIL_WINDOW_LIMIT) {
          const trimCount = merged.length - EMAIL_WINDOW_LIMIT;
          if (direction === "older") {
            merged = merged.slice(trimCount);
            mergedOffset += trimCount;
          } else {
            merged = merged.slice(0, EMAIL_WINDOW_LIMIT);
          }
        }

        setEmails(merged);
        setEmailOffset(mergedOffset);
        setEmailTotal(page.total);
        restoreEmailScrollAnchor(anchor);
      } catch (error) {
        setToast(error instanceof Error ? error.message : String(error));
      } finally {
        emailWindowLoadingRef.current = null;
        setEmailWindowLoading(null);
      }
    },
    [activeCategory, captureEmailScrollAnchor, loading, query, restoreEmailScrollAnchor, selectedMailbox]
  );

  const loadNotifications = useCallback(async (status = notificationStatus, silent = false) => {
    if (!silent) setNotificationsLoading(true);
    try {
      const page = await api.notifications(status, 0, 60);
      setNotifications(page.items);
      setNotificationPage(page);
    } finally {
      if (!silent) setNotificationsLoading(false);
    }
  }, [notificationStatus]);

  async function updateNotificationQueue(action: "retry" | "pause" | "resume", deliveryId: string) {
    setNotificationActionBusy(`${action}:${deliveryId}`);
    try {
      if (action === "retry") await api.retryNotification(deliveryId);
      if (action === "pause") await api.pauseNotification(deliveryId);
      if (action === "resume") await api.resumeNotification(deliveryId);
      await Promise.allSettled([loadNotifications(notificationStatus, true), loadDashboard(), loadEmails(true)]);
      setToast(action === "pause" ? "已暂停这条 QQ 通知" : "已加入 QQ 通知重试队列");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setNotificationActionBusy("");
    }
  }

  async function retryAllQqNotifications() {
    setNotificationActionBusy("retry-all");
    try {
      const result = await api.retryAllQqNotifications();
      await Promise.allSettled([loadNotifications(notificationStatus, true), loadDashboard(), loadEmails(true)]);
      setToast(`已恢复 ${result.updatedCount} 条 QQ 通知重试`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setNotificationActionBusy("");
    }
  }

  const handleEmailListScroll = useCallback(() => {
    const node = emailListRef.current;
    if (!node || loading || emailWindowLoadingRef.current) return;

    const currentItems = emailsRef.current;
    const currentOffset = emailOffsetRef.current;
    const currentTotal = emailTotalRef.current;
    const nearTop = node.scrollTop < EMAIL_SCROLL_THRESHOLD;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < EMAIL_SCROLL_THRESHOLD;

    if (nearTop && currentOffset > 0) {
      void loadEmailWindow("newer");
      return;
    }

    if (nearBottom && currentOffset + currentItems.length < currentTotal) {
      void loadEmailWindow("older");
    }
  }, [loadEmailWindow, loading]);

  const applyEmailReadState = useCallback((updated: ProcessedEmail) => {
    setEmails((current) =>
      current.map((email) =>
        email.id === updated.id
          ? { ...email, panelRead: updated.panelRead, panelReadAt: updated.panelReadAt }
          : email
      )
    );
    setDetail((current) =>
      current?.id === updated.id
        ? { ...current, panelRead: updated.panelRead, panelReadAt: updated.panelReadAt }
        : current
    );
  }, []);

  const patchEmailReadState = useCallback(
    (id: string, patch: { panelRead: boolean; panelReadAt?: string }) => {
      setEmails((current) =>
        current.map((email) =>
          email.id === id
            ? { ...email, panelRead: patch.panelRead, panelReadAt: patch.panelReadAt }
            : email
        )
      );
      setDetail((current) =>
        current?.id === id
          ? { ...current, panelRead: patch.panelRead, panelReadAt: patch.panelReadAt }
          : current
      );
    },
    []
  );

  const updateEmailReadState = useCallback(
    async (id: string, panelRead: boolean, options: { silent?: boolean; suppressAutoRead?: boolean } = {}) => {
      const requestSeq = (readStateRequestSeqRef.current.get(id) || 0) + 1;
      readStateRequestSeqRef.current.set(id, requestSeq);
      const previousListItem = emailsRef.current.find((email) => email.id === id);
      const previousDetail =
        detail?.id === id ? { panelRead: detail.panelRead, panelReadAt: detail.panelReadAt } : undefined;
      let requestIsCurrent = false;

      emailRequestSeqRef.current += 1;
      patchEmailReadState(id, buildOptimisticPanelReadPatch(panelRead));

      try {
        const updated = await api.updateEmailReadState(id, panelRead);
        if (readStateRequestSeqRef.current.get(id) === requestSeq) {
          applyEmailReadState(updated);
        }
      } catch (error) {
        if (readStateRequestSeqRef.current.get(id) === requestSeq) {
          const fallback = previousDetail ?? previousListItem;
          if (fallback) {
            patchEmailReadState(id, {
              panelRead: fallback.panelRead,
              panelReadAt: fallback.panelReadAt
            });
          }
        }
        throw error;
      } finally {
        requestIsCurrent = readStateRequestSeqRef.current.get(id) === requestSeq;
        if (requestIsCurrent) {
          readStateRequestSeqRef.current.delete(id);
        }
      }

      if (!requestIsCurrent) return;

      if (!panelRead && options.suppressAutoRead) {
        setAutoReadSuppressedId(id);
      }
      if (panelRead) {
        setAutoReadSuppressedId((current) => (current === id ? null : current));
      }
      scheduleDashboardRefresh();
      if (!options.silent) {
        setToast(panelRead ? "已标记为系统已读" : "已标记为系统未读");
      }
    },
    [applyEmailReadState, detail, patchEmailReadState, scheduleDashboardRefresh]
  );

  function requestMarkCurrentCategoryRead() {
    const unreadCount = dashboard?.unreadCounts?.[activeCategory] ?? 0;
    if (!unreadCount || bulkReadBusy || bulkReadUndo) return;

    setBulkReadConfirmation({
      category: activeCategory,
      mailboxId: selectedMailbox,
      mailboxLabel:
        selectedMailbox === "all"
          ? "全部邮箱"
          : mailboxMap.get(selectedMailbox)?.name || "当前邮箱",
      unreadCount
    });
  }

  async function markCurrentCategoryRead(scope: BulkReadConfirmation) {
    if (bulkReadBusy || bulkReadUndo) return;

    const optimisticReadAt = new Date().toISOString();
    const loadedUnreadIds = emailsRef.current.filter((email) => !email.panelRead).map((email) => email.id);
    const detailWasUnread = Boolean(detail && !detail.panelRead);
    setBulkReadConfirmation(null);
    setBulkReadBusy(true);
    setEmails((current) =>
      current.map((email) =>
        email.panelRead ? email : { ...email, panelRead: true, panelReadAt: optimisticReadAt }
      )
    );
    setDetail((current) =>
      current && !current.panelRead
        ? { ...current, panelRead: true, panelReadAt: optimisticReadAt }
        : current
    );
    setDashboard((current) =>
      current
        ? {
            ...current,
            unreadCounts: {
              ...current.unreadCounts,
              [scope.category]: 0
            }
          }
        : current
    );

    try {
      const result = await api.markEmailsRead(scope.category, scope.mailboxId);
      if (result.updatedCount > 0 && result.operationId && result.undoExpiresAt) {
        setBulkReadUndo({
          operationId: result.operationId,
          expiresAt: result.undoExpiresAt,
          category: scope.category,
          mailboxId: scope.mailboxId,
          updatedCount: result.updatedCount,
          loadedUnreadIds,
          detailWasUnread
        });
      } else {
        setToast("当前分类没有未读邮件");
      }
      await loadDashboard();
    } catch (error) {
      await Promise.allSettled([loadDashboard(), loadEmails(true)]);
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBulkReadBusy(false);
    }
  }

  async function undoCurrentBulkRead() {
    const operation = bulkReadUndo;
    if (!operation || bulkReadUndoBusy || bulkReadUndoSeconds <= 0) return;

    setBulkReadUndoBusy(true);
    try {
      const result = await api.undoMarkEmailsRead(operation.operationId);
      const affectedIds = new Set(operation.loadedUnreadIds);
      setEmails((current) =>
        current.map((email) =>
          affectedIds.has(email.id) ? { ...email, panelRead: false, panelReadAt: undefined } : email
        )
      );
      setDetail((current) =>
        current && operation.detailWasUnread && affectedIds.has(current.id)
          ? { ...current, panelRead: false, panelReadAt: undefined }
          : current
      );
      setBulkReadUndo(null);
      await loadDashboard();
      setToast("已撤回，恢复 " + result.restoredCount + " 封系统未读邮件");
    } catch (error) {
      setBulkReadUndo(null);
      await Promise.allSettled([loadDashboard(), loadEmails(true)]);
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBulkReadUndoBusy(false);
    }
  }
  const openEmailContextMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, email: EmailListItem) => {
    event.preventDefault();
    setSelectedEmailId(email.id);
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 86),
      emailId: email.id,
      panelRead: email.panelRead
    });
  }, []);

  const selectEmail = useCallback(
    (email: EmailListItem) => {
      setSelectedEmailId(email.id);
      setDetailOpen(true);
      if (email.category === "secondary" && !email.panelRead) {
        void updateEmailReadState(email.id, true, { silent: true }).catch((error) => setToast(error.message));
      }
    },
    [updateEmailReadState]
  );

  useEffect(() => {
    void loadDashboard().catch((error) => setToast(error.message));
  }, [loadDashboard]);

  useEffect(() => {
    if (view === "mail") {
      void loadEmails().catch((error) => setToast(error.message));
    }
  }, [view, loadEmails]);

  useEffect(() => {
    if (view === "notifications") {
      void loadNotifications(notificationStatus).catch((error) => setToast(error.message));
    }
  }, [view, notificationStatus, loadNotifications]);

  useEffect(() => {
    if (!selectedEmailId) {
      detailRequestSeqRef.current += 1;
      setDetail(null);
      setDetailLoading(false);
      return;
    }

    const requestSeq = ++detailRequestSeqRef.current;
    setDetailLoading(true);
    void api
      .email(selectedEmailId)
      .then((nextDetail) => {
        if (requestSeq === detailRequestSeqRef.current) setDetail(nextDetail);
      })
      .catch((error) => {
        if (requestSeq === detailRequestSeqRef.current) setToast(error.message);
      })
      .finally(() => {
        if (requestSeq === detailRequestSeqRef.current) setDetailLoading(false);
      });
  }, [selectedEmailId]);

  useEffect(() => {
    setAutoReadSuppressedId(null);
  }, [selectedEmailId]);

  useEffect(() => {
    if (!detail || detail.panelRead || !shouldAutoMarkPanelRead(detail.category)) return;
    if (singlePane && !detailOpen) return;
    if (detail.id === autoReadSuppressedId) return;

    const timer = window.setTimeout(() => {
      void updateEmailReadState(detail.id, true, { silent: true }).catch((error) => setToast(error.message));
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [autoReadSuppressedId, detail?.id, detail?.panelRead, detail?.category, detailOpen, singlePane, updateEmailReadState]);

  useEffect(() => {
    if (!bulkReadConfirmation) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBulkReadConfirmation(null);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [bulkReadConfirmation]);

  useEffect(() => {
    if (!bulkReadUndo) {
      setBulkReadUndoSeconds(0);
      return;
    }

    const operationId = bulkReadUndo.operationId;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((Date.parse(bulkReadUndo.expiresAt) - Date.now()) / 1000));
      setBulkReadUndoSeconds(remaining);
      if (remaining === 0) {
        setBulkReadUndo((current) => (current?.operationId === operationId ? null : current));
      }
    };

    tick();
    const timer = window.setInterval(tick, 200);
    return () => window.clearInterval(timer);
  }, [bulkReadUndo]);

  useEffect(() => {
    if (!contextMenu) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextMenu]);

  useEffect(() => {
    let refreshTimer = 0;
    let closed = false;
    const source = new EventSource(api.eventsUrl(), { withCredentials: true });

    const scheduleRefresh = (event: MessageEvent<string>) => {
      if (closed) return;
      const readState = parseEmailReadStateEvent(event.data);
      if (readState) {
        patchEmailReadState(readState.id, readState);
      }
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void loadDashboard().catch(() => undefined);
        const nearLatest =
          emailOffsetRef.current === 0 &&
          (!emailListRef.current || emailListRef.current.scrollTop < EMAIL_SCROLL_THRESHOLD);
        if (view === "mail" && nearLatest) {
          void loadEmails(true).catch(() => undefined);
        }
        if (view === "notifications") {
          void loadNotifications(notificationStatus, true).catch(() => undefined);
        }

        try {
          const message = JSON.parse(event.data) as { payload?: { id?: string } };
          if (message.payload?.id && message.payload.id === selectedEmailId) {
            void api
              .email(selectedEmailId)
              .then((nextDetail) => setDetail(nextDetail))
              .catch(() => undefined);
          }
        } catch {
          // SSE events are best-effort UI hints; malformed payloads should not interrupt the console.
        }
      }, 220);
    };

    source.addEventListener("app", scheduleRefresh);

    return () => {
      closed = true;
      window.clearTimeout(refreshTimer);
      source.removeEventListener("app", scheduleRefresh);
      source.close();
    };
  }, [loadDashboard, loadEmails, loadNotifications, notificationStatus, patchEmailReadState, selectedEmailId, view]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadDashboard().catch(() => undefined);
    }, 60000);
    return () => window.clearInterval(timer);
  }, [loadDashboard]);

  useEffect(() => {
    if (!dashboard?.processorRunning) return;
    const timer = window.setInterval(() => {
      void loadDashboard().catch(() => undefined);
      const nearLatest =
        emailOffsetRef.current === 0 && (!emailListRef.current || emailListRef.current.scrollTop < EMAIL_SCROLL_THRESHOLD);
      if (view === "mail" && nearLatest) {
        void loadEmails(true).catch(() => undefined);
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [dashboard?.processorRunning, loadDashboard, loadEmails, view]);

  async function runProcessing() {
    setBusy(true);
    setToast("");
    try {
      const run = await api.run(selectedMailbox);
      await loadDashboard();
      await loadEmails();
      setToast(`处理完成：${run.processedCount} 封邮件，重要 ${run.importantCount} 封。`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const activeMailboxName =
    selectedMailbox === "all" ? "全部邮箱" : mailboxMap.get(selectedMailbox)?.name || "当前邮箱";
  const pageEyebrow = view === "calendar" ? "本地日程" : view === "mail"
    ? activeMailboxName
    : view === "notifications"
      ? "QQ 通知"
      : view === "usage"
        ? "AI 可观测性"
        : "系统配置";
  const pageTitle = {
    calendar: "我的日历",
    mail: "邮件处理台",
    notifications: "通知队列",
    usage: "模型用量",
    settings: "管理设置"
  }[view];
  const runStatusText = dashboard?.processorRunning
    ? dashboard.currentRun?.currentStage || "正在处理"
    : "空闲";
  const showProcessingProgress = shouldShowProcessingProgress(
    dashboard?.currentRun,
    Boolean(dashboard?.processorRunning)
  );
  const mailNavExpanded = view === "mail";
  const loadedEmailStart = emailTotal ? emailOffset + 1 : 0;
  const loadedEmailEnd = emailOffset + emails.length;
  const unloadedEarlierCount = emailOffset;
  const unloadedLaterCount = Math.max(0, emailTotal - loadedEmailEnd);

  return (
    <div className="app-shell">
      <aside className="side-panel" aria-label="主导航">
        <div className="brand-lockup">
          <div className="brand-mark">
            <EnvelopeSimple size={22} weight="duotone" />
          </div>
          <div>
            <strong>本地日程系统</strong>
            <span>Calendar &amp; Mail</span>
          </div>
        </div>

        <nav className="nav-stack">
          <button className={view === "calendar" ? "nav-item active" : "nav-item"} onClick={() => setView("calendar")}>
            <ClockCounterClockwise size={18} />我的日历
          </button>
          <div className={mailNavExpanded ? "nav-group active" : "nav-group"}>
            <button className={view === "mail" ? "nav-item active" : "nav-item"} onClick={() => setView("mail")}>
              <SealCheck size={18} />
              处理台
            </button>
            <div
              className={mailNavExpanded ? "mailbox-submenu expanded" : "mailbox-submenu collapsed"}
              aria-hidden={!mailNavExpanded}
              aria-label="处理台邮箱视图"
            >
              <p className="submenu-label">邮箱视图</p>
              <button
                className={selectedMailbox === "all" ? "mailbox-chip active" : "mailbox-chip"}
                onClick={() => setSelectedMailbox("all")}
                tabIndex={mailNavExpanded ? 0 : -1}
                title="全部邮箱"
              >
                <MailboxIcon size={17} />
                <span className="mailbox-chip-label">全部邮箱</span>
                <em>{dashboard?.allTotal ?? dashboard?.total ?? 0}</em>
              </button>
              {dashboard?.mailboxes.map((mailbox) => (
                <button
                  key={mailbox.id}
                  className={selectedMailbox === mailbox.id ? "mailbox-chip active" : "mailbox-chip"}
                  onClick={() => setSelectedMailbox(mailbox.id)}
                  tabIndex={mailNavExpanded ? 0 : -1}
                  title={`${mailbox.name} · ${mailbox.email}`}
                >
                  <span className={mailbox.enabled ? "status-dot online" : "status-dot"} />
                  <span className="mailbox-chip-label">{mailbox.name}</span>
                  <em>{mailbox.protocol.toUpperCase()}</em>
                </button>
              ))}
            </div>
          </div>
          <button
            className={view === "notifications" ? "nav-item active" : "nav-item"}
            onClick={() => setView("notifications")}
          >
            <BellRinging size={18} />
            通知队列
          </button>
          <button
            className={view === "usage" ? "nav-item active" : "nav-item"}
            onClick={() => setView("usage")}
          >
            <ChartLineUp size={18} />
            模型用量
          </button>
          <button
            className={view === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => setView("settings")}
          >
            <GearSix size={18} />
            管理设置
          </button>
        </nav>

        <div className="side-footer">
          <ClockCounterClockwise size={17} />
          <span>
            {dashboard?.settings.system.autoProcessEnabled
              ? `${dashboard.settings.system.pollIntervalMinutes} 分钟自动处理`
              : "自动处理已关闭"}
          </span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{pageEyebrow}</p>
            <h1>{pageTitle}</h1>
          </div>
          <div className="topbar-actions">
            {view !== "calendar" && <>
            <div className={dashboard?.processorRunning ? "run-state running" : "run-state"}>
              <span />
              {runStatusText}
            </div>
            <button
              className={view === "mail" ? "primary-button" : "primary-button contextual-run-action"}
              disabled={busy}
              onClick={runProcessing}
              aria-label={busy ? "正在处理邮件" : "立即处理邮件"}
              title={busy ? "正在处理邮件" : "立即处理邮件"}
            >
              <Play size={18} weight="fill" />
              <span className="button-label">{busy ? "处理中" : "立即处理"}</span>
            </button>
            </>}
            <button className="ghost-button icon-button" onClick={onLogout} title="退出登录" aria-label="退出登录">
              <SignOut size={18} />
            </button>
          </div>
        </header>

        {view === "calendar" ? <CalendarPage /> : view === "mail" ? (
          <section
            ref={mailLayoutRef}
            className={detailOpen ? "mail-layout detail-open" : "mail-layout"}
            style={mailLayoutStyle}
          >
            <div className="mail-main">
              <div className="metric-grid">
                {(Object.keys(categoryMeta) as MailCategory[]).map((category) => {
                  const Icon = categoryMeta[category].icon;
                  const active = activeCategory === category;
                  const totalCount = dashboard?.counts[category] ?? 0;
                  const unreadCount = dashboard?.unreadCounts?.[category] ?? 0;
                  return (
                    <button
                      key={category}
                      className={active ? `metric-card ${category} active` : `metric-card ${category}`}
                      onClick={() => setActiveCategory(category)}
                    >
                      <div className="metric-icon">
                        <Icon size={22} />
                      </div>
                      <span>{categoryMeta[category].label}</span>
                      {category === "ignore" ? (
                        <strong className="metric-count muted-total">{totalCount}</strong>
                      ) : (
                        <strong className="metric-count split">
                          <b>{unreadCount}</b>
                          <em>/{totalCount}</em>
                        </strong>
                      )}
                      <small>{categoryMeta[category].short}</small>
                    </button>
                  );
                })}
              </div>

              <ProcessingProgress run={dashboard?.currentRun} running={showProcessingProgress} />

              <div className="list-toolbar">
                <div className="list-toolbar-heading">
                  <div>
                    <h2>{categoryMeta[activeCategory].label}邮件</h2>
                    <p>{categoryMeta[activeCategory].helper}</p>
                  </div>
                  <label className="mobile-mailbox-filter">
                    <MailboxIcon size={16} />
                    <select
                      aria-label="选择邮箱"
                      value={selectedMailbox}
                      onChange={(event) => setSelectedMailbox(event.target.value)}
                    >
                      <option value="all">全部邮箱</option>
                      {dashboard?.mailboxes.map((mailbox) => (
                        <option value={mailbox.id} key={mailbox.id}>{mailbox.name}</option>
                      ))}
                    </select>
                    <CaretDown size={14} />
                  </label>
                </div>
                <div className="list-toolbar-actions">
                  <button
                    type="button"
                    className="ghost-button mark-all-read-button"
                    disabled={bulkReadBusy || Boolean(bulkReadUndo) || (dashboard?.unreadCounts?.[activeCategory] ?? 0) === 0}
                    onClick={requestMarkCurrentCategoryRead}
                    title={bulkReadUndo ? "请先撤回或等待当前操作完成" : "将当前邮箱的" + categoryMeta[activeCategory].label + "邮件全部标记为系统已读"}
                  >
                    <CheckCircle size={18} weight="duotone" />
                    <span>{bulkReadBusy ? "标记中..." : "全部已读"}</span>
                    {(dashboard?.unreadCounts?.[activeCategory] ?? 0) > 0 && (
                      <em>{dashboard?.unreadCounts?.[activeCategory]}</em>
                    )}
                  </button>
                  <label className="search-box">
                    <MagnifyingGlass size={18} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索邮件"
                    />
                  </label>
                </div>
              </div>

              {!loading && emailTotal > 0 && (
                <div className="email-window-status">
                  <span>
                    已加载 {loadedEmailStart}-{loadedEmailEnd} / {emailTotal}
                  </span>
                  <em>滚动时按需换入历史记录</em>
                </div>
              )}

              <div
                ref={emailListRef}
                className={loading ? "email-list loading" : "email-list ready"}
                onScroll={handleEmailListScroll}
              >
                {loading ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <div
                      className="email-skeleton"
                      key={index}
                      style={{ "--row-index": String(index) } as CSSProperties}
                    />
                  ))
                ) : emails.length ? (
                  <>
                    {(unloadedEarlierCount > 0 || emailWindowLoading === "newer") && (
                      <div className="email-window-edge">
                        {emailWindowLoading === "newer"
                          ? "正在换入更新邮件..."
                          : `向上滚动可换入 ${unloadedEarlierCount} 封更新邮件`}
                      </div>
                    )}
                    {emails.map((email, index) => {
                    const CategoryIcon = categoryMeta[email.category].icon;
                    const day = formatDay(email.receivedAt || email.processedAt);
                    const showDay =
                      (index === 0 || formatDay(emails[index - 1]?.receivedAt || emails[index - 1]?.processedAt) !== day);
                    const rowClassName = [
                      "email-row",
                      email.category,
                      selectedEmailId === email.id ? "active" : "",
                      email.panelRead ? "panel-read" : "panel-unread"
                    ]
                      .filter(Boolean)
                      .join(" ");

                    return (
                      <div className="email-list-entry" key={email.id}>
                        {showDay && (
                          <div className="email-day-divider">
                            <span>{day}</span>
                            <em>{activeMailboxName}</em>
                          </div>
                        )}
                      <button
                        data-email-id={email.id}
                        className={rowClassName}
                        style={{ "--row-index": String(Math.min(index, 12)) } as CSSProperties}
                        onClick={() => selectEmail(email)}
                        onContextMenu={(event) => openEmailContextMenu(event, email)}
                      >
                        <div className="email-row-top">
                          <div className="email-row-title">
                            <span className={email.panelRead ? "read-dot" : "read-dot unread"} />
                            <span className={`email-category-chip ${email.category}`}>
                              <CategoryIcon size={14} weight="duotone" />
                              {categoryMeta[email.category].label}
                            </span>
                            <strong>{email.subject}</strong>
                          </div>
                          <time>{formatTime(email.receivedAt || email.processedAt)}</time>
                        </div>
                        <div className="email-row-meta">
                          <span>{senderName(email)}</span>
                          <span>{mailboxMap.get(email.mailboxId)?.name || "邮箱"}</span>
                        </div>
                        <p>{markdownToPlainText(email.summaryZh)}</p>
                        <div className="email-row-bottom">
                          <div className="email-row-statuses">
                            <span className={email.panelRead ? "panel-state read" : "panel-state unread"}>
                              {email.panelRead ? <CheckCircle size={15} /> : <EnvelopeSimple size={15} />}
                              {email.panelRead ? "系统已读" : "系统未读"}
                            </span>
                            <span className="read-badge">
                              <CheckCircle size={15} />
                              {email.readMarked ? "邮箱已读" : "邮箱待确认"}
                            </span>
                            <QqNotificationBadge email={email} />
                          </div>
                          {email.actionItemsZh.length > 0 && <em>{email.actionItemsZh.length} 个动作</em>}
                        </div>
                      </button>
                      </div>
                    );
                  })}
                    {(unloadedLaterCount > 0 || emailWindowLoading === "older") && (
                      <div className="email-window-edge">
                        {emailWindowLoading === "older"
                          ? "正在加载更早邮件..."
                          : `向下滚动可加载 ${unloadedLaterCount} 封更早邮件`}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="empty-state">
                    <ShieldCheck size={34} />
                    <h3>这里还没有邮件</h3>
                    <p>添加邮箱并运行处理后，系统会把所有已处理邮件自动归入这三个列表。</p>
                  </div>
                )}
              </div>
            </div>

            <div
              className="mail-resizer"
              role="separator"
              aria-label="调整邮件预览宽度"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={startDetailResize}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  nudgeDetailWidth(32);
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  nudgeDetailWidth(-32);
                }
              }}
            >
              <span />
            </div>

            <div className="mail-detail-pane" aria-hidden={singlePane && !detailOpen}>
              <EmailDetail
                detail={detail}
                loading={detailLoading}
                mailbox={detail ? mailboxMap.get(detail.mailboxId) : undefined}
                autoLoadRemoteImages={Boolean(dashboard?.settings.system.autoLoadRemoteImages)}
                onClose={() => setDetailOpen(false)}
              />
            </div>
          </section>
        ) : view === "notifications" ? (
          <NotificationQueuePanel
            status={notificationStatus}
            onStatusChange={setNotificationStatus}
            notifications={notifications}
            page={notificationPage}
            loading={notificationsLoading}
            busyAction={notificationActionBusy}
            onReload={() => loadNotifications(notificationStatus)}
            onRetry={(id) => updateNotificationQueue("retry", id)}
            onPause={(id) => updateNotificationQueue("pause", id)}
            onResume={(id) => updateNotificationQueue("resume", id)}
            onRetryAll={retryAllQqNotifications}
            onOpenEmail={(emailId) => {
              setSelectedEmailId(emailId);
              setDetailOpen(true);
              setView("mail");
            }}
          />
        ) : view === "usage" ? (
          <ModelUsagePage />
        ) : (
          <SettingsPanel
            dashboard={dashboard}
            onReload={async () => {
              await loadDashboard();
              await loadEmails();
            }}
            setToast={setToast}
          />
        )}
      </main>

      <nav className="mobile-tabbar" aria-label="主导航">
        <button type="button" className={view === "calendar" ? "active" : ""} onClick={() => { setView("calendar"); setDetailOpen(false); }}>
          <ClockCounterClockwise size={20} /><span>日历</span>
        </button>
        <button
          type="button"
          className={view === "mail" ? "active" : ""}
          onClick={() => {
            setView("mail");
            setDetailOpen(false);
          }}
        >
          <SealCheck size={20} weight={view === "mail" ? "fill" : "regular"} />
          <span>处理台</span>
        </button>
        <button
          type="button"
          className={view === "notifications" ? "active" : ""}
          onClick={() => setView("notifications")}
        >
          <BellRinging size={20} weight={view === "notifications" ? "fill" : "regular"} />
          <span>通知</span>
        </button>
        <button
          type="button"
          className={view === "usage" ? "active" : ""}
          onClick={() => setView("usage")}
        >
          <ChartLineUp size={20} weight={view === "usage" ? "fill" : "regular"} />
          <span>用量</span>
        </button>
        <button
          type="button"
          className={view === "settings" ? "active" : ""}
          onClick={() => setView("settings")}
        >
          <GearSix size={20} weight={view === "settings" ? "fill" : "regular"} />
          <span>设置</span>
        </button>
      </nav>

      {bulkReadConfirmation && (
        <div
          className="bulk-read-confirmation-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setBulkReadConfirmation(null);
          }}
        >
          <section
            className="bulk-read-confirmation"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-read-confirmation-title"
          >
            <div className="bulk-read-confirmation-icon">
              <CheckCircle size={26} weight="duotone" />
            </div>
            <div className="bulk-read-confirmation-copy">
              <p className="section-kicker">批量操作</p>
              <h2 id="bulk-read-confirmation-title">将这些邮件全部标记为已读？</h2>
              <p>
                将把 <strong>{bulkReadConfirmation.mailboxLabel}</strong> 中
                <strong> {categoryMeta[bulkReadConfirmation.category].label}</strong> 分类的
                <strong> {bulkReadConfirmation.unreadCount} 封</strong>系统未读邮件标记为已读。
              </p>
              <small>仅影响处理台内的已读状态。确认后可在 10 秒内撤回。</small>
            </div>
            <div className="bulk-read-confirmation-actions">
              <button
                type="button"
                className="ghost-button"
                autoFocus
                onClick={() => setBulkReadConfirmation(null)}
              >
                <X size={17} />
                取消
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void markCurrentCategoryRead(bulkReadConfirmation)}
              >
                <CheckCircle size={17} weight="duotone" />
                全部标为已读
              </button>
            </div>
          </section>
        </div>
      )}

      {bulkReadUndo && (
        <div className="bulk-read-undo" role="status" aria-live="polite">
          <div className="bulk-read-undo-copy">
            <span className="bulk-read-undo-icon">
              <CheckCircle size={21} weight="fill" />
            </span>
            <span>
              <strong>
                已将 {bulkReadUndo.updatedCount} 封{categoryMeta[bulkReadUndo.category].label}邮件标为已读
              </strong>
              <small>本次操作可在倒计时结束前撤回</small>
            </span>
          </div>
          <button
            type="button"
            onClick={() => void undoCurrentBulkRead()}
            disabled={bulkReadUndoBusy || bulkReadUndoSeconds <= 0}
          >
            <ClockCounterClockwise size={18} />
            {bulkReadUndoBusy ? "撤回中..." : "撤回 " + bulkReadUndoSeconds + "s"}
          </button>
          <span className="bulk-read-undo-progress" aria-hidden="true">
            <i style={{ width: String(Math.min(100, bulkReadUndoSeconds * 10)) + "%" }} />
          </span>
        </div>
      )}

      {contextMenu && (
        <>
          <div
            className="context-menu-shield"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          />
          <div
            className="email-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const nextReadState = !contextMenu.panelRead;
                const emailId = contextMenu.emailId;
                setContextMenu(null);
                void updateEmailReadState(emailId, nextReadState, { suppressAutoRead: !nextReadState }).catch((error) =>
                  setToast(error.message)
                );
              }}
            >
              {contextMenu.panelRead ? <EnvelopeSimple size={16} /> : <CheckCircle size={16} />}
              {contextMenu.panelRead ? "标记为系统未读" : "标记为系统已读"}
            </button>
          </div>
        </>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button onClick={() => setToast("")} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function AuthLoading() {
  return (
    <main className="auth-shell">
      <section className="auth-card loading">
        <div className="auth-mark">
          <ShieldCheck size={28} weight="duotone" />
        </div>
        <p className="section-kicker">安全验证</p>
        <h1>正在检查登录状态</h1>
        <div className="auth-loading-bar">
          <span />
        </div>
      </section>
    </main>
  );
}

function LoginView({
  error,
  onLogin
}: {
  error: string;
  onLogin: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setLocalError("");
    try {
      await onLogin(password);
      setPassword("");
    } catch (loginError) {
      setLocalError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-card-head">
          <div className="auth-mark">
            <LockKey size={28} weight="duotone" />
          </div>
          <div>
            <p className="section-kicker">AI Inbox Console</p>
            <h1>登录自动邮件系统</h1>
          </div>
        </div>
        <p className="auth-copy">请输入管理密码。登录状态会在当前浏览器保存 7 天。</p>
        <label className="auth-field">
          管理密码
          <input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={password}
            placeholder="输入管理密码"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {(localError || error) && <div className="auth-error">{localError || error}</div>}
        <button className="primary-button auth-submit" disabled={busy || !password.trim()} type="submit">
          <ShieldCheck size={18} />
          {busy ? "正在登录" : "登录"}
        </button>
      </form>
    </main>
  );
}

function App() {
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .authSession()
      .then((session) => {
        if (!cancelled) setAuthenticated(session.authenticated);
      })
      .catch((error) => {
        if (!cancelled) {
          setAuthenticated(false);
          setAuthError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function login(password: string) {
    const result = await api.login(password);
    setAuthenticated(result.authenticated);
    setAuthError("");
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      setAuthenticated(false);
    }
  }

  if (!authReady) return <AuthLoading />;
  if (!authenticated) return <LoginView error={authError} onLogin={login} />;
  return <ConsoleApp onLogout={logout} />;
}

function progressPercent(done = 0, total = 0) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function getRunProgress(run?: ProcessingRun | null) {
  const totalUnread = run?.totalUnreadCount ?? 0;
  const handledUnread = run?.handledUnreadCount ?? 0;
  const total = run?.totalTaskCount ?? totalUnread;
  const handled = run?.handledTaskCount ?? Math.max(run?.processedCount ?? 0, handledUnread);

  return {
    total,
    handled,
    percent: progressPercent(handled, total)
  };
}

function shouldShowProcessingProgress(run: ProcessingRun | null | undefined, running: boolean) {
  if (!running || !run) return false;
  const confirmedUnread = Math.max(run.totalUnreadCount ?? 0, run.currentMailboxUnreadCount ?? 0);
  const confirmedTasks = Math.max(run.totalTaskCount ?? 0, run.handledTaskCount ?? 0);
  const activeEmailStep = (run.currentEmailStepIndex ?? 0) > 0 && (run.currentEmailStepTotal ?? 0) > 0;
  return confirmedUnread > 0 || confirmedTasks > 0 || activeEmailStep || (run.processedCount ?? 0) > 0;
}

function ProcessingProgress({ run, running }: { run?: ProcessingRun | null; running: boolean }) {
  const totalUnread = run?.totalUnreadCount ?? 0;
  const handledUnread = run?.handledUnreadCount ?? 0;
  const runProgress = getRunProgress(run);
  const mailboxTotal = run?.currentMailboxUnreadCount ?? 0;
  const mailboxHandled = run?.currentMailboxHandledCount ?? 0;
  const mailboxPercent = progressPercent(mailboxHandled, mailboxTotal);
  const emailStepTotal = run?.currentEmailStepTotal ?? 0;
  const emailStepIndex = run?.currentEmailStepIndex ?? 0;
  const visibleStepTotal = emailStepTotal || 4;
  const mailboxLabel =
    run?.currentMailboxName && run.totalMailboxCount
      ? `${run.currentMailboxName} · ${run.currentMailboxIndex ?? 1}/${run.totalMailboxCount}`
      : run?.currentMailboxName || "等待任务";
  const currentEmailLabel = run?.currentEmailStep || run?.currentStage || "等待下一封邮件";

  return (
    <section
      className={running ? "progress-panel active" : "progress-panel"}
      aria-hidden={!running}
      aria-label="邮件处理进度"
    >
      <div className="progress-heading">
        <div>
          <p className="section-kicker">处理进度</p>
          <h2>{running ? "正在处理邮件" : "当前没有运行中的任务"}</h2>
        </div>
        <span className={running ? "progress-status running" : "progress-status"}>
          <i />
          {running ? "运行中" : "空闲"}
        </span>
      </div>

      <div className="progress-grid">
        <div className="progress-card">
          <div className="progress-row">
            <span>本轮任务</span>
            <strong>{runProgress.handled}/{runProgress.total}</strong>
          </div>
          <div className="progress-track" aria-label={`本轮进度 ${runProgress.percent}%`}>
            <span style={{ width: `${runProgress.percent}%` }} />
          </div>
          <p>未读 {handledUnread}/{totalUnread}</p>
        </div>

        <div className="progress-card">
          <div className="progress-row">
            <span>{mailboxLabel}</span>
            <strong>{mailboxHandled}/{mailboxTotal}</strong>
          </div>
          <div className="progress-track" aria-label={`当前邮箱进度 ${mailboxPercent}%`}>
            <span style={{ width: `${mailboxPercent}%` }} />
          </div>
          <p>邮箱 {run?.currentMailboxIndex ?? 0}/{run?.totalMailboxCount ?? 0}</p>
        </div>

        <div className="progress-card current-email-card">
          <div className="progress-row">
            <span>当前邮件</span>
            <strong>{emailStepTotal ? `${emailStepIndex}/${emailStepTotal}` : "--"}</strong>
          </div>
          <div className="step-strip" aria-label={`当前邮件步骤 ${emailStepIndex}/${visibleStepTotal}`}>
            {Array.from({ length: visibleStepTotal }).map((_, index) => {
              const step = index + 1;
              const className =
                step < emailStepIndex ? "step-dot done" : step === emailStepIndex ? "step-dot active" : "step-dot";
              return <span className={className} key={step} />;
            })}
          </div>
          <p>
            <strong>{currentEmailLabel}</strong>
            {run?.currentSubject ? ` · ${run.currentSubject}` : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

function EmailDetail({
  detail,
  loading,
  mailbox,
  autoLoadRemoteImages,
  onClose
}: {
  detail: ProcessedEmail | null;
  loading: boolean;
  mailbox?: Mailbox;
  autoLoadRemoteImages: boolean;
  onClose: () => void;
}) {
  const [originalMode, setOriginalMode] = useState<"rendered" | "source">("rendered");
  const [loadImages, setLoadImages] = useState(autoLoadRemoteImages);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setOriginalMode("rendered");
    setLoadImages(autoLoadRemoteImages);
  }, [detail?.id, autoLoadRemoteImages]);

  useEffect(() => {
    if (!detail) return;
    const panel = panelRef.current;
    if (!panel) return;
    panel.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }, [detail?.id]);

  const originalSource = useMemo(() => {
    if (!detail) return "无可展示原文。";
    return detail.rawSource || detail.originalHtml || detail.originalText || "无可展示原文。";
  }, [detail]);

  const originalPreview = useMemo(() => {
    if (!detail) return "";
    const sourceHtml = detail.originalHtml?.trim()
      ? detail.originalHtml
      : textToSafeHtml(detail.originalText || originalSource);

    return createSafeEmailSrcDoc(sourceHtml, {
      emailId: detail.id,
      assetToken: detail.assetToken,
      loadRemoteImages: loadImages
    });
  }, [detail, originalSource, loadImages]);

  if (!detail) {
    return (
      <aside className={loading ? "detail-panel empty is-loading-next" : "detail-panel empty"} ref={panelRef}>
        {loading && <span className="detail-switch-indicator" aria-hidden="true" />}
        <div>
          <EnvelopeSimple size={38} />
          <h2>选择一封邮件</h2>
          <p>这里会显示完整分析、判断理由、动作项和邮件原件。</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={loading ? "detail-panel is-loading-next" : "detail-panel"} ref={panelRef}>
      {loading && <span className="detail-switch-indicator" aria-hidden="true" />}
      <div className="detail-content-switch" key={detail.id}>
        <div className="detail-mobile-bar">
          <button type="button" onClick={onClose} aria-label="返回邮件列表">
            <ArrowLeft size={19} />
          </button>
          <strong>邮件详情</strong>
          <time>{formatTime(detail.receivedAt || detail.processedAt)}</time>
        </div>
        <div className="detail-header">
          <div className="detail-pills">
            <span className={`category-pill ${detail.category}`}>{categoryMeta[detail.category].label}</span>
            <span className={detail.panelRead ? "panel-state read" : "panel-state unread"}>
              {detail.panelRead ? <CheckCircle size={15} /> : <EnvelopeSimple size={15} />}
              {detail.panelRead ? "系统已读" : "系统未读"}
            </span>
            <QqNotificationBadge email={detail} />
          </div>
          <time>{formatTime(detail.receivedAt || detail.processedAt)}</time>
        </div>
        <h2>{detail.subject}</h2>
        <div className="detail-meta">
          <span>发件人：{senderName(detail)}</span>
          <span>邮箱：{mailbox?.name || "未知邮箱"}</span>
          {detail.toText && <span>收件人：{detail.toText}</span>}
        </div>

        <section className="summary-block analysis-block">
          <p className="section-kicker">完整分析</p>
          <MarkdownContent content={detail.summaryZh} />
        </section>

        {detail.calendarAnalysis && (
          <section className="summary-block">
            <p className="section-kicker">日程核对</p>
            <p style={{ whiteSpace: "pre-wrap" }}>{detail.calendarAnalysis.notes || "本次尚未完成课表核对。"}</p>
            {detail.calendarAnalysis.taskId && <small>任务编号：{detail.calendarAnalysis.taskId}；可在日程指令页面查看及确认提案。</small>}
          </section>
        )}

        <section className="summary-block">
          <p className="section-kicker">判断理由</p>
          <MarkdownContent content={detail.reasonZh} />
        </section>

        {detail.actionItemsZh.length > 0 && (
          <section className="summary-block">
            <p className="section-kicker">建议动作</p>
            <ul className="action-list">
              {detail.actionItemsZh.map((item) => (
                <li key={item}>
                  <MarkdownContent content={item} compact />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="original-block">
          <div className="original-heading">
            <div>
              <p className="section-kicker">邮件原件</p>
              <span className="security-note">
                <ShieldCheck size={14} />
                {loadImages
                  ? "安全沙箱预览，图片通过本地代理加载，脚本、表单和插件仍禁用"
                  : "安全沙箱预览，已禁用脚本、表单、插件和远程图片"}
              </span>
            </div>
            <div className="original-actions">
              <button
                className={loadImages ? "image-load-button active" : "image-load-button"}
                type="button"
                onClick={() => setLoadImages((current) => !current)}
              >
                {loadImages ? "隐藏图片" : "加载图片"}
              </button>
              <div className="view-toggle" role="tablist" aria-label="邮件原件视图">
                <button
                  className={originalMode === "rendered" ? "active" : ""}
                  type="button"
                  onClick={() => setOriginalMode("rendered")}
                >
                  渲染
                </button>
                <button
                  className={originalMode === "source" ? "active" : ""}
                  type="button"
                  onClick={() => setOriginalMode("source")}
                >
                  源码
                </button>
              </div>
            </div>
          </div>
          {originalMode === "rendered" ? (
            <iframe
              className="email-html-frame"
              title="邮件原件安全预览"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={originalPreview}
            />
          ) : (
            <pre className="raw-source">{originalSource}</pre>
          )}
        </section>
      </div>
    </aside>
  );
}

function QqNotificationBadge({ email }: { email: EmailListItem | ProcessedEmail }) {
  const meta = qqNotificationLabel(email);
  const title = email.qqNotification?.lastError ? safeErrorLabel(email.qqNotification.lastError) : meta.label;
  return (
    <span className={`qq-notification-badge ${meta.className}`} title={title}>
      <BellRinging size={15} />
      {meta.label}
    </span>
  );
}

const notificationQueueTabs: Array<{ status: NotificationQueueStatus; label: string }> = [
  { status: "failed", label: "失败/重试" },
  { status: "paused", label: "已暂停" },
  { status: "sending", label: "发送中" },
  { status: "sent", label: "已发送" }
];

function NotificationQueuePanel({
  status,
  onStatusChange,
  notifications,
  page,
  loading,
  busyAction,
  onReload,
  onRetry,
  onPause,
  onResume,
  onRetryAll,
  onOpenEmail
}: {
  status: NotificationQueueStatus;
  onStatusChange: (status: NotificationQueueStatus) => void;
  notifications: NotificationDeliveryItem[];
  page: NotificationDeliveryPage | null;
  loading: boolean;
  busyAction: string;
  onReload: () => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onRetryAll: () => Promise<void>;
  onOpenEmail: (emailId: string) => void;
}) {
  return (
    <section className="queue-panel">
      <div className="queue-toolbar">
        <div>
          <p className="section-kicker">QQ 通知</p>
          <h2>通知投递队列</h2>
        </div>
        <div className="queue-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => void onReload()}
            disabled={loading || Boolean(busyAction)}
          >
            <ClockCounterClockwise size={17} />
            刷新
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void onRetryAll()}
            disabled={busyAction === "retry-all"}
          >
            <BellRinging size={17} />
            {busyAction === "retry-all" ? "恢复中" : "重试全部"}
          </button>
        </div>
      </div>

      <div className="queue-tabs" role="tablist" aria-label="通知状态">
        {notificationQueueTabs.map((tab) => (
          <button
            key={tab.status}
            type="button"
            className={status === tab.status ? "active" : ""}
            onClick={() => onStatusChange(tab.status)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="queue-summary">
        <span>
          当前列表 {page && notifications.length ? `${page.offset + 1}-${page.offset + notifications.length}` : "0"} / {page?.total ?? 0}
        </span>
        <em>按邮件收到时间从早到晚</em>
      </div>

      <div className={loading ? "queue-list loading" : "queue-list"}>
        {loading ? (
          Array.from({ length: 6 }).map((_, index) => <div className="queue-skeleton" key={index} />)
        ) : notifications.length ? (
          notifications.map((delivery) => {
            const meta = notificationStatusMeta[delivery.status];
            const email = delivery.email;
            const busyRetry = busyAction === `retry:${delivery.id}`;
            const busyPause = busyAction === `pause:${delivery.id}`;
            const busyResume = busyAction === `resume:${delivery.id}`;
            return (
              <article className="queue-row" key={delivery.id}>
                <div className="queue-row-main">
                  <div className="queue-row-title">
                    <span className={`qq-notification-badge ${meta.className}`}>
                      <BellRinging size={15} />
                      {meta.label}
                    </span>
                    <strong>{email?.subject || "邮件不存在"}</strong>
                  </div>
                  <div className="queue-row-meta">
                    <span>{email?.mailboxName || "未知邮箱"}</span>
                    <span>{email?.fromName || email?.fromAddress || "未知发件人"}</span>
                    <time>{formatTime(email?.receivedAt || email?.processedAt || delivery.createdAt)}</time>
                  </div>
                  <p>
                    {delivery.lastError
                      ? safeErrorLabel(delivery.lastError)
                      : markdownToPlainText(email?.summaryZh || "暂无失败原因")}
                  </p>
                  <div className="queue-row-foot">
                    <span>尝试 {delivery.attemptCount} 次</span>
                    {delivery.nextAttemptAt && <span>下次 {formatTime(delivery.nextAttemptAt)}</span>}
                    {delivery.sentAt && <span>已发 {formatTime(delivery.sentAt)}</span>}
                  </div>
                </div>
                <div className="queue-row-actions">
                  {email && (
                    <button type="button" className="ghost-button" onClick={() => onOpenEmail(email.id)}>
                      <EnvelopeSimple size={16} />
                      打开
                    </button>
                  )}
                  {delivery.status !== "sent" && delivery.status !== "sending" && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void onRetry(delivery.id)}
                      disabled={busyRetry}
                    >
                      <ClockCounterClockwise size={16} />
                      {busyRetry ? "提交中" : "重试"}
                    </button>
                  )}
                  {delivery.status === "paused" ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void onResume(delivery.id)}
                      disabled={busyResume}
                    >
                      <Play size={16} weight="fill" />
                      {busyResume ? "恢复中" : "恢复"}
                    </button>
                  ) : delivery.status !== "sent" ? (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void onPause(delivery.id)}
                      disabled={busyPause}
                    >
                      <X size={16} />
                      {busyPause ? "暂停中" : "暂停"}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })
        ) : (
          <div className="empty-state queue-empty">
            <BellRinging size={34} />
            <h3>没有匹配的 QQ 通知</h3>
            <p>切换状态标签可以查看其他通知记录。</p>
          </div>
        )}
      </div>
    </section>
  );
}

function SettingsSection({
  id,
  kicker,
  title,
  summary,
  icon: Icon,
  open,
  onToggle,
  className = "",
  children
}: {
  id: SettingsSectionId;
  kicker: string;
  title: string;
  summary: string;
  icon: typeof Warning;
  open: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  const contentId = `settings-section-${id}`;

  return (
    <section
      className={`settings-panel settings-section ${open ? "is-open" : "is-collapsed"} ${className}`.trim()}
      data-settings-section={id}
    >
      <button
        type="button"
        className="settings-section-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className="settings-section-icon">
          <Icon size={20} weight="duotone" />
        </span>
        <span className="settings-section-heading">
          <small>{kicker}</small>
          <strong>{title}</strong>
        </span>
        <span className="settings-section-summary" title={summary}>{summary}</span>
        <span className="settings-section-caret" aria-hidden="true">
          <CaretDown size={17} />
        </span>
      </button>
      {open && (
        <div className="settings-section-body" id={contentId} role="region" aria-label={`${title}设置`}>
          {children}
        </div>
      )}
    </section>
  );
}

function SettingsPanel({
  dashboard,
  onReload,
  setToast
}: {
  dashboard: Dashboard | null;
  onReload: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const [aiForm, setAiForm] = useState<AiSettings | null>(null);
  const [systemForm, setSystemForm] = useState<SystemSettings | null>(null);
  const [notificationForm, setNotificationForm] = useState<NotificationSettings | null>(null);
  const [authForm, setAuthForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  });
  const [notificationCategoryOpen, setNotificationCategoryOpen] = useState(true);
  const [weclawStatus, setWeclawStatus] = useState<WeclawStatus | null>(null);
  const [weclawQrDataUrl, setWeclawQrDataUrl] = useState("");
  const [weclawBusy, setWeclawBusy] = useState(false);
  const [weclawLogOpen, setWeclawLogOpen] = useState(false);
  const weclawLogRef = useRef<HTMLPreElement | null>(null);
  const [mailboxForm, setMailboxForm] = useState<Partial<Mailbox>>(emptyMailbox);
  const [saving, setSaving] = useState(false);
  const [layoutMode, setLayoutMode] = useState<SettingsLayoutMode>(readSettingsLayoutMode);
  const [openSections, setOpenSections] = useState<Record<SettingsSectionId, boolean>>(() =>
    createSettingsSectionState(false)
  );
  const weclawQrUrl = useMemo(() => extractWeclawQrUrl(weclawStatus?.logTail ?? ""), [weclawStatus?.logTail]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_LAYOUT_STORAGE_KEY, layoutMode);
    } catch {
      // Layout preference is optional when browser storage is unavailable.
    }
  }, [layoutMode]);

  function toggleSettingsSection(id: SettingsSectionId) {
    setOpenSections((current) => ({ ...current, [id]: !current[id] }));
  }

  useEffect(() => {
    if (!dashboard) return;
    setAiForm({ ...dashboard.settings.ai, apiKey: "" });
    setSystemForm({
      ...dashboard.settings.system,
      autoLoadRemoteImages: Boolean(dashboard.settings.system.autoLoadRemoteImages)
    });
    setNotificationForm({
      ...dashboard.settings.notification,
      enabled: Boolean(dashboard.settings.notification.enabled),
      clawbotApiUrl: "http://127.0.0.1:18011/api/send",
      clawbotRecipientId: "",
      importantOnly: Boolean(dashboard.settings.notification.importantOnly),
      notifyCategories: normalizeNotifyCategories(dashboard.settings.notification.notifyCategories)
    });
  }, [dashboard]);

  const refreshWeclawStatus = useCallback(async () => {
    const status = await api.weclawStatus();
    setWeclawStatus(status);
    return status;
  }, []);

  useEffect(() => {
    void refreshWeclawStatus().catch(() => undefined);
    const timer = window.setInterval(() => {
      void refreshWeclawStatus().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshWeclawStatus]);

  useEffect(() => {
    let cancelled = false;

    if (
      !shouldShowWeclawQr({
        qrUrl: weclawQrUrl,
        hasCredentials: weclawLoginSaved,
        managedRunning: Boolean(weclawStatus?.managedRunning)
      })
    ) {
      setWeclawQrDataUrl("");
      return () => {
        cancelled = true;
      };
    }

    QRCode.toDataURL(weclawQrUrl, {
      color: { dark: "#151a19", light: "#ffffff" },
      errorCorrectionLevel: "M",
      margin: 2,
      width: 256
    })
      .then((dataUrl) => {
        if (!cancelled) setWeclawQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setWeclawQrDataUrl("");
      });

    return () => {
      cancelled = true;
    };
  }, [weclawQrUrl, weclawStatus?.apiReachable]);

  useEffect(() => {
    if (!weclawLogOpen) return;

    let secondFrame = 0;
    const scrollToLatest = () => {
      const logNode = weclawLogRef.current;
      if (!logNode) return;
      logNode.scrollTop = logNode.scrollHeight;
      logNode.scrollLeft = 0;
    };
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToLatest();
      secondFrame = window.requestAnimationFrame(scrollToLatest);
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [weclawLogOpen, weclawStatus?.logTail]);

  async function saveAi() {
    if (!aiForm) return;
    setSaving(true);
    try {
      await api.updateAi(aiForm);
      await onReload();
      setToast("AI 设置已保存。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testAi() {
    if (!aiForm) return;
    setSaving(true);
    try {
      const result = await api.testAi(aiForm);
      let endpointHost = result.endpoint;
      try {
        endpointHost = new URL(result.endpoint).host;
      } catch {
        // Keep the safe server-provided endpoint when the browser cannot parse it.
      }
      setToast(
        `AI API 测试成功 · 提供商：${result.provider} · 协议：${result.protocol} · 模型：${result.model} · 地址：${endpointHost} · 分类：${result.category}`
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function selectAiPreset(presetId: string) {
    if (!aiForm) return;
    setAiForm(applyAiPreset(aiForm, presetId));
  }

  function updateAiProviderField<K extends AiProviderEditableField>(
    field: K,
    value: AiSettings[K]
  ) {
    if (!aiForm) return;
    setAiForm(applyAiProviderFieldUpdate(aiForm, field, value));
  }

  async function saveSystem() {
    if (!systemForm) return;
    setSaving(true);
    try {
      await api.updateSystem(systemForm);
      await onReload();
      setToast("系统设置已保存。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveAuthPassword() {
    if (authForm.newPassword !== authForm.confirmPassword) {
      setToast("两次输入的新密码不一致。");
      return;
    }
    if (authForm.newPassword.length < 8) {
      setToast("新密码至少需要 8 位。");
      return;
    }

    setSaving(true);
    try {
      await api.updateAuthPassword(authForm.currentPassword, authForm.newPassword);
      setAuthForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      await onReload();
      setToast("登录密码已更新，旧登录状态会失效。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveNotification() {
    if (!notificationForm) return;
    setSaving(true);
    try {
      await api.updateNotification(notificationForm);
      await onReload();
      setToast("微信通知设置已保存。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testNotification() {
    if (!notificationForm) return;
    setSaving(true);
    try {
      const result = await api.testNotification(notificationForm);
      setToast(result.message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function startManagedWeclaw() {
    setWeclawBusy(true);
    try {
      const status = await api.startWeclaw();
      setWeclawStatus(status);
      setToast(status.message || "WeClaw 已启动。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setWeclawBusy(false);
    }
  }

  async function stopManagedWeclaw() {
    setWeclawBusy(true);
    try {
      const status = await api.stopWeclaw();
      setWeclawStatus(status);
      setToast(status.message || "WeClaw 已停止。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setWeclawBusy(false);
    }
  }

  async function rebindManagedWeclaw() {
    setWeclawBusy(true);
    try {
      const status = await api.rebindWeclaw();
      setWeclawStatus(status);
      setToast(status.message || "已启动微信重新绑定。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setWeclawBusy(false);
    }
  }

  async function toggleManagedWeclaw() {
    if (weclawStatus?.managedRunning) {
      await stopManagedWeclaw();
      return;
    }
    await startManagedWeclaw();
  }

  async function saveMailbox() {
    setSaving(true);
    try {
      await api.saveMailbox(mailboxForm);
      setMailboxForm(emptyMailbox);
      await onReload();
      setToast("邮箱已保存。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function deleteMailbox(id: string) {
    setSaving(true);
    try {
      await api.deleteMailbox(id);
      await onReload();
      setToast("邮箱已删除。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testMailbox(id: string) {
    setSaving(true);
    try {
      const result = await api.testMailbox(id);
      setToast(result.message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function updateNotificationCategory(category: MailCategory, enabled: boolean) {
    if (!notificationForm) return;
    const notifyCategories = {
      ...normalizeNotifyCategories(notificationForm.notifyCategories),
      [category]: enabled
    };
    setNotificationForm({
      ...notificationForm,
      notifyCategories,
      importantOnly: notifyCategories.important && !notifyCategories.secondary && !notifyCategories.ignore
    });
  }

  const notificationCategories = normalizeNotifyCategories(notificationForm?.notifyCategories);
  const notificationSummary = notificationCategorySummary(notificationCategories);
  const weclawExternalRunning = Boolean(weclawStatus?.apiReachable && !weclawStatus.managedRunning);
  const weclawToggleDisabled = weclawBusy || weclawExternalRunning;
  const weclawToggleLabel = weclawExternalRunning
    ? "外部桥接在线"
    : weclawStatus?.managedRunning
      ? "停止通知桥接"
      : "启动通知桥接";
  const weclawAutoRecipient = weclawStatus?.recipientId || "";
  const weclawLoginSaved = Boolean(weclawStatus?.hasCredentials);
  const weclawContextReady = Boolean(weclawStatus?.contextReady);
  const weclawSessionExpired = Boolean(weclawStatus?.sessionExpired);
  const weclawTokenHealth = weclawStatus?.tokenHealth || (weclawContextReady ? "healthy" : "missing");
  const weclawTokenNeedsAction = ["invalid", "expired", "unverified"].includes(weclawTokenHealth);
  const weclawTokenHealthMeta = {
    missing: { label: "尚未获取令牌", helper: "请先给 ClawBot 发送一条消息" },
    unverified: { label: "等待发送验证", helper: "已收到上下文，正在确认主动发送能力" },
    healthy: { label: "令牌已验证", helper: "当前可以发送邮件通知" },
    "refresh-soon": { label: "即将需要刷新", helper: "请尽快给 ClawBot 发送一条消息" },
    expired: { label: "预计窗口已过期", helper: "邮件通知会排队，刷新后自动补发" },
    invalid: { label: "令牌已失效", helper: "微信已拒绝发送，请立即刷新" }
  }[weclawTokenHealth];
  const weclawQrHint = weclawStatus?.apiReachable
    ? weclawContextReady
      ? `微信桥接已经在线，通知会自动发送给扫码绑定的微信。`
      : weclawTokenNeedsAction && !weclawSessionExpired
        ? "微信桥接在线，但当前令牌没有通过发送验证。请在微信里给 ClawBot 发送任意一条消息；验证成功后，排队的邮件通知会自动补发。"
      : weclawSessionExpired
        ? "扫码确认已经完成，但微信侧随后返回 session expired，说明 ClawBot 聊天没有在微信里真正建立。请先确认微信已更新，并且“设置 > 插件”里能看到微信 ClawBot。"
        : "微信已登录并自动绑定扫码用户。首次通知前，请在微信里搜索并打开 ClawBot，对它发送任意一条消息来激活会话；如果找不到联系人，请重新绑定微信。"
    : weclawQrUrl
      ? "用手机微信扫描下方二维码完成登录。"
      : weclawStatus?.managedRunning
        ? "正在等待通知桥接输出登录二维码。"
        : weclawLoginSaved
          ? "已保存微信登录状态。重启程序后点击启动通知桥接即可恢复，无需重新扫码。"
          : "启动通知桥接后，这里会自动显示登录二维码。";
  const weclawHeading = weclawSessionExpired
    ? "微信会话未激活"
    : weclawStatus?.running
    ? "微信桥接已在线"
    : weclawLoginSaved
      ? "微信登录已保存"
      : "微信桥接未在线";
  const weclawStatusLabel = weclawStatus?.apiReachable
    ? weclawStatus.managedRunning
      ? weclawContextReady
        ? `${weclawTokenHealthMeta.label}${weclawStatus.managedPid ? ` · PID ${weclawStatus.managedPid}` : ""}`
        : weclawSessionExpired
          ? `微信侧会话过期${weclawStatus.managedPid ? ` · PID ${weclawStatus.managedPid}` : ""}`
          : `${weclawTokenHealthMeta.label}${weclawStatus.managedPid ? ` · PID ${weclawStatus.managedPid}` : ""}`
      : "外部桥接在线"
    : weclawLoginSaved
      ? "已绑定微信"
      : weclawStatus
        ? "可启动"
        : "检测中";
  const weclawRuntimeText = weclawLoginSaved
    ? `${weclawStatus?.credentialsPath || "检测中"} · ${weclawStatus?.credentialCount ?? 0} 个账号`
    : weclawStatus?.runtimeName || "内置 Node iLink 桥接";
  const weclawRuntimeTitle = weclawLoginSaved
    ? weclawStatus?.credentialsPath
    : weclawStatus?.legacyExecutableAvailable
      ? `当前使用内置代码桥接；兼容二进制：${weclawStatus.legacyExecutablePath}`
      : "当前使用内置 Node iLink 桥接，无需 WeClaw exe，Linux 可直接运行。";
  const weclawLogText =
    weclawStatus?.logTail || "启动后这里会显示 WeClaw 日志。首次运行时请根据日志提示用手机微信扫码登录。";
  const openSectionCount = SETTINGS_SECTION_IDS.filter((id) => openSections[id]).length;
  const allSectionsOpen = openSectionCount === SETTINGS_SECTION_IDS.length;
  const aiSettingsSummary = aiForm
    ? `${aiForm.providerName || "自定义服务"} · ${aiForm.model || "未选择模型"}`
    : "正在读取配置";
  const systemSettingsSummary = systemForm
    ? `${systemForm.autoProcessEnabled ? `${systemForm.pollIntervalMinutes} 分钟自动处理` : "自动处理已关闭"} · ${
        systemForm.autoLoadRemoteImages ? "自动加载图片" : "手动加载图片"
      }`
    : "正在读取配置";
  const authSettingsSummary = `登录状态保存 ${dashboard?.settings.auth.sessionDays ?? 7} 天`;
  const wechatSettingsSummary = `${notificationForm?.enabled ? "通知已开启" : "通知未开启"} · ${weclawStatusLabel}`;
  const enabledMailboxCount = dashboard?.mailboxes.filter((mailbox) => mailbox.enabled).length ?? 0;
  const mailboxSettingsSummary = `${dashboard?.mailboxes.length ?? 0} 个邮箱 · ${enabledMailboxCount} 个启用`;

  return (
    <section className="settings-layout">
      <div className="settings-layout-toolbar">
        <div className="settings-layout-overview">
          <strong>设置分组</strong>
          <span>{SETTINGS_SECTION_IDS.length} 个模块 · 已展开 {openSectionCount}</span>
        </div>
        <div className="settings-layout-actions">
          <div className="settings-layout-segments" role="group" aria-label="设置页排版">
            {([
              ["auto", "自适应"],
              ["two", "双栏"],
              ["one", "单栏"]
            ] as Array<[SettingsLayoutMode, string]>).map(([mode, label]) => (
              <button
                type="button"
                key={mode}
                className={layoutMode === mode ? "active" : ""}
                aria-pressed={layoutMode === mode}
                onClick={() => setLayoutMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="settings-expand-all"
            onClick={() => setOpenSections(createSettingsSectionState(!allSectionsOpen))}
          >
            <CaretDown size={16} className={allSectionsOpen ? "rotated" : ""} />
            {allSectionsOpen ? "全部收起" : "全部展开"}
          </button>
        </div>
      </div>

      <div className={`settings-grid layout-${layoutMode}`}>
        <div className="settings-column control-column">
          <SettingsSection
            id="ai"
            kicker="AI API"
            title="模型与识别"
            summary={aiSettingsSummary}
            icon={Plugs}
            open={openSections.ai}
            onToggle={() => toggleSettingsSection("ai")}
            className="ai-settings-panel"
          >
          {aiForm && (
            <div className="form-grid">
              <label>
                API 提供商
                <select value={aiForm.providerPreset || "custom"} onChange={(event) => selectAiPreset(event.target.value)}>
                  {AI_PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                服务名称
                <input
                  value={aiForm.providerName}
                  onChange={(event) => updateAiProviderField("providerName", event.target.value)}
                />
              </label>
              <label>
                Base URL
                <input
                  value={aiForm.baseUrl}
                  onChange={(event) => updateAiProviderField("baseUrl", event.target.value)}
                />
              </label>
              <label>
                协议
                <select
                  value={aiForm.protocol || "auto"}
                  onChange={(event) =>
                    updateAiProviderField("protocol", event.target.value as NonNullable<AiSettings["protocol"]>)
                  }
                >
                  {AI_PROTOCOL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                模型
                <input value={aiForm.model} onChange={(event) => updateAiProviderField("model", event.target.value)} />
              </label>
              <label>
                Temperature
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={aiForm.temperature}
                  onChange={(event) => setAiForm({ ...aiForm, temperature: Number(event.target.value) })}
                />
              </label>
              <label className="switch-row full-span">
                <span>
                  <strong>多模态附件识别</strong>
                  <small>内嵌图片、图片附件和 PDF 会先由所选多模态模型摘要，再参与邮件分类。</small>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(aiForm.multimodalEnabled)}
                  onChange={(event) => updateAiProviderField("multimodalEnabled", event.target.checked)}
                />
              </label>
              <label>
                多模态 Base URL
                <input
                  value={aiForm.multimodalBaseUrl}
                  onChange={(event) => updateAiProviderField("multimodalBaseUrl", event.target.value)}
                />
              </label>
              <label>
                多模态协议
                <select
                  value={aiForm.multimodalProtocol || "same"}
                  onChange={(event) =>
                    updateAiProviderField(
                      "multimodalProtocol",
                      event.target.value as NonNullable<AiSettings["multimodalProtocol"]>
                    )
                  }
                >
                  {MULTIMODAL_PROTOCOL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                多模态模型
                <input
                  value={aiForm.multimodalModel}
                  onChange={(event) => updateAiProviderField("multimodalModel", event.target.value)}
                />
              </label>
              <label>
                多模态 API Key（可选）
                <input
                  type="password"
                  value={aiForm.multimodalApiKey || ""}
                  placeholder={
                    aiForm.hasMultimodalApiKey
                      ? `已保存 ${aiForm.maskedMultimodalApiKey}，留空不修改`
                      : "留空时继承主 API Key"
                  }
                  onChange={(event) => setAiForm({ ...aiForm, multimodalApiKey: event.target.value })}
                />
              </label>
              <label>
                单附件上限 MB
                <input
                  type="number"
                  min="1"
                  max="32"
                  value={aiForm.multimodalMaxAttachmentMb}
                  onChange={(event) =>
                    setAiForm({ ...aiForm, multimodalMaxAttachmentMb: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                单封总上限 MB
                <input
                  type="number"
                  min="1"
                  max="64"
                  value={aiForm.multimodalMaxTotalMb}
                  onChange={(event) => setAiForm({ ...aiForm, multimodalMaxTotalMb: Number(event.target.value) })}
                />
              </label>
              <label className="full-span">
                API Key
                <input
                  type="password"
                  value={aiForm.apiKey}
                  placeholder={aiForm.hasApiKey ? `已保存 ${aiForm.maskedApiKey}，留空不修改` : "输入 API Key"}
                  onChange={(event) => setAiForm({ ...aiForm, apiKey: event.target.value })}
                />
              </label>
              <div className="form-actions full-span">
                <button className="ghost-button" disabled={saving} onClick={testAi}>
                  <Plugs size={18} />
                  测试 AI API
                </button>
                <button className="secondary-button" disabled={saving} onClick={saveAi}>
                  <FloppyDisk size={18} />
                  保存 AI 设置
                </button>
              </div>
            </div>
          )}
          </SettingsSection>

        <SettingsSection
          id="system"
          kicker="自动处理"
          title="轮询策略"
          summary={systemSettingsSummary}
          icon={ClockCounterClockwise}
          open={openSections.system}
          onToggle={() => toggleSettingsSection("system")}
          className="system-settings-panel"
        >
          {systemForm && (
            <div className="form-grid">
              <label className="switch-row full-span">
                <span>
                  <strong>开启自动处理</strong>
                  <small>服务启动后定时读取未读邮件</small>
                </span>
                <input
                  type="checkbox"
                  checked={systemForm.autoProcessEnabled}
                  onChange={(event) => setSystemForm({ ...systemForm, autoProcessEnabled: event.target.checked })}
                />
              </label>
              <label className="switch-row full-span">
                <span>
                  <strong>自动加载邮件图片</strong>
                  <small>默认通过本地安全代理加载远程图片，可能触发邮件追踪像素</small>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(systemForm.autoLoadRemoteImages)}
                  onChange={(event) => setSystemForm({ ...systemForm, autoLoadRemoteImages: event.target.checked })}
                />
              </label>
              <label>
                轮询间隔，分钟
                <input
                  type="number"
                  min="1"
                  value={systemForm.pollIntervalMinutes}
                  onChange={(event) =>
                    setSystemForm({ ...systemForm, pollIntervalMinutes: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                每个邮箱单次上限
                <input
                  type="number"
                  min="1"
                  value={systemForm.processLimitPerMailbox}
                  onChange={(event) =>
                    setSystemForm({ ...systemForm, processLimitPerMailbox: Number(event.target.value) })
                  }
                />
              </label>
              <button className="secondary-button full-span" disabled={saving} onClick={saveSystem}>
                <FloppyDisk size={18} />
                保存系统设置
              </button>
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          id="auth"
          kicker="访问控制"
          title="登录安全"
          summary={authSettingsSummary}
          icon={LockKey}
          open={openSections.auth}
          onToggle={() => toggleSettingsSection("auth")}
          className="auth-settings-panel"
        >
          <div className="auth-settings-summary">
            <span>登录状态</span>
            <strong>保存 {dashboard?.settings.auth.sessionDays ?? 7} 天</strong>
            <small>
              {dashboard?.settings.auth.passwordUpdatedAt
                ? `密码更新时间：${formatTime(dashboard.settings.auth.passwordUpdatedAt)}`
                : "使用默认管理员密码，建议上线后立即修改。"}
            </small>
          </div>
          <div className="form-grid auth-password-grid">
            <label>
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                value={authForm.currentPassword}
                onChange={(event) => setAuthForm({ ...authForm, currentPassword: event.target.value })}
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                value={authForm.newPassword}
                onChange={(event) => setAuthForm({ ...authForm, newPassword: event.target.value })}
              />
            </label>
            <label className="full-span">
              确认新密码
              <input
                type="password"
                autoComplete="new-password"
                value={authForm.confirmPassword}
                onChange={(event) => setAuthForm({ ...authForm, confirmPassword: event.target.value })}
              />
            </label>
            <button
              className="secondary-button full-span"
              disabled={saving || !authForm.currentPassword || !authForm.newPassword || !authForm.confirmPassword}
              onClick={saveAuthPassword}
            >
              <FloppyDisk size={18} />
              保存登录密码
            </button>
          </div>
        </SettingsSection>
        </div>

        <div className="settings-column integration-column">
        <SettingsSection
          id="wechat"
          kicker="微信通知"
          title="ClawBot 推送"
          summary={wechatSettingsSummary}
          icon={BellRinging}
          open={openSections.wechat}
          onToggle={() => toggleSettingsSection("wechat")}
          className="notification-settings-panel"
        >
          {notificationForm && (
            <div className="notification-form">
              <div className="notification-hero">
                <button
                  type="button"
                  className={`notification-primary-toggle${notificationForm.enabled ? " active" : ""}`}
                  onClick={() => setNotificationForm({ ...notificationForm, enabled: !notificationForm.enabled })}
                >
                  <span className="notification-toggle-icon">
                    <BellRinging size={22} weight={notificationForm.enabled ? "fill" : "regular"} />
                  </span>
                  <span className="notification-toggle-copy">
                    <strong>{notificationForm.enabled ? "微信通知已开启" : "开启微信通知"}</strong>
                    <small>重要邮件入库后，会通过项目内桥接发送到扫码绑定的微信</small>
                  </span>
                  <em>{notificationForm.enabled ? "已开启" : "未开启"}</em>
                </button>
                <div className="notification-hero-actions">
                  <button className="ghost-button" disabled={saving} onClick={testNotification}>
                    <Plugs size={18} />
                    测试通知
                  </button>
                  <button className="secondary-button" disabled={saving} onClick={saveNotification}>
                    <FloppyDisk size={18} />
                    保存设置
                  </button>
                </div>
              </div>

              <div className="notification-workspace">
                <section className="notification-control-card">
                  <button
                    type="button"
                    className={`notification-category-trigger${notificationCategoryOpen ? " open" : ""}`}
                    onClick={() => setNotificationCategoryOpen((value) => !value)}
                    aria-expanded={notificationCategoryOpen}
                  >
                    <span>
                      <SlidersHorizontal size={18} />
                      通知分类
                    </span>
                    <strong>{notificationSummary}</strong>
                    <CaretDown size={16} />
                  </button>

                  {notificationCategoryOpen && (
                    <div className="notification-category-grid">
                      {notificationCategoryOrder.map((category) => {
                        const Icon = categoryMeta[category].icon;
                        const enabled = notificationCategories[category];
                        return (
                          <button
                            key={category}
                            type="button"
                            className={`notification-category-card ${category}${enabled ? " active" : ""}`}
                            onClick={() => updateNotificationCategory(category, !enabled)}
                          >
                            <span className="category-card-icon">
                              <Icon size={18} />
                            </span>
                            <span>
                              <strong>{categoryMeta[category].label}</strong>
                              <small>{enabled ? "发送到微信" : "不发送"}</small>
                            </span>
                            <em>{enabled ? "开" : "关"}</em>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="notification-auto-binding">
                    <span>自动接收人</span>
                    <strong>{weclawAutoRecipient || "扫码登录后自动绑定"}</strong>
                    <small>
                      {weclawContextReady
                        ? "扫码用户已绑定，会话上下文已保存"
                        : weclawSessionExpired
                          ? "已识别扫码用户，但微信侧没有成功创建 ClawBot 会话"
                        : "扫码后自动绑定接收人；首次通知前需给 ClawBot 发一条消息"}
                    </small>
                  </div>
                </section>

                <section className="weclaw-console">
                  <div className="weclaw-console-head">
                    <div>
                      <p className="section-kicker">项目内桥接</p>
                      <h3>{weclawHeading}</h3>
                    </div>
                    <span
                      className={`weclaw-status${
                        weclawStatus?.apiReachable && weclawContextReady
                          ? " online"
                          : weclawStatus?.apiReachable && weclawTokenNeedsAction
                            ? " danger"
                            : ""
                      }`}
                    >
                      {weclawStatusLabel}
                    </span>
                  </div>
                  <div className="weclaw-console-actions">
                    <button
                      className={weclawStatus?.managedRunning ? "ghost-button" : "secondary-button"}
                      disabled={weclawToggleDisabled}
                      onClick={toggleManagedWeclaw}
                    >
                      {weclawStatus?.managedRunning ? <X size={18} /> : <Play size={18} />}
                      {weclawBusy ? "处理中..." : weclawToggleLabel}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={weclawBusy}
                      onClick={rebindManagedWeclaw}
                    >
                      <ClockCounterClockwise size={18} />
                      重新绑定
                    </button>
                  </div>
                  <div className={`weclaw-token-health ${weclawTokenHealth}`}>
                    <div className="weclaw-token-health-copy">
                      <span>通知令牌</span>
                      <strong>{weclawTokenHealthMeta.label}</strong>
                      <small>{weclawTokenHealthMeta.helper}</small>
                    </div>
                    <dl className="weclaw-token-health-times">
                      <div>
                        <dt>最后收到</dt>
                        <dd>{formatTime(weclawStatus?.contextObservedAt || weclawStatus?.contextCapturedAt)}</dd>
                      </div>
                      <div>
                        <dt>发送验证</dt>
                        <dd>{weclawStatus?.contextVerifiedAt ? formatTime(weclawStatus.contextVerifiedAt) : "尚未通过"}</dd>
                      </div>
                      <div>
                        <dt>预计失效</dt>
                        <dd>
                          {weclawStatus?.contextEstimatedExpiresAt
                            ? formatTime(weclawStatus.contextEstimatedExpiresAt)
                            : "等待令牌"}
                        </dd>
                      </div>
                    </dl>
                    {weclawStatus?.contextLastError && (
                      <p className="weclaw-token-health-error" title={weclawStatus.contextLastError}>
                        最后失败：{weclawStatus.contextLastError}
                      </p>
                    )}
                  </div>
                  <div
                    className={`weclaw-qr-card${weclawQrDataUrl ? " ready" : ""}${
                      weclawStatus?.apiReachable ? " connected" : ""
                    }${weclawSessionExpired ? " expired" : ""}`}
                  >
                    <div className="weclaw-qr-copy">
                      <span>
                        <QrCode size={16} />
                        微信连接
                      </span>
                      <strong>
                        {weclawStatus?.apiReachable
                          ? weclawSessionExpired
                            ? "扫码后会话过期"
                            : "已连接到微信"
                          : weclawQrDataUrl
                            ? "扫码登录微信"
                            : weclawLoginSaved
                              ? "登录状态已保存"
                              : "等待二维码"}
                      </strong>
                      <small>{weclawQrHint}</small>
                    </div>
                    <div className="weclaw-qr-frame">
                      {weclawQrDataUrl ? (
                        <img src={weclawQrDataUrl} alt="WeClaw 微信登录二维码" />
                      ) : (
                        <QrCode size={44} weight="duotone" />
                      )}
                    </div>
                  </div>
                  {weclawSessionExpired && (
                    <div className="weclaw-diagnosis">
                      <strong>没有出现联系人，是微信侧没有完成 ClawBot 聊天创建。</strong>
                      <span>
                        本机已经拿到 Bot ID {weclawStatus?.botId || "未知"}，但消息轮询立即返回 session expired。
                        {"请在手机微信确认版本为 8.0.70 或更新，并检查“我 > 设置 > 插件 > 微信 ClawBot”是否可用；如果没有这个插件入口，这个微信账号暂时不能通过当前 WeClaw 入口接收推送。"}
                      </span>
                    </div>
                  )}
                  <div className="weclaw-runtime">
                    <span>{weclawLoginSaved ? "凭据位置" : "桥接模式"}</span>
                    <strong title={weclawRuntimeTitle}>{weclawRuntimeText}</strong>
                  </div>
                  <details
                    className="weclaw-log-panel"
                    open={weclawLogOpen}
                    onToggle={(event) => setWeclawLogOpen(event.currentTarget.open)}
                  >
                    <summary>
                      <span>运行日志</span>
                      <small>
                        <ClockCounterClockwise size={14} />
                        自动刷新
                      </small>
                    </summary>
                    <pre ref={weclawLogRef} className="weclaw-log" tabIndex={0}>
                      {weclawLogText}
                    </pre>
                  </details>
                </section>
              </div>
            </div>
          )}
        </SettingsSection>
        <QqNotificationPanel
          setToast={setToast}
          open={openSections.qq}
          onToggle={() => toggleSettingsSection("qq")}
        />

        <SettingsSection
          id="mailboxes"
          kicker="多邮箱"
          title={mailboxForm.id ? "编辑邮箱" : "邮箱账户"}
          summary={mailboxSettingsSummary}
          icon={MailboxIcon}
          open={openSections.mailboxes}
          onToggle={() => toggleSettingsSection("mailboxes")}
          className="mailbox-settings-panel"
        >
          <div className="mailbox-form-shell">
            <section className="mailbox-form-section">
              <div className="mailbox-form-section-head">
                <span>
                  <EnvelopeSimple size={18} />
                </span>
                <div>
                  <h3>账户信息</h3>
                  <p>填写显示名称、登录账号和授权码。</p>
                </div>
              </div>
              <div className="mailbox-field-grid mailbox-account-grid">
                <label>
                  名称
                  <input
                    value={mailboxForm.name || ""}
                    onChange={(event) => setMailboxForm({ ...mailboxForm, name: event.target.value })}
                  />
                </label>
                <label>
                  邮箱地址
                  <input
                    value={mailboxForm.email || ""}
                    onChange={(event) => setMailboxForm({ ...mailboxForm, email: event.target.value })}
                  />
                </label>
                <label>
                  用户名
                  <input
                    value={mailboxForm.username || ""}
                    onChange={(event) => setMailboxForm({ ...mailboxForm, username: event.target.value })}
                  />
                </label>
                <label>
                  密码或授权码
                  <input
                    type="password"
                    value={mailboxForm.password || ""}
                    placeholder={mailboxForm.hasPassword ? "已保存，留空不修改" : "输入密码或授权码"}
                    onChange={(event) => setMailboxForm({ ...mailboxForm, password: event.target.value })}
                  />
                </label>
              </div>
            </section>

            <section className="mailbox-form-section">
              <div className="mailbox-form-section-head">
                <span>
                  <Plugs size={18} />
                </span>
                <div>
                  <h3>连接设置</h3>
                  <p>配置 IMAP/POP3 服务地址和安全连接。</p>
                </div>
              </div>
              <div className="mailbox-field-grid mailbox-connection-grid">
                <label>
                  协议
                  <select
                    value={mailboxForm.protocol || "imap"}
                    onChange={(event) => {
                      const protocol = event.target.value as "imap" | "pop3";
                      setMailboxForm({
                        ...mailboxForm,
                        protocol,
                        port: protocol === "imap" ? 993 : 995,
                        folder: protocol === "imap" ? mailboxForm.folder || "INBOX" : ""
                      });
                    }}
                  >
                    <option value="imap">IMAP</option>
                    <option value="pop3">POP3</option>
                  </select>
                </label>
                <label>
                  主机
                  <input
                    placeholder="imap.example.com"
                    value={mailboxForm.host || ""}
                    onChange={(event) => setMailboxForm({ ...mailboxForm, host: event.target.value })}
                  />
                </label>
                <label>
                  端口
                  <input
                    type="number"
                    value={mailboxForm.port || ""}
                    onChange={(event) => setMailboxForm({ ...mailboxForm, port: Number(event.target.value) })}
                  />
                </label>
                <label>
                  文件夹
                  <input
                    disabled={mailboxForm.protocol === "pop3"}
                    value={mailboxForm.folder || ""}
                    onChange={(event) => setMailboxForm({ ...mailboxForm, folder: event.target.value })}
                  />
                </label>
                <label className="switch-row mailbox-switch-card">
                  <span>
                    <strong>SSL/TLS</strong>
                    <small>推荐开启</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={Boolean(mailboxForm.secure)}
                    onChange={(event) => setMailboxForm({ ...mailboxForm, secure: event.target.checked })}
                  />
                </label>
              </div>
            </section>

            <section className="mailbox-form-section mailbox-run-section">
              <label className="switch-row mailbox-switch-card">
                <span>
                  <strong>启用邮箱</strong>
                  <small>开启后自动轮询并处理此邮箱。</small>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(mailboxForm.enabled)}
                  onChange={(event) => setMailboxForm({ ...mailboxForm, enabled: event.target.checked })}
                />
              </label>
              <div className="form-actions full-span">
                <button className="secondary-button" disabled={saving} onClick={saveMailbox}>
                  <FloppyDisk size={18} />
                  保存邮箱
                </button>
                {mailboxForm.id && (
                  <button className="ghost-button" onClick={() => setMailboxForm(emptyMailbox)}>
                    <X size={18} />
                    取消编辑
                  </button>
                )}
              </div>
            </section>
          </div>

          <div className="mailbox-list-header">
            <div>
              <p className="section-kicker">已保存邮箱</p>
              <h3>{dashboard?.mailboxes.length ?? 0} 个邮箱</h3>
            </div>
            <span>IMAP / POP3</span>
          </div>

          <div className="mailbox-table">
            {dashboard?.mailboxes.length ? (
              dashboard.mailboxes.map((mailbox) => (
                <div className="mailbox-row" key={mailbox.id}>
                  <div>
                    <strong>{mailbox.name}</strong>
                    <span>{mailbox.email}</span>
                    {mailbox.lastError && <small className="error-text">{mailbox.lastError}</small>}
                  </div>
                  <div className="mailbox-row-meta">
                    <span>{mailbox.protocol.toUpperCase()}</span>
                    <span>{mailbox.lastSyncAt ? formatTime(mailbox.lastSyncAt) : "未同步"}</span>
                  </div>
                  <div className="row-actions">
                    <button onClick={() => testMailbox(mailbox.id)} title="测试连接">
                      <Plugs size={17} />
                    </button>
                    <button
                      onClick={() =>
                        setMailboxForm({
                          ...mailbox,
                          password: ""
                        })
                      }
                      title="编辑"
                    >
                      <PencilSimple size={17} />
                    </button>
                    <button onClick={() => deleteMailbox(mailbox.id)} title="删除">
                      <Trash size={17} />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state compact">
                <MailboxIcon size={30} />
                <h3>还没有邮箱</h3>
                <p>添加 IMAP 或 POP3 邮箱后，系统就能开始读取并分类邮件。</p>
              </div>
            )}
          </div>
        </SettingsSection>
        </div>
      </div>
    </section>
  );
}

export default App;
