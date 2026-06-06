import test from "node:test";
import assert from "node:assert/strict";
import * as orch from "../dist/lib/orchestrator.js";

test("delegationError: allows a fresh, non-cyclic delegation", () => {
  assert.equal(orch.delegationError("a", "b", [], 0), null);
});

test("delegationError: blocks self-delegation", () => {
  assert.match(orch.delegationError("a", "a", [], 0), /yourself/);
});

test("delegationError: blocks a cycle (target already in chain)", () => {
  assert.match(orch.delegationError("a", "b", ["a", "b"], 0), /cycle/);
});

test("delegationError: blocks beyond max depth", () => {
  assert.match(orch.delegationError("a", "b", [], orch.MAX_DELEGATION_DEPTH), /depth/);
});
