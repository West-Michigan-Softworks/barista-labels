import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import net from "node:net";
const cache = resolve(".cache/ms-playwright");
const expected = chromium.executablePath().split(sep),
  revision = expected.findIndex((part) => /^chromium-\d+$/.test(part));
const executablePath = resolve(cache, ...expected.slice(revision));
mkdirSync("test-results", { recursive: true });
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: {
    ...process.env,
    BARISTA_DEV_AUTH: "true",
    SQL_PRINTERS_ENABLED: "false",
    PORT: "3012",
    BARISTA_HOST: "127.0.0.1",
    BARISTA_DATA_DIR: resolve(`test-results/ui-data-${Date.now()}`),
  },
  stdio: "pipe",
  windowsHide: true,
});
let logs = "";
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
let browser;
let page;
const printChunks = [];
const fakePrinter = net.createServer(socket => socket.on("data", chunk => printChunks.push(chunk)));
try {
  await new Promise(resolve => fakePrinter.listen(0, "127.0.0.1", resolve));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3012/api/config")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch({ headless: true, executablePath });
  page = await browser.newPage({
    viewport: { width: 1500, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3012");
  await page
    .getByRole("button", { name: "Save project (Ctrl+S)", exact: true })
    .waitFor();
  await page
    .locator('.canvas-container[data-authoritative="true"]')
    .waitFor({ timeout: 30000 });
  await page.screenshot({ path: "test-results/editor.png", fullPage: true });
  await page
    .getByRole("button", { name: "Insert rectangle", exact: true })
    .click();
  await page.getByLabel("Object name", { exact: true }).fill("Test rectangle");
  await page.getByLabel("xUm", { exact: true }).fill("12");
  await page.getByLabel("yUm", { exact: true }).fill("25");
  const canvasBox = await page.locator(".canvas-container").boundingBox();
  await page.mouse.move(canvasBox.x + 170, canvasBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 170, canvasBox.y + 140, { steps: 5 });
  await page.mouse.up();
  await page
    .getByRole("button", { name: "Save project (Ctrl+S)", exact: true })
    .click();
  await page.getByText(/Saved · revision/).waitFor();
  await page
    .getByRole("button", { name: "Page setup", exact: true })
    .first()
    .click();
  await page.getByRole("dialog", { name: "Page Setup" }).waitFor();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page
    .getByRole("button", { name: "Print preview", exact: true })
    .click();
  await page.getByRole("dialog", { name: "Print Preview & Print" }).waitFor();
  await page
    .getByAltText("Authoritative monochrome print preview")
    .waitFor({ timeout: 30000 });
  assert.equal(
    await page.getByRole("dialog").locator(".diagnostic.error").count(),
    0,
    "example should compile without errors",
  );
  await page.screenshot({ path: "test-results/preview.png", fullPage: true });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await page
    .getByRole("button", { name: /Receiving label/ })
    .first()
    .click();
  assert.equal(
    await page.getByLabel("Object name", { exact: true }).count(),
    0,
    "opening clears selection",
  );
  const saved = await (
    await fetch("http://127.0.0.1:3012/api/projects")
  ).json();
  assert(
    saved.some((p) =>
      p.templates[0].elements.some((e) => e.name === "Test rectangle"),
    ),
  );
  assert.equal(
    saved[0].templates[0].guides.length,
    1,
    "ruler guide is saved with project",
  );
  await page.getByRole("button", { name: "Company", exact: true }).click();
  await page
    .getByRole("button", { name: "Description", exact: true })
    .click({ modifiers: ["Shift"] });
  await page.getByText("2 objects selected", { exact: true }).waitFor();
  await page.keyboard.press("Control+d");
  assert.equal(await page.locator(".object-tree button").count(), 8);
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator(".object-tree button").count(), 6);
  await page
    .getByRole("button", { name: "Named fields and CSV", exact: true })
    .click();
  await page
    .locator('input[type=file][accept=".csv"]')
    .setInputFiles({
      name: "batch.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "description,item,qty\nBatch one,BY1001,1\nBatch two,BY1002,2\n",
      ),
    });
  await page.getByText(/2 rows loaded/).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const latest = saved[0];
  await fetch(`http://127.0.0.1:3012/api/projects/${latest.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...latest,
      name: "Other user revision",
      revision: latest.revision,
    }),
  });
  await page
    .getByRole("button", { name: "Save project (Ctrl+S)", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Project Changed on Server" })
    .waitFor();
  await page
    .getByRole("button", { name: "Keep edits as new project", exact: true })
    .click();
  // Publishing saves the new draft first, then switches to the dedicated workspace.
  await page.getByRole("button", { name: "Publish label", exact: true }).click();
  await page.getByRole("button", { name: "Republish label", exact: true }).waitFor();
  await page.getByRole("button", { name: "Company", exact: true }).first().click();
  await page.getByLabel("Object name", { exact: true }).fill("Unsaved editor change");
  const createPrinter = async (name, location) => {
    const response = await fetch("http://127.0.0.1:3012/api/printers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "new", name, host: "127.0.0.1", port: fakePrinter.address().port, dotsPerMm: 8, widthDots: 832, offsetX: 0, offsetY: 0, location }),
    });
    assert.equal(response.status, 200); return response.json();
  };
  const firstPrinter = await createPrinter("Location 12 test printer", 12);
  await createPrinter("Location 13 test printer", 13);
  await page.getByRole("button", { name: "Switch to Printer", exact: true }).click();
  assert.equal(new URL(page.url()).pathname, "/printer");
  await page.getByLabel("Label template", { exact: true }).selectOption({ index: 1 });
  assert.equal(await page.getByLabel("Quantity", { exact: true }).count(), 0, "CSV quantity cannot be overridden");
  const [csvDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV template" }).click()]);
  assert.equal(csvDownload.suggestedFilename(), "label-data.csv");
  const upload = page.getByLabel("Upload populated CSV", { exact: true });
  await upload.setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("description,item\nMissing item,\n") });
  await page.getByText(/item is required/).waitFor();
  await upload.setInputFiles({ name: "print.csv", mimeType: "text/csv", buffer: Buffer.from("description,item\nFirst label,0012\n,\nSecond label,0013\n") });
  await page.getByText("Labels to print:", { exact: false }).waitFor();
  await page.getByLabel("Location", { exact: true }).selectOption("12");
  const options = await page.getByLabel("Printer", { exact: true }).locator("option").allTextContents();
  assert.deepEqual(options, ["Select a printer", "Location 12 test printer"]);
  await page.getByLabel("Printer", { exact: true }).selectOption(firstPrinter.id);
  await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
  await page.getByAltText("Prepared label preview").waitFor({ timeout: 30000 });
  await page.getByText("Label 1 of 2", { exact: true }).waitFor();
  const firstPreview = await page.getByAltText("Prepared label preview").getAttribute("src");
  await page.getByRole("button", { name: "Next label", exact: true }).click();
  await page.getByText("Label 2 of 2", { exact: true }).waitFor();
  await page.waitForFunction(previous => document.querySelector('img[alt="Prepared label preview"]')?.getAttribute("src") && document.querySelector('img[alt="Prepared label preview"]')?.getAttribute("src") !== previous, firstPreview);
  await page.screenshot({ path: "test-results/printer.png", fullPage: true });
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await page.getByText(/Queued 2 labels/).waitFor();
  await page.getByRole("button", { name: "Print", exact: true }).click();
  const printedJobs = await (await fetch("http://127.0.0.1:3012/api/jobs")).json();
  assert.equal(printedJobs.length, 2, "repeat print submission must not duplicate jobs");
  for (let attempt = 0; attempt < 60 && printChunks.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(printChunks.length >= 2, "two labels reach the local fake printer");
  await page.getByLabel("Location", { exact: true }).selectOption("13");
  assert.equal(await page.getByLabel("Printer", { exact: true }).inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Print", exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "Switch to Editor", exact: true }).click();
  assert.equal(await page.getByLabel("Object name", { exact: true }).inputValue(), "Unsaved editor change");
  const staticProject = await (await fetch("http://127.0.0.1:3012/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      schemaVersion: 1, name: "Static test", templates: [{ id: "static", name: "Static label", widthUm: 50000, heightUm: 25000, elements: [] }], variables: [], assets: [], importDiagnostics: [],
    }),
  })).json();
  const staticLabel = await (await fetch(`http://127.0.0.1:3012/api/projects/${staticProject.id}/labels/static/publish`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: staticProject.revision }),
  })).json();
  // Verify the user-only UI and direct navigation without a real Entra account.
  const userPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  userPage.on("pageerror", e => errors.push(e.message));
  await userPage.route("**/api/me", route => route.fulfill({ json: { id: "ui-user", roles: ["Labels.User"] } }));
  await userPage.goto("http://127.0.0.1:3012/editor");
  await userPage.getByRole("heading", { name: "Print labels", exact: true }).waitFor();
  assert.equal(new URL(userPage.url()).pathname, "/printer");
  assert.equal(await userPage.getByRole("button", { name: "Switch to Editor" }).count(), 0);
  assert.equal(await userPage.getByRole("button", { name: "Printer configuration", exact: true }).count(), 0);
  assert.equal(await userPage.locator(".canvas-container").count(), 0);
  await userPage.getByLabel("Label template", { exact: true }).selectOption(staticLabel.id);
  assert.equal(await userPage.getByLabel("Upload populated CSV", { exact: true }).count(), 0);
  await userPage.getByLabel("Quantity", { exact: true }).fill("3");
  await userPage.getByLabel("Location", { exact: true }).selectOption("12");
  await userPage.getByLabel("Printer", { exact: true }).selectOption(firstPrinter.id);
  await userPage.getByRole("button", { name: "Prepare preview", exact: true }).click();
  await userPage.getByAltText("Prepared label preview").waitFor();
  await userPage.getByText("Ready to print 3 labels", { exact: true }).waitFor();
  await userPage.screenshot({ path: "test-results/printer-user.png", fullPage: true });
  await page.getByRole("button", { name: "Switch to Printer", exact: true }).click();
  await page.getByRole("button", { name: "Printer configuration", exact: true }).click();
  await page.getByRole("dialog", { name: "Printer Configuration", exact: true }).waitFor();
  await userPage.close();
  assert.deepEqual(errors, [], "browser should have no runtime errors");
  console.log(
    "UI smoke passed: editor, publication, draft-preserving mode switch, Printer CSV/preview/printing, location filtering, idempotency and user-only routing.",
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: "test-results/ui-failure.png", fullPage: true }).catch(() => {});
    console.error(await page.locator("body").ariaSnapshot().catch(() => ""));
  }
  console.error(logs.slice(-3000));
  throw e;
} finally {
  await browser?.close();
  server.kill();
  await new Promise(resolve => fakePrinter.close(resolve));
}
