import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Seed a legacy single-provider store BEFORE importing db (which reads cwd).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-mig-"));
fs.mkdirSync(path.join(tmp, ".data"));
fs.writeFileSync(
  path.join(tmp, ".data", "store.json"),
  JSON.stringify({ settings: { provider: "openai", apiKey: "legacy-key", model: "gpt-4o-mini" } }),
);
process.chdir(tmp);
const db = await import("../dist/lib/db.js");

test("legacy single-provider settings migrate to a profiles[] store", () => {
  const s = db.getSettings();
  assert.equal(s.profiles.length, 1);
  assert.equal(s.profiles[0].provider, "openai");
  assert.equal(s.profiles[0].apiKey, "legacy-key");
  assert.equal(s.profiles[0].model, "gpt-4o-mini");
  assert.equal(s.defaultProfileId, "default");
});
