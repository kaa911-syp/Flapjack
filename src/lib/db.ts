import fs from "node:fs";
import path from "node:path";
import type {
  Approval,
  AuditEntry,
  Channel,
  Connectors,
  Message,
  Note,
  Profile,
  Provider,
  Settings,
  Store,
  UsageEntry,
} from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const LOCK_PATH = STORE_PATH + ".lock";

export function uid(prefix = ""): string {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

function envProfile(): Profile {
  return {
    id: "default",
    name: "Default",
    provider: (process.env.FLAPJACK_PROVIDER as Provider) || "openai",
    apiKey: process.env.FLAPJACK_API_KEY || "",
    model: process.env.FLAPJACK_MODEL || "gpt-4o-mini",
    baseUrl: process.env.FLAPJACK_BASE_URL || "",
  };
}

function defaultConnectors(): Connectors {
  return {
    slackWebhookUrl: process.env.FLAPJACK_SLACK_WEBHOOK || "",
    discordWebhookUrl: process.env.FLAPJACK_DISCORD_WEBHOOK || "",
    inboundSecret: process.env.FLAPJACK_INBOUND_SECRET || "",
    slackSigningSecret: process.env.FLAPJACK_SLACK_SIGNING_SECRET || "",
    discordPublicKey: process.env.FLAPJACK_DISCORD_PUBLIC_KEY || "",
  };
}

function defaultSettings(): Settings {
  // Only seed a profile from the environment when it's actually usable
  // (a key, or a base URL for a local/self-hosted server). Otherwise start
  // with zero profiles so the user's first `profile add` becomes the default.
  const envKey = process.env.FLAPJACK_API_KEY || "";
  const envBase = process.env.FLAPJACK_BASE_URL || "";
  const profiles: Profile[] = [];
  let defaultProfileId = "";
  if (envKey || envBase) {
    const def = envProfile();
    profiles.push(def);
    defaultProfileId = def.id;
  }
  return {
    profiles,
    defaultProfileId,
    company: process.env.FLAPJACK_COMPANY || "Your Company",
    maxSteps: 8,
    connectors: defaultConnectors(),
  };
}

/** Accept either the new profile-based settings or the legacy single-provider shape. */
function migrateSettings(raw: any): Settings {
  const base = defaultSettings();
  if (!raw) return base;
  // New format: a `profiles` array is present (even if empty). Preserve everything.
  if (Array.isArray(raw.profiles)) {
    return {
      profiles: raw.profiles,
      defaultProfileId: raw.defaultProfileId || raw.profiles[0]?.id || "",
      company: raw.company ?? base.company,
      maxSteps: raw.maxSteps ?? base.maxSteps,
      connectors: { ...base.connectors, ...(raw.connectors || {}) },
    };
  }
  if (raw.provider || raw.apiKey || raw.model) {
    const legacy: Profile = {
      id: "default",
      name: "Default",
      provider: raw.provider || "openai",
      apiKey: raw.apiKey || "",
      model: raw.model || "gpt-4o-mini",
      baseUrl: raw.baseUrl || "",
    };
    return {
      profiles: [legacy],
      defaultProfileId: legacy.id,
      company: raw.company ?? base.company,
      maxSteps: raw.maxSteps ?? base.maxSteps,
      connectors: { ...base.connectors, ...(raw.connectors || {}) },
    };
  }
  return base;
}

function defaultChannels(): Channel[] {
  return [
    { id: "briefing", name: "briefing", purpose: "Daily standups and overnight summaries" },
    { id: "growth", name: "growth", purpose: "Marketing, ads, social and outbound" },
    { id: "engineering", name: "engineering", purpose: "DevOps, monitoring and QA" },
    { id: "operations", name: "operations", purpose: "Invoicing and customer support" },
    { id: "general", name: "general", purpose: "Everything else" },
  ];
}

function emptyStore(): Store {
  return {
    settings: defaultSettings(),
    channels: defaultChannels(),
    messages: [],
    approvals: [],
    audit: [],
    notes: [],
    usage: [],
  };
}

// In-process read cache. Survives Next.js dev HMR by living on globalThis.
const g = globalThis as unknown as { __flapjackStore?: Store };

/** Read + normalize the store from disk. Returns null if there's no file yet. */
function readStore(): Store | null {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    const store: Store = { ...emptyStore(), ...parsed };
    store.settings = migrateSettings(parsed.settings);
    if (!store.channels?.length) store.channels = defaultChannels();
    if (!Array.isArray(store.usage)) store.usage = [];
    return store;
  } catch {
    return null;
  }
}

