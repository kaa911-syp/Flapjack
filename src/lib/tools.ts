import fs from "node:fs";
import path from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import type { AgentDef, Settings } from "./types";
import type { ToolSchema } from "./llm";
import { addMessage, addNote, listNotes } from "./db";

export interface ToolContext {
  agent: AgentDef;
  settings: Settings;
}

export interface Tool {
  id: string;
  /** One-line description shown to the model. */
  description: string;
  /** Arg name -> description, shown to the model. */
  args: Record<string, string>;
  /**
   * Names from `args` that the model MUST provide. Defaults to none (all args
   * optional, matching the lax string coercion below). Used to build the JSON
   * Schema sent to the provider's tool-calling API.
   */
  required?: string[];
  /**
   * Optional extra runtime validation beyond `required` (e.g. an email format
   * check). Return an error string to reject the call, or null when the args
   * are acceptable. Runs before a tool is executed or queued for approval.
   */
  validate?: (args: Record<string, any>) => string | null;
  /**
   * Gated tools represent real-world / external side effects. They are never
   * executed directly by an agent — they create an approval and only run once
   * a human approves them.
   */
  gated: boolean;
  /**
   * Delegation tools are intercepted by the orchestrator (they hand a subtask
   * to another agent); they have no run/effect of their own.
   */
  delegate?: boolean;
  /** Executed immediately for non-gated tools. */
  run?: (args: Record<string, any>, ctx: ToolContext) => Promise<string>;
  /** Executed after a human approves a gated tool. */
  effect?: (args: Record<string, any>, ctx: ToolContext) => Promise<string>;
  /** Build the human-readable approval summary for a gated tool. */
  summarize?: (args: Record<string, any>) => string;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function clipText(s: string, max: number): string {
  const t = str(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ── fetch_url: SSRF-guarded HTTP GET ────────────────────────────
const FETCH_MAX_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_TEXT_CAP = 4000;

/** Scheme + host validation for a model-supplied URL (the private-address
 *  check is enforced at fetch time so it can honor FLAPJACK_FETCH_ALLOW_PRIVATE). */
export function validateHttpUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "url must be a valid absolute URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "url must be http or https";
  if (!u.hostname) return "url must include a host";
  return null;
}

function isPrivateHostLiteral(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    return true;
  }
  return isPrivateIp(h);
}

function isPrivateIp(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("::ffff:")) return isPrivateIp(ip.slice(7)); // v4-mapped v6
  return false;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

async function fetchUrlText(raw: string): Promise<string> {
  const v = validateHttpUrl(raw);
  if (v) return `blocked: ${v}`;
  const u = new URL(raw);
  const allowPrivate = process.env.FLAPJACK_FETCH_ALLOW_PRIVATE === "1";
  if (!allowPrivate) {
    if (isPrivateHostLiteral(u.hostname)) return "blocked: refusing to fetch a private/loopback address";
    // Resolve DNS and re-check the IP (defends against a public hostname that
    // points at an internal address / basic DNS-rebinding).
    try {
      const { address } = await dnsLookup(u.hostname);
      if (isPrivateIp(address)) return "blocked: host resolves to a private/loopback address";
    } catch {
      return "blocked: could not resolve host";
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(raw, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "flapjack/0.1 (+https://github.com/your-org/flapjack)" },
    });
    if (!res.ok) return `fetch failed: HTTP ${res.status}`;
    const ct = res.headers.get("content-type") || "";
    const reader = res.body?.getReader();
    const parts: Buffer[] = [];
    let received = 0;
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          received += value.length;
          parts.push(Buffer.from(value));
          if (received > FETCH_MAX_BYTES) {
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            break;
          }
        }
      }
    }
    let body = Buffer.concat(parts).toString("utf8");
    if (/html/i.test(ct) || /^\s*</.test(body)) body = htmlToText(body);
    body = body.replace(/\s+/g, " ").trim();
    return clipText(body, FETCH_TEXT_CAP) || "(empty response)";
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      return `fetch failed: timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    }
    return `fetch failed: ${String(err)}`;
  } finally {
    clearTimeout(timer);
  }
}

// ── search_notes: bounded keyword retrieval over saved notes ────
function searchNotes(query: string, limit: number) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const notes = listNotes();
  if (!terms.length) return notes.slice(0, limit);
  const scored = notes.map((n) => {
    const title = n.title.toLowerCase();
    const hay = `${title} ${n.content.toLowerCase()}`;
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 2;
      if (hay.includes(t)) score += 1;
    }
    return { n, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.n);
}

// ── Built-in tools ─────────────────────────────────────────────

const BUILTIN: Record<string, Tool> = {
  post_message: {
    id: "post_message",
    description: "Post a message into a team channel so humans and other agents can see it.",
    args: { channel: "channel name (optional, defaults to your channel)", text: "the message" },
    required: ["text"],
    gated: false,
    async run(args, ctx) {
      const channelId = str(args.channel || ctx.agent.channel).replace(/^#/, "") || ctx.agent.channel;
      addMessage({
        channelId,
        authorKind: "agent",
        authorId: ctx.agent.id,
        authorName: ctx.agent.name,
        emoji: ctx.agent.emoji,
        text: str(args.text),
      });
      return `Posted to #${channelId}.`;
    },
  },

  save_note: {
    id: "save_note",
    description: "Save a note to shared team memory for later reference.",
    args: { title: "short title", content: "note body" },
    required: ["content"],
    gated: false,
    async run(args) {
      const n = addNote(str(args.title) || "Untitled", str(args.content));
      return `Saved note "${n.title}".`;
    },
  },

  read_notes: {
    id: "read_notes",
    description: "Read the team's saved notes/memory (most recent first).",
    args: {},
    gated: false,
    async run() {
      const notes = listNotes().slice(0, 20);
      if (!notes.length) return "No notes saved yet.";
      return notes.map((n) => `• ${n.title}: ${clipText(n.content, 200)}`).join("\n");
    },
  },

  search_notes: {
    id: "search_notes",
    description: "Search the team's saved notes by keyword and return the most relevant ones.",
    args: { query: "what to look for", limit: "max results (optional, default 5, max 10)" },
    required: ["query"],
    gated: false,
    async run(args) {
      const limit = Math.max(1, Math.min(10, Number(str(args.limit)) || 5));
      const hits = searchNotes(str(args.query), limit);
      if (!hits.length) return `No notes match "${str(args.query)}".`;
      return hits.map((n) => `• ${n.title}: ${clipText(n.content, 200)}`).join("\n");
    },
  },

  fetch_url: {
    id: "fetch_url",
    description:
      "Fetch the readable text of a public web page over HTTP(S) (GET only, read-only). Returns plain text, truncated.",
    args: { url: "the http(s) URL to fetch" },
    required: ["url"],
    validate: (a) => validateHttpUrl(str(a.url)),
    gated: false,
    async run(args) {
      return await fetchUrlText(str(args.url));
    },
  },

  delegate: {
    id: "delegate",
    description:
      "Hand a subtask to another agent (by id) and get their summary back. Use for work outside your remit.",
    args: { agent: "the target agent id", task: "what you need them to do" },
    required: ["agent", "task"],
    gated: false,
    delegate: true,
  },

  web_search: {
    id: "web_search",
    description:
      "Look up information on the web. (Simulated in this open-source build — use fetch_url for a known URL, or wire up a real search API to enable.)",
    args: { query: "search query" },
    required: ["query"],
    gated: false,
    async run(args) {
      return `(simulated search) No live web search configured for "${str(
        args.query,
      )}". If you have a specific URL, use fetch_url. Otherwise reason from what you know, or ask a human.`;
    },
  },

  // ── Gated external actions (require human approval) ──────────

  send_email: {
    id: "send_email",
    description: "Send an email to a person. Requires human approval.",
    args: { to: "recipient", subject: "subject", body: "email body" },
    required: ["to", "subject", "body"],
    validate: (a) =>
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(a.to).trim()) ? null : `"to" must be a valid email address`,
    gated: true,
    summarize: (a) => `Email "${str(a.subject)}" to ${str(a.to)}`,
    async effect(args) {
      return `Email sent to ${str(args.to)} (simulated).`;
    },
  },

  send_invoice: {
    id: "send_invoice",
    description: "Issue an invoice to a customer. Requires human approval.",
    args: { customer: "customer name", amount: "amount, e.g. $4,820", description: "what for" },
    required: ["customer", "amount"],
    gated: true,
    summarize: (a) => `Invoice ${str(a.amount)} to ${str(a.customer)}`,
    async effect(args) {
      return `Invoice for ${str(args.amount)} issued to ${str(args.customer)} (simulated).`;
    },
  },

  publish_post: {
    id: "publish_post",
    description: "Publish a post to a social platform. Requires human approval.",
    args: { platform: "x | linkedin | instagram", content: "post text" },
    required: ["platform", "content"],
    gated: true,
    summarize: (a) => `Publish to ${str(a.platform)}: "${str(a.content).slice(0, 60)}…"`,
    async effect(args) {
      return `Published to ${str(args.platform)} (simulated).`;
    },
  },

  run_ad_campaign: {
    id: "run_ad_campaign",
    description: "Launch or change a paid ad campaign. Requires human approval.",
    args: { platform: "ad platform", budget: "daily budget", objective: "goal" },
    required: ["platform", "budget", "objective"],
    gated: true,
    summarize: (a) => `Ad campaign on ${str(a.platform)} @ ${str(a.budget)}/day`,
    async effect(args) {
      return `Campaign launched on ${str(args.platform)} at ${str(args.budget)}/day (simulated).`;
    },
  },

  deploy: {
    id: "deploy",
    description: "Ship code / deploy to production. Requires human approval.",
    args: { service: "service name", summary: "what is changing" },
    required: ["service"],
    gated: true,
    summarize: (a) => `Deploy ${str(a.service)}: ${str(a.summary)}`,
    async effect(args) {
      return `Deployed ${str(args.service)} (simulated).`;
    },
  },

  reply_ticket: {
    id: "reply_ticket",
    description: "Reply to a customer support ticket. Requires human approval.",
    args: { ticket: "ticket id/subject", reply: "your reply" },
    required: ["ticket", "reply"],
    gated: true,
    summarize: (a) => `Reply to ticket ${str(a.ticket)}`,
    async effect(args) {
      return `Replied to ticket ${str(args.ticket)} (simulated).`;
    },
  },
};

