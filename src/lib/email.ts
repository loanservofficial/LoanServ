import "server-only";
import { site } from "./site";

export interface LeadEmail {
  subject: string;
  html: string;
  replyTo?: string;
}

type Provider = "smtp" | "resend" | "brevo";

function env(name: string): string {
  return (process.env[name] || "").trim();
}

/**
 * Sends a lead email. LEAD_EMAIL_PROVIDER picks how (default "smtp"):
 *
 * - smtp:   Nodemailer over SMTP_HOST/PORT/USER/PASS (works on Vercel/Node and
 *           on Cloudflare Workers via nodejs_compat TCP sockets).
 * - resend: Resend's HTTP API (RESEND_API_KEY + LEAD_FROM_EMAIL).
 * - brevo:  Brevo's HTTP API (BREVO_API_KEY + LEAD_FROM_EMAIL).
 *
 * The HTTP providers are plain fetch() calls, so they work on any runtime.
 * If the chosen provider isn't configured, it degrades gracefully: the
 * submission still succeeds (free lead-capture path) and we log a non-PII
 * warning instead of throwing. A configured provider that fails does throw;
 * callers (lead-delivery, voice-webhook) catch it.
 */
export async function sendLeadEmail(email: LeadEmail): Promise<{ sent: boolean }> {
  const to = env("LEAD_TO_EMAIL") || site.email;
  const provider = (env("LEAD_EMAIL_PROVIDER").toLowerCase() || "smtp") as Provider;

  switch (provider) {
    case "smtp":
      return sendViaSmtp(email, to);
    case "resend":
      return sendViaResend(email, to);
    case "brevo":
      return sendViaBrevo(email, to);
    default:
      console.warn(`[lead] Unknown LEAD_EMAIL_PROVIDER "${provider}"; lead accepted but not emailed.`);
      return { sent: false };
  }
}

/** Never log the lead's PII — only which settings are missing. */
function notConfigured(what: string): { sent: false } {
  console.warn(`[lead] ${what} not configured; lead accepted but not emailed.`);
  return { sent: false };
}

async function sendViaSmtp({ subject, html, replyTo }: LeadEmail, to: string): Promise<{ sent: boolean }> {
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const port = Number(env("SMTP_PORT") || 587);
  if (!host || !user || !pass) return notConfigured("SMTP (SMTP_HOST/SMTP_USER/SMTP_PASS)");

  // Loaded only when SMTP is actually used, so the HTTP providers never pull
  // Nodemailer (and its net/tls dependencies) into a request.
  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: `"${site.name} Website" <${user}>`,
    to,
    subject,
    html,
    replyTo,
  });
  return { sent: true };
}

/** POST JSON to an email API; throws with the status (never the body: it may echo PII). */
async function postJson(url: string, headers: Record<string, string>, body: unknown, label: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${label} responded ${res.status}`);
  }
  await res.body?.cancel();
}

async function sendViaResend({ subject, html, replyTo }: LeadEmail, to: string): Promise<{ sent: boolean }> {
  const key = env("RESEND_API_KEY");
  const from = env("LEAD_FROM_EMAIL");
  if (!key || !from) return notConfigured("Resend (RESEND_API_KEY/LEAD_FROM_EMAIL)");

  await postJson(
    "https://api.resend.com/emails",
    { authorization: `Bearer ${key}` },
    {
      from: `${site.name} Website <${from}>`,
      to: [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    "Resend",
  );
  return { sent: true };
}

async function sendViaBrevo({ subject, html, replyTo }: LeadEmail, to: string): Promise<{ sent: boolean }> {
  const key = env("BREVO_API_KEY");
  const from = env("LEAD_FROM_EMAIL");
  if (!key || !from) return notConfigured("Brevo (BREVO_API_KEY/LEAD_FROM_EMAIL)");

  await postJson(
    "https://api.brevo.com/v3/smtp/email",
    { "api-key": key },
    {
      sender: { name: `${site.name} Website`, email: from },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    },
    "Brevo",
  );
  return { sent: true };
}

export type RateLimiter = (key: string, limit?: number, windowMs?: number) => boolean;

/**
 * Very small in-memory rate limiter (per-instance) to blunt spam bursts.
 *
 * BEST-EFFORT ONLY. This is not distributed: on serverless each instance keeps
 * its own Map, so a determined attacker can bypass it by fanning out across
 * cold starts, and the key is ultimately derived from the client-controllable
 * x-forwarded-for header (see the route handlers). Production should back this
 * with a shared store (Upstash/Vercel KV) keyed on a platform-trusted client IP.
 * Here we at least (a) evict expired entries so the Map can't grow unbounded and
 * (b) enforce a global request cap as a coarse spam backstop.
 *
 * Each call builds an independent limiter with its own map and global cap, so
 * one feature's traffic (e.g. chat) can't exhaust the cap lead capture uses.
 */
export function createRateLimiter({ globalLimit = 300 }: { globalLimit?: number } = {}): RateLimiter {
  const hits = new Map<string, { count: number; ts: number }>();

  // Global backstop: total accepted requests across ALL keys within a window.
  let globalCount = 0;
  let globalTs = Date.now();
  let lastSweep = Date.now();

  /** Drop entries whose window has elapsed so the Map stays bounded. */
  function evictExpired(now: number, windowMs: number): void {
    // Sweep at most once per window to keep the common path cheap.
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, v] of hits) {
      if (now - v.ts > windowMs) hits.delete(k);
    }
  }

  return function rateLimit(key: string, limit = 5, windowMs = 60_000): boolean {
    const now = Date.now();
    evictExpired(now, windowMs);

    // Global cap across all keys — coarse protection against key-cycling spam.
    if (now - globalTs > windowMs) {
      globalCount = 0;
      globalTs = now;
    }
    if (globalCount >= globalLimit) return false;

    const entry = hits.get(key);
    if (!entry || now - entry.ts > windowMs) {
      hits.set(key, { count: 1, ts: now });
      globalCount += 1;
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    globalCount += 1;
    return true;
  };
}

/** Shared limiter for the lead forms and webhooks. */
export const rateLimit = createRateLimiter();

/** Minimal HTML escaping for values interpolated into the email body. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sanitise any user-supplied string before it is placed into an email header
 * (e.g. Subject): strip CR/LF to defeat header injection and collapse runs of
 * whitespace. Nodemailer already encodes headers, but this is defence-in-depth.
 */
export function sanitizeHeader(v: unknown): string {
  return String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
