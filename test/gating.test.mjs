import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// chdir + scaffold before importing db/orchestrator/approvals (cwd bound at load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-gate-"));
fs.mkdirSync(path.join(tmp, "agents"));
fs.writeFileSync(
  path.join(tmp, "agents", "approver.md"),
  "---\nname: Approver\ntools: [send_email]\nautonomy: approval\nchannel: operations\n---\nYou email.",
);
fs.writeFileSync(
  path.join(tmp, "agents", "suggester.md"),
  "---\nname: Suggester\ntools: [send_email]\nautonomy: suggest\nchannel: operations\n---\nYou suggest.",
);
process.chdir(tmp);

// Mock: ask to send a (valid) email first, then finish once it sees a tool result.
const server = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const sawTool = (JSON.parse(b).messages || []).some((m) => m.role === "tool");
    res.writeHead(200, { "Content-Type": "application/json" });
    if (sawTool) {
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "Handled." }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
    } else {
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "e1", type: "function", function: { name: "send_email", arguments: JSON.stringify({ to: "a@b.com", subject: "Hi", body: "Yo" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
    }
  });
});

test("gated tool: suggest autonomy is refused, queues nothing", async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const db = await import("../dist/lib/db.js");
  db.upsertProfile({ name: "Mock", provider: "openai-compatible", model: "m", baseUrl: `http://127.0.0.1:${port}/v1` });
  const orch = await import("../dist/lib/orchestrator.js");

  const res = await orch.runAgent("suggester", { trigger: "email the customer" });
  assert.equal(res.ok, true);
  assert.equal(db.listApprovals("pending").length, 0, "suggest must not queue an approval");
});

test("gated tool: approval autonomy queues, then approve runs the effect", async () => {
  const db = await import("../dist/lib/db.js");
  const orch = await import("../dist/lib/orchestrator.js");
  const approvals = await import("../dist/lib/approvals.js");

  const res = await orch.runAgent("approver", { trigger: "email the customer" });
  assert.equal(res.ok, true);

  const pending = db.listApprovals("pending");
  assert.equal(pending.length, 1, "gated call should queue exactly one approval");
  assert.equal(pending[0].tool, "send_email");

  const decided = await approvals.approve(pending[0].id);
  assert.equal(decided.status, "approved");
  assert.match(decided.result, /simulated/);
  assert.equal(db.listApprovals("pending").length, 0);

  server.close();
});