const BUILTIN_IDS = new Set(Object.keys(BUILTIN));

// ── Config-defined tools (tools/*.json in the project) ──────────
// Users can add simple tools without editing TypeScript. Currently one kind:
//   { "id","description","args","required","kind":"webhook","url","method"? }
// Webhook tools are gated (real side effect): on approval they POST the args as
// JSON to `url`. Bad configs are skipped with a warning — never crash a run.

interface ConfigToolDef {
  id?: string;
  description?: string;
  args?: Record<string, string>;
  required?: string[];
  kind?: string;
  url?: string;
  method?: string;
}

let configCache: Record<string, Tool> | null = null;

/** Reset the config-tool cache (used by tests). */
export function resetToolsCache(): void {
  configCache = null;
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

function buildConfigTool(def: ConfigToolDef, file: string): Tool | null {
  const id = str(def.id).trim();
  if (!id || !/^[a-z0-9_]+$/.test(id)) {
    console.error(`[flapjack] tool config ${file}: missing or invalid id (use [a-z0-9_]); skipped`);
    return null;
  }
  if (BUILTIN_IDS.has(id)) {
    console.error(`[flapjack] tool config ${file}: id "${id}" collides with a built-in tool; skipped`);
    return null;
  }
  if (def.kind !== "webhook") {
    console.error(`[flapjack] tool config ${file}: unsupported kind "${str(def.kind)}" (only "webhook"); skipped`);
    return null;
  }
  const url = str(def.url);
  if (!isHttpUrl(url)) {
    console.error(`[flapjack] tool config ${file}: "url" must be an http(s) URL; skipped`);
    return null;
  }
  const args = def.args && typeof def.args === "object" ? def.args : {};
  const required = Array.isArray(def.required) ? def.required.map(String) : [];
  const method = (str(def.method) || "POST").toUpperCase();
  return {
    id,
    description: str(def.description) || `Config tool ${id}`,
    args,
    required,
    gated: true, // real side effect → always behind the approval gate
    summarize: (a) => `${id}: ${clipText(JSON.stringify(a), 60)}`,
    async effect(a) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(a),
          signal: ctrl.signal,
        });
        return res.ok ? `Sent to ${id} (HTTP ${res.status}).` : `${id} webhook failed: HTTP ${res.status}`;
      } catch (err) {
        return `${id} webhook error: ${String(err)}`;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function loadConfigTools(): Record<string, Tool> {
  if (configCache) return configCache;
  const out: Record<string, Tool> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(process.cwd(), "tools")).filter((f) => f.endsWith(".json"));
  } catch {
    configCache = out;
    return out;
  }
  for (const file of files) {
    try {
      const def = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tools", file), "utf8")) as ConfigToolDef;
      const tool = buildConfigTool(def, file);
      if (tool) out[tool.id] = tool;
    } catch (err) {
      console.error(`[flapjack] skipped invalid tool config ${file}: ${String(err)}`);
    }
  }
  configCache = out;
  return out;
}

