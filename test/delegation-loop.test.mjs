import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// chdir + scaffold BEFORE importing db/orchestrator/agents (they bind cwd at load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-deleg-"));
fs.mkdirSync(path.join(tmp, "agents"));
fs.writeFileSync(
  path.join(tmp, "agents", "looper.md"),
  "---\nname: Looper\ntools: [delegate]\nautonomy: approval\nchannel: general\n---\nYou delegate everything.",
);
process.chdir(tmp);

test("self-delegation terminates without runaway recursion", async () => {
  // Mock model: always asks to delegate to itself.
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c" + calls, type: "function", function: { name: "delegate", arguments: JSON.stringify({ agent: "looper", task: "again" }) } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const db = await import("../dist/lib/db.js");
  db.saveSettings({ maxSteps: 3 });
  db.upsertProfile({ name: "Mock", provider: "openai-compatible", model: "m", baseUrl: `http://127.0.0.1:${port}/v1` });

  const orch = await import("../dist/lib/orchestrator.js");
  const res = await orch.runAgent("looper", { trigger: "kick off" });
  server.close();

  assert.equal(res.ok, true, "run should finish, not hang/throw");
  assert.ok(res.steps <= 3, `bounded by maxSteps, got ${res.steps}`);
});
