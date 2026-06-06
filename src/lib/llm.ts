import type { Profile } from "./types";

// ── Neutral, tool-aware transcript ──────────────────────────────
// The orchestrator speaks only this shape. Each provider builder below
// translates it to/from that provider's wire format.

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** A JSON-Schema object describing a tool's arguments. */
export type JSONSchemaObject = {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
};

/** Provider-neutral description of a callable tool. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchemaObject;
}

/** One tool invocation the model asked for. */
export interface ToolCall {
  /** Provider call id, used to correlate the result. Synthesized for Gemini. */
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** True when the provider didn't report usage and we estimated it. */
  estimated: boolean;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

export interface CompletionResult {
  /** Assistant prose for this turn. May be "" when the turn is only tool calls. */
  text: string;
  /** Tools the model wants to run. Empty array means "the model is answering". */
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: TokenUsage;
  model: string;
  raw?: unknown;
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  /** Tool schemas the model may call. Omit/empty for a plain completion. */
  tools?: ToolSchema[];
  /**
   * "auto" (default when tools present) — model may call tools or answer.
   * "none" — tools are withheld this turn, forcing a plain-text answer.
   *          Used on the final step so finishing never needs an extra call.
   */
  toolChoice?: "auto" | "none";
  /** When true and onText is given, stream text deltas as they arrive. */
  stream?: boolean;
  /** Called with each text delta during streaming. */
  onText?: (delta: string) => void;
}

export class LLMError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LLMError";
  }
}

function baseUrlFor(profile: Profile): string {
  if (profile.baseUrl) return profile.baseUrl.replace(/\/$/, "");
  switch (profile.provider) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "openai":
    case "openai-compatible":
    default:
      return "https://api.openai.com/v1";
  }
}

/** ~4 chars per token is a decent rough estimate when usage isn't reported. */
function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

