import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// db derives its data dir from cwd at import — chdir first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-mem-"));
process.chdir(tmp);
const db = await import("../dist/lib/db.js");
const tools = await import("../dist/lib/tools.js");

db.addNote("Pricing plan", "We charge $99/mo for the pro tier");
db.addNote("Hiring", "Looking for a backend engineer");
db.addNote("Pricing FAQ", "Discounts apply for annual billing");

test("search_notes returns relevant notes and excludes irrelevant ones", async () => {
  const out = await tools.getTool("search_notes").run({ query: "pricing", limit: 5 }, {});
  assert.match(out, /Pricing plan/);
  assert.match(out, /Pricing FAQ/);
  assert.ok(!/Hiring/.test(out), "unrelated note excluded");
});

test("search_notes honors the limit", async () => {
  const out = await tools.getTool("search_notes").run({ query: "pricing", limit: 1 }, {});
  assert.equal(out.split("\n").length, 1);
});

test("search_notes reports no matches cleanly", async () => {
  const out = await tools.getTool("search_notes").run({ query: "zzzznotfound", limit: 5 }, {});
  assert.match(out, /No notes match/);
});

test("read_notes output is bounded (per-note clip)", async () => {
  db.addNote("Big", "x".repeat(5000));
  const out = await tools.getTool("read_notes").run({}, {});
  // Each note clipped to ~200 chars; the giant note must not dump in full.
  assert.ok(out.length < 2000, `unexpectedly large: ${out.length}`);
});
