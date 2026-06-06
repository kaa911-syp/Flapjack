import fs from "node:fs";
import path from "node:path";
import type { Provider } from "./types";

/**
 * Per-model price, USD per 1,000,000 tokens, as input/output.
 * Matched by longest model-id substring.
 */
export interface PriceRow {
  match: string;
  in: number;
  out: number;
}

/**
 * Built-in defaults. Rough public list prices — a transparency aid for the cost
 * meter, NOT billing. Override or extend them at runtime by dropping a
 * `.data/pricing.json` (an array of {match,in,out}) in your project; entries
 * there add to / replace these by `match`. Unknown models stay free ($0).
 */
const DEFAULT_PRICES: PriceRow[] = [
  // OpenAI
  { match: "gpt-4o-mini", in: 0.15, out: 0.6 },
  { match: "gpt-4o", in: 2.5, out: 10 },
  { match: "gpt-4.1-mini", in: 0.4, out: 1.6 },
  { match: "gpt-4.1", in: 2, out: 8 },
  { match: "o4-mini", in: 1.1, out: 4.4 },
  { match: "o3-mini", in: 1.1, out: 4.4 },
  { match: "gpt-3.5", in: 0.5, out: 1.5 },
  // Anthropic
  { match: "claude-3-5-haiku", in: 0.8, out: 4 },
  { match: "claude-3-5-sonnet", in: 3, out: 15 },
  { match: "claude-3-7-sonnet", in: 3, out: 15 },
  { match: "claude-haiku", in: 0.8, out: 4 },
  { match: "claude-sonnet", in: 3, out: 15 },
  { match: "claude-opus", in: 15, out: 75 },
  { match: "claude-3-opus", in: 15, out: 75 },
  { match: "claude-3-haiku", in: 0.25, out: 1.25 },
  // Google Gemini
  { match: "gemini-1.5-flash", in: 0.075, out: 0.3 },
  { match: "gemini-1.5-pro", in: 1.25, out: 5 },
  { match: "gemini-2.0-flash", in: 0.1, out: 0.4 },
  { match: "gemini-2.5-flash", in: 0.3, out: 2.5 },
  { match: "gemini-2.5-pro", in: 1.25, out: 10 },
  // Common open models via OpenRouter/Together (approx)
  { match: "llama-3.1-70b", in: 0.6, out: 0.6 },
  { match: "llama-3.3-70b", in: 0.6, out: 0.6 },
  { match: "mixtral-8x7b", in: 0.24, out: 0.24 },
];

let cache: PriceRow[] | null = null;

/** Reset the in-process price cache (used by tests). */
export function resetPricingCache(): void {
  cache = null;
}

/** Built-in defaults merged with an optional `.data/pricing.json` override. */
function loadPrices(): PriceRow[] {
  if (cache) return cache;
  const byMatch = new Map<string, PriceRow>(DEFAULT_PRICES.map((r) => [r.match, r]));
  try {
    const file = path.join(process.cwd(), ".data", "pricing.json");
    const user = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(user)) {
      for (const u of user) {
        if (u && typeof u.match === "string") {
          byMatch.set(u.match, { match: u.match, in: Number(u.in) || 0, out: Number(u.out) || 0 });
        }
      }
    }
  } catch {
    /* no override file — defaults only */
  }
  cache = [...byMatch.values()];
  return cache;
}

/** Find the per-1M price for a model id, or null if unknown. */
function lookup(model: string): { in: number; out: number } | null {
  const m = model.toLowerCase();
  let best: PriceRow | null = null;
  for (const p of loadPrices()) {
    if (m.includes(p.match) && (!best || p.match.length > best.match.length)) {
      best = p;
    }
  }
  return best ? { in: best.in, out: best.out } : null;
}

/**
 * Estimate the USD cost of a single call. Local/self-hosted models whose ids
 * don't match a known (or configured) price are treated as free.
 */
export function estimateCost(
  _provider: Provider,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  // Unknown / local model with no published or configured price -> $0.
  const price = lookup(model);
  if (!price) return 0;
  const cost = (promptTokens / 1e6) * price.in + (completionTokens / 1e6) * price.out;
  return Math.round(cost * 1e6) / 1e6; // 6dp
}

/** True if we have a published/configured price for this model. */
export function hasKnownPrice(model: string): boolean {
  return lookup(model) !== null;
}
