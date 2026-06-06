// Core domain types shared across the app.

export type Provider = "openai" | "anthropic" | "gemini" | "openai-compatible";

/**
 * A named "Bring Your Own Key" connection to one AI service. Flapjack supports
 * any number of these at once, so different agents can run on different models
 * (mixture-of-models). Keys never leave the server.
 */
export interface Profile {
  id: string;
  name: string;
  provider: Provider;
  apiKey: string;
  model: string;
  baseUrl: string;
  /**
   * How this profile drives the agent loop:
   *   "native" (default) — use the provider's real tool-calling / function-calling API.
   *   "json"             — legacy fallback: ask the model to emit one JSON action per
   *                        step and parse it. Only for local/self-hosted models that
   *                        don't support tool calling (older Ollama / LM Studio).
   * Absent on existing stores → treated as "native".
   */
  toolMode?: "native" | "json";
}

/** Outbound + inbound chat platform wiring. */
export interface Connectors {
  /** Slack Incoming Webhook URL — agent updates are mirrored here. */
  slackWebhookUrl: string;
  /** Discord Webhook URL — agent updates are mirrored here. */
  discordWebhookUrl: string;
  /** Shared secret for the generic inbound endpoint. */
  inboundSecret: string;
  /** Slack signing secret, to verify inbound slash commands. */
  slackSigningSecret: string;
  /** Discord application public key, to verify inbound interactions. */
  discordPublicKey: string;
}

export interface Settings {
  /** All configured BYOK connections. */
  profiles: Profile[];
  /** Which profile agents use unless they specify their own. */
  defaultProfileId: string;
  company: string;
  /** Max reasoning/tool steps per agent run. */
  maxSteps: number;
  connectors: Connectors;
}

export type Autonomy = "suggest" | "approval" | "autonomous";

/** A parsed agent definition (from an agents/*.md file). */
export interface AgentDef {
  id: string; // slug derived from filename
  name: string;
  department: string;
  emoji: string;
  role: string;
  /** Optional per-agent model override (wins over the profile's model). */
  model?: string;
  /** Optional profile id/name this agent runs on (mixture-of-models). */
  profile?: string;
  /** Tool ids this agent is allowed to call. */
  tools: string[];
  /** suggest = never acts, approval = acts behind approval, autonomous = may act directly. */
  autonomy: Autonomy;
  /** Optional cron string, documented for external schedulers. */
  schedule?: string;
  /** Channel the agent posts to by default. */
  channel: string;
  /** System prompt body (markdown beneath the frontmatter). */
  systemPrompt: string;
}

export interface Channel {
  id: string;
  name: string;
  purpose: string;
}

export type MessageAuthorKind = "user" | "agent" | "system";

export interface Message {
  id: string;
  channelId: string;
  authorKind: MessageAuthorKind;
  authorId: string; // agent id, or "you", or "system"
  authorName: string;
  emoji?: string;
  text: string;
  createdAt: string; // ISO
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  agentId: string;
  agentName: string;
  emoji?: string;
  tool: string;
  action: string; // human-readable summary
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  result?: string;
}

export type AuditKind =
  | "agent_run_start"
  | "agent_run_end"
  | "llm_call"
  | "tool_call"
  | "message"
  | "approval_requested"
  | "approval_decided"
  | "error";

export interface AuditEntry {
  id: string;
  at: string; // ISO
  kind: AuditKind;
  agentId?: string;
  agentName?: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

/** One LLM call's token usage + estimated cost, for the cost meter. */
export interface UsageEntry {
  id: string;
  at: string; // ISO
  agentId?: string;
  agentName?: string;
  profileId: string;
  provider: Provider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** True when token counts were estimated (provider returned none). */
  estimated: boolean;
}

/** Everything persisted to disk. */
export interface Store {
  settings: Settings;
  channels: Channel[];
  messages: Message[];
  approvals: Approval[];
  audit: AuditEntry[];
  notes: Note[];
  usage: UsageEntry[];
}
