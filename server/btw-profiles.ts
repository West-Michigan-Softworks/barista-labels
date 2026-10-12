import { createHash, randomUUID } from "node:crypto";
import type { Project } from "../shared/model.js";

/** Strict descriptors of controlled reference documents, not general archive decoding.
 * Every byte outside declared, experimentally verified fields must match a SHA-256
 * fingerprint. Unrecognized printer/form/object graphs fail closed.
 * See docs/btw-format.md and tools/btw-profile-fixtures.ps1.
 */
export const blankProfile = {
  id: "original-blank-113002-v1",
  version: 113002,
  bytes: 30322,
  digest: "910fcb1ac4f7a1f4868cd90f52133c7688e26debe08a0896631d9fc51fee1230",
  identityOffset: 38,
  widthOffset: 7439,
  heightOffset: 7443,
} as const;
const thousandthsToUm = (value: number) => Math.round(value * 25.4);
export const coreProfile = {
  id: "controlled-text-rectangle-113002-v1",
  version: 113002,
  normalizedBytes: 100923,
  digest: "9f971dab0164e3922b8f1440df3ae12eb68f3dc6c8efa8c0f62f5b6aa0f86975",
  textOffset: 43353,
  // Offsets below are in the canonical payload with the one literal string removed.
  spans: [
    [38, 16],
    [41975, 8],
    [43464, 4],
    [43556, 4],
    [43682, 4],
    [43788, 8],
    [45299, 8],
    [45397, 8],
    [45406, 4],
  ] as readonly (readonly [number, number])[],
} as const;
function importCore(
  payload: Buffer,
  archiveVersion: number,
  name: string,
): { project: Project; profileId: string } | undefined {
  if (
    archiveVersion !== coreProfile.version ||
    payload.length < coreProfile.textOffset + 4
  )
    return;
  const start = coreProfile.textOffset;
  if (!payload.subarray(start, start + 3).equals(Buffer.from([255, 254, 255])))
    return;
  let length = payload[start + 3],
    prefix = 4;
  if (length === 255) {
    if (payload.length < start + 6) return;
    length = payload.readUInt16LE(start + 4);
    prefix = 6;
  }
  if (length > 64 || start + prefix + length * 2 > payload.length) return;
  const text = payload
    .subarray(start + prefix, start + prefix + length * 2)
    .toString("utf16le");
  // The tested profile has one literal ASCII line, no variable transforms or script.
  if (!/^[\x20-\x7e]*$/.test(text)) return;
  const canonical = Buffer.concat([
    payload.subarray(0, start),
    payload.subarray(start + prefix + length * 2),
  ]);
  if (canonical.length !== coreProfile.normalizedBytes) return;
  const normalized = Buffer.from(canonical);
  for (const [offset, count] of coreProfile.spans)
    normalized.fill(0, offset, offset + count);
  if (
    createHash("sha256").update(normalized).digest("hex") !== coreProfile.digest
  )
    return;
  const integer = (offset: number) => canonical.readInt32LE(offset);
  const fontPoints = canonical.readFloatLE(43556);
  if (fontPoints !== 12 && fontPoints !== 24) return;
  const textHeight = integer(43682);
  if (
    integer(43464) !== -fontPoints * 20 ||
    textHeight !== (fontPoints === 12 ? 187 : 371)
  )
    return;
  const textX = integer(41975),
    textY = integer(41979);
  // Verified cached origin relationships; never mask them without checking consistency.
  if (
    integer(43788) !== 1868 - textX ||
    integer(43792) !== textY - (fontPoints === 12 ? 138 : 140)
  )
    return;
  const boxX = integer(45299),
    boxY = integer(45303),
    boxHeight = integer(45397),
    boxWidth = integer(45401),
    stroke = integer(45406);
  if (
    [textX, textY, boxX, boxY].some((v) => Math.abs(v) > 78740) ||
    boxWidth <= 0 ||
    boxHeight <= 0 ||
    boxWidth > 78740 ||
    boxHeight > 78740 ||
    stroke < 0 ||
    stroke > 1000
  )
    return;
  const warning = {
    severity: "warning" as const,
    code: "BTW_VERIFIED_STRUCTURAL_PROFILE",
    message:
      "Imported a strict verified 113002 text/rectangle profile. Other BTW graphs and changed settings are rejected. Non-printing data-entry forms are not recreated. Rectangle dimensions include the outer stroke because BarTender centers its pen on the serialized path; text remains an embedded literal.",
  };
  const strokeUm = thousandthsToUm(stroke),
    halfStroke = Math.round(strokeUm / 2);
  const project: Project = {
    schemaVersion: 1,
    id: randomUUID(),
    name: name.replace(/\.btw$/i, "") || "Imported label",
    templates: [
      {
        id: randomUUID(),
        name: "Template 1",
        widthUm: 101600,
        heightUm: 50800,
        elements: [
          {
            id: randomUUID(),
            name: "Text 1",
            type: "text",
            xUm: 101600 - thousandthsToUm(textX) - 50800,
            yUm: thousandthsToUm(textY),
            widthUm: 50800,
            heightUm: thousandthsToUm(textHeight),
            lineHeightUm: thousandthsToUm(textHeight),
            rotation: 0,
            locked: false,
            text,
            dataMode: "literal",
            fontFamily: "Arial",
            fontSizeUm: Math.round((fontPoints * 25400) / 72),
            bold: false,
            align: "center",
          },
          {
            id: randomUUID(),
            name: "Box 1",
            type: "rectangle",
            xUm:
              101600 -
              thousandthsToUm(boxX) -
              thousandthsToUm(boxWidth) -
              halfStroke,
            yUm: thousandthsToUm(boxY) - halfStroke,
            widthUm: thousandthsToUm(boxWidth) + strokeUm,
            heightUm: thousandthsToUm(boxHeight) + strokeUm,
            rotation: 0,
            locked: false,
            strokeUm,
            fill: "none",
          },
        ],
      },
    ],
    variables: [],
    assets: [],
    importDiagnostics: [warning],
  };
  return { project, profileId: coreProfile.id };
}
export function importVerifiedBtwProfile(
  payload: Buffer,
  archiveVersion: number,
  name: string,
): { project: Project; profileId: string } | undefined {
  const core = importCore(payload, archiveVersion, name);
  if (core) return core;
  if (
    archiveVersion !== blankProfile.version ||
    payload.length !== blankProfile.bytes
  )
    return;
  const normalized = Buffer.from(payload);
  normalized.fill(
    0,
    blankProfile.identityOffset,
    blankProfile.identityOffset + 16,
  );
  normalized.fill(0, blankProfile.widthOffset, blankProfile.heightOffset + 4);
  if (
    createHash("sha256").update(normalized).digest("hex") !==
    blankProfile.digest
  )
    return;
  const widthUm = thousandthsToUm(
    payload.readInt32LE(blankProfile.widthOffset),
  );
  const heightUm = thousandthsToUm(
    payload.readInt32LE(blankProfile.heightOffset),
  );
  if (
    widthUm <= 0 ||
    heightUm <= 0 ||
    widthUm > 2_000_000 ||
    heightUm > 2_000_000
  )
    return;
  const warning = {
    severity: "warning" as const,
    code: "BTW_VERIFIED_STRUCTURAL_PROFILE",
    message:
      "Imported the verified empty 113002 document profile. General BTW object graphs remain unsupported; all non-geometry payload bytes matched the controlled reference fingerprint.",
  };
  const project: Project = {
    schemaVersion: 1,
    id: randomUUID(),
    name: name.replace(/\.btw$/i, "") || "Imported label",
    templates: [
      { id: randomUUID(), name: "Template 1", widthUm, heightUm, elements: [] },
    ],
    variables: [],
    assets: [],
    importDiagnostics: [warning],
  };
  return { project, profileId: blankProfile.id };
}
