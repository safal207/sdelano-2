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
try {
  for (const width of [320, 390]) {
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
      await sibling.close();

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
      assert.equal(mismatch.result.expectedXp, 55);
      assert.equal(mismatch.result.observedXp, 56);
      assert.deepEqual(errors, [], "Unexpected page errors: " + errors.join("; "));
      console.log("BitOS shadow read-only QA passed:", browserName, width);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