function load(): Store {
  if (g.__flapjackStore) return g.__flapjackStore;
  const store = readStore() ?? emptyStore();
  g.__flapjackStore = store;
  return store;
}

// ── Cross-process advisory lock ─────────────────────────────────
// A coarse lock file serializes read-modify-write across processes (e.g.
// `flapjack serve` and a one-shot CLI command running at the same time), so a
// concurrent writer can no longer clobber another's changes. Re-entrant within
// a single process. Best-effort: if the lock can't be taken (permissions) or a
// holder appears to have crashed, we proceed rather than deadlock.
let lockFd: number | null = null;
let lockDepth = 0;

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable — skip the wait */
  }
}

function acquireLock(): void {
  if (lockDepth > 0) {
    lockDepth++;
    return;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      lockFd = fs.openSync(LOCK_PATH, "wx"); // exclusive create
      lockDepth = 1;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        // Can't create a lock at all — proceed unlocked rather than fail.
        lockFd = null;
        lockDepth = 1;
        return;
      }
      // Steal a stale lock left by a crashed process.
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > 10000) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        /* lock vanished — retry */
      }
      if (Date.now() > deadline) {
        // Waited too long; proceed unlocked to avoid a hard deadlock.
        lockFd = null;
        lockDepth = 1;
        return;
      }
      sleepSync(20);
    }
  }
}

function releaseLock(): void {
  if (lockDepth > 1) {
    lockDepth--;
    return;
  }
  lockDepth = 0;
  if (lockFd !== null) {
    try {
      fs.closeSync(lockFd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      /* ignore */
    }
    lockFd = null;
  }
}

function writeNow(store: Store): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE_PATH + ".tmp";
    // 0o600: the store holds API keys; keep it readable only by the owner.
    // (No-op on Windows file systems, but harmless and correct on POSIX.)
    // tmp + rename = atomic swap, so a crash mid-write never corrupts the store.
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
    try {
      fs.chmodSync(STORE_PATH, 0o600);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    console.error("[flapjack] failed to persist store:", err);
  }
}

/**
 * Retained for compatibility. Writes are now synchronous under a lock, so there
 * is nothing to flush before exit — this is a no-op. (Previously the store used
 * a 50ms write debounce that could drop a mutation if the CLI exited first.)
 */
export function flushStore(): void {
  /* no-op */
}

/** Read-only access to the live store. */
export function getStore(): Store {
  return load();
}

/** Mutate the store with a function, then persist — atomically and durably. */
export function mutate<T>(fn: (store: Store) => T): T {
  acquireLock();
  try {
    // Read the latest from disk inside the lock so we never clobber another
    // process's concurrent write (serve + a one-shot CLI command).
    const store = readStore() ?? emptyStore();
    const result = fn(store);
    writeNow(store);
    g.__flapjackStore = store; // keep the in-process read cache fresh
    return result;
  } finally {
    releaseLock();
  }
}

// ── Convenience helpers ────────────────────────────────────────

export function getSettings(): Settings {
  return load().settings;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  return mutate((s) => {
    s.settings = { ...s.settings, ...patch };
    return s.settings;
  });
}

// ── Provider profiles (multi-service BYOK) ────────────────────────

export function listProfiles(): Profile[] {
  return load().settings.profiles;
}

export function getProfile(id: string): Profile | undefined {
  return load().settings.profiles.find((p) => p.id === id);
}

