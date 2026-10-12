import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  dots,
  packMonochrome,
  graphicZpl,
  resolveFields,
  compileProject,
  closeRenderer,
} from "../server/render.js";

test("centered barcode boxes center the printed bars as data and resolution change", async () => {
  try {
    for (const dotsPerMm of [8, 12, 24]) {
      for (const value of ["ABC", "BY-10482", "12345678901234567890"]) {
        const barcode = { id: "bc", type: "barcode", xUm: 10000, yUm: 5000,
          widthUm: 80000, heightUm: 15000, symbology: "code128", value, dataMode: "literal" as const };
        const result = await compileProject({ templates: [{ id: "t", widthUm: 100000,
          heightUm: 30000, elements: [barcode] }] }, "t", {}, { dotsPerMm, widthDots: 100 * dotsPerMm }, ".");
        assert.deepEqual(result.diagnostics, []);
        const pixels = await sharp(Buffer.from(result.previewBase64, "base64")).greyscale().raw().toBuffer();
        let left = result.widthDots, right = -1;
        for (let i = 0; i < pixels.length; i++) {
          if (pixels[i] === 0) {
            left = Math.min(left, i % result.widthDots);
            right = Math.max(right, i % result.widthDots);
          }
        }
        assert.ok(right >= left, "Barcode must contain ink");
        assert.ok(Math.abs(left - (result.widthDots - 1 - right)) <= 1,
          `${value} at ${dotsPerMm} dots/mm has unequal label margins: ${left}, ${result.widthDots - 1 - right}`);
        // Decode the actual printer graphic and compare every dot to the preview.
        const printed = new Uint8Array(pixels.length).fill(255);
        for (const match of result.zpl.matchAll(/\^FO(\d+),(\d+)\^GFA,(\d+),(\d+),(\d+),([A-F0-9]+)/g)) {
          const [, x, y, , , rowBytes, hex] = match;
          const packed = Buffer.from(hex!, "hex"), stride = Number(rowBytes);
          for (let i = 0; i < packed.length; i++) {
            for (let bit = 0; bit < 8; bit++) {
              const px = Number(x) + (i % stride) * 8 + bit;
              const py = Number(y) + Math.floor(i / stride);
              if (px < result.widthDots && (packed[i]! & (128 >> bit)))
                printed[py * result.widthDots + px] = 0;
            }
          }
        }
        assert.deepEqual(Buffer.from(printed), pixels, "ZPL must retain the centered preview pixels");
      }
    }
  } finally { await closeRenderer(); }
});

