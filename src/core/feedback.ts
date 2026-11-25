/**
 * Деталь 3.8 — обратная связь «чужой пользователь → автор» (F-1).
 *
 * Публичный npm-пакет не может содержать токены: в коде только URL write-only
 * приёмника (Cloudflare Worker из infra/feedback-worker). Секреты живут в
 * секретах Worker. При недоступности приёмника отчёт уходит в локальный
 * outbox и НЕ блокирует запуск/завершение задачи (fail-open).
 */
import crypto from "node:crypto";
import os from "node:os";
import { getDb } from "../db/index.js";
import type { FeedbackSettings } from "../settings.js";
import { getPluginVersion } from "../version.js";

/** Версия контракта payload. Приёмник обязателен принимать только её. */
export const FEEDBACK_SCHEMA_VERSION = 1;
/** Таймаут одного HTTP-запроса (F-1.2). */
export const FEEDBACK_TIMEOUT_MS = 10_000;
/** Количество повторов после первой попытки (F-1.2). */
export const FEEDBACK_MAX_RETRIES = 2;
/** Базовая задержка backoff в мс (удваивается на каждом повторе). */
export const FEEDBACK_BACKOFF_MS = 500;
/** Окно антиспама по хешу описания (F-1.7). */
export const FEEDBACK_ANTISPAM_WINDOW_MS = 5 * 60_000;
/** Лимит отчётов в час по умолчанию (F-1.7). */
export const FEEDBACK_MAX_PER_HOUR = 6;
/** Максимальное число попыток отправки из outbox. */
export const FEEDBACK_OUTBOX_MAX_ATTEMPTS = 5;
/** Пределы длин полей (совпадают с валидацией Worker). */
export const FEEDBACK_LIMITS = {
  description: 4000,
  logs: 8000,
  contactEmail: 254,
  taskName: 200,
} as const;

export type FeedbackDestination = "author" | "local" | "both";

/** Контракт, который получает приёмник (F-1.1). */
export interface FeedbackPayload {
  schemaVersion: 1;
  reportId: string;
  createdAt: string;
  pluginVersion: string;
  os: { platform: string; release: string; arch: string };
  node: string;
  locale: string;
  profile: string;
  taskName?: string;
  description: string;
  contactEmail?: string;
  redactedLogs?: string;
  metrics?: Record<string, number>;
  /** Honeypot: боты заполняют, человек — никогда. Приёмник молча дропает. */
  website?: string;
}

/** Входные данные для сборки payload. */
export interface FeedbackBuildInput {
  description: string;
  taskName?: string;
  contactEmail?: string;
  redactedLogs?: string;
  metrics?: Record<string, number>;
  locale?: string;
  profile?: string;
  reportId?: string;
  now?: Date;
}

/** Окружение, подставляемое в payload (легко подменить в тестах). */
export interface FeedbackBuildEnv {
  platform?: string;
  release?: string;
  arch?: string;
  node?: string;
  pluginVersion?: string;
}

/** Результат отправки. */
export interface FeedbackSendResult {
  ok: boolean;
  reportId: string;
  attempts: number;
  issueUrl?: string;
  error?: string;
  status?: number;
}

/** Результат высокоуровневой обработки report_bug. */
export interface FeedbackReportResult {
  success: boolean;
  reportId: string;
  destination: FeedbackDestination;
  mode: "sent" | "dryRun" | "outbox" | "duplicate" | "local";
  preview?: string;
  error?: string;
  author?: FeedbackSendResult;
}

interface OutboxRow {
  id: string;
  report_id: string;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  last_attempt_at: string | null;
}

