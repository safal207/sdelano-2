import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const browserName = process.env.SDELANO_QA_ENGINE || "chromium";
const browser = await ({ chromium, firefox, webkit })[browserName].launch({ headless: true });
const root = "http://127.0.0.1:8765/";
const walletKey = "sdelano.game.v1", taskKey = "todo-list.tasks.v1";

async function arrive(page) {
  await page.goto(root, { waitUntil: "networkidle" });
  await page.evaluate(() => document.querySelector("#welcome-start")?.click());
  await page.waitForFunction(() => Boolean(window.sdelanoShadow));
}
async function addAndComplete(page, title) {
  await page.locator("#task-title").fill(title);
  await page.locator("#task-title").press("Enter");
  const task = page.locator("li.task").filter({ hasText: title });
  await task.waitFor({ state: "visible" });
  await task.locator(".task-checkbox").check();
  await page.locator('.task-panel[aria-busy="true"]').waitFor({ state: "hidden" });
  return task;
}
async function inspect(page) {
  return page.evaluate(() => window.sdelanoShadow.inspect());
}
async function verifyReadOnly(page) {
  return page.evaluate(key => {
    const before = localStorage.getItem(key);
    const keys = Object.keys(localStorage).sort();
    const first = window.sdelanoShadow.refresh();
    const second = window.sdelanoShadow.inspect();
    const after = localStorage.getItem(key);
    return { unchanged: before === after, sameKeys: JSON.stringify(keys) === JSON.stringify(Object.keys(localStorage).sort()),
      first, second };
  }, walletKey);
}
// Isolate the diagnostic from legitimate production writes. Intercept every
// Storage mutation method, including writes that would restore identical bytes.
async function verifyIsolatedRuntime(width) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const probe = root + "__shadow_probe__";
    await page.route(probe, route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><title>Shadow probe</title>"
    }));
    await page.goto(probe);
    const result = await page.evaluate(async key => {
      const p = Storage.prototype;
      const original = { setItem: p.setItem, removeItem: p.removeItem, clear: p.clear, getItem: p.getItem };
      original.setItem.call(sessionStorage, "probe", "untouched");
      const attempts = [];
      for (const name of ["setItem", "removeItem", "clear"]) {
        p[name] = function (...args) {
          attempts.push(name);
          return original[name].apply(this, args);
        };
      }
      const snapshot = () => JSON.stringify([localStorage, sessionStorage].map(storage =>
        Object.keys(storage).sort().map(k => [k, original.getItem.call(storage, k)])));
      const before = snapshot();
      const statuses = [];
      await import("/engine-lab/shadow-runtime.mjs?v=1");
      statuses.push(window.sdelanoShadow.inspect().status);
      const initialUnchanged = before === snapshot();
      const check = expected => {
        const prior = snapshot();
        const a = window.sdelanoShadow.refresh();
        statuses.push(a.status);
        if (a.status !== expected || prior !== snapshot()) throw Error("Shadow mutated storage or wrong status");
      };
      // Setup uses unwrapped methods; only diagnostic attempts are counted.
      original.setItem.call(localStorage, key, "{broken JSON");
      check("unavailable");
      original.setItem.call(localStorage, key, JSON.stringify({ version: 1, grants: [], excludedIds: [] }));
      check("ok");
      p.getItem = function (k) {
        if (this === localStorage && k === key) throw new DOMException("Denied", "SecurityError");
        return original.getItem.call(this, k);
      };
      check("unavailable");
      p.getItem = original.getItem;
      original.setItem.call(localStorage, key, JSON.stringify({ version: 1, grants: [null], excludedIds: [] }));
      const prior = snapshot();
      window.dispatchEvent(new Event("sdelano:game-changed"));
      statuses.push(window.sdelanoShadow.inspect().status);
      const mismatchUnchanged = prior === snapshot();
      original.removeItem.call(localStorage, key);
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
      statuses.push(window.sdelanoShadow.inspect().status);
      return { attempts, statuses, initialUnchanged, mismatchUnchanged };
    }, walletKey);
    assert.deepEqual(result.attempts, [], "SHADOW-002: zero Storage mutation attempts");
    assert.ok(result.initialUnchanged && result.mismatchUnchanged);
    assert.deepEqual(result.statuses, ["no-wallet", "unavailable", "ok", "unavailable", "mismatch", "no-wallet"]);
    assert.deepEqual(errors, []);
    console.log("BitOS shadow storage/failure isolation QA passed:", browserName, width);
  } finally { await context.close(); }
}

