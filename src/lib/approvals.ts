import { getApproval, updateApproval, addAudit, addMessage, getSettings } from "./db";
import { getAgent } from "./agents";
import { getTool } from "./tools";
import { mirrorToChat } from "./connectors";
import type { Approval } from "./types";

/** Approve a pending request and run the gated tool's real effect. */
export async function approve(id: string): Promise<Approval | { error: string }> {
  const approval = getApproval(id);
  if (!approval) return { error: "Approval not found" };
  if (approval.status !== "pending") return { error: `Already ${approval.status}` };

  const tool = getTool(approval.tool);
  const agent = getAgent(approval.agentId);
  const settings = getSettings();

  let result = "Approved.";
  try {
    if (tool?.effect && agent) {
      result = await tool.effect(approval.payload, { agent, settings });
    }
  } catch (err) {
    result = `Effect failed: ${String(err)}`;
  }

  const updated = updateApproval(id, {
    status: "approved",
    decidedAt: new Date().toISOString(),
    result,
  })!;

  addAudit({
    kind: "approval_decided",
    agentId: approval.agentId,
    agentName: approval.agentName,
    summary: `Approved: ${approval.action}`,
    detail: { approvalId: id, result },
  });

  addMessage({
    channelId: agent?.channel || "general",
    authorKind: "system",
    authorId: "system",
    authorName: "Flapjack",
    emoji: "✅",
    text: `Approved **${approval.action}** (${approval.agentName}). ${result}`,
  });
  await mirrorToChat({
    channel: agent?.channel || "general",
    author: "Flapjack",
    emoji: "✅",
    text: `Approved ${approval.action} (${approval.agentName}). ${result}`,
  });

  return updated;
}

/** Reject a pending request; nothing is executed. */
export function reject(id: string): Approval | { error: string } {
  const approval = getApproval(id);
  if (!approval) return { error: "Approval not found" };
  if (approval.status !== "pending") return { error: `Already ${approval.status}` };

  const agent = getAgent(approval.agentId);
  const updated = updateApproval(id, {
    status: "rejected",
    decidedAt: new Date().toISOString(),
    result: "Rejected by human.",
  })!;

  addAudit({
    kind: "approval_decided",
    agentId: approval.agentId,
    agentName: approval.agentName,
    summary: `Rejected: ${approval.action}`,
    detail: { approvalId: id },
  });

  addMessage({
    channelId: agent?.channel || "general",
    authorKind: "system",
    authorId: "system",
    authorName: "Flapjack",
    emoji: "🚫",
    text: `Rejected **${approval.action}** (${approval.agentName}).`,
  });

  return updated;
}
