import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const parts = chromium.executablePath().split(sep);
const executablePath = resolve(
  ".cache/ms-playwright",
  ...parts.slice(parts.findIndex((p) => /^chromium-\d+$/.test(p))),
);
const origin = "http://127.0.0.1:3017";
mkdirSync("test-results", { recursive: true });
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: {
    ...process.env,
    BARISTA_DEV_AUTH: "true",
    SQL_PRINTERS_ENABLED: "false",
    PORT: "3017",
    BARISTA_HOST: "127.0.0.1",
    BARISTA_DATA_DIR: resolve("test-results/formula-data-" + Date.now()),
  },
  stdio: "pipe",
  windowsHide: true,
});
let logs = "",
  browser;
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
try {
  let ready = false;
  for (let i = 0; i < 180; i++) {
    try {
      if ((await fetch(origin + "/api/config")).ok) { ready = true; break; }
    } catch {}
    if (server.exitCode !== null) throw new Error("Formula test server exited before readiness.");
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, "Formula test server did not become ready within 45 seconds.");
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 950 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/editor");
  await page
    .getByRole("button", { name: "Save project (Ctrl+S)", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Edit named fields", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Named Data Sources & CSV Batch",
  });
  const item = dialog
    .locator(".data-field-row")
    .filter({
      has: page
        .getByLabel("Field name", { exact: true })
        .and(page.locator('[value="item"]')),
    });
  await item.getByLabel("Default value", { exact: true }).fill("1234567890");
  await dialog
    .getByRole("button", { name: "Add named field", exact: true })
    .click();
  const row = dialog.locator(".data-field-row").last();
  await row.getByLabel("Field name", { exact: true }).fill("formatted_item");
  await row.getByLabel("Named source type").selectOption("formula");
  const formula =
    '=CONCATENATE(LEFT(item,1),"-",MID(item,2,2),"-",MID(item,4,2),"-",MID(item,6,2),"-",MID(item,8,2),"-",RIGHT(item,1))';
  await row.getByLabel("Named formula").fill(formula);
  await row
    .getByLabel("Result for formatted_item")
    .filter({ hasText: "1-23-45-67-89-0" })
    .waitFor();
  await page.screenshot({
    path: "test-results/formula-sources.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByRole("button", { name: "Insert text", exact: true }).click();
  await page.getByLabel("Text data source").selectOption("formula");
  await page
    .getByLabel("Text content", { exact: true })
    .fill('formatted_item & "!"');
  await page
    .getByLabel("Formula result", { exact: true })
    .filter({ hasText: "1-23-45-67-89-0!" })
    .waitFor();
  await page
    .locator('.canvas-container[data-authoritative="true"]')
    .waitFor({ timeout: 30000 });
  await page.screenshot({
    path: "test-results/formula-element.png",
    fullPage: true,
  });
  await page
    .getByLabel("Text content", { exact: true })
    .fill("LEFT(missing,1)");
  await page
    .getByRole("alert")
    .filter({ hasText: "Missing value for missing" })
    .waitFor();
  await page
    .getByLabel("Text content", { exact: true })
    .fill('formatted_item & "!"');
  await page
    .getByRole("button", { name: "Save project (Ctrl+S)", exact: true })
    .click();
  await page.getByText(/Saved · revision/).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Open project", exact: true })
    .locator(".project-list button")
    .first()
    .click();
  await page
    .getByRole("button", { name: "Edit named fields", exact: true })
    .click();
  assert.equal(await page.getByLabel("Named formula").inputValue(), formula);
  assert.deepEqual(errors, []);
  console.log(
    "Formula UI: creation, reusable binding, result, validation, and saved reload passed.",
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