export interface AntispamRow {
  at: string;
  hash: string;
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export function makeReportId(): string {
  return crypto.randomUUID();
}

/** Стабильный хеш описания для антиспама (без самого текста в БД). */
export function descriptionHash(description: string): string {
  return crypto.createHash("sha256").update(description.trim().toLowerCase()).digest("hex");
}

/**
 * Редакция секретов и приватных данных (F-1.4).
 *
 * Порядок важен: сначала Known-паттерны токенов, затем явные значения из
 * manage_secrets (после — home и email). Возвращает plaintext, пригодный
 * для включения в payload; при dryRun ничего не уходит по сети.
 */
export function redactText(
  text: string,
  options: { secrets?: string[]; home?: string; redactEmails?: boolean } = {},
): string {
  let out = String(text ?? "");
  const known: [RegExp, string][] = [
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github]"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github]"],
    [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED:openai]"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack]"],
    [/\b\d{8,}:[A-Za-z0-9_-]{30,}/g, "[REDACTED:bot]"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws]"],
  ];
  for (const [re, replacement] of known) out = out.replace(re, replacement);

  const secrets = (options.secrets ?? []).filter((v) => v.length >= 4);
  secrets.sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    out = out.split(secret).join("[REDACTED:secret]");
  }

  const home = options.home ?? os.homedir();
  if (home && home.length > 2) {
    out = out.split(home).join("~");
    // Windows-пути часто приходят с прямыми слешами.
    out = out.split(home.replace(/\\/g, "/")).join("~");
  }
  if (options.redactEmails !== false) {
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]");
  }
  return out;
}

function clamp(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Собирает payload по контракту F-1.1. Никакой сети — только данные. */
export function buildFeedbackPayload(
  input: FeedbackBuildInput,
  env: FeedbackBuildEnv = {},
): FeedbackPayload {
  const now = input.now ?? new Date();
  const payload: FeedbackPayload = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    reportId: input.reportId ?? makeReportId(),
    createdAt: now.toISOString(),
    pluginVersion: clamp(env.pluginVersion ?? getPluginVersion(), 64) ?? "unknown",
    os: {
      platform: clamp(env.platform ?? os.platform(), 64) ?? "unknown",
      release: clamp(env.release ?? os.release(), 128) ?? "unknown",
      arch: clamp(env.arch ?? os.arch(), 32) ?? "unknown",
    },
    node: clamp(env.node ?? process.version, 64) ?? "unknown",
    locale: clamp(input.locale, 16) ?? "en",
    profile: clamp(input.profile, 64) ?? "default",
    description: clamp(input.description, FEEDBACK_LIMITS.description) ?? "",
  };
  const taskName = clamp(input.taskName, FEEDBACK_LIMITS.taskName);
  if (taskName) payload.taskName = taskName;
  const contactEmail = clamp(input.contactEmail, FEEDBACK_LIMITS.contactEmail);
  if (contactEmail) payload.contactEmail = contactEmail;
  const redactedLogs = clamp(input.redactedLogs, FEEDBACK_LIMITS.logs);
  if (redactedLogs) payload.redactedLogs = redactedLogs;
  if (input.metrics && Object.keys(input.metrics).length > 0) payload.metrics = input.metrics;
  return payload;
}

/**
 * Валидация URL приёмника (F-1.3): только http(s), без встроенных учётных
 * данных (username/password) и без фрагмента. http разрешён только для
 * localhost (разработка).
 */
export function validateFeedbackEndpoint(raw: string): { ok: boolean; reason?: string } {
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, reason: "endpoint is empty" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "endpoint is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "only http(s) endpoint is allowed" };
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return { ok: false, reason: "http is allowed only for localhost" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "endpoint must not contain credentials" };
  }
  if (url.hash) return { ok: false, reason: "endpoint must not contain a fragment" };
  if (value.length > 2048) return { ok: false, reason: "endpoint is too long" };
  return { ok: true };
}

