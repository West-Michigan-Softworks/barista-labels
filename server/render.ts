import { evaluateFormula, resolveFormulaSources } from "../shared/formula";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import bwipjs from "bwip-js/node";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fitBarcode, printerDots } from "../shared/barcode";

// Physical geometry is rounded exactly once. A renderer pixel is a printer dot.
export const dots = printerDots;
export type Diagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  elementId?: string;
};
type Element = {
  id: string;
  type: string;
  xUm: number;
  yUm: number;
  widthUm: number;
  heightUm: number;
  rotation?: number;
  text?: string;
  dataMode?: "literal" | "template" | "formula";
  fontFamily?: string;
  fontSizeUm?: number;
  lineHeightUm?: number;
  bold?: boolean;
  align?: string;
  strokeUm?: number;
  cornerRadiusUm?: number;
  fill?: string;
  symbology?: string;
  value?: string;
  assetId?: string;
};
type Project = {
  templates: {
    id: string;
    widthUm: number;
    heightUm: number;
    elements: Element[];
  }[];
  variables?: { name: string; defaultValue?: string; formula?: string }[];
  assets?: {
    id: string;
    fileName?: string;
    mimeType?: string;
    name?: string;
    kind?: string;
  }[];
  importDiagnostics?: Diagnostic[];
};
type Printer = {
  dotsPerMm: number;
  widthDots: number;
  offsetX?: number;
  offsetY?: number;
  media?: "gap" | "continuous" | "mark";
};
export type Compilation = {
  zpl: string;
  previewBase64: string;
  widthDots: number;
  heightDots: number;
  diagnostics: Diagnostic[];
};

let browserPromise: Promise<Browser> | undefined;
let rendering = 0;
const waiting: (() => void)[] = [];
async function acquireRender() {
  if (rendering >= 2) {
    if (waiting.length >= 64)
      throw new Error("Renderer is busy; retry shortly.");
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else rendering++;
  return () => {
    const next = waiting.shift();
    if (next) next();
    else rendering--;
  };
}
async function browser() {
  if (!browserPromise)
    browserPromise = (async () => {
      // Workspace cache survives Windows sandbox processes whose LOCALAPPDATA
      // paths differ. Browser installation uses the same pinned Playwright revision.
      const expected = chromium.executablePath();
      const parts = expected.split(path.sep),
        revision = parts.findIndex((p) => /^chromium-\d+$/.test(p));
      const cached =
        revision >= 0
          ? path.resolve(".cache/ms-playwright", ...parts.slice(revision))
          : "";
      let executablePath: string | undefined;
      if (!process.env.PLAYWRIGHT_BROWSERS_PATH && cached) {
        try {
          await access(cached);
          executablePath = cached;
        } catch {
          /* normal Playwright installation */
        }
      }
      return chromium.launch({ headless: true, executablePath });
    })().catch((error) => {
      browserPromise = undefined;
      throw error;
    });
  return browserPromise;
}
export async function closeRenderer() {
  const pending = browserPromise;
  browserPromise = undefined;
  if (pending) await (await pending).close();
}
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function resolveFields(
  value: string,
  data: Record<string, string>,
  diagnostics: Diagnostic[],
  elementId: string,
) {
  return value.replace(/\{\{([A-Za-z_][\w.-]*)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(data, name)) {
      diagnostics.push({
        severity: "error",
        code: "MISSING_VARIABLE",
        message: `Missing value for ${name}.`,
        elementId,
      });
      return "";
    }
    return data[name];
  });
}

// MSB first; white padding at the end of every scanline. Zebra ^GF reference:
// https://docs.zebra.com/content/tcm/us/en/printers/software/zpl-pg/zpl-commands/%5Egf.html
export function packMonochrome(
  pixels: Uint8Array,
  width: number,
  height: number,
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    pixels.length !== width * height
  )
    throw new Error("Invalid monochrome raster dimensions.");
  const bytesPerRow = Math.ceil(width / 8);
  const packed = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (pixels[y * width + x] < 128)
        packed[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7);
  return { packed, bytesPerRow };
}
export function graphicZpl(pixels: Uint8Array, width: number, height: number) {
  const { packed, bytesPerRow } = packMonochrome(pixels, width, height);
  if (bytesPerRow > 99999)
    throw new Error("Graphic row exceeds ZPL field limits.");
  const rowsPerField = Math.floor(99999 / bytesPerRow);
  const fields: string[] = [];
  for (let y = 0; y < height; y += rowsPerField) {
    const strip = packed.subarray(
      y * bytesPerRow,
      Math.min(height, y + rowsPerField) * bytesPerRow,
    );
    fields.push(
      `^FO0,${y}^GFA,${strip.length},${strip.length},${bytesPerRow},${strip.toString("hex").toUpperCase()}^FS`,
    );
  }
  return fields.join("\n");
}

