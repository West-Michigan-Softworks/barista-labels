import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import net from "node:net";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { zipSync, strToU8 } from "fflate";
import { inventory } from "./editor-control-inventory.mjs";

const controls = inventory();
assert.deepEqual(controls, JSON.parse(readFileSync("docs/editor-controls.json", "utf8")));
const out = resolve("test-results/editor-audit");
mkdirSync(out, { recursive: true });
// Exercise production components with a fixed admin identity and a measurable sign-out callback.
// The production bootstrap is independently covered by ui-smoke.mjs.
const fixtureRoot = resolve("test-results/editor-audit-harness");
mkdirSync(fixtureRoot, { recursive: true });
writeFileSync(resolve(fixtureRoot, "index.html"), '<div id="root"></div><script type="module" src="/entry.tsx"></script>');
writeFileSync(resolve(fixtureRoot, "entry.tsx"), `import React from "react"; import { createRoot } from "react-dom/client"; import Workspace from "../../src/Workspace";
createRoot(document.getElementById("root")!).render(<Workspace user="Audit administrator" roles={["Labels.Admin"]} development onSignOut={() => { document.documentElement.dataset.signOutCalls = String(Number(document.documentElement.dataset.signOutCalls || 0) + 1); }} />);`);
await build({ configFile: false, root: fixtureRoot, plugins: [react()], logLevel: "error", build: { outDir: resolve(out, "build"), assetsDir: "audit-assets", emptyOutDir: true } });
const css = readFileSync("dist/index.html", "utf8").match(/href="([^\"]+\.css)"/)[1];
const html = readFileSync(resolve(out, "build/index.html"), "utf8") + `<link rel="stylesheet" href="${css}">`;
const origin = "http://127.0.0.1:3013";
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: { ...process.env, BARISTA_DEV_AUTH: "true", BARISTA_STORAGE_BACKEND: "sqlite", SQL_PRINTERS_ENABLED: "false", PORT: "3013", BARISTA_HOST: "127.0.0.1", BARISTA_DATA_DIR: resolve(out, `data-${Date.now()}`) },
  stdio: "pipe", windowsHide: true,
});
let logs = "";
server.stdout.on("data", chunk => { logs = (logs + chunk).slice(-12000); });
server.stderr.on("data", chunk => { logs = (logs + chunk).slice(-12000); });
const chunks = [];
const fakePrinter = net.createServer(socket => socket.on("data", chunk => chunks.push(chunk)));
let browser, page, testName;
const results = [], verified = new Map(), seen = new Set(), variants = new Set();
let pending = new Set();
const from = Number(process.argv.find(arg => arg.startsWith("--from="))?.split("=")[1] ?? 1);
let scenarioIndex = 0;
const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.ok, true, `${method} ${path}: ${await response.clone().text()}`);
  return response.json();
};
const by = (id, n = 0) => page.locator(`[data-editor-control="${id}"]`).nth(n);
const button = name => page.getByRole("button", { name, exact: true }).first();
const mark = async locator => {
  const id = await locator.getAttribute("data-editor-control");
  assert.ok(id, "interactive element must have an inventory ID");
  pending.add(id);
  variants.add(`${id}: ${await locator.getAttribute("aria-label") || (await locator.textContent()).trim() || await locator.getAttribute("accept") || await locator.getAttribute("type")}`);
};
const idle = () => page.waitForFunction(() => { const save = document.querySelector('[aria-label="Save project (Ctrl+S)"]'); return !save || !save.disabled; });
const click = async (locator, options) => { await mark(locator); await locator.click(options); await idle(); };
const fill = async (locator, value) => { await mark(locator); await locator.fill(String(value)); assert.equal(await locator.inputValue(), String(value)); };
const select = async (locator, value) => { await mark(locator); await locator.selectOption(String(value)); assert.equal(await locator.inputValue(), String(value)); };
const upload = async (locator, name, mimeType, buffer) => { await mark(locator); await locator.setInputFiles({ name, mimeType, buffer }); };
const close = async () => { await click(button("Close dialog")); await page.getByRole("dialog").waitFor({ state: "hidden" }); };
const menu = async (group, item) => { await click(page.locator(".menubar").getByRole("button", { name: group, exact: true })); if (item) await click(page.locator(".desktop-menu").getByRole("button", { name: item, exact: true })); };
const save = async () => {
  await button("Save project (Ctrl+S)").waitFor();
  const responsePromise = page.waitForResponse(r => /\/api\/projects(?:\/[^/]+)?$/.test(r.url()) && ["POST", "PUT"].includes(r.request().method()));
  await click(button("Save project (Ctrl+S)"));
  const response = await responsePromise;
  assert.equal(response.ok(), true, await response.text());
  await page.waitForFunction(() => !document.querySelector('[aria-label="Save project (Ctrl+S)"]').disabled);
  return response.json();
};
const rectangle = (id, x = 5000, y = 5000) => ({ id, name: id, type: "rectangle", xUm: x, yUm: y, widthUm: 10000, heightUm: 10000, rotation: 0, locked: false, strokeUm: 300, fill: "none" });
const project = (name, elements = [], variables = []) => ({ schemaVersion: 1, id: crypto.randomUUID(), name, templates: [{ id: crypto.randomUUID(), name: "Audit template", widthUm: 100000, heightUm: 50000, elements }], variables, assets: [], importDiagnostics: [] });
const load = async p => {
  const saved = await api("/projects", p);
  await click(button("Open project"));
  await click(page.getByRole("dialog").getByRole("button", { name: new RegExp(p.name) }));
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  return saved;
};
const picked = async (names, shift = false) => {
  for (const [i, name] of names.entries()) await click(page.locator(".object-tree").getByRole("button", { name, exact: true }), i || shift ? { modifiers: ["Shift"] } : undefined);
};
const expectDisabled = async (locator, reason) => {
  assert.equal(await locator.isDisabled(), true);
  if (reason) assert.match(await locator.getAttribute("title") || "", reason);
  await mark(locator);
};
const run = async (name, action) => {
  if (++scenarioIndex < from) return;
  testName = name; pending = new Set();
  await action();
  for (const id of pending) verified.set(id, [...new Set([...(verified.get(id) ?? []), name])]);
  const unidentified = await page.locator(".application button, .application input, .application select, .application textarea, .application summary, .application [tabindex='0']").evaluateAll(elements => elements.filter(el => !el.dataset.editorControl).map(el => el.outerHTML.slice(0, 200)));
  assert.deepEqual(unidentified, [], "Every rendered interactive editor element must map to the inventory");
  for (const id of await page.locator("[data-editor-control]").evaluateAll(els => els.map(el => el.dataset.editorControl))) seen.add(id);
  results.push({ name, status: "passed", controls: [...pending] });
  console.log(`PASS ${name}`);
};
const errors = [];
try {
  await new Promise(resolve => fakePrinter.listen(0, "127.0.0.1", resolve));
  let ready = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${origin}/api/config`)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }
  assert.ok(ready, logs);
  if (from > 7) await api("/printers", { id: crypto.randomUUID(), name: "Audit printer", host: "127.0.0.1", port: fakePrinter.address().port, dotsPerMm: 8, widthDots: 832, offsetX: 0, offsetY: 0, location: 12 });
  const parts = chromium.executablePath().split(sep), index = parts.findIndex(p => /^chromium-\d+$/.test(p));
  browser = await chromium.launch({ headless: true, executablePath: resolve(".cache/ms-playwright", ...parts.slice(index)) });
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/editor-audit", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/audit-assets/**", route => {
    const relative = new URL(route.request().url()).pathname.slice(1);
    assert.ok(/^audit-assets\/[\w.-]+$/.test(relative));
    return route.fulfill({ contentType: "text/javascript", body: readFileSync(resolve(out, "build", relative)) });
  });
  await page.goto(`${origin}/editor-audit`);
  await button("Save project (Ctrl+S)").waitFor();

  await run("empty selection, history, clipboard and modal keyboard", async () => {
    for (const name of ["Cut", "Copy", "Paste", "Undo", "Redo", "Align left", "Align right", "Align top", "Align bottom", "Centre horizontal", "Centre vertical", "Rotate"])
      await expectDisabled(button(name));
    await menu("Edit");
    for (const name of ["Cut", "Copy", "Paste", "Delete", "Undo", "Redo"]) await expectDisabled(page.locator(".desktop-menu").getByRole("button", { name, exact: true }));
    await page.keyboard.press("Escape"); assert.equal(await page.locator(".desktop-menu").count(), 0);
    await menu("View"); await click(button("Dismiss menu"), { position: { x: 900, y: 650 } }); assert.equal(await page.locator(".desktop-menu").count(), 0);
    await menu("File");
    for (const name of ["Revision history", "Export portable project"]) await expectDisabled(page.locator(".desktop-menu").getByRole("button", { name, exact: true }), /Save/);
    await page.keyboard.press("Escape");
    for (const control of ["Font family", "Font size in points", "Line thickness mm"]) await expectDisabled(page.getByLabel(control, { exact: true }));
    await click(button("New project"));
    const dialog = page.getByRole("dialog");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Close dialog");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Open receiving-label example");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Close dialog");
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "New project");
    await mark(button("New project")); await button("New project").press("Space"); await page.getByRole("dialog", { name: "New project" }).waitFor();
    await mark(button("Close dialog")); await button("Close dialog").press("Space"); await page.getByRole("dialog").waitFor({ state: "hidden" });
    await click(button("New project")); await click(button("Create blank project"));
    assert.equal(await page.locator(".object-tree button").count(), 0);
    await click(button("Page setup")); await click(by("Modal-002"), { position: { x: 5, y: 5 } });
    assert.equal(await dialog.count(), 0);
    await click(button("New project")); await click(button("Open receiving-label example"));
    assert.equal(await page.locator(".object-tree button").count(), 5);
  });

  await run("insert every object and edit every object-specific property", async () => {
    await load(project("Object audit"));
    for (const type of ["text", "barcode", "line", "rectangle", "ellipse"]) {
      await click(button(`Insert ${type}`));
      await fill(page.getByLabel("Object name", { exact: true }), `Audit ${type}`);
      for (const [key, value] of [["xUm", 10], ["yUm", 10], ["widthUm", 30]]) await fill(page.getByLabel(key, { exact: true }), value);
      if (type !== "line") await fill(page.getByLabel("heightUm", { exact: true }), 15);
      else await expectDisabled(page.getByLabel("heightUm", { exact: true }), /stroke thickness/);
      await fill(page.getByLabel("Rotation", { exact: true }), 0);
      if (type === "text") {
        await select(page.getByLabel("Font family", { exact: true }), "Courier New");
        await fill(page.getByLabel("Font size in points", { exact: true }), 10);
        await click(button("Bold")); assert.equal(await button("Bold").getAttribute("aria-pressed"), "true");
        for (const align of ["center", "right", "left"]) { await click(button(`Text align ${align}`)); assert.equal(await button(`Text align ${align}`).getAttribute("aria-pressed"), "true"); }
        await select(page.getByLabel("Text data source", { exact: true }), "literal");
        await fill(page.getByLabel("Text content", { exact: true }), "Hello");
        await select(page.getByLabel("Text data source", { exact: true }), "formula");
        await fill(page.getByLabel("Text content", { exact: true }), '=UPPER("hello")');
        assert.equal(await page.getByLabel("Formula result", { exact: true }).textContent(), "HELLO");
        await click(page.getByText("Formula functions and fields", { exact: true }));
        assert.ok(await page.getByText(/MID positions start at 1/).isVisible());
        await select(page.getByLabel("Text data source", { exact: true }), "template");
        await fill(page.getByLabel("Text content", { exact: true }), "Hello");
      }
      if (type === "barcode") {
        await select(page.getByLabel("Barcode data source", { exact: true }), "literal");
        await fill(page.getByLabel("Barcode data", { exact: true }), "123456789012");
        for (const sym of ["code128", "gs1-128", "code39", "ean13", "upca", "qrcode", "datamatrix"]) await select(by("App-053"), sym);
        await select(by("App-053"), "code128");
        await select(page.getByLabel("Barcode data source", { exact: true }), "formula");
        await fill(page.getByLabel("Barcode data", { exact: true }), '=LEFT("123456",3)');
        assert.equal(await page.getByLabel("Formula result", { exact: true }).textContent(), "123");
        await select(page.getByLabel("Barcode data source", { exact: true }), "template");
        await fill(page.getByLabel("Barcode data", { exact: true }), "123456");
      }
      if (["line", "rectangle", "ellipse"].includes(type)) {
        await fill(page.getByLabel("Line thickness mm", { exact: true }), .5);
        await fill(page.getByLabel("Thickness", { exact: true }), .6);
        if (type === "line") await expectDisabled(page.getByLabel("Fill", { exact: true }), /no fill area/);
        else for (const value of ["black", "white", "none"]) await select(page.getByLabel("Fill", { exact: true }), value);
      }
      if (type === "rectangle") await fill(page.getByLabel("Corner radius", { exact: true }), 2);
    }
    const chooser = page.waitForEvent("filechooser"); await click(button("Insert image")); await chooser;
    await upload(by("App-002"), "pixel.png", "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=", "base64"));
    await page.getByLabel("Object name", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Object name"]').value === "pixel.png");
    await fill(page.getByLabel("Object name", { exact: true }), "Audit image");
    const saved = await save();
    assert.equal(saved.templates[0].elements.length, 6);
    const text = saved.templates[0].elements.find(e => e.type === "text");
    assert.equal(text.fontFamily, "Courier New"); assert.equal(text.fontSizeUm, 3528); assert.equal(text.text, "Hello");
    assert.equal(saved.templates[0].elements.find(e => e.type === "rectangle").cornerRadiusUm, 2000);
    assert.equal(saved.templates[0].elements.find(e => e.type === "line").heightUm, 600);
    assert.equal(saved.assets.length, 1);
    await picked(["Audit rectangle"]);
    await click(page.locator(".object-tree").getByRole("button", { name: "Audit rectangle", exact: true }), { clickCount: 2 });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Object name");
    await mark(page.getByLabel("widthUm", { exact: true })); await page.getByLabel("widthUm", { exact: true }).fill("-1");
    assert.equal((await save()).templates[0].elements.find(e => e.type === "rectangle").widthUm, 1);
  });

  await run("clipboard, keyboard equivalents, selection toggling and locking", async () => {
    await load(project("Selection audit", [rectangle("A"), rectangle("B", 25000), rectangle("C", 50000)]));
    await picked(["A", "B"]); assert.equal(await page.getByText("2 objects selected", { exact: true }).count(), 1);
    await picked(["B"], true); assert.equal(await page.locator(".object-tree .selected").count(), 1);
    await click(button("Copy")); await click(button("Paste"));
    assert.equal(await page.locator(".object-tree button").count(), 4);
    await click(button("Undo")); assert.equal(await page.locator(".object-tree button").count(), 3);
    await click(button("Redo")); assert.equal(await page.locator(".object-tree button").count(), 4);
    await click(button("Cut")); assert.equal(await page.locator(".object-tree button").count(), 3);
    await menu("Edit", "Paste"); assert.equal(await page.locator(".object-tree button").count(), 4);
    await menu("Edit", "Delete"); assert.equal(await page.locator(".object-tree button").count(), 3);
    await picked(["A"]); await menu("Edit", "Copy"); await menu("Edit", "Cut");
    assert.equal(await page.locator(".object-tree button").count(), 2);
    await menu("Edit", "Undo"); await menu("Edit", "Redo"); await menu("Edit", "Undo");
    await menu("Edit", "Select all"); assert.equal(await page.locator(".object-tree .selected").count(), 3);
    await click(button("Select objects")); assert.equal(await page.locator(".object-tree .selected").count(), 0);
    await picked(["A"]); await click(button("Lock selection"));
    await expectDisabled(page.getByLabel("Object name", { exact: true }));
    await expectDisabled(page.getByLabel("xUm", { exact: true }));
    await expectDisabled(button("Delete selection"), /unlocked/);
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Delete");
    let saved = await save(); assert.equal(saved.templates[0].elements[0].xUm, 5000); assert.equal(saved.templates[0].elements.length, 3);
    await click(button("Unlock selection"));
    await page.locator(".canvas-container").click({ position: { x: 700, y: 400 } });
    await picked(["A"]);
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Shift+ArrowDown");
    saved = await save(); assert.equal(saved.templates[0].elements[0].xUm, 5100); assert.equal(saved.templates[0].elements[0].yUm, 6000);
    await page.locator(".canvas-container").focus(); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowUp");
    saved = await save(); assert.equal(saved.templates[0].elements[0].xUm, 5000); assert.equal(saved.templates[0].elements[0].yUm, 5900);
    await page.keyboard.press("Control+d"); assert.equal(await page.locator(".object-tree button").count(), 4);
    await page.keyboard.press("Control+z"); assert.equal(await page.locator(".object-tree button").count(), 3);
    await page.keyboard.press("Control+Shift+Z"); assert.equal(await page.locator(".object-tree button").count(), 4);
    await page.keyboard.press("Control+a"); assert.equal(await page.locator(".object-tree .selected").count(), 4);
    await page.keyboard.press("Escape"); assert.equal(await page.locator(".object-tree .selected").count(), 0);
    await picked(["A"]); await page.keyboard.press("Control+c"); await page.keyboard.press("Control+x"); await page.keyboard.press("Control+v");
    assert.equal(await page.locator(".object-tree button").count(), 4);
    await page.keyboard.press("Backspace"); assert.equal(await page.locator(".object-tree button").count(), 3);
    await page.keyboard.press("Control+y");
  });

  await run("all arrange buttons and menu variants change geometry or grouping", async () => {
    const setup = async () => { await load(project(`Arrange ${crypto.randomUUID()}`, [rectangle("A"), rectangle("B", 27000, 17000), rectangle("C", 60000, 30000)])); await picked(["A", "B", "C"]); };
    const alignments = [["Align left", "xUm"], ["Align right", "xUm"], ["Align top", "yUm"], ["Align bottom", "yUm"], ["Horizontal centres", "xUm"], ["Vertical centres", "yUm"], ["Centre horizontal", "xUm"], ["Centre vertical", "yUm"]];
    for (const [name, coordinate] of alignments) {
      const count = await page.getByRole("button", { name, exact: true }).count();
      for (let i = 0; i < Math.max(1, count); i++) {
        await setup(); await click(page.getByRole("button", { name, exact: true }).nth(i));
        const es = (await save()).templates[0].elements;
        assert.equal(new Set(es.map(e => e[coordinate])).size, 1, name);
      }
    }
    for (const name of ["Distribute horizontally", "Distribute vertically"]) {
      await setup(); await click(button(name));
      const es = (await save()).templates[0].elements, key = name.endsWith("horizontally") ? "xUm" : "yUm";
      assert.equal(es[1][key] - es[0][key], es[2][key] - es[1][key]);
    }
    for (const [name, key, target] of [["Centre on label ↔", "xUm", 45000], ["Centre on label ↕", "yUm", 20000]]) {
      await setup(); await click(button(name)); assert.ok((await save()).templates[0].elements.every(e => e[key] === target));
    }
    for (const name of ["Rotate 90 degrees", "Rotate"]) { await setup(); await click(button(name)); assert.ok((await save()).templates[0].elements.every(e => e.rotation === 90)); }
    await setup(); await menu("Arrange", "Rotate 90°"); assert.ok((await save()).templates[0].elements.every(e => e.rotation === 90));
    for (const viaMenu of [false, true]) {
      await setup();
      if (viaMenu) await menu("Arrange", "Group"); else await click(button("Group"));
      let es = (await save()).templates[0].elements; assert.ok(es[0].groupId); assert.equal(new Set(es.map(e => e.groupId)).size, 1);
      await picked(["A"]); assert.equal(await page.locator(".object-tree .selected").count(), 3);
      if (viaMenu) await menu("Arrange", "Ungroup"); else await click(button("Ungroup"));
      assert.ok((await save()).templates[0].elements.every(e => !e.groupId));
      for (const name of ["Bring to front", "Send to back"]) {
        await picked(["B"]);
        if (viaMenu) await menu("Arrange", name); else await click(button(name));
        es = (await save()).templates[0].elements; assert.equal(es[name === "Bring to front" ? es.length - 1 : 0].name, "B");
      }
      await click(button("Delete selection")); assert.equal(await page.locator(".object-tree button").count(), 2);
    }
  });

  await run("view controls, rename, page setup and template tabs", async () => {
    await load(project("Page audit"));
    await click(button("Zoom in")); assert.equal(await page.getByLabel("Zoom", { exact: true }).inputValue(), "110");
    await click(button("Zoom out")); assert.equal(await page.getByLabel("Zoom", { exact: true }).inputValue(), "100");
    await menu("View", "Zoom in"); await menu("View", "Zoom out"); assert.equal(await page.getByLabel("Zoom", { exact: true }).inputValue(), "100");
    await select(page.getByLabel("Zoom", { exact: true }), 300); await expectDisabled(button("Zoom in"), /Maximum/);
    await select(page.getByLabel("Zoom", { exact: true }), 25); await click(button("Zoom out")); await expectDisabled(button("Zoom out"), /Minimum/);
    await select(page.getByLabel("Zoom", { exact: true }), 100);
    await click(button("Show grid")); assert.equal(await button("Show grid").getAttribute("aria-pressed"), "true");
    await menu("View", "Show grid"); assert.equal(await button("Show grid").getAttribute("aria-pressed"), "false");
    await click(button("Snap to grid and objects")); assert.equal(await button("Snap to grid and objects").getAttribute("aria-pressed"), "false");
    await menu("View", "Snap to grid / object"); assert.equal(await button("Snap to grid and objects").getAttribute("aria-pressed"), "true");
    await select(page.getByLabel("Display units", { exact: true }), "in"); assert.match(await page.locator(".statusbar").textContent(), /in/);
    await select(page.getByLabel("Display units", { exact: true }), "mm");
    await mark(by("App-006")); await by("App-006").dblclick();
    await fill(page.getByLabel("Label name", { exact: true }), "Renamed audit"); await page.keyboard.press("Enter");
    assert.match(await by("App-006").textContent(), /Renamed audit/);
    await by("App-006").press("F2"); await fill(page.getByLabel("Label name", { exact: true }), "Cancelled rename"); await page.keyboard.press("Escape");
    assert.match(await by("App-006").textContent(), /Renamed audit/);
    await click(by("App-069")); await fill(page.getByLabel("Project name", { exact: true }), "Page changed");
    await fill(page.getByLabel("Template name", { exact: true }), "First template");
    await fill(page.getByLabel("Width (mm)", { exact: true }), 90); await fill(page.getByLabel("Height (mm)", { exact: true }), 40);
    await click(button("Layout")); await select(page.getByLabel("Orientation", { exact: true }), "portrait");
    await click(page.getByRole("button", { name: /Swap Width & Height/ })); assert.equal(await page.getByLabel("Orientation", { exact: true }).inputValue(), "landscape");
    for (const id of ["App-091", "App-092", "App-093"]) { assert.equal(await by(id).getAttribute("readonly"), ""); assert.ok(await by(id).getAttribute("title")); await mark(by(id)); }
    await click(button("Page")); assert.equal(await page.getByLabel("Width (mm)", { exact: true }).inputValue(), "90");
    await fill(page.getByLabel("Height (mm)", { exact: true }), 90); await click(button("Layout"));
    await expectDisabled(page.getByLabel("Orientation", { exact: true }), /Square/);
    await expectDisabled(page.getByRole("button", { name: /Swap Width & Height/ }), /already equal/);
    await click(button("Page")); await fill(page.getByLabel("Height (mm)", { exact: true }), 40);
    await click(button("OK"));
    await click(button("Add template")); assert.equal(await page.locator(".object-tree button").count(), 0);
    await click(page.locator(".template-tabs").getByRole("button", { name: "First template", exact: true }));
    const saved = await save(); assert.equal(saved.name, "Page changed"); assert.equal(saved.templates.length, 2); assert.equal(saved.templates[0].widthUm, 90000);
    await menu("File", "Page setup"); await close();
    await page.keyboard.press("Control+n"); await page.getByRole("dialog", { name: "New project" }).waitFor(); await close();
    await page.keyboard.press("Control+o"); await page.getByRole("dialog", { name: "Open project" }).waitFor(); await close();
  });

  await run("save/open, portable export/import, history, recovery and both conflict choices", async () => {
    const saved = await load(project("Persistence audit", [rectangle("Persisted")]));
    await picked(["Persisted"]); await fill(page.getByLabel("Object name", { exact: true }), "Persisted change");
    const revision = await save();
    await menu("File", "Save"); await page.getByText(/Saved · revision/).waitFor();
    await page.locator(".canvas-container").focus();
    const keyboardSave = page.waitForResponse(r => r.request().method() === "PUT" && /\/api\/projects\/[^/]+$/.test(r.url()));
    await page.keyboard.press("Control+s"); assert.equal((await keyboardSave).ok(), true); await idle();
    await menu("File", "Revision history"); await click(page.getByRole("button", { name: /^Revision 1\b/ }));
    assert.equal(await page.locator(".object-tree button").textContent(), "Persisted");
    await menu("File", "Open project library"); await click(page.getByRole("dialog").getByRole("button", { name: /Persistence audit/ }));
    assert.equal(await page.locator(".object-tree button").textContent(), "Persisted change");
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem("barista-drafts") || "{}")).length > 0);
    await menu("File", "Recover draft"); await click(page.getByRole("dialog").getByRole("button", { name: /Recovered local draft/ }).first());
    assert.match(await page.locator(".statusbar").textContent(), /Project opened/);
    await load(project("Portable audit", [rectangle("Portable object")])); await save();
    const dlPromise = page.waitForEvent("download"); await menu("File", "Export portable project"); const dl = await dlPromise;
    assert.equal(dl.suggestedFilename(), "Portable audit.barista");
    const bytes = readFileSync(await dl.path()); assert.ok(bytes.length > 100);
    await click(button("Open project"));
    const chooser = page.waitForEvent("filechooser"); await click(button("Import file")); await chooser;
    await upload(by("App-001"), "roundtrip.barista", "application/zip", bytes);
    await page.getByRole("dialog").waitFor({ state: "hidden" }); assert.equal(await page.locator(".object-tree button").textContent(), "Portable object");
    for (const keep of [false, true]) {
      const p = await load(project(`Conflict ${keep}`, [rectangle("Conflict object")]));
      await api(`/projects/${p.id}`, { ...p, name: "Server version", revision: p.revision }, "PUT");
      await picked(["Conflict object"]); await fill(page.getByLabel("Object name", { exact: true }), "Local version");
      await click(button("Save project (Ctrl+S)")); await page.getByRole("dialog", { name: "Project Changed on Server" }).waitFor();
      await click(button(keep ? "Keep edits as new project" : "Open latest revision")); await page.getByRole("dialog").waitFor({ state: "hidden" });
      const result = await save(); assert.equal(result.id === p.id, !keep);
      assert.equal(result.templates[0].elements[0].name, keep ? "Local version" : "Conflict object");
      if (await button("Dismiss error").count()) await click(button("Dismiss error"));
    }
    assert.ok(revision.revision > saved.revision);
  });

  await run("printer configuration fields, check/save/delete and SQL read-only state", async () => {
    await menu("Administer", "Printer configuration");
    await click(button("New printer"));
    for (const [label, value] of [["Name", "Audit printer"], ["IP address / hostname", "127.0.0.1"], ["TCP port", fakePrinter.address().port], ["Dots per mm", 8], ["Printable width (dots)", 832], ["X offset (dots)", 0], ["Y offset (dots)", 0], ["Location number", 12]])
      await fill(page.getByRole("dialog").getByLabel(label, { exact: true }), value);
    for (const media of ["continuous", "mark", "gap"]) await select(page.getByLabel("Media", { exact: true }), media);
    await click(button("Save printer")); await page.getByText("Printer profile saved", { exact: true }).waitFor();
    await click(button("Refresh printer list")); await button("Audit printer").waitFor();
    await click(button("Audit printer")); await click(button("Check connection"));
    await page.getByText("TCP connection succeeded; no label was printed", { exact: true }).waitFor(); assert.equal(chunks.length, 0);
    await click(button("New printer")); await fill(page.getByRole("dialog").getByLabel("Name", { exact: true }), "Delete me");
    await click(button("Save printer")); await page.getByRole("dialog").getByRole("alert").filter({ hasText: "Invalid printer profile" }).waitFor();
    await fill(page.getByRole("dialog").getByLabel("IP address / hostname", { exact: true }), "127.0.0.1");
    await click(button("Save printer")); await page.getByText("Printer profile saved", { exact: true }).waitFor();
    page.once("dialog", dialog => dialog.dismiss()); await click(button("Delete printer")); assert.equal(await button("Delete me").count(), 1);
    page.once("dialog", dialog => dialog.accept()); await click(button("Delete printer")); await button("Delete me").waitFor({ state: "hidden" });
    await close();
    const realPrinters = await api("/printers");
    await page.route("**/api/printers", async route => {
      if (route.request().method() === "GET") await route.fulfill({ json: [...realPrinters, { ...realPrinters[0], id: "sql:fixture", name: "SQL audit printer", source: "sql" }] }); else await route.continue();
    });
    await menu("Administer", "Printer configuration"); await click(button("SQL audit printer"));
    for (const label of ["Name", "IP address / hostname", "TCP port", "Dots per mm", "Printable width (dots)", "X offset (dots)", "Y offset (dots)", "Location number", "Media"])
      await expectDisabled(page.getByRole("dialog").getByLabel(label, { exact: true }));
    await expectDisabled(button("Save printer")); await expectDisabled(button("Delete printer"));
    assert.ok(await page.getByText(/Managed by BYAPPS/).isVisible()); await close(); await page.unroute("**/api/printers");
  });

  await run("named fields, formulas, every CSV control and validated batch delivery", async () => {
    await load(project("Data audit", [], [{ name: "item", defaultValue: "initial" }]));
    for (const name of ["Data Sources", "Edit named fields", "item", "Named fields and CSV"]) { await click(button(name)); await page.getByRole("dialog", { name: "Named Data Sources & CSV Batch" }).waitFor(); await close(); }
    await menu("Tools", "Named fields / CSV data");
    await fill(page.getByLabel("Field name", { exact: true }), "description"); await fill(page.getByLabel("Default value", { exact: true }), "Default description");
    await click(button("Add named field")); await fill(page.getByLabel("Field name", { exact: true }).nth(1), "computed");
    await select(page.getByLabel("Named source type", { exact: true }).nth(1), "formula");
    await fill(page.getByLabel("Named formula", { exact: true }), '=UPPER(description)');
    assert.equal(await page.getByLabel("Result for computed", { exact: true }).textContent(), "DEFAULT DESCRIPTION");
    await click(button("Add named field")); await click(button("Remove field"));
    // Remove the last field rather than the referenced source; restore a simple input for the batch.
    await click(button("Remove field")); await click(button("Remove field"));
    await click(button("Add named field")); await fill(page.getByLabel("Field name", { exact: true }), "item");
    await fill(page.getByLabel("Default value", { exact: true }), "default");
    const chooser = page.waitForEvent("filechooser"); await click(button("Load CSV")); await chooser;
    await upload(by("App-003"), "data.csv", "text/csv", Buffer.from("source,qty\nfirst,1\nsecond,2\n"));
    await page.getByText(/2 rows loaded/).waitFor();
    await select(page.getByRole("dialog").getByLabel("item", { exact: true }), "source");
    await select(page.getByLabel("Quantity column", { exact: true }), "qty");
    await fill(page.getByLabel("Preview row", { exact: true }), 2);
    assert.match(await page.locator(".csv-sample").textContent(), /second/);
    const printer = (await api("/printers"))[0];
    await select(page.getByRole("dialog").getByLabel("Printer", { exact: true }), printer.id);
    await click(button("Validate & queue batch")); await page.getByRole("dialog", { name: "Print Jobs" }).waitFor();
    const jobs = await api("/jobs"); assert.equal(jobs.length, 2); assert.deepEqual(jobs.map(j => j.quantity).sort(), [1, 2]); await close();
    await click(button("Named fields and CSV"));
    await upload(by("App-003"), "replacement.csv", "text/csv", Buffer.from("item\nreplacement\n"));
    await page.getByText(/1 rows loaded/).waitFor(); assert.equal(await page.getByLabel("Quantity column", { exact: true }).inputValue(), "");
    await close();
    await load(project("Clean data state")); await click(button("Named fields and CSV")); assert.equal(await page.getByText(/rows loaded/).count(), 0); await close();
  });

  await run("preview, inputs, download, stale compilation, print and reprint/cancel", async () => {
    await load(project("Preview audit", [rectangle("Preview shape")], [{ name: "item", defaultValue: "one" }, { name: "computed", defaultValue: "", formula: '=UPPER(item)' }]));
    await click(button("Print preview")); await page.getByAltText("Authoritative monochrome print preview").waitFor();
    await mark(page.getByRole("dialog").getByLabel("Printer", { exact: true }));
    await page.getByRole("dialog").getByLabel("Printer", { exact: true }).selectOption({ index: 0 });
    await click(button("Generate preview")); await page.getByAltText("Authoritative monochrome print preview").waitFor();
    await expectDisabled(page.getByRole("dialog").getByRole("button", { name: "Print", exact: true }));
    await select(page.getByRole("dialog").getByLabel("Printer", { exact: true }), (await api("/printers"))[0].id);
    await click(button("Refresh printers"));
    await expectDisabled(button("Download ZPL"), /valid preview/);
    await fill(page.getByLabel("Identical copies", { exact: true }), 2);
    await fill(page.getByRole("dialog").getByLabel("item", { exact: true }), "two");
    const computed = page.getByRole("dialog").getByLabel("computed", { exact: true });
    assert.equal(await computed.inputValue(), "TWO"); assert.equal(await computed.getAttribute("readonly"), ""); await mark(computed);
    await click(button("Generate preview")); await page.getByAltText("Authoritative monochrome print preview").waitFor();
    const changedPrinter = (await api("/printers"))[0];
    await api(`/printers/${changedPrinter.id}`, { ...changedPrinter, offsetX: 1 }, "PUT");
    await click(button("Refresh printers")); await expectDisabled(button("Download ZPL"), /valid preview/);
    await click(button("Generate preview")); await page.getByAltText("Authoritative monochrome print preview").waitFor();
    await click(page.getByText("Generated ZPL", { exact: true })); assert.match(await page.locator(".zpl-details pre").textContent(), /\^XA/);
    const dlPromise = page.waitForEvent("download"); await click(button("Download ZPL")); const dl = await dlPromise;
    assert.match(readFileSync(await dl.path(), "utf8"), /\^PQ2/);
    await click(page.getByRole("dialog").getByRole("button", { name: "Print", exact: true })); await page.getByRole("dialog", { name: "Print Jobs" }).waitFor();
    await page.getByText("sent", { exact: true }).first().waitFor();
    const before = (await api("/jobs")).length;
    page.once("dialog", d => d.dismiss()); await click(button("Reprint")); assert.equal((await api("/jobs")).length, before);
    page.once("dialog", d => d.accept()); await click(button("Reprint"));
    await page.waitForFunction(n => document.querySelectorAll(".jobs-list > div").length === n, before + 1); assert.equal((await api("/jobs")).length, before + 1);
    await close();
    await click(button("Print (Ctrl+P)")); await page.getByAltText("Authoritative monochrome print preview").waitFor(); await close();
    await menu("File", "Print preview / Print"); await page.getByAltText("Authoritative monochrome print preview").waitFor(); await close();
    await page.keyboard.press("Control+p"); await page.getByAltText("Authoritative monochrome print preview").waitFor(); await close();
    let releaseCompile, compileStarted;
    const compileGate = new Promise(resolve => { releaseCompile = resolve; });
    const started = new Promise(resolve => { compileStarted = resolve; });
    await page.route("**/api/compile", async route => { const response = await route.fetch(); compileStarted(); await compileGate; await route.fulfill({ response }); });
    await mark(button("Print preview")); await button("Print preview").click(); await started;
    await fill(page.getByLabel("Identical copies", { exact: true }), 3); releaseCompile(); await idle();
    assert.equal(await page.getByAltText("Authoritative monochrome print preview").count(), 0, "stale in-flight compilation is discarded");
    await expectDisabled(page.getByRole("dialog").getByRole("button", { name: "Print", exact: true }), /valid preview/);
    await page.unroute("**/api/compile"); await close();
    await picked(["Preview shape"]); await fill(page.getByLabel("xUm", { exact: true }), 20); await page.locator(".canvas-container").focus(); await page.keyboard.press("Control+z");
    assert.equal(await page.getByLabel("xUm", { exact: true }).inputValue(), "5");
    await click(button("Print preview")); await page.getByAltText("Authoritative monochrome print preview").waitFor(); await close();
    // Hold a job in queued state to exercise the conditionally rendered Cancel UI deterministically.
    const queued = { ...(await api("/jobs"))[0], id: "audit-queued", state: "queued" };
    let cancelled = false;
    await page.route("**/api/jobs", route => route.fulfill({ json: [{ ...queued, state: cancelled ? "cancelled" : "queued" }] }));
    await page.route("**/api/jobs/audit-queued/cancel", route => { cancelled = true; return route.fulfill({ json: { ...queued, state: "cancelled" } }); });
    await menu("Tools", "Print jobs"); await click(button("Cancel")); await page.getByText("cancelled", { exact: true }).waitFor(); assert.equal(cancelled, true);
    await close(); await page.unroute("**/api/jobs"); await page.unroute("**/api/jobs/audit-queued/cancel");
    assert.ok(chunks.length > 0, "compiled labels reach only the local fake printer");
  });

  await run("canvas gestures, guides, snap, resize, rotation and pan", async () => {
    await load(project("Canvas audit", [rectangle("Canvas A", 10000, 10000), rectangle("Canvas B", 40000, 10000)]));
    await mark(page.locator(".canvas-container"));
    const box = await page.locator(".canvas-container").boundingBox();
    const point = (x, y) => ({ x: box.x + x, y: box.y + y });
    const drag = async (x1, y1, x2, y2) => { const a = point(x1, y1), b = point(x2, y2); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); };
    await page.mouse.click(box.x + 140, box.y + 145); assert.equal(await page.getByLabel("Object name", { exact: true }).inputValue(), "Canvas A");
    await drag(140, 145, 156, 161);
    let es = (await save()).templates[0].elements; assert.equal(es[0].xUm % 1000, 0); assert.notEqual(es[0].xUm, 10000);
    await page.mouse.dblclick(box.x + 156, box.y + 161);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Object name");
    await drag(90, 100, 340, 200); assert.equal(await page.locator(".object-tree .selected").count(), 2);
    await page.keyboard.down("Shift"); await page.mouse.click(box.x + 156, box.y + 161); await page.keyboard.up("Shift");
    assert.equal(await page.locator(".object-tree .selected").count(), 1);
    await picked(["Canvas A"]);
    es = (await save()).templates[0].elements;
    const e = es[0], right = 70 + (e.xUm + e.widthUm) * .005 + 2, bottom = 75 + (e.yUm + e.heightUm) * .005 + 2;
    await drag(right, bottom, right + 20, bottom + 15);
    let resized = (await save()).templates[0].elements[0]; assert.ok(resized.widthUm > e.widthUm); assert.ok(resized.heightUm > e.heightUm);
    const cx = 70 + (resized.xUm + resized.widthUm / 2) * .005, top = 75 + resized.yUm * .005 - 52;
    await drag(cx, top, cx + 50, top + 40);
    assert.notEqual((await save()).templates[0].elements[0].rotation, 0);
    await drag(180, 12, 180, 175); await drag(12, 220, 350, 220);
    const guides = (await save()).templates[0].guides; assert.equal(guides.length, 2); assert.deepEqual(guides.map(g => g.axis).sort(), ["x", "y"]);
    const vertical = guides.find(g => g.axis === "x"); await drag(70 + vertical.positionUm * .005, 280, 70 + vertical.positionUm * .005 + 20, 280);
    assert.notEqual((await save()).templates[0].guides.find(g => g.id === vertical.id).positionUm, vertical.positionUm);
    const horizontal = guides.find(g => g.axis === "y"); await page.mouse.dblclick(box.x + 450, box.y + 75 + horizontal.positionUm * .005);
    assert.equal((await save()).templates[0].guides.length, 1);
    const beforePan = (await save()).templates[0];
    await page.locator(".canvas-container").focus();
    await page.keyboard.down("Space"); await drag(600, 350, 620, 370); await page.keyboard.up("Space");
    assert.deepEqual((await save()).templates[0], beforePan, "panning changes the view without moving elements or guides");
    // Ruler ticks move with the label: create a guide at its new origin plus 50 px.
    await drag(140, 12, 140, 200);
    const afterPan = (await save()).templates[0];
    assert.equal(afterPan.guides.at(-1).positionUm, 21000, "panning shifts the ruler coordinate origin by 20 px");
    await page.screenshot({ path: resolve(out, "canvas.png") });
  });

  await run("publishing, navigation, error feedback, font upload and BTW import report", async () => {
    const publicationProject = await load(project("Publication audit"));
    await click(button("Publish label")); await button("Republish label").waitFor();
    const publication = (await api("/publications")).find(p => p.projectId === publicationProject.id);
    assert.equal(publication.published, true);
    await click(button("Republish label")); await page.getByText(/Published Audit template/).waitFor();
    assert.equal((await api("/publications")).find(p => p.projectId === publicationProject.id).version, publication.version + 1);
    await click(button("Unpublish label")); await button("Publish label").waitFor();
    assert.equal((await api("/publications")).find(p => p.projectId === publicationProject.id).published, false);
    await click(button("Switch to Printer")); assert.equal(new URL(page.url()).pathname, "/printer");
    await page.getByRole("button", { name: "Switch to Editor", exact: true }).click(); assert.equal(new URL(page.url()).pathname, "/editor");
    await click(button("Sign out")); assert.equal(await page.evaluate(() => document.documentElement.dataset.signOutCalls), "1");
    await page.route("**/api/projects", route => route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: "Audit library unavailable" } }) : route.continue());
    await click(button("Open project")); await page.getByRole("alert").filter({ hasText: "Audit library unavailable" }).waitFor();
    await click(button("Dismiss error")); assert.equal(await page.locator(".notice.error").count(), 0); await page.unroute("**/api/projects");
    await click(button("Insert text")); await fill(page.getByLabel("Text content", { exact: true }), "Before upload");
    let releaseAsset, assetStarted;
    const assetGate = new Promise(resolve => { releaseAsset = resolve; });
    const assetRequest = new Promise(resolve => { assetStarted = resolve; });
    await page.route("**/api/assets", async route => { const response = await route.fetch(); assetStarted(); await assetGate; await route.fulfill({ response }); });
    await menu("Administer", "Upload font");
    page.once("dialog", d => d.accept("Audit Arial"));
    await upload(by("App-004"), "arial.ttf", "font/ttf", readFileSync("C:/Windows/Fonts/arial.ttf"));
    await assetRequest; await fill(page.getByLabel("Text content", { exact: true }), "During upload");
    releaseAsset(); await idle(); await page.unroute("**/api/assets");
    await page.getByLabel("Font family", { exact: true }).locator("option", { hasText: "Audit Arial" }).waitFor({ state: "attached" });
    await select(page.getByLabel("Font family", { exact: true }), "Audit Arial");
    const uploaded = await save(); assert.equal(uploaded.assets.find(a => a.kind === "font").name, "Audit Arial");
    assert.equal(uploaded.templates[0].elements[0].text, "During upload", "upload does not overwrite edits made while it was pending");
    // Fixture the import response; actual envelope decoding is covered by btw.test.ts.
    const imported = project("Imported audit", [rectangle("Imported object")]);
    await page.route("**/api/import/btw", route => route.fulfill({ json: { id: "audit-import" } }));
    await page.route("**/api/import/audit-import", route => route.fulfill({ json: { status: "complete", archiveVersion: 113002, project: imported, diagnostics: [] } }));
    const chooser = page.waitForEvent("filechooser"); await menu("File", "Import BTW / Barista project"); await chooser;
    await upload(by("App-001"), "audit.btw", "application/octet-stream", Buffer.from("fixture"));
    await page.getByRole("dialog", { name: "BarTender Import Report" }).waitFor(); await click(button("Open imported project"));
    assert.equal(await page.locator(".object-tree button").textContent(), "Imported object");
    await page.unroute("**/api/import/btw"); await page.unroute("**/api/import/audit-import");
    const portable = zipSync({ "manifest.json": strToU8(JSON.stringify(project("Repeated file audit"))) });
    await upload(by("App-001"), "repeat.barista", "application/zip", Buffer.from(portable));
    await page.waitForFunction(() => document.querySelector(".header-name")?.textContent?.includes("Repeated file audit"));
    await upload(by("App-001"), "repeat.barista", "application/zip", Buffer.from(portable));
    await page.waitForFunction(() => !document.querySelector('[aria-label="Save project (Ctrl+S)"]').disabled);
    assert.equal((await api("/projects")).filter(p => p.name === "Repeated file audit").length, 2, "choosing the same file again triggers import again");
  });

  assert.deepEqual(errors, [], "no browser runtime errors");
  const missing = controls.filter(c => !verified.has(c.id));
  writeFileSync(resolve(out, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), complete: from === 1 && missing.length === 0 && errors.length === 0, fromScenario: from, results, controls: controls.map(c => ({ ...c, verifiedBy: verified.get(c.id) ?? [], seen: seen.has(c.id) })), variants: [...variants], browserErrors: errors }, null, 2));
  if (from === 1) {
    assert.deepEqual(missing.map(c => `${c.id} ${c.label}`), [], "Every interactive source site must have a verified outcome");
    console.log(`Editor audit passed: ${controls.length} control sites, ${variants.size} runtime variants, ${results.length} scenarios.`);
  } else console.log(`Partial diagnostic run passed from scenario ${from}; full coverage was not checked.`);
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(out, "failure.png"), fullPage: true }).catch(() => {}); writeFileSync(resolve(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot().catch(() => "")); }
  writeFileSync(resolve(out, "partial-report.json"), JSON.stringify({ testName, results, verified: Object.fromEntries(verified), pending: [...pending], errors }, null, 2));
  console.error(`FAILED ${testName}: ${error.message}\n${logs.slice(-1000)}`);
  throw error;
} finally {
  await browser?.close(); server.kill(); await new Promise(resolve => fakePrinter.close(resolve));
}