/** Built-in tools merged with config-defined tools. Built-ins always win. */
function registry(): Record<string, Tool> {
  return { ...loadConfigTools(), ...BUILTIN };
}

export function getTool(id: string): Tool | undefined {
  return registry()[id];
}

export function allTools(): Tool[] {
  return Object.values(registry());
}

/** Build the tool documentation block (used only by the json fallback mode). */
export function describeTools(toolIds: string[]): string {
  const reg = registry();
  const lines: string[] = [];
  for (const id of toolIds) {
    const t = reg[id];
    if (!t) continue;
    const argList = Object.entries(t.args)
      .map(([k, d]) => `${k} (${d})`)
      .join(", ");
    lines.push(
      `- ${t.id}${t.gated ? " [requires approval]" : ""}: ${t.description}` +
        (argList ? `\n    args: ${argList}` : "\n    args: none"),
    );
  }
  return lines.join("\n");
}

/**
 * Validate a tool call's arguments before the tool runs or is queued for
 * approval. Checks every `required` arg is present and non-blank, then runs the
 * tool's own `validate` (if any). Returns an error string, or null when valid.
 * Critical for gated tools: a malformed payload should never reach the approval
 * queue for a human to rubber-stamp.
 */
export function validateToolArgs(tool: Tool, args: Record<string, any>): string | null {
  for (const name of tool.required ?? []) {
    if (!str(args[name]).trim()) return `missing required argument "${name}"`;
  }
  return tool.validate ? tool.validate(args) : null;
}

/**
 * Derive a provider-neutral JSON-Schema tool description from a Tool's `args`
 * map. Every arg is a string property (matching the lax `str()` coercion);
 * `required` is honored if the tool declares it. Authors still only write
 * `args` — no hand-rolled JSON Schema needed to add a tool.
 */
export function toolSchema(t: Tool): ToolSchema {
  const properties: Record<string, any> = {};
  for (const [name, desc] of Object.entries(t.args)) {
    properties[name] = { type: "string", description: desc };
  }
  return {
    name: t.id,
    description: t.description,
    parameters: { type: "object", properties, required: t.required ?? [] },
  };
}

/** Schemas for the given tool ids, skipping unknown ids. */
export function schemasFor(toolIds: string[]): ToolSchema[] {
  const reg = registry();
  const out: ToolSchema[] = [];
  for (const id of toolIds) {
    const t = reg[id];
    if (t) out.push(toolSchema(t));
  }
  return out;
}
