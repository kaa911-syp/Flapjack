import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as tools from "../dist/lib/tools.js";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("validateHttpUrl: scheme/host checks", () => {
  assert.match(tools.validateHttpUrl("ftp://x.com"), /http/);
  assert.match(tools.validateHttpUrl("file:///etc/passwd"), /http/);
  assert.match(tools.validateHttpUrl("notaurl"), /valid/);
  assert.equal(tools.validateHttpUrl("http://127.0.0.1/"), null); // scheme ok; SSRF enforced at fetch time
  assert.equal(tools.validateHttpUrl("https://example.com/x"), null);
});

test("fetch_url blocks a loopback address by default (SSRF guard)", async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>secret internal</h1>");
  });
  const out = await tools.getTool("fetch_url").run({ url: `http://127.0.0.1:${port}/` }, {});
  server.close();
  assert.match(out, /blocked/);
});

test("fetch_url returns stripped text when private is explicitly allowed", async () => {
  process.env.FLAPJACK_FETCH_ALLOW_PRIVATE = "1";
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Hello</h1><script>alert(1)</script><p>World</p>");
  });
  const out = await tools.getTool("fetch_url").run({ url: `http://127.0.0.1:${port}/` }, {});
  server.close();
  delete process.env.FLAPJACK_FETCH_ALLOW_PRIVATE;
  assert.match(out, /Hello/);
  assert.match(out, /World/);
  assert.ok(!/alert/.test(out), "script content stripped");
  assert.ok(!/[<>]/.test(out), "html tags stripped");
});