const systemFonts: Record<string, string> =
  process.platform === "win32"
    ? {
        Arial: "C:/Windows/Fonts/arial.ttf",
        "Courier New": "C:/Windows/Fonts/cour.ttf",
        "Times New Roman": "C:/Windows/Fonts/times.ttf",
      }
    : {
        Arial:
          "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "Courier New":
          "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
        "Times New Roman":
          "/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf",
      };
// Validate Unicode coverage rather than silently accepting OS fallback fonts.
// Original parser for the documented OpenType cmap formats 4 and 12:
// https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
export function fontHasGlyph(font: Buffer, codepoint: number): boolean {
  const u16 = (at: number) => font.readUInt16BE(at),
    u32 = (at: number) => font.readUInt32BE(at);
  let cmap = -1;
  for (let i = 0; i < u16(4); i++) {
    const at = 12 + i * 16;
    if (font.toString("ascii", at, at + 4) === "cmap") {
      cmap = u32(at + 8);
      break;
    }
  }
  if (cmap < 0) throw new Error("Font has no Unicode character map.");
  for (let i = 0; i < u16(cmap + 2); i++) {
    const rec = cmap + 4 + i * 8,
      platform = u16(rec),
      encoding = u16(rec + 2),
      at = cmap + u32(rec + 4);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding)))
      continue;
    if (u16(at) === 12) {
      for (let g = 0; g < u32(at + 12); g++) {
        const p = at + 16 + g * 12,
          start = u32(p),
          end = u32(p + 4);
        if (codepoint >= start && codepoint <= end)
          return u32(p + 8) + codepoint - start !== 0;
      }
    } else if (u16(at) === 4 && codepoint <= 65535) {
      const count = u16(at + 6) / 2,
        ends = at + 14,
        starts = ends + count * 2 + 2,
        deltas = starts + count * 2,
        offsets = deltas + count * 2;
      for (let g = 0; g < count; g++)
        if (
          codepoint >= u16(starts + g * 2) &&
          codepoint <= u16(ends + g * 2)
        ) {
          const delta = u16(deltas + g * 2),
            offset = u16(offsets + g * 2);
          if (!offset) return ((codepoint + delta) & 65535) !== 0;
          const glyph = u16(
            offsets + g * 2 + offset + (codepoint - u16(starts + g * 2)) * 2,
          );
          return glyph !== 0 && ((glyph + delta) & 65535) !== 0;
        }
    }
  }
  return false;
}
export type AssetSource =
  string | { readAsset(id: string): Promise<Buffer | undefined> };
