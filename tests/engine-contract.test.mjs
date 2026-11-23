import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, applyEvent, replay } from "../engine-lab/event-ledger.mjs";

const policy = event => event.kind === "task.completed"
  ? { xp: 10, coins: 5, ruleVersion: "lab-v1" }
  : { xp: 0, coins: 0, ruleVersion: "lab-v1" };
const e1 = { eventId: "e1", actorId: "u1", kind: "task.completed", occurredAt: "2026-11-23T10:00:00Z" };
const e2 = { eventId: "e2", actorId: "u1", kind: "task.completed", occurredAt: "2026-11-23T11:00:00Z" };

test("replay deterministic; duplicate events never mint rewards twice", () => {
  const out = replay("u1", [e1, e1, e2], policy);
  assert.deepEqual([out.entries.length, out.xp, out.coins], [2, 20, 10]);
  assert.deepEqual(replay("u1", [e1, e1, e2], policy), out);
});
test("does not mutate previous ledger; detects cross-account awards", () => {
  const before = emptyLedger("u1");
  const after = applyEvent(before, e1, policy);
  assert.deepEqual(before, { actorId: "u1", entries: [], xp: 0, coins: 0 });
  assert.equal(after.xp, 10);
  assert.throws(() => applyEvent(before, { ...e1, actorId: "u2" }, policy), /Actor mismatch/);
});
test("rejects invalid input and policy inflation", () => {
  const before = emptyLedger("u1");
  assert.throws(() => applyEvent(before, { ...e1, kind: "order.paid" }, policy), /Unsupported/);
  assert.throws(() => applyEvent(before, e1, () => ({ xp: -1, coins: 5 })), /Invalid policy/);
  assert.throws(() => applyEvent(before, e1, () => ({ xp: 999999, coins: 1 })), /Invalid policy/);
  assert.throws(() => applyEvent(before, { ...e1, eventId: "" }, policy), /Invalid eventId/);
});
test("focus is not rewarded without approved rule", () => {
  const e = { eventId: "f1", actorId: "u1", kind: "focus.claimed", occurredAt: "2026-11-23T12:00:00Z" };
  const out = replay("u1", [e], policy);
  assert.equal(out.xp, 0);
  assert.equal(out.entries.length, 1);
});
