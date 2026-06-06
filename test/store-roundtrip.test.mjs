import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// db.ts derives its data dir from process.cwd() at import time, so chdir first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flap-store-"));
process.chdir(tmp);
const db = await import("../dist/lib/db.js");
const file = path.join(tmp, ".data", "store.json");

test("addNote persists to .data/store.json", () => {
  db.addNote("hello", "world");
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.notes.length, 1);
  assert.equal(raw.notes[0].title, "hello");
});

test("mutate reads latest from disk — no clobber of a concurrent write", () => {
  // Simulate another process appending directly to the store file.
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  disk.notes.push({ id: "ext_1", title: "external", content: "x", createdAt: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(disk));

  // Our next mutate must merge on top of that external write, not overwrite it.
  db.addNote("second", "note");
  const titles = JSON.parse(fs.readFileSync(file, "utf8")).notes.map((n) => n.title);
  assert.ok(titles.includes("hello"), "original note preserved");
  assert.ok(titles.includes("external"), "external concurrent write preserved");
  assert.ok(titles.includes("second"), "new write present");
});
