import type { AgentDef, Profile, Settings } from "./types";
import {
  complete,
  type ChatMessage,
  type CompletionResult,
  type ToolCall,
  LLMError,
} from "./llm";
import { getAgent, loadKnowledge } from "./agents";
import { schemasFor, getTool, validateToolArgs } from "./tools";
import { estimateCost } from "./pricing";
import { mirrorToChat } from "./connectors";
import {
  addApproval,
  addAudit,
  addMessage,
  addUsage,
  getSettings,
  listMessages,
  resolveProfile,
} from "./db";

export interface RunResult {
  ok: boolean;
  agentId: string;
  steps: number;
  summary?: string;
  error?: string;
}

/** Live events emitted during a run, for terminal streaming and chat mirroring. */
export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "text"; delta: string }
  | { type: "tool_call"; tool: string; args: Record<string, any>; observation: string }
  | { type: "approval"; tool: string; summary: string; approvalId: string }
  | { type: "finish"; summary: string; steps: number }
  | { type: "error"; message: string };

export interface RunOptions {
  trigger?: string;
  channel?: string;
  /** Optional sink for live progress (CLI prints deltas; serve mirrors steps). */
  onEvent?: (e: AgentEvent) => void;
  /** Internal: current delegation depth (callers leave unset). */
  _depth?: number;
  /** Internal: ids of agents already in this delegation chain (loop guard). */
  _chain?: string[];
}

/** Max nested delegations before we refuse, to bound runaway delegation. */
export const MAX_DELEGATION_DEPTH = 3;

/**
 * Decide whether `currentId` may delegate to `targetId` given the chain of
 * ancestors and the current depth. Returns an error string, or null if allowed.
 * Prevents self-delegation, cycles (A→B→A), and unbounded depth.
 */
export function delegationError(
  currentId: string,
  targetId: string,
  chain: string[],
  depth: number,
): string | null {
  if (depth >= MAX_DELEGATION_DEPTH) return `delegation depth limit (${MAX_DELEGATION_DEPTH}) reached`;
  if (!targetId) return "no target agent specified";
  if (targetId === currentId) return "cannot delegate to yourself";
  if (chain.includes(targetId)) return `delegation cycle blocked (${[...chain, targetId].join(" → ")})`;
  return null;
}

function buildSystemPrompt(agent: AgentDef, company: string): string {
  return [
    `You are ${agent.name} ${agent.emoji}, the ${agent.role || agent.name} in the ${agent.department} department at ${company}.`,
    "",
    "## Your charter",
    agent.systemPrompt,
    "",
    "## How you operate",
    "You work in discrete steps. Use the tools provided to take real action — call a tool whenever it moves the task forward.",
    "When the task is done, STOP calling tools and reply in plain text with a concise, skimmable update (1-4 sentences). That plain-text reply is your final report to the team.",
    "",
    "## Rules",
    `- Your autonomy level is "${agent.autonomy}".`,
    "  - suggest: never call a tool that requires approval; only research, post messages, and recommend next steps.",
    "  - approval / autonomous: you may call approval-gated tools, but they are queued for a human and do NOT run until approved.",
    "- Tools that require approval have real-world side effects. Never claim you completed one — say you requested approval.",
    "- Be concrete and specific. Use the real context provided. No filler.",
    "- Take the fewest steps possible. Stop as soon as the task is done; never repeat a message you've already posted.",
  ].join("\n");
}

/**
 * Rough char budget for shared knowledge injected into every run (~3k tokens at
 * ~4 chars/token). Stops an ever-growing knowledge/ folder from inflating the
 * cost and latency of every step. Oldest content beyond the budget is dropped.
 */
const MAX_KNOWLEDGE_CHARS = 12000;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "\n\n…(knowledge truncated to fit the context budget)";
}