test("physical geometry quantizes consistently for 8, 12 and 24 dots/mm", () => {
  for (const dpm of [8, 12, 24]) {
    assert.equal(dots(25400, dpm), Math.round(25.4 * dpm));
    assert.equal(dots(1000, dpm), dpm);
  }
});
test('line physical thickness comes from stroke, not legacy object height', async () => {
  const line={id:'line',type:'line',xUm:1000,yUm:1000,widthUm:6000,heightUm:100,strokeUm:400,fill:'none'};
  try {
    const result=await compileProject({templates:[{id:'t',widthUm:10000,heightUm:10000,elements:[line]}]},'t',{}, {dotsPerMm:8,widthDots:80},'.');
    assert.equal(result.diagnostics.length,0);
    const pixels=await sharp(Buffer.from(result.previewBase64,'base64')).greyscale().raw().toBuffer();
    assert.equal([...pixels].filter(pixel=>pixel===0).length,48*3);
    assert.ok(result.zpl.includes('^GB48,3,3,B,0'));
    const invalid=await compileProject({templates:[{id:'t',widthUm:10000,heightUm:10000,elements:[{...line,strokeUm:0}]}]},'t',{}, {dotsPerMm:8,widthDots:80},'.');
    assert.equal(invalid.zpl,'');assert.match(invalid.diagnostics[0].message,/at least one printer dot/);
  }finally{await closeRenderer();}
});
test('zero-stroke unfilled rectangle and ellipse produce no ink', async () => {
  const elements=['rectangle','ellipse'].map((type,i)=>({id:type,type,xUm:1000+i*4000,yUm:1000,widthUm:3000,heightUm:3000,strokeUm:0,fill:'none'}));
  try {
    const result=await compileProject({templates:[{id:'t',widthUm:10000,heightUm:10000,elements}]},'t',{}, {dotsPerMm:8,widthDots:80},'.');
    assert.equal(result.diagnostics.length,0);
    const pixels=await sharp(Buffer.from(result.previewBase64,'base64')).greyscale().raw().toBuffer();
    assert.ok([...pixels].every(pixel=>pixel===255));assert.ok(!result.zpl.includes('^GB'));
  }finally{await closeRenderer();}
});
test('explicit physical line height preserves imported natural Arial boxes', async () => {
  try {
    for(const [fontSizeUm,heightUm] of [[4233,4750],[8467,9423]]) for(const dotsPerMm of [8,12]) {
      const text={id:'txt',type:'text',xUm:0,yUm:10000,widthUm:60000,heightUm,lineHeightUm:heightUm,text:'Hello world',fontFamily:'Arial',fontSizeUm,align:'center'};
      const result=await compileProject({templates:[{id:'t',widthUm:100000,heightUm:50000,elements:[text]}]},'t',{}, {dotsPerMm,widthDots:104*dotsPerMm},'.');
      assert.equal(result.diagnostics.length,0,`${fontSizeUm}µm at ${dotsPerMm}dots/mm: ${JSON.stringify(result.diagnostics)}`);
      assert.ok(result.previewBase64);
    }
  }finally{await closeRenderer();}
});
test('literal braces remain literal while template missing inputs block compilation', async () => {
  const text={id:'txt',type:'text',xUm:0,yUm:0,widthUm:60000,heightUm:20000,text:'{{missing}}',fontFamily:'Arial',fontSizeUm:4000,dataMode:'literal' as const};
  const barcode={id:'bc',type:'barcode',xUm:0,yUm:25000,widthUm:60000,heightUm:20000,symbology:'code128',value:'{{missing}}',dataMode:'literal' as const};
  try {
    const result=await compileProject({templates:[{id:'t',widthUm:100000,heightUm:50000,elements:[text,barcode]}]},'t',{}, {dotsPerMm:8,widthDots:832},'.');
    assert.equal(result.diagnostics.length,0);assert.ok(result.zpl);
    const blocked=await compileProject({templates:[{id:'t',widthUm:100000,heightUm:50000,elements:[{...text,dataMode:'template'},{...barcode,dataMode:'template'}]}]},'t',{}, {dotsPerMm:8,widthDots:832},'.');
    assert.equal(blocked.zpl,'');assert.ok(blocked.diagnostics.some(d=>d.code==='MISSING_VARIABLE'));
  }finally{await closeRenderer();}
});
test('empty text loads its declared font without a false missing-font diagnostic', async () => {
  const text={id:'txt',type:'text',xUm:0,yUm:0,widthUm:60000,heightUm:20000,text:'',fontFamily:'Arial',fontSizeUm:4000};
  try {
    const result=await compileProject({templates:[{id:'t',widthUm:100000,heightUm:50000,elements:[text]}]},'t',{}, {dotsPerMm:8,widthDots:832},'.');
    assert.equal(result.diagnostics.length,0);assert.ok(result.zpl);
    const pixels=await sharp(Buffer.from(result.previewBase64,'base64')).greyscale().raw().toBuffer();
    assert.ok([...pixels].every(pixel=>pixel===255));
  }finally{await closeRenderer();}
});
test("MSB graphic packing preserves pixels and white row padding", () => {
  const pixels = Uint8Array.from([
    0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
  ]);
  const { packed, bytesPerRow } = packMonochrome(pixels, 9, 2);
  assert.equal(bytesPerRow, 2);
  assert.equal(packed.toString("hex"), "aa805500");
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 9; x++)
      assert.equal(
        (packed[y * bytesPerRow + (x >> 3)]! >> (7 - (x & 7))) & 1,
        pixels[y * 9 + x]! < 128 ? 1 : 0,
      );
  assert.match(graphicZpl(pixels, 9, 2), /^\^FO0,0\^GFA,4,4,2,AA805500\^FS$/);
});
test("large graphics split into documented bounded fields", () => {
  const zpl = graphicZpl(new Uint8Array(800 * 1200).fill(255), 800, 1200);
  assert.equal((zpl.match(/\^GFA/g) ?? []).length, 2);
  for (const match of zpl.matchAll(/\^GFA,(\d+),(\d+),(\d+),([A-F0-9]+)/g)) {
    assert.ok(Number(match[1]) <= 99999);
    assert.equal(match[1], match[2]);
    assert.equal(match[4]!.length, Number(match[1]) * 2);
  }
});
test("field resolution diagnoses missing input and does not recursively expand", () => {
  const diagnostics: any[] = [];
  assert.equal(
    resolveFields(
      "{{name}} {{missing}}",
      { name: "^XZ{{next}}" },
      diagnostics,
      "text1",
    ),
    "^XZ{{next}} ",
  );
  assert.equal(diagnostics[0].code, "MISSING_VARIABLE");
});
test("invalid label and missing font fail closed before Chromium", async () => {
  const project = {
    templates: [
      {
        id: "t",
        widthUm: 10000,
        heightUm: 10000,
        elements: [
          {
            id: "a",
            type: "text",
            xUm: 0,
            yUm: 0,
            widthUm: 10000,
            heightUm: 10000,
            text: "Test",
            fontFamily: "Missing font",
          },
        ],
      },
    ],
  };
  const result = await compileProject(
    project,
    "t",
    {},
    { dotsPerMm: 8, widthDots: 80 },
    ".",
  );
  assert.equal(result.zpl, "");
  assert.equal(result.diagnostics[0].severity, "error");
  const small = await compileProject(
    { ...project, templates: [{ ...project.templates[0], elements: [] }] },
    "t",
    {},
    { dotsPerMm: 8, widthDots: 40 },
    ".",
  );
  assert.equal(small.diagnostics[0].code, "PRINTER_WIDTH");
});
test("authoritative raster preview exactly matches emitted graphic pixels", async () => {
  const project = {
    templates: [
      {
        id: "t",
        widthUm: 10000,
        heightUm: 10000,
        elements: [
          {
            id: "r",
            type: "rectangle",
            xUm: 1000,
            yUm: 1000,
            widthUm: 4000,
            heightUm: 3000,
            fill: "black",
            strokeUm: 125,
          },
        ],
      },
    ],
  };
  try {
    const result = await compileProject(
      project,
      "t",
      {},
      { dotsPerMm: 8, widthDots: 80 },
      ".",
    );
    assert.equal(result.diagnostics.length, 0);
    const pixels = await sharp(Buffer.from(result.previewBase64, "base64"))
      .greyscale()
      .raw()
      .toBuffer();
    const reconstructed = Buffer.alloc(80 * 80, 255);
    for (const field of result.zpl.matchAll(
      /\^FO(\d+),(\d+)\^GFA,(\d+),(\d+),(\d+),([A-F0-9]+)/g,
    )) {
      const bytes = Buffer.from(field[6]!, "hex"),
        bpr = Number(field[5]),
        oy = Number(field[2]);
      for (let yy = 0; yy < bytes.length / bpr; yy++)
        for (let xx = 0; xx < 80; xx++)
          if (bytes[yy * bpr + (xx >> 3)]! & (0x80 >> (xx & 7)))
            reconstructed[(oy + yy) * 80 + xx] = 0;
    }
    for (const field of result.zpl.matchAll(
      /\^FO(\d+),(\d+)\^GB(\d+),(\d+),(\d+),B,0/g,
    )) {
      const [, sx, sy, sw, sh, ss] = field,
        x = Number(sx),
        y = Number(sy),
        w = Number(sw),
        h = Number(sh),
        s = Number(ss);
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++)
          if (xx < s || yy < s || xx >= w - s || yy >= h - s)
            reconstructed[(y + yy) * 80 + x + xx] = 0;
    }
    assert.deepEqual(reconstructed, pixels);
    assert.ok(result.zpl.includes("^GB32,24,24,B,0"));
    assert.equal(pixels[10 * 80 + 10], 0);
    assert.equal(pixels[0], 255);
    assert.equal(
      result.zpl,
      (
        await compileProject(
          project,
          "t",
          {},
          { dotsPerMm: 8, widthDots: 80 },
          ".",
        )
      ).zpl,
    );
  } finally {
    await closeRenderer();
  }
});
test("invalid quantities cannot inject printer commands", async () => {
  await assert.rejects(
    compileProject(
      {
        templates: [{ id: "t", widthUm: 10000, heightUm: 10000, elements: [] }],
      },
      "t",
      {},
      { dotsPerMm: 8, widthDots: 80 },
      ".",
      { quantity: 1.5 },
    ),
    /Quantity/,
  );
});
test("barcode inputs including ZPL metacharacters stay raster data", async () => {
  const project = {
    templates: [
      {
        id: "t",
        widthUm: 50000,
        heightUm: 20000,
        elements: [
          {
            id: "b",
            type: "barcode",
            xUm: 0,
            yUm: 0,
            widthUm: 50000,
            heightUm: 20000,
            symbology: "code128",
            value: "^XZ~JA",
          },
        ],
      },
    ],
  };
  try {
    const result = await compileProject(
      project,
      "t",
      {},
      { dotsPerMm: 8, widthDots: 400 },
      ".",
    );
    assert.equal(result.diagnostics.length, 0);
    assert.equal((result.zpl.match(/\^XZ/g) ?? []).length, 1);
    assert.ok(!result.zpl.includes("~JA"));
    const { data: pixels, info } = await sharp(
      Buffer.from(result.previewBase64, "base64"),
    )
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const columns = new Set<number>();
    for (let yy = 0; yy < info.height; yy++)
      for (let xx = 0; xx < info.width; xx++)
        if (pixels[yy * info.width + xx] === 0) columns.add(xx);
    assert.ok(
      Math.max(...columns) - Math.min(...columns) > 280,
      "Linear barcode must use a meaningful fraction of its 400-dot width.",
    );
  } finally {
    await closeRenderer();
  }
});
test("all supported barcode families render locally without stretching", async () => {
  const cases: Record<string, string> = {
    code128: "BY-10482",
    "gs1-128": "(01)09501101530003(10)ABC",
    code39: "ABC-123",
    ean13: "5901234123457",
    upca: "036000291452",
    qrcode: "https://example.invalid/local",
    datamatrix: "ABC-123",
  };
  try {
    for (const [symbology, value] of Object.entries(cases)) {
      const project = {
        templates: [
          {
            id: "t",
            widthUm: 100000,
            heightUm: 30000,
            elements: [
              {
                id: "b",
                type: "barcode",
                xUm: 0,
                yUm: 0,
                widthUm: 100000,
                heightUm: 30000,
                symbology,
                value,
              },
            ],
          },
        ],
      };
      const result = await compileProject(
        project,
        "t",
        {},
        { dotsPerMm: 8, widthDots: 800 },
        ".",
      );
      assert.equal(
        result.diagnostics.length,
        0,
        `${symbology}: ${JSON.stringify(result.diagnostics)}`,
      );
      assert.ok(result.previewBase64);
      assert.ok(result.zpl.includes("^GFA"));
    }
  } finally {
    await closeRenderer();
  }
});
test("Unicode text is rasterized and text overflow blocks printing", async () => {
  const template = {
    id: "t",
    widthUm: 60000,
    heightUm: 20000,
    elements: [
      {
        id: "txt",
        type: "text",
        xUm: 0,
        yUm: 0,
        widthUm: 60000,
        heightUm: 20000,
        text: "Café • ^XZ <script>",
        fontFamily: "Arial",
        fontSizeUm: 4000,
      },
    ],
  };
  try {
    const result = await compileProject(
      { templates: [template] },
      "t",
      {},
      { dotsPerMm: 8, widthDots: 480 },
      ".",
    );
    assert.equal(result.diagnostics.length, 0);
    assert.equal((result.zpl.match(/\^XZ/g) ?? []).length, 1);
    const overflow = await compileProject(
      {
        templates: [
          {
            ...template,
            elements: [{ ...template.elements[0], heightUm: 1000 }],
          },
        ],
      },
      "t",
      {},
      { dotsPerMm: 8, widthDots: 480 },
      ".",
    );
    assert.equal(overflow.zpl, "");
    assert.equal(overflow.diagnostics[0].code, "TEXT_OVERFLOW");
  } finally {
    await closeRenderer();
  }
});
test("missing glyphs require font replacement instead of silent OS fallback", async () => {
  const project = {
    templates: [
      {
        id: "t",
        widthUm: 60000,
        heightUm: 20000,
        elements: [
          {
            id: "txt",
            type: "text",
            xUm: 0,
            yUm: 0,
            widthUm: 60000,
            heightUm: 20000,
            text: "Unsupported \u{10FFFF}",
            fontFamily: "Arial",
            fontSizeUm: 4000,
          },
        ],
      },
    ],
  };
  const result = await compileProject(
    project,
    "t",
    {},
    { dotsPerMm: 8, widthDots: 480 },
    ".",
  );
  assert.equal(result.zpl, "");
  assert.match(result.diagnostics[0].message, /lacks characters/);
});
test("overlapping shapes retain composite raster stacking", async () => {
  const elements = [
    {
      id: "black",
      type: "rectangle",
      xUm: 1000,
      yUm: 1000,
      widthUm: 6000,
      heightUm: 6000,
      fill: "black",
      strokeUm: 0,
    },
    {
      id: "white",
      type: "rectangle",
      xUm: 3000,
      yUm: 3000,
      widthUm: 2000,
      heightUm: 2000,
      fill: "white",
      strokeUm: 0,
    },
  ];
  try {
    const result = await compileProject(
      { templates: [{ id: "t", widthUm: 10000, heightUm: 10000, elements }] },
      "t",
      {},
      { dotsPerMm: 8, widthDots: 80 },
      ".",
    );
    assert.equal(result.diagnostics.length, 0);
    assert.ok(!result.zpl.includes("^GB"));
    const pixels = await sharp(Buffer.from(result.previewBase64, "base64"))
      .greyscale()
      .raw()
      .toBuffer();
    assert.equal(pixels[16 * 80 + 16], 0);
    assert.equal(pixels[30 * 80 + 30], 255);
    assert.ok(result.zpl.includes(graphicZpl(pixels, 80, 80)));
  } finally {
    await closeRenderer();
  }
});
