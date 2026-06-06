import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitReady(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function startServe(port, extraArgs, env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-serve-"));
  const proc = spawn(process.execPath, [cli, "serve", "--port", String(port), ...extraArgs], {
    cwd: tmp,
    env: { ...process.env, ...env },
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  return { proc, out: () => out };
}

test("serve binds loopback, serves /health, and enforces the inbound secret", async () => {
  const port = await freePort();
  const s = startServe(port, ["--rate-limit", "100"], { FLAPJACK_INBOUND_SECRET: "topsecret" });
  try {
    assert.ok(await waitReady(port), "server should become ready");
    assert.match(s.out(), new RegExp(`127\\.0\\.0\\.1:${port}`), "startup log shows loopback bind");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    const bad = await fetch(`http://127.0.0.1:${port}/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "WRONG", text: "hi" }),
    });
    assert.equal(bad.status, 401, "wrong secret rejected");

    const good = await fetch(`http://127.0.0.1:${port}/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "topsecret", text: "hi" }),
    });
    assert.equal(good.status, 200, "correct secret accepted");
  } finally {
    s.proc.kill();
  }
});

test("serve rate-limits a POST flood", async () => {
  const port = await freePort();
  const s = startServe(port, ["--rate-limit", "2"], {});
  try {
    assert.ok(await waitReady(port));
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `expected a 429 in ${codes.join(",")}`);
  } finally {
    s.proc.kill();
  }
});
