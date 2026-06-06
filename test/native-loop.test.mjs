import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// chdir + scaffold before importing db/orchestrator (cwd bound at load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-native-"));
fs.mkdirSync(path.join(tmp, "agents"));
fs.writeFileSync(
  path.join(tmp, "agents", "noter.md"),
  "---\nname: Noter\ntools: [save_note]\nautonomy: suggest\nchannel: general\n---\nYou save notes.",
);
process.chdir(tmp);

test("native loop: tool_call → tool result → finish", async () => {
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const msgs = JSON.parse(b).messages || [];
      const sawTool = msgs.some((m) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (sawTool) {
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "Saved the greeting note." }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
      } else {
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "save_note", arguments: JSON.stringify({ title: "Greeting", content: "hello team" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const db = await import("../dist/lib/db.js");
  db.upsertProfile({ name: "Mock", provider: "openai-compatible", model: "m", baseUrl: `http://127.0.0.1:${port}/v1` });
  const orch = await import("../dist/lib/orchestrator.js");

  const res = await orch.runAgent("noter", { trigger: "save a greeting note" });
  server.close();

  assert.equal(res.ok, true);
  assert.equal(res.steps, 2, "one tool step + one finish");
  assert.match(res.summary, /Saved/);
  const notes = db.listNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Greeting");
});
