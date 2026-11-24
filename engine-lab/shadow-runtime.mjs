// Diagnostic only: watches the already-persisted wallet but never changes it.
// No prompts, storage writes, tracking requests, DOM or production wallet API.
import { auditWallet } from "./shadow-audit.mjs";

const walletKey = "sdelano.game.v1";
let latest = null;
function copy() {
  return { ...latest, issues: latest.issues.map(entry => ({ ...entry })) };
}
function refresh() {
  try {
    const raw = localStorage.getItem(walletKey);
    latest = auditWallet(raw === null ? null : JSON.parse(raw));
  } catch {
    // Corrupt JSON and blocked storage must not impact the actual game.
    latest = { status: "unavailable", ruleVersion: "shadow-v1", grants: 0,
      expectedXp: 0, observedXp: 0, expectedCoins: 0, observedCoins: 0,
      issues: [{ code: "unreadable-wallet", index: -1 }] };
  }
  return copy();
}
window.sdelanoShadow = Object.freeze({ inspect: copy, refresh });
window.addEventListener("sdelano:game-changed", refresh);
window.addEventListener("storage", event => {
  if (event.key === walletKey || event.key === null) refresh();
});
refresh();
