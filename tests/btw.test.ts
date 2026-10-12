import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { decodeBtwEnvelope, importBtw, btwLimits } from "../server/btw.js";
import { coreProfile } from "../server/btw-profiles.js";

// Original synthetic envelope; deliberately contains no recovered proprietary object records.
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const archiveString = (s: string) =>
  Buffer.concat([
    Buffer.from([255, 254, 255, s.length]),
    Buffer.from(s, "utf16le"),
  ]);
function png() {
  function crc32(b: Buffer) {
    let c = 0xffffffff;
    for (const v of b) {
      c ^= v;
      for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  const header = Buffer.alloc(25);
  header.writeUInt32BE(13);
  header.write("IHDR", 4);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(1, 12);
  header[16] = 8;
  header[17] = 0;
  header.writeUInt32BE(crc32(header.subarray(4, 21)), 21);
  const end = Buffer.alloc(12);
  end.write("IEND", 4);
  end.writeUInt32BE(crc32(end.subarray(4, 8)), 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    header,
    end,
  ]);
}
function fixture(
  options: { version?: number; payload?: Buffer; description?: string } = {},
) {
  const version = options.version ?? 113002,
    image = png();
  const header = Buffer.from(
    `\r\nBar Tender Format File\r\nDocument: ArchiveVersion=${version}\r\n----------------------------------------------\r\n\x1a`,
  );
  return Buffer.concat([
    header,
    ...[version, 2, 0, version, 100, 10002].map(u32),
    archiveString(options.description ?? "original fixture"),
    u32(0),
    u32(image.length),
    image,
    u32(image.length),
    image,
    Buffer.from([0, 1]),
    deflateSync(
      options.payload ??
        Buffer.concat([archiveString("BarTender"), archiveString("idbtlf")]),
    ),
  ]);
}
test("BTW envelope sequentially reads descriptions and both previews", () => {
  const envelope = decodeBtwEnvelope(fixture());
  assert.equal(envelope.archiveVersion, 113002);
  assert.equal(envelope.description, "original fixture");
  assert.equal(envelope.previews.length, 2);
  assert.ok(envelope.offsets.zlib > envelope.offsets.previews[1]);
});
test("preview decoding never claims an editable project or print eligibility", () => {
  const result = importBtw(fixture(), "sample.btw");
  assert.equal(result.project, undefined);
  assert.equal(result.printEligible, false);
  assert.ok(result.previewBase64);
  assert.equal(result.diagnostics[0].code, "BTW_EDITABLE_RECORDS_UNSUPPORTED");
});
test("all observed versions decode but still block editable import", () => {
  for (const version of [111054, 111055, 112015, 113002])
    assert.equal(
      decodeBtwEnvelope(fixture({ version })).archiveVersion,
      version,
    );
});
test("unknown versions and malformed headers reject explicitly", () => {
  assert.equal(
    importBtw(fixture({ version: 999999 }), "bad.btw").diagnostics[0].code,
    "BTW_VERSION_UNSUPPORTED",
  );
  assert.equal(
    importBtw(Buffer.from("not a label"), "bad.btw").diagnostics[0].code,
    "BTW_HEADER",
  );
});
test("truncated fields and compressed data reject", () => {
  const data = fixture();
  for (const end of [data.indexOf(26) + 2, data.length - 5])
    assert.equal(
      importBtw(data.subarray(0, end), "bad.btw").printEligible,
      false,
    );
});
test("payload corruption and trailing bytes reject rather than silently recover", () => {
  const data = fixture();
  const corrupt = Buffer.from(data);
  corrupt[corrupt.length - 1] ^= 255;
  assert.equal(
    importBtw(corrupt, "bad.btw").diagnostics[0].code,
    "BTW_DECOMPRESSION",
  );
  assert.equal(
    importBtw(Buffer.concat([data, Buffer.from("trailing")]), "bad.btw")
      .diagnostics[0].code,
    "BTW_TRAILING_DATA",
  );
});
test("oversized descriptions and decompression bombs reject", () => {
  const data = fixture();
  const env = decodeBtwEnvelope(data);
  const malformed = Buffer.from(data);
  malformed[env.offsets.description + 3] = 255;
  malformed.writeUInt16LE(65534, env.offsets.description + 4);
  assert.equal(
    importBtw(malformed, "bad.btw").diagnostics[0].code,
    "BTW_STRING_LIMIT",
  );
  assert.equal(
    importBtw(
      fixture({ payload: Buffer.alloc(btwLimits.inflatedBytes + 1) }),
      "bomb.btw",
    ).diagnostics[0].code,
    "BTW_DECOMPRESSION",
  );
});

const originalBlank = "research-artifacts/btw/blank.btw";
test(
  "controlled empty profile imports real editable dimensions and rejects unknown byte changes",
  { skip: !existsSync(originalBlank) },
  () => {
    const source = decodeBtwEnvelope(readFileSync(originalBlank));
    const result = importBtw(
      fixture({ payload: source.payload }),
      "original.btw",
    );
    assert.equal(result.printEligible, true);
    assert.equal(result.project?.templates[0].widthUm, 101600);
    assert.equal(result.project?.templates[0].heightUm, 50800);
    assert.deepEqual(result.project?.templates[0].elements, []);
    const changed = Buffer.from(source.payload);
    changed.writeInt32LE(3000, 7439);
    changed.writeInt32LE(1000, 7443);
    const resized = importBtw(fixture({ payload: changed }), "resized.btw");
    assert.equal(resized.project?.templates[0].widthUm, 76200);
    assert.equal(resized.project?.templates[0].heightUm, 25400);
    changed[8000] ^= 1;
    assert.equal(
      importBtw(fixture({ payload: changed }), "unknown.btw").project,
      undefined,
    );
  },
);

const originalCore = "research-artifacts/btw/mail-core.btw";
test(
  "controlled original core converts literal text, font, geometry, stacking and colors",
  { skip: !existsSync(originalCore) },
  () => {
    const result = importBtw(readFileSync(originalCore), "core.btw");
    assert.equal(result.printEligible, true);
    const template = result.project!.templates[0];
    assert.equal(template.widthUm, 101600);
    assert.equal(template.heightUm, 50800);
    const [text, box] = template.elements;
    assert.equal(text.type, "text");
    assert.equal(box.type, "rectangle");
    if (text.type === "text") {
      assert.equal(text.text, "Hello world");
      assert.equal(text.fontFamily, "Arial");
      assert.equal(text.fontSizeUm, 4233);
      assert.equal(text.align, "center");
      assert.equal(text.lineHeightUm, 4750);
      assert.equal(text.dataMode, "literal");
      assert.equal(text.xUm, 0);
      assert.equal(text.yUm, 25400);
    }
    if (box.type === "rectangle") {
      assert.equal(box.xUm, 50673);
      assert.equal(box.yUm, 6223);
      assert.equal(box.widthUm, 25654);
      assert.equal(box.heightUm, 12954);
      assert.equal(box.strokeUm, 254);
      assert.equal(box.fill, "none");
    }
    for (const name of [
      "box-x",
      "box-y",
      "box-width",
      "box-height",
      "box-stroke",
      "text-x",
      "text-y",
      "text-size",
      "text-value",
    ])
      assert.equal(
        importBtw(
          readFileSync(`research-artifacts/btw/mail-core-${name}.btw`),
          name,
        ).printEligible,
        true,
        name,
      );
    const changed = importBtw(
      readFileSync("research-artifacts/btw/mail-core-text-value.btw"),
      "changed.btw",
    );
    const changedText = changed.project!.templates[0].elements[0];
    assert.equal(
      changedText.type === "text" ? changedText.text : "",
      "Changed label",
    );
    assert.equal(
      importBtw(
        readFileSync("research-artifacts/btw/mail-core-box-rotation.btw"),
        "rotation.btw",
      ).project,
      undefined,
    );
  },
);
test(
  "core fingerprint and derived-field checks reject unsupported changes",
  { skip: !existsSync(originalCore) },
  () => {
    const original = decodeBtwEnvelope(readFileSync(originalCore)).payload;
    const literal = "A{{item}}B";
    const offset = coreProfile.textOffset,
      originalFieldBytes = 4 + original[offset + 3] * 2;
    const literalPayload = Buffer.concat([
      original.subarray(0, offset),
      archiveString(literal),
      original.subarray(offset + originalFieldBytes),
    ]);
    const literalProject = importBtw(
      fixture({ payload: literalPayload }),
      "literal.btw",
    ).project;
    const literalText = literalProject!.templates[0].elements[0];
    assert.equal(literalText.type === "text" ? literalText.text : "", literal);
    assert.equal(
      literalText.type === "text" ? literalText.dataMode : "",
      "literal",
    );
    const unknown = Buffer.from(original);
    unknown[50000] ^= 1;
    assert.equal(
      importBtw(fixture({ payload: unknown }), "unknown.btw").project,
      undefined,
    );
    const staleCache = Buffer.from(original);
    staleCache.writeInt32LE(2500, 41975);
    assert.equal(
      importBtw(fixture({ payload: staleCache }), "stale.btw").project,
      undefined,
    );
    const badFont = Buffer.from(original);
    badFont.writeInt32LE(-260, 43490);
    assert.equal(
      importBtw(fixture({ payload: badFont }), "font.btw").project,
      undefined,
    );
  },
);