function buildContext(agent: AgentDef, trigger: string, channel: string): string {
  const knowledge = clip(loadKnowledge(), MAX_KNOWLEDGE_CHARS);
  const recent = listMessages(channel).slice(-15);
  const history = recent.length
    ? recent.map((m) => `${m.emoji ?? ""} ${m.authorName}: ${m.text}`).join("\n")
    : "(channel is empty)";
  return [
    knowledge ? `## Company context\n${knowledge}` : "",
    `## Recent activity in #${channel}\n${history}`,
    `## Your task right now\n${trigger}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const DEFAULT_TRIGGER =
  "Take one useful action for the business based on your charter and the current context, then post a short update to your channel.";

/** Build a tool-result turn the model will see on the next step. */
function toolResult(call: ToolCall, content: string): ChatMessage {
  return { role: "tool", toolCallId: call.id, name: call.name, content };
}

export async function runAgent(agentId: string, opts: RunOptions = {}): Promise<RunResult> {
  const agent = getAgent(agentId);
  if (!agent) return { ok: false, agentId, steps: 0, error: "Agent not found" };

  // The agent replies in the channel it was triggered from (if given),
  // otherwise its own home channel.
  const channel = opts.channel?.trim() || agent.channel;
  const emit = opts.onEvent;

  const settings = getSettings();
  const profile = resolveProfile(agent.profile);
  if (!profile) {
    const msg =
      "No model profile configured. Add one with: flapjack profile add --name Default --provider openai --model gpt-4o-mini --key <your-key>";
    addAudit({ kind: "error", agentId: agent.id, agentName: agent.name, summary: msg });
    addMessage({
      channelId: channel,
      authorKind: "system",
      authorId: "system",
      authorName: "Flapjack",
      emoji: "⚠️",
      text: `${agent.name} could not run: ${msg}`,
    });
    emit?.({ type: "error", message: msg });
    return { ok: false, agentId: agent.id, steps: 0, error: msg };
  }
  const trigger = opts.trigger?.trim() || DEFAULT_TRIGGER;

  addAudit({
    kind: "agent_run_start",
    agentId: agent.id,
    agentName: agent.name,
    summary: `${agent.name} started a run on ${profile.name} (${profile.provider})`,
    detail: { trigger, profile: profile.name, model: agent.model || profile.model },
  });

  // Only schemas for tools this agent is actually allowed to call.
  const schemas = schemasFor(agent.tools);

  const convo: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(agent, settings.company) },
    { role: "user", content: buildContext(agent, trigger, channel) },
  ];

  let lastText = "";

  for (let step = 1; step <= settings.maxSteps; step++) {
    emit?.({ type: "step", step });
    const lastStep = step === settings.maxSteps;

    let res: CompletionResult;
    try {
      res = await complete(convo, profile, {
        model: agent.model,
        tools: schemas,
        // On the final step, withhold tools so the model must produce a
        // plain-text wrap-up — no extra LLM call needed.
        toolChoice: lastStep ? "none" : "auto",
        stream: !!emit,
        onText: emit ? (delta) => emit({ type: "text", delta }) : undefined,
      });
      recordUsage(agent, profile, res);
    } catch (err) {
      const msg = err instanceof LLMError ? err.message : String(err);
      addAudit({ kind: "error", agentId: agent.id, agentName: agent.name, summary: msg });
      addMessage({
        channelId: channel,
        authorKind: "system",
        authorId: "system",
        authorName: "Flapjack",
        emoji: "⚠️",
        text: `${agent.name} could not run: ${msg}`,
      });
      emit?.({ type: "error", message: msg });
      return { ok: false, agentId: agent.id, steps: step - 1, error: msg };
    }

    if (res.text) lastText = res.text;

    // Record the assistant's turn (text + any tool calls) for the next round.
    convo.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    // No tool calls → the model is answering. That plain text is the finish.
    if (res.toolCalls.length === 0) {
      return await finish(agent, channel, step, res.text, emit);
    }

    // Otherwise, run each requested tool (or queue/deny it) and feed results back.
    for (const call of res.toolCalls) {
      const tool = getTool(call.name);
      if (!tool || !agent.tools.includes(call.name)) {
        convo.push(
          toolResult(call, `"${call.name}" is not a tool you can use. Available: ${agent.tools.join(", ") || "(none)"}.`),
        );
        continue;
      }

      // Validate args BEFORE running or queueing — a malformed gated payload
      // must never reach the approval queue.
      const argErr = validateToolArgs(tool, call.arguments);
      if (argErr) {
        convo.push(
          toolResult(call, `Invalid arguments for ${call.name}: ${argErr}. Fix the arguments and call it again, or finish.`),
        );
        continue;
      }

      // Delegation: hand the subtask to another agent (loop-guarded). Not a
      // registry run/effect — intercepted here.
      if (tool.delegate) {
        const depth = opts._depth ?? 0;
        const chain = opts._chain ?? [];
        const targetId = String(call.arguments.agent ?? "").trim();
        const subTask = String(call.arguments.task ?? "").trim();
        const errd = delegationError(agent.id, targetId, chain, depth);
        if (errd) {
          convo.push(toolResult(call, `Delegation refused: ${errd}. Do it yourself or finish.`));
          continue;
        }
        const target = getAgent(targetId);
        if (!target) {
          convo.push(toolResult(call, `No agent "${targetId}". Use a valid agent id, or finish.`));
          continue;
        }
        emit?.({ type: "tool_call", tool: "delegate", args: { agent: targetId, task: subTask }, observation: `delegating to ${target.name}` });
        const sub = await runAgent(targetId, {
          trigger: subTask || undefined,
          channel,
          onEvent: emit,
          _depth: depth + 1,
          _chain: [...chain, agent.id],
        });
        convo.push(
          toolResult(
            call,
            sub.ok
              ? `${target.name} replied: ${sub.summary ?? "(no summary)"}`
              : `${target.name} could not complete it: ${sub.error ?? "failed"}`,
          ),
        );
        continue;
      }

      // Gated tools never execute here — they create an approval request.
      if (tool.gated) {
        if (agent.autonomy === "suggest") {
          convo.push(
            toolResult(call, `Your autonomy is "suggest" — you may not call ${call.name}. Recommend it to a human instead, then finish.`),
          );
          continue;
        }
        const summaryText = tool.summarize ? tool.summarize(call.arguments) : `${tool.id} action`;
        const approval = addApproval({
          agentId: agent.id,
          agentName: agent.name,
          emoji: agent.emoji,
          tool: tool.id,
          action: summaryText,
          payload: call.arguments,
        });
        addAudit({
          kind: "approval_requested",
          agentId: agent.id,
          agentName: agent.name,
          summary: `Requested approval: ${summaryText}`,
          detail: { approvalId: approval.id, tool: tool.id, args: call.arguments },
        });
        addMessage({
          channelId: channel,
          authorKind: "agent",
          authorId: agent.id,
          authorName: agent.name,
          emoji: agent.emoji,
          text: `🔐 Requesting approval to **${summaryText}**. Waiting on a human in the Approvals queue.`,
        });
        void mirrorToChat({
          channel,
          author: agent.name,
          emoji: agent.emoji,
          text: `🔐 Requesting approval to ${summaryText}. Awaiting a human.`,
        });
        emit?.({ type: "approval", tool: tool.id, summary: summaryText, approvalId: approval.id });
        convo.push(
          toolResult(call, `Approval requested (id ${approval.id}) for "${summaryText}". It will only run once a human approves. Do not retry it. Finish with a short status.`),
        );
        continue;
      }

      // Non-gated tool: run it now.
      try {
        const observation = tool.run ? await tool.run(call.arguments, { agent, settings }) : "ok";
        addAudit({
          kind: "tool_call",
          agentId: agent.id,
          agentName: agent.name,
          summary: `${agent.name} used ${tool.id}`,
          detail: { args: call.arguments, observation },
        });
        emit?.({ type: "tool_call", tool: tool.id, args: call.arguments, observation });
        convo.push(toolResult(call, observation));
      } catch (err) {
        convo.push(toolResult(call, `tool error: ${String(err)}`));
      }
    }
  }

  // Defensive: the final step withholds tools, so we normally finish above.
  return await finish(agent, channel, settings.maxSteps, lastText || "Reached the step limit.", emit);
}

/** Record token usage + estimated cost for one LLM call. */
function recordUsage(agent: AgentDef, profile: Profile, res: CompletionResult): void {
  const cost = estimateCost(
    profile.provider,
    res.model,
    res.usage.promptTokens,
    res.usage.completionTokens,
  );
  addUsage({
    agentId: agent.id,
    agentName: agent.name,
    profileId: profile.id,
    provider: profile.provider,
    model: res.model,
    promptTokens: res.usage.promptTokens,
    completionTokens: res.usage.completionTokens,
    costUsd: cost,
    estimated: res.usage.estimated,
  });
  addAudit({
    kind: "llm_call",
    agentId: agent.id,
    agentName: agent.name,
    summary: `${agent.name} → ${res.model}: ${res.usage.promptTokens}+${res.usage.completionTokens} tok ($${cost.toFixed(
      4,
    )})`,
    detail: { provider: profile.provider, model: res.model, usage: res.usage, costUsd: cost },
  });
}

async function finish(
  agent: AgentDef,
  channel: string,
  steps: number,
  rawSummary: string,
  emit?: (e: AgentEvent) => void,
): Promise<RunResult> {
  const summary = rawSummary.trim() || "Done.";
  // Don't post a duplicate of the agent's most recent message.
  const recent = listMessages(channel).slice(-1)[0];
  const isDup = recent && recent.authorId === agent.id && recent.text.trim() === summary;
  if (!isDup) {
    addMessage({
      channelId: channel,
      authorKind: "agent",
      authorId: agent.id,
      authorName: agent.name,
      emoji: agent.emoji,
      text: summary,
    });
    await mirrorToChat({
      channel, // mirror to the channel this run actually used, not always the agent's home
      author: agent.name,
      emoji: agent.emoji,
      text: summary,
    });
  }
  addAudit({
    kind: "agent_run_end",
    agentId: agent.id,
    agentName: agent.name,
    summary: `${agent.name} finished`,
    detail: { steps, summary },
  });
  emit?.({ type: "finish", summary, steps });
  return { ok: true, agentId: agent.id, steps, summary };
}