function estimateUsage(messages: ChatMessage[], completion: string): TokenUsage {
  const prompt = messages
    .map((m) => ("content" in m ? m.content : ""))
    .join("\n");
  return {
    promptTokens: estimateTokens(prompt),
    completionTokens: estimateTokens(completion),
    estimated: true,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function safeJsonParse(s: string | undefined): Record<string, any> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Monotonic ids for providers (Gemini) that don't return tool-call ids. */
let synthCounter = 0;
function synthId(): string {
  return `call_${(synthCounter++).toString(36)}_${Date.now().toString(36)}`;
}

/** fetch with an abort timeout so a hung provider can't block an agent forever. */
async function fetchWithTimeout(url: string, init: RequestInit, ms = 90000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new LLMError(`Request timed out after ${Math.round(ms / 1000)}s`);
    }
    throw new LLMError(`Network error reaching the provider: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Retry with bounded exponential backoff + jitter ─────────────
// Transient failures (429, 5xx, network/timeout) are retried; deterministic
// user/config errors (4xx like 401 bad key, 400 malformed) are NOT.
const RETRY_ATTEMPTS = Math.max(1, Number(process.env.FLAPJACK_RETRY_ATTEMPTS) || 4);
const RETRY_BASE_MS = Number(process.env.FLAPJACK_RETRY_BASE_MS) || 500;
const RETRY_CAP_MS = Number(process.env.FLAPJACK_RETRY_CAP_MS) || 8000;

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Full-jitter backoff; honors a numeric Retry-After (seconds) as a floor. */
function backoffDelay(attempt: number, retryAfter?: string | null): number {
  const ceil = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  let delay = Math.random() * ceil;
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra)) delay = Math.max(delay, ra * 1000);
  return delay;
}

/**
 * fetch that retries transient failures and resolves only to an ok Response;
 * otherwise throws an LLMError. Non-retryable (4xx) failures throw immediately
 * with the provider's error body.
 */
async function fetchOk(url: string, init: RequestInit, timeoutMs = 90000): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, init, timeoutMs);
    } catch (err) {
      // Network error / timeout — transient.
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw err instanceof LLMError ? err : new LLMError(String(err));
    }
    if (res.ok) return res;
    if (isRetryableStatus(res.status) && attempt < RETRY_ATTEMPTS) {
      const ra = res.headers.get("retry-after");
      try {
        await res.text(); // drain body so the socket can be reused
      } catch {
        /* ignore */
      }
      await sleep(backoffDelay(attempt, ra));
      continue;
    }
    throw new LLMError(`Provider error ${res.status}: ${truncate(await res.text(), 500)}`, res.status);
  }
  throw lastErr instanceof LLMError ? lastErr : new LLMError("Request failed after retries");
}

/**
 * Read a Server-Sent-Events response, invoking `cb` once per event block.
 * Handles both single-line (OpenAI/Gemini) and `event:`-prefixed (Anthropic) SSE.
 */
async function eachSSEEvent(
  res: Response,
  cb: (e: { event?: string; data: string }) => void,
): Promise<void> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) cb({ event, data: dataLines.join("\n") });
    }
  }
}

function mapFinish(reason: string | undefined | null, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return "tool_calls";
  switch (reason) {
    case "stop":
    case "end_turn":
    case "STOP":
      return "stop";
    case "length":
    case "max_tokens":
    case "MAX_TOKENS":
      return "length";
    case "tool_calls":
    case "tool_use":
      return "tool_calls";
    default:
      return "other";
  }
}

/**
 * Provider-agnostic completion. With `opts.tools` the model can call tools via
 * the provider's native tool/function-calling API; the returned `toolCalls`
 * drive the agent loop. The only secret used is the profile's own API key (BYOK).
 */
export async function complete(
  messages: ChatMessage[],
  profile: Profile,
  opts: CompleteOptions = {},
): Promise<CompletionResult> {
  if (!profile.apiKey && profile.provider !== "openai-compatible") {
    throw new LLMError(
      `Profile "${profile.name}" has no API key. Add one with: flapjack profile add --name ${profile.name} --provider ${profile.provider} --model ${profile.model} --key <your-key>`,
    );
  }
  const model = opts.model || profile.model;

  // Opt-in legacy path for local models without tool-calling support.
  if ((profile.toolMode ?? "native") === "json") {
    return completeJsonMode(messages, profile, model, opts);
  }

  switch (profile.provider) {
    case "anthropic":
      return completeAnthropic(messages, profile, model, opts);
    case "gemini":
      return completeGemini(messages, profile, model, opts);
    default:
      return completeOpenAICompatible(messages, profile, model, opts);
  }
}

// ── OpenAI / OpenAI-compatible ──────────────────────────────────

function toOpenAIMessages(messages: ChatMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant") {
      const msg: any = { role: "assistant", content: m.content || "" };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        }));
        if (!m.content) msg.content = null; // OpenAI: null content allowed alongside tool_calls
      }
      return msg;
    }
    return { role: m.role, content: m.content };
  });
}

function openAIToolsField(opts: CompleteOptions): {
  tools?: any[];
  tool_choice?: string;
} {
  // toolChoice "none" → withhold tools entirely, forcing a text answer.
  if (opts.toolChoice === "none" || !opts.tools?.length) return {};
  return {
    tools: opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: "auto",
  };
}

async function completeOpenAICompatible(
  messages: ChatMessage[],
  profile: Profile,
  model: string,
  opts: CompleteOptions,
): Promise<CompletionResult> {
  const url = `${baseUrlFor(profile)}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Local servers (e.g. Ollama) accept any/empty key; cloud needs a real one.
  if (profile.apiKey) headers["Authorization"] = `Bearer ${profile.apiKey}`;

  const streaming = !!(opts.stream && opts.onText);
  const body: any = {
    model,
    messages: toOpenAIMessages(messages),
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1200,
    ...openAIToolsField(opts),
  };
  if (streaming) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  const res = await fetchOk(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    streaming ? 600000 : 90000,
  );

  if (streaming) {
    const acc: string[] = [];
    const toolAcc: Record<number, { id?: string; name?: string; args: string }> = {};
    let finish: string | undefined;
    let rawUsage: any;
    await eachSSEEvent(res, ({ data }) => {
      if (data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      if (json.usage) rawUsage = json.usage;
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) {
        acc.push(delta.content);
        opts.onText?.(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          const slot = (toolAcc[i] ??= { args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    });
    const text = acc.join("");
    const toolCalls: ToolCall[] = Object.values(toolAcc)
      .filter((s) => s.name)
      .map((s) => ({ id: s.id || synthId(), name: s.name!, arguments: safeJsonParse(s.args) }));
    const usage: TokenUsage = rawUsage
      ? {
          promptTokens: rawUsage.prompt_tokens ?? 0,
          completionTokens: rawUsage.completion_tokens ?? 0,
          estimated: false,
        }
      : estimateUsage(messages, text);
    return { text, toolCalls, finishReason: mapFinish(finish, toolCalls.length > 0), usage, model };
  }

  const data = (await res.json()) as any;
  const msg = data?.choices?.[0]?.message;
  const text: string = msg?.content ?? "";
  const toolCalls: ToolCall[] = Array.isArray(msg?.tool_calls)
    ? msg.tool_calls.map((tc: any) => ({
        id: tc.id || synthId(),
        name: tc.function?.name ?? "",
        arguments: safeJsonParse(tc.function?.arguments),
      }))
    : [];
  const u = data?.usage;
  const usage: TokenUsage = u
    ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, estimated: false }
    : estimateUsage(messages, text);
  return {
    text,
    toolCalls,
    finishReason: mapFinish(data?.choices?.[0]?.finish_reason, toolCalls.length > 0),
    usage,
    model,
    raw: data,
  };
}

// ── Anthropic ───────────────────────────────────────────────────

function splitSystem(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
}

/**
 * Anthropic system field. Sent as a cache_control block so the (large, reused)
 * system prompt — charter + shared knowledge, resent on every step — is served
 * from Anthropic's prompt cache. Safe by default: caching is GA and silently
 * no-ops below the model's minimum cacheable size.
 */
function anthropicSystem(messages: ChatMessage[]): any {
  const sys = splitSystem(messages);
  if (!sys) return undefined;
  return [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }];
}

/**
 * Anthropic requires strictly alternating user/assistant turns, with all
 * tool_result blocks for a turn grouped into a single user message. We coalesce
 * consecutive tool-role messages (and any adjacent user text) accordingly.
 */
function toAnthropicMessages(messages: ChatMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant") {
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? [])
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
      continue;
    }
    // plain user text
    out.push({ role: "user", content: m.content });
  }
  return out;
}

async function completeAnthropic(
  messages: ChatMessage[],
  profile: Profile,
  model: string,
  opts: CompleteOptions,
): Promise<CompletionResult> {
  const url = `${baseUrlFor(profile)}/v1/messages`;
  const streaming = !!(opts.stream && opts.onText);
  const body: any = {
    model,
    system: anthropicSystem(messages),
    messages: toAnthropicMessages(messages),
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1200,
  };
  // toolChoice "none" → withhold tools, forcing a text answer.
  if (opts.toolChoice !== "none" && opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (streaming) body.stream = true;

  const res = await fetchOk(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": profile.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    },
    streaming ? 600000 : 90000,
  );

  if (streaming) {
    const blocks: Record<number, { type: string; text?: string; id?: string; name?: string; json?: string }> = {};
    let inputTok = 0;
    let outputTok = 0;
    let stopReason: string | undefined;
    await eachSSEEvent(res, ({ event, data }) => {
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      switch (event) {
        case "message_start":
          inputTok = json.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start": {
          const cb = json.content_block;
          blocks[json.index] = {
            type: cb.type,
            text: cb.type === "text" ? "" : undefined,
            id: cb.id,
            name: cb.name,
            json: cb.type === "tool_use" ? "" : undefined,
          };
          break;
        }
        case "content_block_delta": {
          const b = blocks[json.index];
          if (!b) break;
          const d = json.delta;
          if (d.type === "text_delta") {
            b.text = (b.text ?? "") + d.text;
            opts.onText?.(d.text);
          } else if (d.type === "input_json_delta") {
            b.json = (b.json ?? "") + d.partial_json;
          }
          break;
        }
        case "message_delta":
          outputTok = json.usage?.output_tokens ?? outputTok;
          stopReason = json.delta?.stop_reason ?? stopReason;
          break;
      }
    });
    const ordered = Object.keys(blocks)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => blocks[i]);
    const text = ordered.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const toolCalls: ToolCall[] = ordered
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id || synthId(), name: b.name ?? "", arguments: b.json ? safeJsonParse(b.json) : {} }));
    const usage: TokenUsage =
      inputTok || outputTok
        ? { promptTokens: inputTok, completionTokens: outputTok, estimated: false }
        : estimateUsage(messages, text);
    return { text, toolCalls, finishReason: mapFinish(stopReason, toolCalls.length > 0), usage, model };
  }

  const data = (await res.json()) as any;
  const content: any[] = Array.isArray(data?.content) ? data.content : [];
  const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const toolCalls: ToolCall[] = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id || synthId(), name: b.name ?? "", arguments: b.input ?? {} }));
  const u = data?.usage;
  const usage: TokenUsage = u
    ? { promptTokens: u.input_tokens ?? 0, completionTokens: u.output_tokens ?? 0, estimated: false }
    : estimateUsage(messages, text);
  return {
    text,
    toolCalls,
    finishReason: mapFinish(data?.stop_reason, toolCalls.length > 0),
    usage,
    model,
    raw: data,
  };
}

