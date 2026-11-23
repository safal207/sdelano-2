// EXPERIMENT ONLY — not connected to game.js or the production wallet.
const allowedKinds = new Set(["task.completed", "task.daily-bonus", "task.triple-bonus", "focus.claimed", "lesson.applied"]);

function assertEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("Event object required");
  for (const name of ["eventId", "actorId", "kind"]) {
    if (typeof event[name] !== "string" || !event[name] || event[name].length > 150)
      throw new TypeError("Invalid " + name);
  }
  if (!allowedKinds.has(event.kind)) throw new TypeError("Unsupported event kind");
  if (typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt)))
    throw new TypeError("Valid occurredAt ISO date required");
}

export function emptyLedger(actorId) {
  if (typeof actorId !== "string" || !actorId || actorId.length > 150) throw new TypeError("Invalid actorId");
  return { actorId, entries: [], xp: 0, coins: 0 };
}

export function applyEvent(previous, event, policy) {
  assertEvent(event);
  if (!previous || previous.actorId !== event.actorId) throw new Error("Actor mismatch");
  if (typeof policy !== "function") throw new TypeError("Policy function required");
  if (previous.entries.some(entry => entry.eventId === event.eventId)) return previous;
  const grant = policy(event);
  if (!grant || !Number.isSafeInteger(grant.xp) || !Number.isSafeInteger(grant.coins) ||
      grant.xp < 0 || grant.coins < 0 || grant.xp > 1000 || grant.coins > 1000)
    throw new Error("Invalid policy result");
  const xp = previous.xp + grant.xp, coins = previous.coins + grant.coins;
  if (!Number.isSafeInteger(xp) || !Number.isSafeInteger(coins)) throw new Error("Ledger overflow");
  return {
    actorId: previous.actorId,
    entries: [...previous.entries, { eventId: event.eventId, kind: event.kind,
      occurredAt: event.occurredAt, ruleVersion: grant.ruleVersion ?? "laboratory-1",
      xp: grant.xp, coins: grant.coins }],
    xp, coins
  };
}

export function replay(actorId, events, policy) {
  if (!Array.isArray(events)) throw new TypeError("Events array required");
  return events.reduce((state, event) => applyEvent(state, event, policy), emptyLedger(actorId));
}

// Fast, read-only replay for shadow diagnostics. Does not need to allocate
// an immutable copy of every intermediate ledger state (O(n) rather than O(n²)).
export function projectRewards(actorId, events, policy) {
  if (typeof actorId !== "string" || !actorId || actorId.length > 150) throw new TypeError("Invalid actorId");
  if (!Array.isArray(events) || events.length > 12000) throw new TypeError("Invalid events array");
  if (typeof policy !== "function") throw new TypeError("Policy function required");
  let xp = 0, coins = 0;
  const seen = new Set();
  for (const event of events) {
    assertEvent(event);
    if (event.actorId !== actorId) throw new Error("Actor mismatch");
    if (seen.has(event.eventId)) continue;
    const grant = policy(event);
    if (!grant || !Number.isSafeInteger(grant.xp) || !Number.isSafeInteger(grant.coins) ||
        grant.xp < 0 || grant.coins < 0 || grant.xp > 1000 || grant.coins > 1000)
      throw new Error("Invalid policy result");
    xp += grant.xp;
    coins += grant.coins;
    if (!Number.isSafeInteger(xp) || !Number.isSafeInteger(coins)) throw new Error("Ledger overflow");
    seen.add(event.eventId);
  }
  return { actorId, count: seen.size, xp, coins };
}
