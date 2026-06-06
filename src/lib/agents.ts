import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { AgentDef, Autonomy } from "./types";

const AGENTS_DIR = path.join(process.cwd(), "agents");
const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Load and parse every agent markdown file. */
export function loadAgents(): AgentDef[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const agents: AgentDef[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
      const { data, content } = matter(raw);
      const id = slug(String(data.id || path.basename(file, ".md")));
      const name = String(data.name || id);
      const autonomy: Autonomy = ["suggest", "approval", "autonomous"].includes(
        String(data.autonomy),
      )
        ? (String(data.autonomy) as Autonomy)
        : "approval";

      agents.push({
        id,
        name,
        department: String(data.department || "General"),
        emoji: String(data.emoji || "🤖"),
        role: String(data.role || ""),
        model: data.model ? String(data.model) : undefined,
        profile: data.profile ? String(data.profile) : undefined,
        tools: asStringArray(data.tools),
        autonomy,
        schedule: data.schedule ? String(data.schedule) : undefined,
        channel: slug(String(data.channel || "general")),
        systemPrompt: content.trim(),
      });
    } catch (err) {
      console.error(`[flapjack] failed to parse agent ${file}:`, err);
    }
  }
  return agents.sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
}

export function getAgent(id: string): AgentDef | undefined {
  return loadAgents().find((a) => a.id === id);
}

/** Read all knowledge/*.md files as a single context block. */
export function loadKnowledge(): string {
  let files: string[] = [];
  try {
    files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8");
      parts.push(`# Source: ${file}\n${raw.trim()}`);
    } catch {
      /* ignore */
    }
  }
  return parts.join("\n\n---\n\n");
}