// ── Google Gemini ───────────────────────────────────────────────

/** Convert a JSON Schema to Gemini's OpenAPI-subset (uppercase type names). */
function toGeminiSchema(s: any): any {
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v as Record<string, any>)) out.properties[pk] = toGeminiSchema(pv);
    } else out[k] = v;
  }
  return out;
}

function geminiFunctionDeclarations(tools: ToolSchema[]): any[] {
  return tools.map((t) => {
    const hasProps = Object.keys(t.parameters.properties || {}).length > 0;
    return {
      name: t.name,
      description: t.description,
      ...(hasProps ? { parameters: toGeminiSchema(t.parameters) } : {}),
    };
  });
}

/** Build Gemini `contents`, coalescing consecutive tool results into one user turn. */
function toGeminiContents(messages: ChatMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const part = { functionResponse: { name: m.name, response: { result: m.content } } };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last._fnResp) last.parts.push(part);
      else out.push({ role: "user", parts: [part], _fnResp: true });
      continue;
    }
    if (m.role === "assistant") {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.arguments ?? {} } });
      out.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    out.push({ role: "user", parts: [{ text: m.content }] });
  }
  // strip internal marker
  for (const c of out) delete c._fnResp;
  return out;
}

async function completeGemini(
  messages: ChatMessage[],
  profile: Profile,
  model: string,
  opts: CompleteOptions,
): Promise<CompletionResult> {
  // Gemini uses non-streaming here; tool-call streaming is not worth the
  // partial-JSON reassembly in Phase 1. Non-stream keeps it correct.
  // Key goes in the x-goog-api-key header, NOT the URL query string, so it
  // can't leak into proxy/CDN/access logs.
  const url = `${baseUrlFor(profile)}/models/${encodeURIComponent(model)}:generateContent`;
  const body: any = {
    systemInstruction: (() => {
      const sys = splitSystem(messages);
      return sys ? { parts: [{ text: sys }] } : undefined;
    })(),
    contents: toGeminiContents(messages),
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: opts.maxTokens ?? 1200,
    },
  };
  if (opts.toolChoice !== "none" && opts.tools?.length) {
    body.tools = [{ functionDeclarations: geminiFunctionDeclarations(opts.tools) }];
  }

  const res = await fetchOk(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": profile.apiKey },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("");
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ id: synthId(), name: p.functionCall.name, arguments: p.functionCall.args ?? {} }));
  const u = data?.usageMetadata;
  const usage: TokenUsage = u
    ? { promptTokens: u.promptTokenCount ?? 0, completionTokens: u.candidatesTokenCount ?? 0, estimated: false }
    : estimateUsage(messages, text);
  return {
    text,
    toolCalls,
    finishReason: mapFinish(data?.candidates?.[0]?.finishReason, toolCalls.length > 0),
    usage,
    model,
    raw: data,
  };
}

