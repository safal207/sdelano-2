import test from "node:test";
import assert from "node:assert/strict";
import { auditWallet } from "../engine-lab/shadow-audit.mjs";
import { projectRewards, replay } from "../engine-lab/event-ledger.mjs";

const date = "2026-11-23", at = Date.UTC(2026, 10, 23, 12);
const row = (key, xp, coins, time = at) => ({ key, day: date, at: time, xp, coins });
const wallet = () => ({
  version: 1, excludedIds: [], grants: [
    row("task:first", 10, 5),
    row("daily:" + date, 10, 5),
    row("task:second", 10, 5),
    row("task:third", 10, 5),
    row("triple:" + date, 15, 10),
    row("focus:session1", 5, 0)
  ]
});

test("shadow projection matches independent task bonuses and a claimed focus", () => {
  const w = wallet(), before = JSON.stringify(w);
  const audit = auditWallet(w);
  assert.equal(audit.status, "ok");
  assert.deepEqual([audit.expectedXp, audit.observedXp, audit.expectedCoins, audit.observedCoins],
    [60, 60, 30, 30]);
  assert.equal(audit.grants, 6);
  assert.deepEqual(audit.issues, []);
  assert.equal(JSON.stringify(w), before, "Audit must never mutate caller's wallet");
});
test("shadow detects modified amounts, duplicate awards and bonus/order gaps", () => {
  const w = wallet(); w.grants[0].xp = 99;
  let a = auditWallet(w);
  assert.equal(a.status, "mismatch");
  assert.ok(a.issues.some(x => x.code === "wrong-reward"));
  assert.ok(a.issues.some(x => x.code === "balance-divergence"));
  const dup = wallet(); dup.grants.push({ ...dup.grants[0] });
  a = auditWallet(dup);
  assert.equal(a.status, "mismatch");
  assert.ok(a.issues.some(x => x.code === "duplicate-grant"));
  const missing = wallet(); missing.grants.splice(1, 1);
  a = auditWallet(missing);
  assert.equal(a.status, "mismatch");
  assert.ok(a.issues.some(x => x.code === "missing-daily-bonus"));
  const orphan = wallet(); orphan.grants.unshift(orphan.grants.splice(4, 1)[0]);
  a = auditWallet(orphan);
  assert.ok(a.issues.some(x => x.code === "bonus-out-of-order"));
});
test("shadow never grants unverified purchases and checks a focus daily limit", () => {
  const w = wallet();
  w.purchases = [{ id: "scarf", coins: 49, at }];
  const a = auditWallet(w);
  assert.equal(a.status, "mismatch");
  assert.ok(a.issues.some(x => x.code === "invalid-purchase"));
  const focus = wallet();
  focus.grants.push(row("focus:session2", 5, 0), row("focus:session3", 5, 0),
    row("focus:session4", 5, 0));
  assert.ok(auditWallet(focus).issues.some(x => x.code === "focus-daily-limit"));
});
test("absent and malformed wallets fail without minting or mutating values", () => {
  assert.equal(auditWallet(null).status, "no-wallet");
  assert.equal(auditWallet({ version: 1, grants: "not-an-array" }).status, "invalid");
  assert.equal(auditWallet({ ...wallet(), grants: [null] }).status, "mismatch");
});
test("max-length task identifiers are valid and never leak into shadow diagnostics", () => {
  const id = "x".repeat(150);
  const w = { version: 1, excludedIds: [],
    grants: [row("task:" + id, 10, 5), row("daily:" + date, 10, 5)] };
  const result = auditWallet(w);
  assert.equal(result.status, "ok");
  assert.equal(result.expectedXp, 20);
  assert.ok(!JSON.stringify(result).includes(id), "Diagnostics must omit task IDs");
});
test("valid cosmetic purchase is subtracted without treating spending as lost XP", () => {
  const w = wallet();
  for (let n = 4; n <= 9; n++) w.grants.push(row("task:task-" + n, 10, 5));
  w.purchases = [{ id: "scarf", coins: 50, at }];
  const result = auditWallet(w);
  assert.equal(result.status, "ok");
  assert.deepEqual([result.expectedXp, result.observedXp, result.expectedCoins, result.observedCoins],
    [120, 120, 10, 10]);
});
test("linear reward projection is deterministic, idempotent and actor-isolated", () => {
  const e = { eventId: "a", actorId: "owner", kind: "task.completed", occurredAt: "2026-11-23T12:00:00Z" };
  const policy = () => ({ xp: 10, coins: 5 });
  const out = projectRewards("owner", [e, e, { ...e, eventId: "b" }], policy);
  assert.deepEqual(out, { actorId: "owner", count: 2, xp: 20, coins: 10 });
  assert.deepEqual([replay("owner", [e, e, { ...e, eventId: "b" }], policy).xp,
    replay("owner", [e, e, { ...e, eventId: "b" }], policy).coins], [20, 10]);
  assert.throws(() => projectRewards("owner", [{ ...e, actorId: "other" }], policy), /Actor mismatch/);
  assert.throws(() => projectRewards("owner", [e], () => ({ xp: 1001, coins: 0 })), /Invalid policy/);
  const many = Array.from({ length: 1000 }, (_, i) => ({ ...e, eventId: "event-" + i }));
  assert.equal(projectRewards("owner", many, policy).xp, 10000);
});

test("SHADOW-004 rejects impossible calendar days but accepts leap day", () => {
  for (const bad of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01"]) {
    const w = wallet();
    w.grants[0].day = bad;
    assert.ok(auditWallet(w).issues.some(x => x.code === "invalid-grant"), bad);
  }
  const leap = "2028-02-29";
  const w = { version: 1, excludedIds: [], grants: [
    { ...row("task:leap", 10, 5), day: leap },
    { ...row("daily:" + leap, 10, 5), day: leap }
  ] };
  assert.equal(auditWallet(w).status, "ok");
});
test("SHADOW-004 rejects spending future earnings, including cumulative purchases", () => {
  const w = wallet();
  for (let n = 4; n <= 33; n++) w.grants.push(row("task:future-" + n, 10, 5, at + 1000));
  w.purchases = [{ id: "scarf", coins: 50, at }];
  const before = JSON.stringify(w);
  const a = auditWallet(w);
  assert.equal(a.status, "mismatch");
  assert.ok(a.issues.some(x => x.code === "purchase-insufficient-at-time"));
  assert.equal(JSON.stringify(w), before);
  w.purchases[0].at = at + 1000;
  assert.equal(auditWallet(w).status, "ok", "same timestamp is permitted");
  w.purchases.push({ id: "glasses", coins: 100, at });
  const b = auditWallet(w);
  assert.ok(b.issues.some(x => x.code === "purchase-out-of-order"));
  assert.ok(b.issues.some(x => x.code === "purchase-insufficient-at-time"));
  w.purchases[1].at = at + 1000;
  assert.equal(auditWallet(w).status, "ok");
});

// Run the load regression in the existing QA smoke matrix.
import "./engine-load.test.mjs";
