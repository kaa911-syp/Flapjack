import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Run in a temp cwd that carries a pricing override, so this one file exercises
// built-in defaults + override + longest-match + free-fallback together.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-price-"));
fs.mkdirSync(path.join(tmp, ".data"));
fs.writeFileSync(
  path.join(tmp, ".data", "pricing.json"),
  JSON.stringify([{ match: "my-custom-model", in: 1, out: 2 }]),
);
process.chdir(tmp);
const pricing = await import("../dist/lib/pricing.js");

test("built-in default prices still apply", () => {
  assert.equal(pricing.estimateCost("openai", "gpt-4o-mini", 1e6, 0), 0.15);
  assert.equal(pricing.hasKnownPrice("claude-3-5-sonnet-latest"), true);
});

test("longest model-id match wins (gpt-4o-mini, not gpt-4o)", () => {
  assert.equal(pricing.estimateCost("openai", "gpt-4o-mini", 1e6, 0), 0.15);
});

test("override from .data/pricing.json is applied", () => {
  // 1 (in) * 1M + 2 (out) * 1M = 3.0
  assert.equal(pricing.estimateCost("openai-compatible", "my-custom-model", 1e6, 1e6), 3);
  assert.equal(pricing.hasKnownPrice("my-custom-model"), true);
});

test("unknown / local model is free ($0)", () => {
  assert.equal(pricing.estimateCost("openai-compatible", "totally-unknown-xyz", 1e6, 1e6), 0);
  assert.equal(pricing.hasKnownPrice("totally-unknown-xyz"), false);
});