// ── Legacy JSON fallback (profile.toolMode === "json") ──────────
// For local/self-hosted models without tool calling. We inject a JSON protocol
// into the prompt, flatten the transcript to plain text, ask for one JSON action
// (or plain-text answer), and parse it back into the same CompletionResult shape
// so the orchestrator loop is identical to the native path.

function buildJsonInstruction(tools: ToolSchema[]): string {
  const lines = tools.map((t) => {
    const args = Object.keys(t.parameters.properties || {}).join(", ") || "(none)";
    return `- ${t.name}: ${t.description}  args: ${args}`;
  });
  return [
    "You can use tools. To call ONE tool, reply with ONLY a JSON object:",
    '{"action":"<tool name>","args":{ ... }}',
    "When the task is complete, reply in PLAIN TEXT (no JSON) with a short summary.",
    "Available tools:",
    lines.join("\n") || "(none — just answer in plain text)",
  ].join("\n");
}

/** Flatten the tool-aware transcript to plain text turns for a non-tool model. */
function toTextMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (m.role === "tool") return { role: "user", content: `Observation from ${m.name}: ${m.content}` };
    if (m.role === "assistant") {
      if (m.toolCalls?.length && !m.content) {
        const tc = m.toolCalls[0];
        return { role: "assistant", content: JSON.stringify({ action: tc.name, args: tc.arguments }) };
      }
      return { role: "assistant", content: m.content };
    }
    return m;
  });
}