/** Красивый preview payload для dryRun и окна подтверждения (F-3.1). */
export function buildReportPreview(payload: FeedbackPayload): string {
  const lines = [
    "=== FEEDBACK PAYLOAD (dryRun — ничего не отправлено) ===",
    `schemaVersion: ${payload.schemaVersion}`,
    `reportId: ${payload.reportId}`,
    `createdAt: ${payload.createdAt}`,
    `pluginVersion: ${payload.pluginVersion}`,
    `os: ${payload.os.platform} ${payload.os.release} ${payload.os.arch}`,
    `node: ${payload.node}`,
    `locale: ${payload.locale}`,
    `profile: ${payload.profile}`,
  ];
  if (payload.taskName) lines.push(`taskName: ${payload.taskName}`);
  lines.push(`description: ${payload.description}`);
  if (payload.contactEmail) lines.push(`contactEmail: ${payload.contactEmail}`);
  if (payload.redactedLogs) lines.push(`redactedLogs (${payload.redactedLogs.length} chars): ${payload.redactedLogs}`);
  if (payload.metrics) lines.push(`metrics: ${JSON.stringify(payload.metrics)}`);
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Одна попытка POST с таймаутом (F-1.2). */
export async function sendFeedbackOnce(
  payload: FeedbackPayload,
  endpoint: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<FeedbackSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEEDBACK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `agent-steward/${payload.pluginVersion}`,
        "x-report-id": payload.reportId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.text();
    let parsed: { issueUrl?: string; error?: string } = {};
    try {
      parsed = JSON.parse(body) as { issueUrl?: string; error?: string };
    } catch {
      // Не JSON — считаем ошибкой, textual body не логируем целиком (PII).
    }
    return {
      ok: response.ok,
      reportId: payload.reportId,
      attempts: 1,
      status: response.status,
      issueUrl: typeof parsed.issueUrl === "string" ? parsed.issueUrl : undefined,
      error: response.ok ? undefined : (parsed.error ?? `HTTP ${response.status}`),
    };
  } catch (err) {
    return {
      ok: false,
      reportId: payload.reportId,
      attempts: 1,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** POST с 2 ретраями и экспоненциальным backoff (F-1.2). */
export async function sendFeedbackWithRetry(
  payload: FeedbackPayload,
  endpoint: string,
  options: { retries?: number; baseDelayMs?: number; sleepFn?: (ms: number) => Promise<void>; fetchImpl?: FetchLike } = {},
): Promise<FeedbackSendResult> {
  const retries = options.retries ?? FEEDBACK_MAX_RETRIES;
  const delay = options.baseDelayMs ?? FEEDBACK_BACKOFF_MS;
  const sleepFn = options.sleepFn ?? sleep;
  let last: FeedbackSendResult = {
    ok: false,
    reportId: payload.reportId,
    attempts: 0,
    error: "no attempt made",
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await sendFeedbackOnce(payload, endpoint, options.fetchImpl);
    last.attempts = attempt + 1;
    if (last.ok) return last;
    // 4xx (кроме 429) — ошибка контракта, повтор не поможет.
    if (last.status && last.status >= 400 && last.status < 500 && last.status !== 429) break;
    if (attempt < retries) await sleepFn(delay * 2 ** attempt);
  }
  return last;
}

/* ------------------------------------------------------------------ */
/* Outbox (F-1.6)                                                       */
/* ------------------------------------------------------------------ */

export function enqueueOutbox(payload: FeedbackPayload): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO feedback_outbox
      (id, report_id, payload_json, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)`,
  ).run(
    payload.reportId,
    payload.reportId,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
}

export function listOutbox(limit = 20): OutboxRow[] {
  return getDb()
    .prepare(
      "SELECT id, report_id, payload_json, attempts, last_error, created_at, last_attempt_at FROM feedback_outbox ORDER BY created_at ASC LIMIT ?",
    )
    .all(limit) as OutboxRow[];
}

function deleteOutbox(reportId: string): void {
  getDb().prepare("DELETE FROM feedback_outbox WHERE report_id = ?").run(reportId);
}

function recordOutboxAttempt(reportId: string, error: string): void {
  const row = getDb()
    .prepare("SELECT attempts FROM feedback_outbox WHERE report_id = ?")
    .get(reportId) as { attempts?: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  if (attempts >= FEEDBACK_OUTBOX_MAX_ATTEMPTS) {
    deleteOutbox(reportId);
    return;
  }
  getDb()
    .prepare("UPDATE feedback_outbox SET attempts = ?, last_error = ?, last_attempt_at = ? WHERE report_id = ?")
    .run(attempts, error.slice(0, 500), new Date().toISOString(), reportId);
}

/** Повтор outbox при старте плагина. Никогда не бросает наружу. */
export async function flushOutbox(
  settings: FeedbackSettings,
  options: { fetchImpl?: FetchLike; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<{ processed: number; sent: number }> {
  if (!settings.enabled || !validateFeedbackEndpoint(settings.endpoint).ok) {
    return { processed: 0, sent: 0 };
  }
  let processed = 0;
  let sent = 0;
  for (const row of listOutbox(20)) {
    let payload: FeedbackPayload;
    try {
      payload = JSON.parse(row.payload_json) as FeedbackPayload;
    } catch {
      deleteOutbox(row.report_id);
      continue;
    }
    processed++;
    const result = await sendFeedbackWithRetry(payload, settings.endpoint, {
      retries: 0,
      sleepFn: options.sleepFn,
      fetchImpl: options.fetchImpl,
    });
    if (result.ok) {
      deleteOutbox(row.report_id);
      sent++;
    } else {
      recordOutboxAttempt(row.report_id, result.error ?? "unknown error");
    }
  }
  return { processed, sent };
}

/* ------------------------------------------------------------------ */
/* Антиспам (F-1.7)                                                     */
/* ------------------------------------------------------------------ */

/** Решение антиспама по истории отправок. Чистая функция. */
export function evaluateAntispam(
  records: AntispamRow[],
  description: string,
  now: Date,
  maxPerHour = FEEDBACK_MAX_PER_HOUR,
): { allowed: boolean; reason?: "duplicate" | "rate_limited" } {
  const hash = descriptionHash(description);
  const hourAgo = now.getTime() - 60 * 60_000;
  const windowAgo = now.getTime() - FEEDBACK_ANTISPAM_WINDOW_MS;
  const recent = records.filter((r) => {
    const at = Date.parse(r.at);
    return Number.isFinite(at) && at >= hourAgo;
  });
  if (recent.some((r) => r.hash === hash && Date.parse(r.at) >= windowAgo)) {
    return { allowed: false, reason: "duplicate" };
  }
  if (recent.length >= maxPerHour) return { allowed: false, reason: "rate_limited" };
  return { allowed: true };
}

export function recordFeedbackSent(payload: FeedbackPayload): void {
  getDb()
    .prepare("INSERT INTO feedback_spam (hash, at) VALUES (?, ?)")
    .run(descriptionHash(payload.description), payload.createdAt);
}

function recentAntispam(now: Date): AntispamRow[] {
  return getDb()
    .prepare("SELECT at, hash FROM feedback_spam WHERE at >= ? ORDER BY at DESC LIMIT 200")
    .all(new Date(now.getTime() - 60 * 60_000).toISOString()) as AntispamRow[];
}

/* ------------------------------------------------------------------ */
/* UX-3.8.2 — гейт авто-отчёта о повторяющейся ошибке                   */
/* ------------------------------------------------------------------ */

/** Одно событие crash/error для счётчика повторов (UX-3.8.2). */
export interface RepeatErrorEvent {
  /** ISO-момент события. */
  at: string;
  /** Стабильный хеш описания (descriptionHash) — «одинаковость» ошибки. */
  hash: string;
}

/** Причина отказа гейта авто-отчёта (UX-3.8.2). */
export type AutoReportBlockReason =
  | "opt_in_required"
  | "feedback_disabled"
  | "not_repeated"
  | "duplicate"
  | "rate_limited";

/** Решение гейта: только решение, без сети и без фоновой отправки. */
export interface AutoReportDecision {
  shouldReport: boolean;
  reason?: AutoReportBlockReason;
  /** Сколько одинаковых crash/error за последний час. */
  repeatCount: number;
}

/** Считает одинаковые crash/error в окне последнего часа (60 минут). */
export function countRepeatErrors(
  events: RepeatErrorEvent[],
  description: string,
  now: Date,
): number {
  const hash = descriptionHash(description);
  const hourAgo = now.getTime() - 60 * 60_000;
  return events.filter((event) => {
    const at = Date.parse(event.at);
    return Number.isFinite(at) && at >= hourAgo && event.hash === hash;
  }).length;
}

/**
 * UX-3.8.2 — минимальный opt-in-гейт автоматической отправки отчёта.
 *
 * Ничего не отправляет и не создаёт фоновых задач: возвращает только решение.
 * Без явного согласия (`autoReportRepeatErrors: false`, в том числе по
 * умолчанию) всегда `shouldReport: false`. Проходит тот же антиспам, что и
 * ручной `report_bug` (F-1.7), и требует N одинаковых ошибок за час.
 */
export function shouldAutoReportRepeatError(
  settings: FeedbackSettings,
  events: RepeatErrorEvent[],
  description: string,
  now: Date,
  antispamRecords: AntispamRow[] = [],
): AutoReportDecision {
  const repeatCount = countRepeatErrors(events, description, now);

  if (settings.autoReportRepeatErrors !== true) {
    return { shouldReport: false, reason: "opt_in_required", repeatCount };
  }
  if (!settings.enabled || !validateFeedbackEndpoint(settings.endpoint).ok) {
    return { shouldReport: false, reason: "feedback_disabled", repeatCount };
  }
  if (repeatCount < settings.autoReportRepeatThreshold) {
    return { shouldReport: false, reason: "not_repeated", repeatCount };
  }

  // Тот же антиспам, что и у ручного report_bug (F-1.7).
  const antispam = evaluateAntispam(antispamRecords, description, now, settings.maxPerHour);
  if (!antispam.allowed) {
    return { shouldReport: false, reason: antispam.reason, repeatCount };
  }
  return { shouldReport: true, repeatCount };
}

/* ------------------------------------------------------------------ */
/* Оркестрация (F-1.5)                                                  */
/* ------------------------------------------------------------------ */

export interface ReportFeedbackOptions {
  settings: FeedbackSettings;
  destination: FeedbackDestination;
  dryRun?: boolean;
  description: string;
  taskName?: string;
  contactEmail?: string;
  redactedLogs?: string;
  metrics?: Record<string, number>;
  locale?: string;
  profile?: string;
  now?: Date;
  secrets?: string[];
  home?: string;
  /** Локальная отправка в каналы репортищего (destination local/both). */
  sendLocal?: (text: string) => Promise<{ success: boolean; message: string }>;
  localText?: string;
  fetchImpl?: FetchLike;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Точка входа для report_bug (F-1.5).
 *
 * - dryRun — только preview, сеть не трогается;
 * - author — POST на приёмник; при ошибке fail-open → outbox;
 * - local  — старые каналы уведомлений (+ outbox как страховка);
 * - both   — и приёмник, и локальные каналы.
 *
 * Если приёмник не настроен или отключён, destination=author деградирует
 * до local (fail-open), что честно отражается в `mode`.
 */
export async function reportFeedback(
  options: ReportFeedbackOptions,
): Promise<FeedbackReportResult> {
  const now = options.now ?? new Date();
  const logRedactOptions = {
    secrets: options.secrets,
    home: options.home,
    redactEmails: true,
  };
  const descRedactOptions = { ...logRedactOptions, redactEmails: false };
  const redactedLogs = options.redactedLogs
    ? redactText(options.redactedLogs, logRedactOptions)
    : undefined;
  const payload = buildFeedbackPayload(
    {
      description: redactText(options.description, descRedactOptions),
      taskName: options.taskName,
      contactEmail: options.contactEmail,
      redactedLogs,
      metrics: options.metrics,
      locale: options.locale,
      profile: options.profile,
      now,
    },
    {},
  );

  if (options.dryRun) {
    return {
      success: true,
      reportId: payload.reportId,
      destination: options.destination,
      mode: "dryRun",
      preview: buildReportPreview(payload),
    };
  }

  const antispam = evaluateAntispam(
    recentAntispam(now),
    payload.description,
    now,
    options.settings.maxPerHour,
  );
  if (!antispam.allowed) {
    return {
      success: true,
      reportId: payload.reportId,
      destination: options.destination,
      mode: "duplicate",
      error: antispam.reason,
    };
  }

  const endpointOk = options.settings.enabled && validateFeedbackEndpoint(options.settings.endpoint).ok;
  const wantAuthor = options.destination === "author" || options.destination === "both";
  const wantLocal = options.destination === "local" || options.destination === "both" || !endpointOk;

  let author: FeedbackSendResult | undefined;
  let mode: FeedbackReportResult["mode"] = "local";
  let success = true;

  if (wantAuthor) {
    author = await sendFeedbackWithRetry(payload, options.settings.endpoint, {
      fetchImpl: options.fetchImpl,
      sleepFn: options.sleepFn,
    });
    if (author.ok) {
      mode = "sent";
      recordFeedbackSent(payload);
    } else {
      mode = "outbox";
      success = false;
      enqueueOutbox(payload);
    }
  } else {
    // Нет рабочего приёмника — сохраняем отчёт локально, чтобы не потерять.
    enqueueOutbox(payload);
    recordFeedbackSent(payload);
  }

  if (wantLocal && options.sendLocal && options.localText) {
    const localResult = await options.sendLocal(options.localText);
    if (!localResult.success && mode !== "sent") {
      success = false;
    }
    if (mode === "local") mode = author?.ok ? "sent" : "local";
  }

  return {
    success,
    reportId: payload.reportId,
    destination: options.destination,
    mode,
    author,
    error: author?.error,
  };
}
