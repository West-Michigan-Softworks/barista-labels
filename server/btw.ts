import { inflateSync } from "node:zlib";
import type { Diagnostic, Project } from "../shared/model.js";
import { importVerifiedBtwProfile } from "./btw-profiles.js";

/** Only the envelope is currently verified; archive versions are not editable support claims. */
export const observedBtwVersions = [111054, 111055, 112015, 113002] as const;
export const btwLimits = {
  fileBytes: 16 * 1024 * 1024,
  inflatedBytes: 32 * 1024 * 1024,
  headerBytes: 64 * 1024,
  previewBytes: 8 * 1024 * 1024,
  stringCharacters: 32768,
};
export interface BtwEnvelope {
  archiveVersion: number;
  header: string;
  description: string;
  previews: Buffer[];
  payload: Buffer;
  offsets: {
    binaryHeader: number;
    description: number;
    previews: number[];
    compressionFlags: number;
    zlib: number;
  };
}
export interface BtwImportResult {
  project?: Project;
  archiveVersion?: number;
  diagnostics: Diagnostic[];
  previewBase64?: string;
  printEligible: boolean;
  analysis?: {
    description: string;
    inflatedBytes: number;
    offsets: BtwEnvelope["offsets"];
  };
}
class BtwError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
class Cursor {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  read(length: number) {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.bytes.length
    )
      throw new BtwError(
        "BTW_TRUNCATED",
        `Truncated BTW field at byte ${this.offset}.`,
      );
    const data = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return data;
  }
  u8() {
    return this.read(1).readUInt8();
  }
  u16() {
    return this.read(2).readUInt16LE();
  }
  u32() {
    return this.read(4).readUInt32LE();
  }
  unicodeString() {
    if (!this.read(3).equals(Buffer.from([0xff, 0xfe, 0xff])))
      throw new BtwError(
        "BTW_STRING_ENCODING",
        "Unsupported archive string encoding.",
      );
    let count = this.u8();
    if (count === 255) {
      count = this.u16();
      if (count === 65535) count = this.u32();
    }
    if (count > btwLimits.stringCharacters)
      throw new BtwError(
        "BTW_STRING_LIMIT",
        "Archive description exceeds the supported length.",
      );
    return this.read(count * 2).toString("utf16le");
  }
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validatePng(bytes: Buffer) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature))
    throw new BtwError("BTW_PREVIEW_FORMAT", "Expected a PNG preview.");
  let offset = 8,
    first = true;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length)
      throw new BtwError("BTW_PREVIEW_TRUNCATED", "Truncated PNG preview.");
    const size = bytes.readUInt32BE(offset),
      type = bytes.toString("ascii", offset + 4, offset + 8);
    if (offset + 12 + size > bytes.length)
      throw new BtwError("BTW_PREVIEW_TRUNCATED", "Invalid PNG chunk length.");
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + size)) !==
      bytes.readUInt32BE(offset + 8 + size)
    )
      throw new BtwError(
        "BTW_PREVIEW_CHECKSUM",
        "PNG preview checksum mismatch.",
      );
    if (first) {
      if (type !== "IHDR" || size !== 13)
        throw new BtwError("BTW_PREVIEW_FORMAT", "Invalid PNG header.");
      const width = bytes.readUInt32BE(offset + 8),
        height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width * height > 25_000_000)
        throw new BtwError(
          "BTW_PREVIEW_LIMIT",
          "Preview dimensions exceed the supported limit.",
        );
      first = false;
    }
    offset += size + 12;
    if (type === "IEND") {
      if (size !== 0 || offset !== bytes.length)
        throw new BtwError(
          "BTW_PREVIEW_FORMAT",
          "Unexpected data following PNG end.",
        );
      return;
    }
  }
  throw new BtwError("BTW_PREVIEW_TRUNCATED", "PNG preview has no end marker.");
}
/** Sequential envelope decoder, never scans for zlib signatures or object-name substrings. */
export function decodeBtwEnvelope(bytes: Buffer): BtwEnvelope {
  if (bytes.length > btwLimits.fileBytes)
    throw new BtwError("BTW_FILE_LIMIT", "BTW exceeds the 16 MiB file limit.");
  const end = bytes.subarray(0, btwLimits.headerBytes).indexOf(0x1a);
  if (end < 0)
    throw new BtwError(
      "BTW_HEADER",
      "No supported BarTender header terminator.",
    );
  const header = bytes.subarray(0, end).toString("utf8");
  if (
    !header.startsWith("\r\nBar Tender Format File\r\n") ||
    !header.endsWith("----------------------------------------------\r\n")
  )
    throw new BtwError("BTW_HEADER", "Unsupported BarTender file header.");
  const cursor = new Cursor(bytes);
  cursor.offset = end + 1;
  const binaryHeader = cursor.offset;
  const archiveVersion = cursor.u32(),
    previewCount = cursor.u32(),
    reserved = cursor.u32(),
    duplicateVersion = cursor.u32(),
    revision = cursor.u32(),
    marker = cursor.u32();
  if (!(observedBtwVersions as readonly number[]).includes(archiveVersion))
    throw new BtwError(
      "BTW_VERSION_UNSUPPORTED",
      `Archive version ${archiveVersion} has not been verified.`,
    );
  const textVersion = header.match(/ArchiveVersion=(\d+)/)?.[1];
  if (
    duplicateVersion !== archiveVersion ||
    (textVersion && Number(textVersion) !== archiveVersion)
  )
    throw new BtwError(
      "BTW_VERSION_MISMATCH",
      "Text and binary archive versions disagree.",
    );
  if (
    previewCount !== 2 ||
    reserved !== 0 ||
    revision !== 100 ||
    marker !== 10002
  )
    throw new BtwError(
      "BTW_ENVELOPE_UNSUPPORTED",
      "Envelope flags differ from the verified unprotected format.",
    );
  const descriptionOffset = cursor.offset,
    description = cursor.unicodeString();
  if (cursor.u32() !== 0)
    throw new BtwError(
      "BTW_ENVELOPE_UNSUPPORTED",
      "Unsupported description extension.",
    );
  const previews: Buffer[] = [],
    previewOffsets: number[] = [];
  for (let index = 0; index < previewCount; index++) {
    const count = cursor.u32();
    if (count > btwLimits.previewBytes)
      throw new BtwError(
        "BTW_PREVIEW_LIMIT",
        "PNG preview exceeds the 8 MiB limit.",
      );
    previewOffsets.push(cursor.offset);
    const image = cursor.read(count);
    validatePng(image);
    previews.push(image);
  }
  const compressionFlags = cursor.offset;
  if (cursor.u8() !== 0 || cursor.u8() !== 1)
    throw new BtwError(
      "BTW_COMPRESSION_UNSUPPORTED",
      "Unsupported encrypted or uncompressed archive payload.",
    );
  const zlib = cursor.offset;
  let payload: Buffer;
  try {
    // Node's runtime supports info:true although @types/node's overload omits its result shape.
    const result = inflateSync(cursor.read(bytes.length - cursor.offset), {
      maxOutputLength: btwLimits.inflatedBytes,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    payload = result.buffer;
    if (result.engine.bytesWritten !== bytes.length - zlib)
      throw new BtwError(
        "BTW_TRAILING_DATA",
        "Unexpected data following the compressed archive.",
      );
  } catch (error) {
    if (error instanceof BtwError) throw error;
    throw new BtwError(
      "BTW_DECOMPRESSION",
      "The compressed archive is corrupt or exceeds the 32 MiB expansion limit.",
    );
  }
  const archiveCursor = new Cursor(payload);
  if (
    archiveCursor.unicodeString() !== "BarTender" ||
    archiveCursor.unicodeString() !== "idbtlf"
  )
    throw new BtwError(
      "BTW_ARCHIVE_SIGNATURE",
      "Unsupported decompressed archive identity.",
    );
  return {
    archiveVersion,
    header,
    description,
    previews,
    payload,
    offsets: {
      binaryHeader,
      description: descriptionOffset,
      previews: previewOffsets,
      compressionFlags,
      zlib,
    },
  };
}
export function importBtw(bytes: Buffer, name: string): BtwImportResult {
  try {
    const envelope = decodeBtwEnvelope(bytes);
    const verified = importVerifiedBtwProfile(
      envelope.payload,
      envelope.archiveVersion,
      name,
    );
    if (verified)
      return {
        project: verified.project,
        archiveVersion: envelope.archiveVersion,
        printEligible: true,
        previewBase64: envelope.previews[0].toString("base64"),
        diagnostics: verified.project.importDiagnostics,
        analysis: {
          description: `Verified profile: ${verified.profileId}`,
          inflatedBytes: envelope.payload.length,
          offsets: envelope.offsets,
        },
      };
    return {
      archiveVersion: envelope.archiveVersion,
      printEligible: false,
      previewBase64: envelope.previews[0].toString("base64"),
      analysis: {
        description: envelope.description,
        inflatedBytes: envelope.payload.length,
        offsets: envelope.offsets,
      },
      diagnostics: [
        {
          severity: "error",
          code: "BTW_EDITABLE_RECORDS_UNSUPPORTED",
          message:
            "The BTW envelope and preview were decoded, but this document does not match a verified editable structural profile. No editable project was created and no objects were silently omitted. Preserve the original file; general BTW object graphs remain unsupported.",
        },
      ],
    };
  } catch (error) {
    return {
      printEligible: false,
      diagnostics: [
        {
          severity: "error",
          code: error instanceof BtwError ? error.code : "BTW_INVALID",
          message: error instanceof Error ? error.message : "Invalid BTW file.",
        },
      ],
    };
  }
}