/** Resolve an agent's profile reference (id or name) to a concrete profile. */
export function resolveProfile(ref?: string): Profile | undefined {
  const s = load().settings;
  if (ref) {
    const found = s.profiles.find(
      (p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase(),
    );
    if (found) return found;
  }
  return s.profiles.find((p) => p.id === s.defaultProfileId) || s.profiles[0];
}

export function upsertProfile(
  p: Partial<Profile> & { name: string; provider: Provider },
): Profile {
  return mutate((s) => {
    const id = p.id && p.id.trim() ? p.id : uid("p_");
    const idx = s.settings.profiles.findIndex((x) => x.id === id);
    const prev = idx >= 0 ? s.settings.profiles[idx] : undefined;
    const merged: Profile = {
      id,
      name: p.name,
      provider: p.provider,
      apiKey: p.apiKey ?? prev?.apiKey ?? "",
      model: p.model ?? prev?.model ?? "",
      baseUrl: p.baseUrl ?? prev?.baseUrl ?? "",
      toolMode: p.toolMode ?? prev?.toolMode,
    };
    if (idx >= 0) s.settings.profiles[idx] = merged;
    else s.settings.profiles.push(merged);
    if (!s.settings.defaultProfileId) s.settings.defaultProfileId = merged.id;
    return merged;
  });
}

export function deleteProfile(id: string): boolean {
  return mutate((s) => {
    const before = s.settings.profiles.length;
    s.settings.profiles = s.settings.profiles.filter((p) => p.id !== id);
    if (s.settings.defaultProfileId === id) {
      s.settings.defaultProfileId = s.settings.profiles[0]?.id || "";
    }
    return s.settings.profiles.length < before;
  });
}

export function listChannels(): Channel[] {
  return load().channels;
}

export function listMessages(channelId?: string): Message[] {
  const all = load().messages;
  const msgs = channelId ? all.filter((m) => m.channelId === channelId) : all;
  return [...msgs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function addMessage(msg: Omit<Message, "id" | "createdAt">): Message {
  return mutate((s) => {
    const full: Message = { ...msg, id: uid("m_"), createdAt: new Date().toISOString() };
    s.messages.push(full);
    return full;
  });
}

export function listApprovals(status?: Approval["status"]): Approval[] {
  const all = load().approvals;
  const filtered = status ? all.filter((a) => a.status === status) : all;
  return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getApproval(id: string): Approval | undefined {
  return load().approvals.find((a) => a.id === id);
}

export function addApproval(
  a: Omit<Approval, "id" | "createdAt" | "status">,
): Approval {
  return mutate((s) => {
    const full: Approval = {
      ...a,
      id: uid("a_"),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    s.approvals.push(full);
    return full;
  });
}

export function updateApproval(id: string, patch: Partial<Approval>): Approval | undefined {
  return mutate((s) => {
    const idx = s.approvals.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    s.approvals[idx] = { ...s.approvals[idx], ...patch };
    return s.approvals[idx];
  });
}

export function listAudit(limit = 200): AuditEntry[] {
  const all = load().audit;
  return [...all].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export function addAudit(e: Omit<AuditEntry, "id" | "at">): AuditEntry {
  return mutate((s) => {
    const full: AuditEntry = { ...e, id: uid("au_"), at: new Date().toISOString() };
    s.audit.push(full);
    // Keep the log from growing without bound on disk.
    if (s.audit.length > 5000) s.audit = s.audit.slice(-5000);
    return full;
  });
}

export function listNotes(): Note[] {
  return [...load().notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addNote(title: string, content: string): Note {
  return mutate((s) => {
    const full: Note = { id: uid("n_"), title, content, createdAt: new Date().toISOString() };
    s.notes.push(full);
    return full;
  });
}

// ── Usage / cost meter ───────────────────────────────────

export function addUsage(u: Omit<UsageEntry, "id" | "at">): UsageEntry {
  return mutate((s) => {
    const full: UsageEntry = { ...u, id: uid("u_"), at: new Date().toISOString() };
    s.usage.push(full);
    if (s.usage.length > 10000) s.usage = s.usage.slice(-10000);
    return full;
  });
}

export function listUsage(limit = 2000): UsageEntry[] {
  const all = load().usage;
  return [...all].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
