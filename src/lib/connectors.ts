import crypto from "node:crypto";
import { getSettings } from "./db";

/**
 * Outbound: mirror a notable message to Slack and/or Discord via incoming
 * webhooks. Best-effort — failures are logged but never block an agent run.
 * Setup is intentionally trivial: `flapjack connectors set --slack-webhook <url>`.
 */
export async function mirrorToChat(opts: {
  channel: string;
  author: string;
  emoji?: string;
  text: string;
}): Promise<void> {
  const { connectors } = getSettings();
  const header = `${opts.emoji ? opts.emoji + " " : ""}${opts.author} · #${opts.channel}`;
  const tasks: Promise<unknown>[] = [];

  if (connectors.slackWebhookUrl) {
    tasks.push(
      postJson(connectors.slackWebhookUrl, {
        text: `*${escapeMrkdwn(header)}*\n${opts.text}`,
      }),
    );
  }
  if (connectors.discordWebhookUrl) {
    tasks.push(
      postJson(connectors.discordWebhookUrl, {
        username: `${opts.emoji ? opts.emoji + " " : ""}${opts.author}`,
        content: truncate(`**#${opts.channel}**\n${opts.text}`, 1900),
      }),
    );
  }
  if (tasks.length) {
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === "rejected") console.error("[flapjack] connector mirror failed:", r.reason);
    }
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

// ── Inbound signature verification (no external deps) ───────────

/** Verify a Slack slash-command request (HMAC-SHA256 over v0:ts:body). */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
): boolean {
  if (!signingSecret || !timestamp || !signature) return false;
  // Reject requests older than 5 minutes (replay protection).
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = "v0=" + crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  return safeEqual(hmac, signature);
}

/** Verify a Discord interaction request (Ed25519 over timestamp+body). */
export function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  rawBody: string,
): boolean {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  try {
    // Wrap the raw 32-byte Ed25519 public key in an SPKI DER envelope.
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(publicKeyHex, "hex"),
    ]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(
      null,
      Buffer.from(timestamp + rawBody),
      key,
      Buffer.from(signatureHex, "hex"),
    );
  } catch (err) {
    console.error("[flapjack] discord verify error:", err);
    return false;
  }
}

/** Constant-time string comparison (length mismatch returns false fast). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function escapeMrkdwn(s: string): string {
  return s.replace(/[*_`]/g, "");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