/** Pull the first balanced JSON object out of a model response. */
function extractJson(text: string): any | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").trim();
}

async function completeJsonMode(
  messages: ChatMessage[],
  profile: Profile,
  model: string,
  opts: CompleteOptions,
): Promise<CompletionResult> {
  const tools = opts.tools ?? [];
  const injected: ChatMessage = { role: "system", content: buildJsonInstruction(tools) };
  const flat = [injected, ...toTextMessages(messages)];
  // No native tools; no streaming (we'd be streaming raw JSON). Reuse the
  // provider text path by calling the matching native fn with tools stripped.
  const textOpts: CompleteOptions = {
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    model,
  };
  let base: CompletionResult;
  switch (profile.provider) {
    case "anthropic":
      base = await completeAnthropic(flat, profile, model, textOpts);
      break;
    case "gemini":
      base = await completeGemini(flat, profile, model, textOpts);
      break;
    default:
      base = await completeOpenAICompatible(flat, profile, model, textOpts);
      break;
  }

  const j = extractJson(base.text);
  if (j && typeof j.action === "string" && j.action !== "finish") {
    const args = j.args && typeof j.args === "object" ? j.args : {};
    return {
      ...base,
      text: "",
      toolCalls: [{ id: synthId(), name: j.action, arguments: args }],
      finishReason: "tool_calls",
    };
  }
  // No tool call → the model is answering. Prefer an explicit summary field.
  const summary =
    j && typeof j.summary === "string" ? j.summary : stripFences(base.text) || base.text;
  return { ...base, text: summary, toolCalls: [], finishReason: "stop" };
}
