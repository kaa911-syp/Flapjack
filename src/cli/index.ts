#!/usr/bin/env node
/**
 * Flapjack CLI — the whole agent org, driven from your terminal.
 * No dashboard, no SaaS: it reads your markdown agents, runs them on your own
 * keys, and writes everything to a local .data/store.json.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import { loadAgents, getAgent } from "../lib/agents";
import { runAgent, type AgentEvent } from "../lib/orchestrator";
import { approve, reject } from "../lib/approvals";
import { complete, LLMError } from "../lib/llm";
import { verifySlackSignature, verifyDiscordSignature, safeEqual } from "../lib/connectors";
import { runInbound } from "../lib/inbound";
import type { Provider } from "../lib/types";
import {
  flushStore,
  getSettings,
  saveSettings,
  listProfiles,
  resolveProfile,
  upsertProfile,
  deleteProfile,
  listApprovals,
  listAudit,
  listUsage,
} from "../lib/db";

// ── tiny ANSI helpers (no deps; respects NO_COLOR) ──────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string | number) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1");
const dim = c("2");
const red = c("31");
const green = c("32");
const yellow = c("33");
const cyan = c("36");
const amber = c("38;5;214");

function log(...a: unknown[]) {
  console.log(...a);
}
function die(msg: string): never {
  console.error(red("error: ") + msg);
  process.exit(1);
}

// ── arg parsing: positionals + --flag value / --flag=value / --bool ──
interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}
// Flags that are always boolean, so `--json run` doesn't swallow "run".
const BOOL_FLAGS = new Set(["json"]);
function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key.includes("=")) {
        const [k, ...rest] = key.split("=");
        flags[k] = rest.join("=");
      } else if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}
const str = (v: string | boolean | undefined): string => (typeof v === "string" ? v : "");

// Machine-readable output: `flapjack <cmd> --json`. Human output stays default.
const wantsJson = (args: Args): boolean => args.flags.json === true;
const emitJson = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};

// ── commands ────────────────────────────────────────────────────

function cmdHelp() {
  log(`${bold(amber("🥞 Flapjack"))} — your AI agent org, in the terminal

${bold("Usage")}  flapjack <command> [options]

${bold("Getting started")}
  init                      Scaffold agents/ + knowledge/ in this folder
  profile add               Add a model connection (Bring Your Own Key)
  test [profileId]          Verify a model connection works

${bold("Run agents")}
  list                      List all agents
  run <agent> [task...]     Run one agent (optional one-off task)
  run-all [department]      Run every agent (optionally one department)

${bold("Oversight")}
  approvals                 Show actions awaiting your approval
  approve <id>              Approve a queued action (runs its effect)
  reject <id>               Reject a queued action
  costs                     Token + dollar usage, by agent and model
  audit [n]                 Show the last n log entries (default 20)

${bold("Configuration")}
  config                    Show current config (secrets masked)
  config set <key> <value>  Set company | maxSteps
  profiles                  List model profiles
  profile add  --name --provider --model [--key] [--base-url] [--tool-mode native|json]
  profile rm <id>           Delete a model profile
  profile default <id>      Set the default model profile
  connectors set            --slack-webhook --discord-webhook --inbound-secret
                            --slack-secret --discord-key

${bold("Chat integration")}
  serve [--port 8787]       Host Slack/Discord/inbound webhooks for /flapjack
        [--host 127.0.0.1]  Bind address (default loopback; use 0.0.0.0 to expose)
        [--rate-limit 60]   Max requests per client per 60s (0 disables)

${dim("Add --json to list / run / test / approvals / costs for machine-readable output.")}
${dim("Providers: openai | anthropic | gemini | openai-compatible (OpenRouter, Groq, Ollama, LM Studio)")}
${dim("Data lives in ./.data/store.json — keys never leave your machine.")}`);
}

function cmdList(args: Args) {
  const agents = loadAgents();
  if (wantsJson(args)) {
    emitJson(
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        department: a.department,
        role: a.role,
        autonomy: a.autonomy,
        profile: a.profile ?? null,
        channel: a.channel,
        tools: a.tools,
      })),
    );
    return;
  }
  if (!agents.length) {
    log(yellow("No agents found.") + " Run " + cyan("flapjack init") + " to scaffold some.");
    return;
  }
  const def = resolveProfile(undefined);
  log(bold(`${agents.length} agent${agents.length === 1 ? "" : "s"}`) + dim("  (default profile: " + (def?.name ?? "none") + ")"));
  let dept = "";
  for (const a of agents) {
    if (a.department !== dept) {
      dept = a.department;
      log("\n" + bold(cyan(dept)));
    }
    const prof = a.profile ? dim(" @" + a.profile) : "";
    const tools = a.tools.length ? dim("  [" + a.tools.join(", ") + "]") : "";
    log(`  ${a.emoji}  ${bold(a.id)}${prof}  ${dim("·")} ${a.role || a.name}  ${autoBadge(a.autonomy)}${tools}`);
  }
}
function autoBadge(a: string): string {
  if (a === "autonomous") return green("autonomous");
  if (a === "approval") return amber("approval");
  return dim("suggest");
}

function oneLine(s: string, n = 90): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

async function cmdRun(args: Args) {
  const id = args._[0];
  if (!id) die("usage: flapjack run <agent> [task...]");
  if (!getAgent(id)) die(`unknown agent "${id}". Run ${cyan("flapjack list")} to see them.`);
  const task = args._.slice(1).join(" ").trim() || undefined;
  const json = wantsJson(args);

  // JSON mode: no streaming/human prints, just the final structured result.
  if (json) {
    const res = await runAgent(id, { trigger: task });
    if (!res.ok) process.exitCode = 1;
    emitJson({ ok: res.ok, agentId: res.agentId, steps: res.steps, summary: res.summary ?? null, error: res.error ?? null });
    return;
  }

  log(dim(`running ${id}${task ? ` — "${task}"` : ""}…`));

  // Stream progress live: tool calls + approvals as they happen, and the final
  // summary token-by-token where the provider supports streaming.
  let streamedText = false;
  let openLine = false; // we're mid-way through a streamed text line
  const breakLine = () => {
    if (openLine) {
      process.stdout.write("\n");
      openLine = false;
    }
  };
  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "text":
        if (e.delta) {
          process.stdout.write(e.delta);
          streamedText = true;
          openLine = true;
        }
        break;
      case "tool_call":
        breakLine();
        log(dim(`  🔧 ${e.tool}`) + (e.observation ? dim("  " + oneLine(e.observation)) : ""));
        break;
      case "approval":
        breakLine();
        log(amber("  🔐 approval queued ") + e.summary + dim(`  (${e.approvalId})`));
        break;
      case "finish":
      case "error":
        breakLine();
        break;
    }
  };

  const res = await runAgent(id, { trigger: task, onEvent });
  if (res.ok) {
    log(green("✓ ") + bold(id) + dim(` (${res.steps} step${res.steps === 1 ? "" : "s"})`));
    // If the summary already streamed live, don't print it twice.
    if (res.summary && !streamedText) log("  " + res.summary);
  } else {
    process.exitCode = 1;
    log(red("✗ ") + bold(id) + ": " + (res.error || "failed"));
  }
}

async function cmdRunAll(args: Args) {
  const dept = args._[0];
  const agents = loadAgents().filter((a) => !dept || a.department.toLowerCase() === dept.toLowerCase());
  if (!agents.length) die(dept ? `no agents in department "${dept}"` : "no agents found");
  log(dim(`running ${agents.length} agent${agents.length === 1 ? "" : "s"}…\n`));
  for (const a of agents) {
    process.stdout.write(`  ${a.emoji} ${bold(a.id)} … `);
    const res = await runAgent(a.id);
    if (res.ok) log(green("ok") + dim(` (${res.steps} steps)`));
    else {
      process.exitCode = 1;
      log(red("failed: ") + (res.error || ""));
    }
  }
}

function cmdApprovals(args: Args) {
  const pending = listApprovals("pending");
  if (wantsJson(args)) {
    emitJson(
      pending.map((a) => ({
        id: a.id,
        agentId: a.agentId,
        agentName: a.agentName,
        tool: a.tool,
        action: a.action,
        payload: a.payload,
        createdAt: a.createdAt,
      })),
    );
    return;
  }
  if (!pending.length) {
    log(green("✓ ") + "Nothing waiting for approval.");
    return;
  }
  log(bold(`${pending.length} action${pending.length === 1 ? "" : "s"} awaiting approval:\n`));
  for (const a of pending) {
    log(`  ${amber(a.id)}  ${a.emoji ?? "🔐"} ${bold(a.agentName)} → ${a.action}`);
    log(dim(`      ${JSON.stringify(a.payload)}`));
  }
  log("\n" + dim("Approve with ") + cyan("flapjack approve <id>") + dim(" or ") + cyan("flapjack reject <id>"));
}

async function cmdApprove(args: Args) {
  const id = args._[0];
  if (!id) die("usage: flapjack approve <id>");
  const r = await approve(id);
  if ("error" in r) die(r.error);
  log(green("✓ approved: ") + r.action + (r.result ? dim("  " + r.result) : ""));
}

function cmdReject(args: Args) {
  const id = args._[0];
  if (!id) die("usage: flapjack reject <id>");
  const r = reject(id);
  if ("error" in r) die(r.error);
  log(yellow("✗ rejected: ") + r.action);
}

function cmdCosts(args: Args) {
  const json = wantsJson(args);
  const entries = listUsage(5000);
  if (!entries.length) {
    if (json) emitJson({ totalCostUsd: 0, calls: 0, promptTokens: 0, completionTokens: 0, estimated: false, byAgent: [], byModel: [] });
    else log(dim("No usage recorded yet. Run an agent first."));
    return;
  }
  let cost = 0, pTok = 0, cTok = 0;
  const byAgent: Record<string, { name: string; cost: number; tok: number; calls: number }> = {};
  const byModel: Record<string, { provider: string; cost: number; tok: number; calls: number }> = {};
  let estimated = false;
  for (const e of entries) {
    cost += e.costUsd; pTok += e.promptTokens; cTok += e.completionTokens;
    if (e.estimated) estimated = true;
    const ak = e.agentId || "unknown";
    (byAgent[ak] ??= { name: e.agentName || ak, cost: 0, tok: 0, calls: 0 });
    byAgent[ak].cost += e.costUsd; byAgent[ak].tok += e.promptTokens + e.completionTokens; byAgent[ak].calls++;
    (byModel[e.model] ??= { provider: e.provider, cost: 0, tok: 0, calls: 0 });
    byModel[e.model].cost += e.costUsd; byModel[e.model].tok += e.promptTokens + e.completionTokens; byModel[e.model].calls++;
  }
  if (json) {
    emitJson({
      totalCostUsd: cost,
      calls: entries.length,
      promptTokens: pTok,
      completionTokens: cTok,
      estimated,
      byAgent: Object.entries(byAgent).map(([id, v]) => ({ agentId: id, name: v.name, costUsd: v.cost, tokens: v.tok, calls: v.calls })),
      byModel: Object.entries(byModel).map(([m, v]) => ({ model: m, provider: v.provider, costUsd: v.cost, tokens: v.tok, calls: v.calls })),
    });
    return;
  }
  const money = (n: number) => "$" + n.toFixed(n < 1 ? 4 : 2);
  log(bold("Total spend ") + amber(money(cost)) + dim(`   ${entries.length} calls · ${(pTok + cTok).toLocaleString()} tokens (${pTok.toLocaleString()} in / ${cTok.toLocaleString()} out)`));
  if (estimated) log(dim("Some token counts are estimated; local models are priced at $0."));
  log("\n" + bold("By agent"));
  for (const [, v] of Object.entries(byAgent).sort((a, b) => b[1].cost - a[1].cost))
    log(`  ${v.name.padEnd(18)} ${money(v.cost).padStart(9)}  ${dim(v.tok.toLocaleString() + " tok · " + v.calls + " calls")}`);
  log("\n" + bold("By model"));
  for (const [m, v] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost))
    log(`  ${m.padEnd(26)} ${money(v.cost).padStart(9)}  ${dim(v.provider + " · " + v.calls + " calls")}`);
}

function cmdAudit(args: Args) {
  const n = Number(args._[0]) || 20;
  const entries = listAudit(n).reverse();
  if (!entries.length) return log(dim("No activity logged yet."));
  for (const e of entries) {
    const t = new Date(e.at).toLocaleTimeString();
    log(`${dim(t)}  ${kindColor(e.kind)}  ${e.summary}`);
  }
}
function kindColor(k: string): string {
  if (k === "error") return red(k);
  if (k === "approval_requested") return amber(k);
  if (k.startsWith("agent_run")) return cyan(k);
  return dim(k);
}

function cmdConfig(args: Args) {
  if (args._[0] === "set") {
    const key = args._[1];
    const value = args._.slice(2).join(" ");
    if (!key) die("usage: flapjack config set <company|maxSteps> <value>");
    if (key === "company") saveSettings({ company: value });
    else if (key === "maxSteps") saveSettings({ maxSteps: Math.max(1, Math.min(20, Number(value) || 8)) });
    else die(`unknown config key "${key}" (use company | maxSteps)`);
    log(green("✓ saved ") + key);
    return;
  }
  const s = getSettings();
  log(bold("Company   ") + s.company);
  log(bold("Max steps ") + s.maxSteps);
  log(bold("Default   ") + (resolveProfile(undefined)?.name ?? dim("none")));
  log(bold("Profiles  ") + s.profiles.length);
  const cn = s.connectors;
  const on = (b: boolean) => (b ? green("on") : dim("off"));
  log(bold("Connectors") + `  slack-webhook ${on(!!cn.slackWebhookUrl)}  discord-webhook ${on(!!cn.discordWebhookUrl)}  inbound ${on(!!cn.inboundSecret)}  slack-verify ${on(!!cn.slackSigningSecret)}  discord-verify ${on(!!cn.discordPublicKey)}`);
}

function cmdProfiles() {
  const profs = listProfiles();
  const def = getSettings().defaultProfileId;
  if (!profs.length) return log(yellow("No profiles.") + " Add one: " + cyan("flapjack profile add --name Default --provider openai --model gpt-4o-mini --key sk-..."));
  for (const p of profs) {
    const d = p.id === def ? amber(" (default)") : "";
    const key = p.apiKey ? green("key set") : dim("no key");
    log(`  ${bold(p.name)}${d}  ${dim(p.id)}\n    ${p.provider} · ${p.model} · ${key}${p.baseUrl ? dim(" · " + p.baseUrl) : ""}`);
  }
}

const PROVIDERS: Provider[] = ["openai", "anthropic", "gemini", "openai-compatible"];

function cmdProfileAdd(args: Args) {
  const name = str(args.flags.name);
  const provider = str(args.flags.provider) as Provider;
  if (!name) die("--name is required");
  if (!PROVIDERS.includes(provider)) die(`--provider must be one of: ${PROVIDERS.join(", ")}`);
  const toolMode = str(args.flags["tool-mode"]);
  if (toolMode && toolMode !== "native" && toolMode !== "json")
    die('--tool-mode must be "native" or "json"');
  const p = upsertProfile({
    id: str(args.flags.id) || undefined,
    name,
    provider,
    model: str(args.flags.model) || undefined,
    baseUrl: str(args.flags["base-url"]) || undefined,
    apiKey: str(args.flags.key) || undefined,
    toolMode: (toolMode as "native" | "json") || undefined,
  });
  // First profile becomes the default automatically (handled in db); confirm:
  log(green("✓ profile saved: ") + bold(p.name) + dim(" " + p.id));
  if (str(args.flags.key)) {
    log(
      dim("  note: API keys are stored unencrypted in ./.data/store.json (gitignored, ") +
        dim("chmod 600 on POSIX). Keep that file private; it is only sent to your provider."),
    );
  }
}

function cmdProfileRm(args: Args) {
  const id = args._[0];
  if (!id) die("usage: flapjack profile rm <id>");
  if (listProfiles().length <= 1) die("keep at least one profile");
  if (!deleteProfile(id)) die("profile not found");
  log(green("✓ deleted ") + id);
}

function cmdProfileDefault(args: Args) {
  const id = args._[0];
  if (!id) die("usage: flapjack profile default <id>");
  if (!listProfiles().some((p) => p.id === id)) die("profile not found");
  saveSettings({ defaultProfileId: id });
  log(green("✓ default profile set"));
}

function cmdConnectorsSet(args: Args) {
  const cur = getSettings().connectors;
  const next = { ...cur };
  const map: Record<string, keyof typeof cur> = {
    "slack-webhook": "slackWebhookUrl",
    "discord-webhook": "discordWebhookUrl",
    "inbound-secret": "inboundSecret",
    "slack-secret": "slackSigningSecret",
    "discord-key": "discordPublicKey",
  };
  let changed = 0;
  for (const [flag, key] of Object.entries(map)) {
    if (args.flags[flag] !== undefined) {
      next[key] = str(args.flags[flag]);
      changed++;
    }
  }
  if (!changed) die("nothing to set. Flags: --slack-webhook --discord-webhook --inbound-secret --slack-secret --discord-key");
  saveSettings({ connectors: next });
  log(green(`✓ updated ${changed} connector setting${changed === 1 ? "" : "s"}`));
}

async function cmdTest(args: Args) {
  const json = wantsJson(args);
  const profile = resolveProfile(args._[0]);
  if (!profile) {
    process.exitCode = 1;
    if (json) {
      emitJson({ ok: false, error: "no profile configured" });
      return;
    }
    die("no profile configured. Add one with " + cyan("flapjack profile add"));
  }
  if (!json) log(dim(`testing ${profile.name} (${profile.provider} · ${profile.model})…`));
  try {
    const res = await complete(
      [
        { role: "system", content: "You are a health check. Reply with exactly: ok" },
        { role: "user", content: "ping" },
      ],
      profile,
      { maxTokens: 8, temperature: 0 },
    );
    if (json) {
      emitJson({ ok: true, profile: profile.name, provider: profile.provider, model: profile.model, reply: res.text.trim() });
      return;
    }
    log(green("✓ connected. ") + dim('reply: "' + res.text.trim().slice(0, 60) + '"'));
  } catch (err) {
    const msg = err instanceof LLMError ? err.message : String(err);
    process.exitCode = 1;
    if (json) {
      emitJson({ ok: false, profile: profile.name, provider: profile.provider, model: profile.model, error: msg });
      return;
    }
    die(msg);
  }
}

// ── serve: Slack/Discord/inbound webhooks for /flapjack ─────────
function cmdServe(args: Args) {
  const port = Number(str(args.flags.port)) || Number(process.env.PORT) || 8787;
  // Safe default: loopback only. Pass --host 0.0.0.0 to expose on the network.
  const host = str(args.flags.host) || process.env.FLAPJACK_HOST || "127.0.0.1";

  // Simple per-client request rate limit (sliding window) to blunt floods of
  // inbound requests / approval-queue spam. Default 60 req / 60s; override with
  // --rate-limit <n> (0 disables).
  const rlMax = args.flags["rate-limit"] !== undefined ? Number(str(args.flags["rate-limit"])) : 60;
  const rlWindowMs = 60000;
  const hits = new Map<string, number[]>();
  const rateLimited = (ip: string): boolean => {
    if (!rlMax) return false;
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < rlWindowMs);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > rlMax;
  };

  const readRaw = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let b = "";
      req.on("data", (ch) => (b += ch));
      req.on("end", () => resolve(b));
    });
  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(code, { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" });
    res.end(payload);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      const ip = req.socket.remoteAddress || "unknown";
      if (rateLimited(ip)) return send(res, 429, { error: "rate limited" });
      const raw = await readRaw(req);
      const { connectors } = getSettings();

      if (url.pathname === "/slack") {
        if (!connectors.slackSigningSecret) return send(res, 200, { text: "Slack not configured in Flapjack." });
        const ok = verifySlackSignature(
          connectors.slackSigningSecret,
          req.headers["x-slack-request-timestamp"] as string,
          req.headers["x-slack-signature"] as string,
          raw,
        );
        if (!ok) return send(res, 401, "invalid signature");
        const params = new URLSearchParams(raw);
        const text = params.get("text") || "";
        const responseUrl = params.get("response_url");
        if (responseUrl) {
          runInbound(text, "Slack")
            .then((r) =>
              fetch(responseUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ response_type: "in_channel", text: r.summary }),
              }),
            )
            .catch((e) => console.error("slack followup:", e));
        }
        return send(res, 200, { response_type: "ephemeral", text: "On it… 🥞" });
      }

      if (url.pathname === "/discord") {
        if (!connectors.discordPublicKey) return send(res, 401, "Discord not configured");
        const ok = verifyDiscordSignature(
          connectors.discordPublicKey,
          req.headers["x-signature-ed25519"] as string,
          req.headers["x-signature-timestamp"] as string,
          raw,
        );
        if (!ok) return send(res, 401, "invalid request signature");
        const interaction = JSON.parse(raw);
        if (interaction.type === 1) return send(res, 200, { type: 1 });
        if (interaction.type === 2) {
          const opts: Array<{ name: string; value: string }> = interaction.data?.options || [];
          const agentOpt = opts.find((o) => o.name === "agent")?.value;
          const taskOpt = opts.find((o) => o.name === "task" || o.name === "prompt")?.value || opts.map((o) => o.value).join(" ");
          const text = [agentOpt, taskOpt].filter(Boolean).join(" ").trim();
          const appId = interaction.application_id;
          const token = interaction.token;
          runInbound(text, "Discord")
            .then((r) =>
              fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: r.summary.slice(0, 1900) }),
              }),
            )
            .catch((e) => console.error("discord followup:", e));
          return send(res, 200, { type: 5 });
        }
        return send(res, 200, { type: 4, data: { content: "Unsupported interaction." } });
      }

      if (url.pathname === "/inbound") {
        if (!connectors.inboundSecret) return send(res, 401, { error: "inbound not configured" });
        let body: any = {};
        try { body = JSON.parse(raw); } catch {}
        if (!safeEqual(String(body.secret || ""), connectors.inboundSecret))
          return send(res, 401, { error: "unauthorized" });
        const text = String(body.text || "").trim();
        if (!text) return send(res, 400, { error: "text is required" });
        const result = await runInbound(text, "Webhook");
        return send(res, 200, result);
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      console.error(err);
      send(res, 500, { error: "internal error" });
    }
  });

  server.listen(port, host, () => {
    log(bold(amber("🥞 Flapjack")) + " webhook server on " + cyan(`http://${host}:${port}`));
    log(dim("  POST /slack    — Slack slash command  (set --slack-secret)"));
    log(dim("  POST /discord  — Discord interactions  (set --discord-key)"));
    log(dim("  POST /inbound  — generic trigger        (set --inbound-secret)"));
    log(dim("  GET  /health   — liveness check"));
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      log(
        yellow(`\n  ⚠ bound to ${host} — reachable beyond this machine.`) +
          dim(" Ensure your signing secrets are set and you trust the network."),
      );
    }
    log(dim("\nExpose with a tunnel (e.g. cloudflared / ngrok) and point your app at it."));
  });
}

// ── init: scaffold a fresh project ──────────────────────────────
function cmdInit() {
  const cwd = process.cwd();
  const agentsDir = path.join(cwd, "agents");
  const knowledgeDir = path.join(cwd, "knowledge");
  let created = 0;
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const existing = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  if (!existing.length) {
    fs.writeFileSync(
      path.join(agentsDir, "assistant.md"),
      `---\nname: Assistant\ndepartment: General\nemoji: 🤖\nrole: General Assistant\nautonomy: suggest\nchannel: general\ntools: [read_notes, save_note, post_message]\n---\n\nYou are a helpful generalist. Given a task, take one concrete, useful step and\nreport a short, skimmable result. Be specific; never invent facts.\n`,
      "utf8",
    );
    created++;
  }
  const companyPath = path.join(knowledgeDir, "company.md");
  if (!fs.existsSync(companyPath)) {
    fs.writeFileSync(
      companyPath,
      `# Company context\n\n> Every agent reads this on each run. Describe your business here.\n\n- **Name:** Your Company\n- **What we do:** (one sentence)\n- **Goals this quarter:** (bullets)\n- **Voice:** (tone, things to avoid)\n`,
      "utf8",
    );
    created++;
  }

  log(green(`✓ initialized`) + dim(` (${created} file${created === 1 ? "" : "s"} created)`));
  log("\nNext:");
  log("  1. " + cyan("flapjack profile add --name Default --provider openai --model gpt-4o-mini --key sk-..."));
  log("  2. " + cyan("flapjack test"));
  log("  3. " + cyan("flapjack run assistant \"say hello\""));
}

// ── dispatch ────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      cmdHelp(); break;
    case "init": cmdInit(); break;
    case "list": case "ls": cmdList(args); break;
    case "run": await cmdRun(args); break;
    case "run-all": await cmdRunAll(args); break;
    case "approvals": cmdApprovals(args); break;
    case "approve": await cmdApprove(args); break;
    case "reject": cmdReject(args); break;
    case "costs": cmdCosts(args); break;
    case "audit": cmdAudit(args); break;
    case "config": cmdConfig(args); break;
    case "profiles": cmdProfiles(); break;
    case "profile": {
      const sub = args._.shift();
      if (sub === "add") cmdProfileAdd(args);
      else if (sub === "rm" || sub === "remove") cmdProfileRm(args);
      else if (sub === "default") cmdProfileDefault(args);
      else die("usage: flapjack profile <add|rm|default>");
      break;
    }
    case "connectors": {
      const sub = args._.shift();
      if (sub === "set") cmdConnectorsSet(args);
      else die("usage: flapjack connectors set [flags]");
      break;
    }
    case "test": await cmdTest(args); break;
    case "serve": cmdServe(args); return; // long-running; don't flush/exit
    default:
      die(`unknown command "${cmd}". Run ${cyan("flapjack help")}.`);
  }

  // Persist any pending writes before the short-lived process exits.
  flushStore();
}

main().catch((err) => {
  console.error(red("fatal: ") + (err?.stack || err));
  flushStore();
  process.exit(1);
});
