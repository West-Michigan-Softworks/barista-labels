import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import bwipjs from "bwip-js/node";
import sharp from "sharp";
import { fitBarcode, printerDots, type BarcodeOptions } from "../shared/barcode";

const cases = {
  code128: "BY-10482", "gs1-128": "(01)09501101530003(10)ABC",
  code39: "ABC-123", ean13: "5901234123457", upca: "036000291452",
  qrcode: "https://example.invalid/local", datamatrix: "ABC-123",
};

test("browser and server barcode fitting produces identical pixels at every printer resolution", async () => {
  const parts = chromium.executablePath().split(path.sep);
  const revision = parts.findIndex(part => /^chromium-\d+$/.test(part));
  const cached = path.resolve(".cache/ms-playwright", ...parts.slice(revision));
  const browser = await chromium.launch({ headless: true,
    executablePath: !process.env.PLAYWRIGHT_BROWSERS_PATH && revision >= 0 && existsSync(cached) ? cached : undefined });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: "node_modules/bwip-js/dist/bwip-js.js" });
    for (const dotsPerMm of [8, 12, 24]) {
      for (const [symbology, text] of Object.entries(cases)) {
        const width = printerDots(98765, dotsPerMm), height = printerDots(29876, dotsPerMm);
        const server = await fitBarcode(symbology, text, width, height, async options => {
          const image = await bwipjs.toBuffer(options);
          const metadata = await sharp(image).metadata();
          return { image, width: metadata.width!, height: metadata.height! };
        });
        const client = await fitBarcode(symbology, text, width, height, async (options: BarcodeOptions) => {
          const result = await page.evaluate(options => {
            const canvas = document.createElement("canvas");
            (window as unknown as { bwipjs: { toCanvas: (canvas: HTMLCanvasElement, options: BarcodeOptions) => void } }).bwipjs.toCanvas(canvas, options);
            return { image: canvas.toDataURL().split(",")[1], width: canvas.width, height: canvas.height };
          }, options);
          return { ...result, image: Buffer.from(result.image, "base64") };
        });
        assert.equal(client.width, server.width, symbology);
        assert.equal(client.height, server.height, symbology);
        assert.equal(client.offsetX, server.offsetX, symbology);
        assert.ok(Math.abs(server.offsetX - (width - server.width - server.offsetX)) <= 1);
        const pixels = async (image: Buffer) => sharp(image).resize(server.width, server.height, { kernel: "nearest" }).flatten({ background: "white" }).greyscale().raw().toBuffer();
        assert.deepEqual(await pixels(client.image), await pixels(server.image), `${symbology} at ${dotsPerMm} dots/mm`);
      }
    }
  } finally { await browser.close(); }
});

test("barcode boxes too small for modules and quiet zones are rejected", async () => {
  await assert.rejects(fitBarcode("qrcode", "ABC", 1, 1, async options => {
    const image = await bwipjs.toBuffer(options);
    const metadata = await sharp(image).metadata();
    return { image, width: metadata.width!, height: metadata.height! };
  }), /does not fit/);
});


test("linear barcode fills its height while retaining horizontal quiet zones", async () => {
  const fitted = await fitBarcode("code128", "BY-10482", 520, 128, async options => {
    const image = await bwipjs.toBuffer(options);
    const metadata = await sharp(image).metadata();
    return { image, width: metadata.width!, height: metadata.height! };
  });
  const { data, info } = await sharp(fitted.image)
    .resize(fitted.width, fitted.height, { kernel: "nearest" })
    .flatten({ background: "white" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const rows = new Set<number>(), columns = new Set<number>();
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[y * info.width + x] === 0) { rows.add(y); columns.add(x); }
  assert.ok(rows.size >= 124, "Bars should occupy at least 97% of the requested height");
  assert.ok(Math.min(...columns) >= 20, "Keep the left quiet zone at the fitted module scale");
  assert.ok(info.width - 1 - Math.max(...columns) >= 20, "Keep the right quiet zone");
});
