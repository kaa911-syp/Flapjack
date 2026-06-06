import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));

test("CLI `help` runs and exits 0", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-cli-"));
  const out = execFileSync(process.execPath, [cli, "help"], { encoding: "utf8", cwd: tmp });
  assert.match(out, /Flapjack/);
  assert.match(out, /serve/);
});