try {
  for (const width of [320, 390]) {
    await verifyIsolatedRuntime(width);
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    try {
      await arrive(page);
      let check = await verifyReadOnly(page);
      assert.ok(check.unchanged && check.sameKeys, "Shadow must never write storage on initial load");
      assert.ok(["no-wallet", "ok"].includes(check.first.status), "Initial status is not a reward");

      const first = "Шадоу первая задача " + width;
      await addAndComplete(page, first);
      await page.waitForFunction(() => window.sdelanoShadow.inspect().expectedXp === 20);
      check = await verifyReadOnly(page);
      assert.ok(check.unchanged && check.sameKeys);
      assert.deepEqual(check.first, check.second);
      assert.equal(check.first.status, "ok");
      assert.deepEqual([check.first.expectedXp, check.first.expectedCoins], [20, 10]);
      const actual = await page.evaluate(() => window.sdelanoGame.inspect());
      assert.deepEqual([actual.xp, actual.coins], [20, 10]);

      await addAndComplete(page, "Шадоу вторая задача " + width);
      await addAndComplete(page, "Шадоу третья задача " + width);
      await page.waitForFunction(() => window.sdelanoShadow.inspect().expectedXp === 55);
      check = await verifyReadOnly(page);
      assert.ok(check.unchanged && check.sameKeys);
      assert.equal(check.first.status, "ok");
      assert.deepEqual([check.first.expectedXp, check.first.expectedCoins], [55, 30]);

      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(() => Boolean(window.sdelanoShadow));
      assert.equal((await inspect(page)).status, "ok");
      assert.equal((await inspect(page)).expectedXp, 55);
      const beforeRedo = await page.evaluate(key => localStorage.getItem(key), walletKey);
      const task = page.locator("li.task").filter({ hasText: first });
      if (!(await task.isVisible())) {
        const filter = page.locator('button[data-filter="done"]');
        await filter.click();
      }
      await task.locator(".task-checkbox").uncheck();
      await page.locator('.task-panel[aria-busy="true"]').waitFor({ state: "hidden" });
      const active = page.locator('button[data-filter="active"]');
      await active.click();
      await task.locator(".task-checkbox").check();
      await page.locator('.task-panel[aria-busy="true"]').waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(key => localStorage.getItem(key), walletKey), beforeRedo,
        "Undo/redo must not regrant or mutate wallet");
      assert.equal((await inspect(page)).expectedXp, 55);

      const sibling = await context.newPage();
      await arrive(sibling);
      assert.equal((await inspect(sibling)).expectedXp, 55);
      const id = await sibling.evaluate(key =>
        JSON.parse(localStorage.getItem(key))[0].id, taskKey);
      const duplicate = await sibling.evaluate(taskId => window.sdelanoGame.awardTask(taskId), id);
      assert.equal(duplicate.awarded, false);
      assert.equal((await inspect(sibling)).expectedXp, 55);
      // SHADOW-001: a real commit in the original tab must update the
      // already-open sibling via the browser storage event, without refresh().
      await addAndComplete(page, "Шадоу четвертая задача " + width);
      await sibling.waitForFunction(() => {
        const a = window.sdelanoShadow.inspect();
        return a.status === "ok" && a.expectedXp === 65 && a.expectedCoins === 35;
      });
      assert.equal((await inspect(page)).expectedXp, 65);

      const mismatch = await page.evaluate(key => {
        const raw = JSON.parse(localStorage.getItem(key));
        raw.grants[0].xp = 11; // Within legacy validation bound, but wrong under shadow policy.
        localStorage.setItem(key, JSON.stringify(raw));
        const before = localStorage.getItem(key);
        const result = window.sdelanoShadow.refresh();
        return { result, noWrite: before === localStorage.getItem(key) };
      }, walletKey);
      assert.ok(mismatch.noWrite);
      assert.equal(mismatch.result.status, "mismatch");
      assert.ok(mismatch.result.issues.some(x => x.code === "wrong-reward"));
      assert.equal(mismatch.result.expectedXp, 65);
      assert.equal(mismatch.result.observedXp, 66);
      await sibling.waitForFunction(() => window.sdelanoShadow.inspect().status === "mismatch");
      await sibling.close();
      assert.deepEqual(errors, [], "Unexpected page errors: " + errors.join("; "));
      console.log("BitOS shadow read-only QA passed:", browserName, width);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
