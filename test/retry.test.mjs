// Fast backoff so the integration test runs quickly. Must be set before llm.js
// is imported (the retry constants are read at module load).
process.env.FLAPJACK_RETRY_BASE_MS = "5";
process.env.FLAPJACK_RETRY_CAP_MS = "30";
process.env.FLAPJACK_RETRY_ATTEMPTS = "5";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const llm = await import("../dist/lib/llm.js");

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("isRetryableStatus: 429 + 5xx retryable, 4xx not", () => {
  assert.equal(llm.isRetryableStatus(429), true);
  assert.equal(llm.isRetryableStatus(500), true);
  assert.equal(llm.isRetryableStatus(503), true);
  assert.equal(llm.isRetryableStatus(400), false);
  assert.equal(llm.isRetryableStatus(401), false);
  assert.equal(llm.isRetryableStatus(404), false);
});

test("complete() retries a 503 then succeeds", async () => {
  let attempts = 0;
  const { server, port } = await listen((req, res) => {
    attempts++;
    if (attempts < 3) {
      res.writeHead(503);
      return res.end("overloaded");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
  const profile = { id: "t", name: "T", provider: "openai-compatible", apiKey: "", model: "m", baseUrl: `http://127.0.0.1:${port}/v1` };
  const res = await llm.complete([{ role: "user", content: "ping" }], profile, {});
  server.close();
  assert.equal(res.text, "pong");
  assert.equal(res.toolCalls.length, 0);
  assert.equal(attempts, 3);
});

test("complete() does NOT retry a 401 (bad key)", async () => {
  let attempts = 0;
  const { server, port } = await listen((req, res) => {
    attempts++;
    res.writeHead(401);
    res.end("invalid api key");
  });
  const profile = { id: "t", name: "T", provider: "openai-compatible", apiKey: "x", model: "m", baseUrl: `http://127.0.0.1:${port}/v1` };
  await assert.rejects(() => llm.complete([{ role: "user", content: "ping" }], profile, {}), /401/);
  server.close();
  assert.equal(attempts, 1);
});
