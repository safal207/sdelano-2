// BitOS Shadow v1 — independent read-only reconciliation of legacy local wallet.
// No DOM mutation, no storage write, no network, no rewards, no telemetry.
import { projectRewards } from "./event-ledger.mjs";

const RULES = Object.freeze({
  "task.completed": Object.freeze({ xp: 10, coins: 5 }),
  "task.daily-bonus": Object.freeze({ xp: 10, coins: 5 }),
  "task.triple-bonus": Object.freeze({ xp: 15, coins: 10 }),
  "focus.claimed": Object.freeze({ xp: 5, coins: 0 })
});
const KIND = Object.freeze({
  task: "task.completed", daily: "task.daily-bonus",
  triple: "task.triple-bonus", focus: "focus.claimed"
});
const SHOP = Object.freeze({ scarf: 50, glasses: 100, cosmic: 150, sparkle: 200 });
const MAX_ENTRIES = 12000;
const MAX_ISSUES = 24;
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const positiveTime = x => Number.isSafeInteger(x) && x >= 0 && x <= 8.64e15;
const nonNegative = x => Number.isSafeInteger(x) && x >= 0;
const day = x => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);

export function auditWallet(wallet) {
  if (wallet === null || wallet === undefined) return {
    status: "no-wallet", ruleVersion: "shadow-v1", grants: 0, issues: [],
    expectedXp: 0, observedXp: 0, expectedCoins: 0, observedCoins: 0
  };
  const issues = [];
  const issue = (code, index = -1) => {
    if (issues.length < MAX_ISSUES) issues.push({ code, index });
  };
  if (!object(wallet) || wallet.version !== 1 || !Array.isArray(wallet.grants) ||
      wallet.grants.length > MAX_ENTRIES ||
      (wallet.purchases !== undefined && (!Array.isArray(wallet.purchases) ||
        wallet.purchases.length > 4)) ||
      (wallet.excludedIds !== undefined && !Array.isArray(wallet.excludedIds))) {
    issue("invalid-schema");
    return { status: "invalid", ruleVersion: "shadow-v1", grants: 0, issues,
      expectedXp: 0, observedXp: 0, expectedCoins: 0, observedCoins: 0 };
  }
  const taskCounts = new Map(), daily = new Set(), triple = new Set();
  const focusCounts = new Map(), knownKeys = new Set(), purchaseIds = new Set();
  const eventIds = new Map(); // Internal opaque IDs: valid task IDs can be 150 chars.
  const events = [];
  let observedXp = 0, observedGrossCoins = 0, spent = 0;
  for (let i = 0; i < wallet.grants.length; i++) {
    const g = wallet.grants[i];
    if (!object(g) || typeof g.key !== "string" || g.key.length > 170 ||
        !day(g.day) || !positiveTime(g.at) ||
        !nonNegative(g.xp) || !nonNegative(g.coins)) {
      issue("invalid-grant", i);
      continue;
    }
    const match = /^(task|daily|triple|focus):(.+)$/.exec(g.key);
    if (!match || match[2].length > 150) { issue("invalid-grant-key", i); continue; }
    if (knownKeys.has(g.key)) issue("duplicate-grant", i);
    knownKeys.add(g.key);
    if (!eventIds.has(g.key)) eventIds.set(g.key, "grant-" + eventIds.size);
    const [_, category, id] = match;
    const kind = KIND[category], amounts = RULES[kind];
    if (g.xp !== amounts.xp || g.coins !== amounts.coins) issue("wrong-reward", i);
    observedXp += g.xp;
    observedGrossCoins += g.coins;
    if (!Number.isSafeInteger(observedXp) || !Number.isSafeInteger(observedGrossCoins))
      issue("reward-overflow", i);
    if (category === "task") {
      taskCounts.set(g.day, (taskCounts.get(g.day) || 0) + 1);
    } else if (category === "daily" || category === "triple") {
      if (id !== g.day) issue("bonus-day-mismatch", i);
      const set = category === "daily" ? daily : triple;
      if (set.has(g.day)) issue("duplicate-bonus", i);
      set.add(g.day);
      if ((taskCounts.get(g.day) || 0) !== (category === "daily" ? 1 : 3))
        issue("bonus-out-of-order", i);
    } else if (category === "focus") {
      const count = (focusCounts.get(g.day) || 0) + 1;
      focusCounts.set(g.day, count);
      if (count > 3) issue("focus-daily-limit", i);
    }
    events.push({
      eventId: eventIds.get(g.key), actorId: "shadow-local",
      kind, occurredAt: new Date(g.at).toISOString()
    });
  }
  for (const [d, count] of taskCounts) {
    if (count >= 1 && !daily.has(d)) issue("missing-daily-bonus");
    if (count >= 3 && !triple.has(d)) issue("missing-triple-bonus");
  }
  for (let i = 0; i < (wallet.purchases || []).length; i++) {
    const purchase = wallet.purchases[i];
    if (!object(purchase) || !own(SHOP, purchase.id) ||
        purchase.coins !== SHOP[purchase.id] || !positiveTime(purchase.at) ||
        purchaseIds.has(purchase.id)) {
      issue("invalid-purchase", i);
      continue;
    }
    purchaseIds.add(purchase.id);
    spent += purchase.coins;
  }
  let projected = { xp: 0, coins: 0 };
  try {
    projected = projectRewards("shadow-local", events, event => RULES[event.kind]);
  } catch {
    issue("projection-error");
  }
  const expectedCoins = projected.coins - spent;
  const observedCoins = observedGrossCoins - spent;
  if (projected.xp !== observedXp || expectedCoins !== observedCoins)
    issue("balance-divergence");
  if (expectedCoins < 0 || observedCoins < 0) issue("negative-balance");
  return {
    status: issues.length ? "mismatch" : "ok",
    ruleVersion: "shadow-v1",
    grants: wallet.grants.length,
    expectedXp: projected.xp, observedXp,
    expectedCoins, observedCoins, issues
  };
}