async function assetBytes(source: AssetSource, fileName: string) {
  if (
    !fileName ||
    path.basename(fileName) !== fileName ||
    fileName.includes("..")
  )
    throw new Error("Invalid asset file name.");
  const bytes =
    typeof source === "string"
      ? await readFile(path.join(source, fileName))
      : await source.readAsset(fileName);
  if (!bytes) throw new Error("Asset content is missing.");
  return bytes;
}
async function fontData(
  family: string,
  project: Project,
  assetsDir: AssetSource,
) {
  if (!/^[\p{L}\p{N}_ -]{1,80}$/u.test(family))
    throw new Error("Font family name is invalid.");
  const asset = project.assets?.find(
    (a) => a.kind === "font" && a.name === family,
  );
  if (asset) {
    if (!asset.fileName || path.basename(asset.fileName) !== asset.fileName)
      throw new Error("Invalid font asset file name.");
    return (await assetBytes(assetsDir, asset.fileName)).toString("base64");
  }
  let file = systemFonts[family];
  if (!file && process.env.BARISTA_FONT_DIR && /^[\w -]{1,80}$/.test(family))
    file = path.join(process.env.BARISTA_FONT_DIR, `${family}.ttf`);
  if (!file)
    throw new Error(`Font ${family} is unavailable; choose an installed font.`);
  await access(file);
  return (await readFile(file)).toString("base64");
}
async function assetData(
  project: Project,
  id: string | undefined,
  assetsDir: AssetSource,
) {
  const asset = project.assets?.find((a) => a.id === id);
  if (!asset?.fileName || path.basename(asset.fileName) !== asset.fileName)
    throw new Error("Image asset is missing or has an invalid file name.");
  // Decode and re-encode: no external references, SVG scripts, or browser file access.
  const png = await sharp(await assetBytes(assetsDir, asset.fileName), {
    limitInputPixels: 16_000_000,
  })
    .rotate()
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

export async function compileProject(
  project: Project,
  templateId: string,
  data: Record<string, string>,
  printer: Printer,
  assetsDir: AssetSource,
  options: { quantity?: number } = {},
): Promise<Compilation> {
  const quantity = options.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000)
    throw new Error("Quantity must be an integer from 1 to 10000.");
  const diagnostics: Diagnostic[] = [...(project.importDiagnostics ?? [])];
  const template = project.templates.find((t) => t.id === templateId);
  if (!template) throw new Error("Unknown label template.");
  if (
    !Number.isFinite(printer.dotsPerMm) ||
    printer.dotsPerMm < 1 ||
    printer.dotsPerMm > 30
  )
    throw new Error("Invalid printer resolution.");
  const widthDots = dots(template.widthUm, printer.dotsPerMm),
    heightDots = dots(template.heightUm, printer.dotsPerMm);
  if (
    widthDots < 1 ||
    heightDots < 1 ||
    widthDots > 8000 ||
    heightDots > 8000 ||
    widthDots * heightDots > 16_000_000
  )
    throw new Error("Label dimensions exceed renderer limits.");
  if (widthDots > printer.widthDots)
    diagnostics.push({
      severity: "error",
      code: "PRINTER_WIDTH",
      message: "Label exceeds printer printable width.",
    });
  const offsetX = printer.offsetX ?? 0,
    offsetY = printer.offsetY ?? 0;
  if (
    ![offsetX, offsetY].every((n) => Number.isInteger(n) && n >= 0 && n <= 8000)
  )
    throw new Error("Printer offsets must be non-negative integer dots.");
  if (widthDots + offsetX > printer.widthDots)
    diagnostics.push({
      severity: "error",
      code: "PRINTER_OFFSET",
      message: "Label and horizontal offset exceed printer printable width.",
    });
  const resolvedSources = resolveFormulaSources(project.variables ?? [], data);
  const values = resolvedSources.values;
  for (const error of resolvedSources.errors)
    diagnostics.push({
      severity: "error",
      code: "INVALID_FORMULA_SOURCE",
      message: `${error.name}: ${error.message}`,
    });
  const fonts = new Map<string, string>();
  const markup: string[] = [];
  const bounds: {
    element: Element;
    x: number;
    y: number;
    w: number;
    h: number;
    stroke: number;
  }[] = [];
  for (const element of template.elements) {
    try {
      const x = dots(element.xUm, printer.dotsPerMm),
        y = dots(element.yUm, printer.dotsPerMm),
        w = dots(element.widthUm, printer.dotsPerMm);
      const stroke = Math.max(
        0,
        dots(element.strokeUm ?? 125, printer.dotsPerMm),
      );
      const h =
        element.type === "line"
          ? Math.max(1, stroke)
          : dots(element.heightUm, printer.dotsPerMm);
      if (element.type === "line" && stroke < 1)
        throw new Error(
          "A line must have at least one printer dot of stroke thickness.",
        );
      if (
        ![x, y, w, h, element.rotation ?? 0].every(Number.isFinite) ||
        w < 1 ||
        h < 1
      )
        throw new Error("Object has invalid geometry.");
      // Rotate around top-left, matching editor and compiler. Warn/block any rotated bounds outside stock.
      const angle = ((element.rotation ?? 0) * Math.PI) / 180;
      const corners = [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ].map(([cx, cy]) => [
        x + cx! * Math.cos(angle) - cy! * Math.sin(angle),
        y + cx! * Math.sin(angle) + cy! * Math.cos(angle),
      ]);
      if (
        corners.some(
          ([cx, cy]) =>
            cx! < -0.01 ||
            cy! < -0.01 ||
            cx! > widthDots + 0.01 ||
            cy! > heightDots + 0.01,
        )
      )
        diagnostics.push({
          severity: "error",
          code: "OUTSIDE_LABEL",
          message: "Object extends outside the label.",
          elementId: element.id,
        });
      bounds.push({ element, x, y, w, h, stroke });
      const style = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:rotate(${element.rotation ?? 0}deg);transform-origin:0 0;box-sizing:border-box;`;
      let inner: string;
      if (element.type === "text") {
        const family = element.fontFamily ?? "Arial";
        if (!fonts.has(family))
          fonts.set(family, await fontData(family, project, assetsDir));
        const size = Math.max(
          1,
          dots(element.fontSizeUm ?? 3500, printer.dotsPerMm),
        );
        const text =
          element.dataMode === "formula"
            ? evaluateFormula(element.text ?? "", values)
            : element.dataMode === "literal"
              ? (element.text ?? "")
              : resolveFields(
                  element.text ?? "",
                  values,
                  diagnostics,
                  element.id,
                );
        const font = Buffer.from(fonts.get(family)!, "base64");
        const missing = [
          ...new Set(
            [...text].filter(
              (c) =>
                !["\n", "\r", "\t"].includes(c) &&
                !fontHasGlyph(font, c.codePointAt(0)!),
            ),
          ),
        ];
        if (missing.length)
          throw new Error(
            `Font ${family} lacks characters ${missing.slice(0, 8).join(" ")}; choose or upload a font containing them.`,
          );
        const lineHeight =
          element.lineHeightUm === undefined
            ? "1.15"
            : `${Math.max(1, dots(element.lineHeightUm, printer.dotsPerMm))}px`;
        inner = `<div data-text-id="${escape(element.id)}" style="${style}font-family:'${escape(family)}';font-size:${size}px;font-weight:${element.bold ? 700 : 400};line-height:${lineHeight};text-align:${["left", "center", "right"].includes(element.align ?? "") ? element.align : "left"};white-space:pre-wrap;overflow:hidden;overflow-wrap:break-word;">${escape(text)}</div>`;
      } else if (["rectangle", "ellipse", "line"].includes(element.type)) {
        const fill =
          element.fill === "black"
            ? "#000"
            : element.fill === "white"
              ? "#fff"
              : "none";
        const shape =
          element.type === "ellipse"
            ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, (w - stroke) / 2)}" ry="${Math.max(0, (h - stroke) / 2)}"/>`
            : element.type === "line"
              ? `<line x1="0" y1="${stroke / 2}" x2="${w}" y2="${stroke / 2}"/>`
              : `<rect x="${stroke / 2}" y="${stroke / 2}" width="${Math.max(0, w - stroke)}" height="${Math.max(0, h - stroke)}" rx="${Math.min(dots(element.cornerRadiusUm ?? 0, printer.dotsPerMm), Math.max(0, w - stroke) / 2, Math.max(0, h - stroke) / 2)}"/>`;
        inner = `<svg style="${style}" viewBox="0 0 ${w} ${h}"><g fill="${fill}" stroke="black" stroke-width="${stroke}">${shape}</g></svg>`;
      } else if (element.type === "image") {
        inner = `<img style="${style}object-fit:contain" src="${await assetData(project, element.assetId, assetsDir)}"/>`;
      } else if (element.type === "barcode") {
        const text =
          element.dataMode === "formula"
            ? evaluateFormula(element.value ?? "", values)
            : element.dataMode === "literal"
              ? (element.value ?? "")
              : resolveFields(
                  element.value ?? "",
                  values,
                  diagnostics,
                  element.id,
                );
        const fitted = await fitBarcode(
          element.symbology ?? "",
          text,
          w,
          h,
          async (options) => {
            const image = await bwipjs.toBuffer(options);
            const meta = await sharp(image).metadata();
            return { image, width: meta.width!, height: meta.height! };
          },
        );
        const png = await sharp(fitted.image)
          .resize(fitted.width, fitted.height, { kernel: "nearest" })
          .png()
          .toBuffer();
        inner = `<div style="${style}"><img style="position:absolute;left:${fitted.offsetX}px;top:0" width="${fitted.width}" height="${fitted.height}" src="data:image/png;base64,${png.toString("base64")}"/></div>`;
      } else throw new Error(`Unsupported object type ${element.type}.`);
      markup.push(inner);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code:
          element.dataMode === "formula"
            ? "INVALID_FORMULA"
            : element.type === "text"
              ? "FONT_OR_TEXT"
              : element.type === "barcode"
                ? "INVALID_BARCODE"
                : "INVALID_ELEMENT",
        message: (error as Error).message,
        elementId: element.id,
      });
    }
  }
  if (diagnostics.some((d) => d.severity === "error"))
    return { zpl: "", previewBase64: "", widthDots, heightDots, diagnostics };
  const release = await acquireRender();
  let page: Page | undefined;
  try {
    page = await (
      await browser()
    ).newPage({
      viewport: { width: widthDots, height: heightDots },
      deviceScaleFactor: 1,
    });
    await page.route("**/*", (route) => route.abort());
    const faces = [...fonts]
      .map(
        ([family, base64]) =>
          `@font-face{font-family:'${escape(family)}';src:url(data:font/ttf;base64,${base64}) format('truetype');}`,
      )
      .join("");
    await page.setContent(
      `<html><head><meta charset="utf-8"><style>${faces}html,body{margin:0;padding:0;width:${widthDots}px;height:${heightDots}px;overflow:hidden;background:white;color:black;}*{animation:none!important}</style></head><body>${markup.join("")}</body></html>`,
    );
    await page.evaluate(async () => {
      // Explicitly load declared faces even for empty text; unused faces are
      // otherwise "unloaded", which must not be mistaken for corrupt fonts.
      await Promise.allSettled([...document.fonts].map((face) => face.load()));
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
    });
    const failedFonts = await page.evaluate(() =>
      [...document.fonts]
        .filter((face) => face.status !== "loaded")
        .map((face) => face.family),
    );
    if (failedFonts.length) {
      diagnostics.push({
        severity: "error",
        code: "INVALID_FONT_FILE",
        message: `Fonts could not be loaded: ${failedFonts.join(", ")}. Replace the font files.`,
      });
      return { zpl: "", previewBase64: "", widthDots, heightDots, diagnostics };
    }
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-text-id]")]
        .filter(
          (el) =>
            el.scrollHeight > el.clientHeight ||
            el.scrollWidth > el.clientWidth,
        )
        .map((el) => el.dataset.textId!),
    );
    if (overflowing.length) {
      diagnostics.push(
        ...overflowing.map((elementId) => ({
          severity: "error" as const,
          code: "TEXT_OVERFLOW",
          message:
            "Text does not fit in its box; enlarge it or reduce the font size.",
          elementId,
        })),
      );
      return { zpl: "", previewBase64: "", widthDots, heightDots, diagnostics };
    }
    const screenshot = await page.screenshot({
      type: "png",
      animations: "disabled",
    });
    const { data: pixels } = await sharp(screenshot)
      .flatten({ background: "#fff" })
      .greyscale()
      .threshold(128)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const preview = await sharp(pixels, {
      raw: { width: widthDots, height: heightDots, channels: 1 },
    })
      .png()
      .toBuffer();
    // Only isolated, axis-aligned boxes/lines use native ^GB. Verify every dot
    // against the authoritative raster first; rounded/antialiased mismatches stay raster.
    const remaining = Buffer.from(pixels),
      native: string[] = [];
    for (const box of bounds) {
      const { element, x, y, w, h, stroke } = box;
      if (
        !["rectangle", "line"].includes(element.type) ||
        (element.rotation ?? 0) % 360 !== 0 ||
        element.fill === "white"
      )
        continue;
      if (
        bounds.some(
          (other) =>
            other !== box &&
            ((other.element.rotation ?? 0) % 360 !== 0 ||
              (x < other.x + other.w &&
                x + w > other.x &&
                y < other.y + other.h &&
                y + h > other.y)),
        )
      )
        continue;
      const thickness =
        element.type === "line" || element.fill === "black"
          ? Math.min(w, h)
          : stroke;
      if (thickness < 1 || thickness > Math.min(w, h)) continue;
      let equivalent = true;
      for (let yy = 0; yy < h && equivalent; yy++)
        for (let xx = 0; xx < w; xx++) {
          const black =
            xx < thickness ||
            yy < thickness ||
            xx >= w - thickness ||
            yy >= h - thickness;
          if (pixels[(y + yy) * widthDots + x + xx] !== (black ? 0 : 255)) {
            equivalent = false;
            break;
          }
        }
      if (!equivalent) continue;
      native.push(`^FO${x},${y}^GB${w},${h},${thickness},B,0^FS`);
      for (let yy = 0; yy < h; yy++)
        remaining.fill(
          255,
          (y + yy) * widthDots + x,
          (y + yy) * widthDots + x + w,
        );
    }
    const media =
      printer.media === "continuous"
        ? "N"
        : printer.media === "mark"
          ? "M"
          : "Y";
    const zpl = `^XA\n^PON\n^PMN\n^LRN\n^LS0\n^LT0\n^PW${widthDots + offsetX}\n^LL${heightDots + offsetY}\n^LH${offsetX},${offsetY}\n^MN${media}\n${graphicZpl(remaining, widthDots, heightDots)}\n${native.join("\n")}\n^PQ${quantity}\n^XZ\n`;
    return {
      zpl,
      previewBase64: preview.toString("base64"),
      widthDots,
      heightDots,
      diagnostics,
    };
  } finally {
    try {
      await page?.close();
    } finally {
      release();
    }
  }
}
