import { loadAgents } from "./agents";
import { runAgent, type AgentEvent } from "./orchestrator";
import { addMessage } from "./db";

export interface InboundCommand {
  agentId: string;
  task: string;
}

/**
 * Parse free-form text like "ad-manager draft a LinkedIn ad" into an agent +
 * task. If the first word names an agent, it's used; otherwise we fall back to
 * the Chief of Staff (or the first agent) and treat the whole text as the task.
 */
export function parseCommand(text: string): InboundCommand {
  const trimmed = (text || "").trim();
  const agents = loadAgents();
  if (!agents.length) return { agentId: "", task: trimmed };

  const [first, ...rest] = trimmed.split(/\s+/);
  const match = agents.find((a) => a.id === (first || "").toLowerCase());
  if (match) return { agentId: match.id, task: rest.join(" ").trim() };

  const fallback = agents.find((a) => a.id === "chief-of-staff") || agents[0];
  return { agentId: fallback.id, task: trimmed };
}

/**
 * Run an inbound chat command and return a short result for the platform.
 * `onEvent` is an optional live-progress sink (e.g. for posting interim Slack
 * updates); omit it for the current ack-then-final-summary behavior.
 */
export async function runInbound(
  text: string,
  source: string,
  onEvent?: (e: AgentEvent) => void,
): Promise<{ agentId: string; summary: string }> {
  const { agentId, task } = parseCommand(text);
  if (!agentId) return { agentId: "", summary: "No agents are configured in Flapjack yet." };

  const agent = loadAgents().find((a) => a.id === agentId)!;
  addMessage({
    channelId: agent.channel,
    authorKind: "user",
    authorId: "you",
    authorName: `You (via ${source})`,
    emoji: "💬",
    text: task || "(run)",
  });

  const res = await runAgent(agentId, { trigger: task || undefined, onEvent });
  return { agentId, summary: res.summary || res.error || "Done." };
}
