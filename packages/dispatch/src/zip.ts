// A small, strict reader for GitHub Actions artifact zips (P2-01). Artifacts from CI hold whatever PR code
// wrote, so the archive is hostile input: it is parsed in memory, never handed to an unzip tool, and only the
// entries the caller selects are inflated. Refused outright: zip64, encryption, multi-disk archives, symlinks
// and any other non-regular entry type, absolute or traversing names, duplicate names (case-insensitively),
// entries whose header ranges overlap the central directory or run past the buffer, sizes over the caps, and
// data whose size or CRC doesn't match the directory. Nothing is written to disk here.
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipLimits {
  /** Entries in the central directory, files and directories together. */
  maxEntries: number;
  /** Largest inflated size of one selected entry. */
  maxEntryBytes: number;
  /** Total inflated bytes of the selected entries. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxEntryBytes: 10 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 };

export interface ZipEntry {
  /** The entry's path inside the archive, validated (relative, `/`-separated, no `.` or `..` segments). */
  name: string;
  data: Buffer;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(`artifact zip: ${message}`);
    this.name = "ZipError";
  }
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const MAX_NAME = 255;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const HOST_UNIX = 3;

/** Strict entry-name check: what a safe extractor would accept as a relative path. */
export function isSafeZipName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME) return false;
  if ([...name].some((c) => c.charCodeAt(0) < 0x20 || c === "\u007f" || c === "\\" || c === ":")) return false;
  if (name.startsWith("/")) return false;
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + EOCD_MIN + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new ZipError("no end-of-central-directory record");
}

/**
 * Reads a zip from memory and returns the selected regular files, in archive order. Every entry's name and
 * type is validated even when it isn't selected, so one bad entry refuses the whole archive.
 */
export function readZip(buf: Buffer, select: (name: string) => boolean, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buf.length < EOCD_MIN) throw new ZipError("too short");
  const eocd = findEocd(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ZipError("multi-disk archives are not supported");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64 is not supported");
  if (total > limits.maxEntries) throw new ZipError(`too many entries (${total}, max ${limits.maxEntries})`);
  if (cdOffset + cdSize > eocd) throw new ZipError("central directory runs past its end record");

  const seen = new Set<string>();
  const out: ZipEntry[] = [];
  let totalBytes = 0;
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== CDH_SIG) throw new ZipError("bad central directory entry");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const startDisk = buf.readUInt16LE(p + 34);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) throw new ZipError("central directory entry runs past the directory");
    if (startDisk !== 0) throw new ZipError("multi-disk archives are not supported");
    if (flags & 0x1 || flags & 0x40) throw new ZipError("encrypted entries are not supported");
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("zip64 is not supported");

    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(p + 46, p + 46 + nameLen));
    } catch {
      throw new ZipError(`entry ${i + 1} has a name that isn't UTF-8`);
    }
    if (!isSafeZipName(name)) throw new ZipError(`entry ${i + 1} has an unsafe name`);
    const key = name.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) throw new ZipError(`entry ${i + 1} repeats a name`);
    seen.add(key);

    const isDir = name.endsWith("/");
    if (madeBy >> 8 === HOST_UNIX) {
      const type = (external >>> 16) & S_IFMT;
      // 0 = no Unix mode recorded. Anything else must match what the name says it is.
      if (type !== 0 && type !== (isDir ? S_IFDIR : S_IFREG)) throw new ZipError(`entry ${i + 1} is not a regular file or directory`);
    }
    if (isDir) {
      if (usize !== 0) throw new ZipError(`directory entry ${i + 1} has data`);
      p = next;
      continue;
    }
    if (!select(name)) {
      p = next;
      continue;
    }

    if (method !== 0 && method !== 8) throw new ZipError(`entry ${i + 1} uses an unsupported compression method`);
    if (usize > limits.maxEntryBytes) throw new ZipError(`entry ${i + 1} is ${usize} bytes (max ${limits.maxEntryBytes})`);
    if (totalBytes + usize > limits.maxTotalBytes) throw new ZipError(`selected entries exceed ${limits.maxTotalBytes} bytes`);
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LFH_SIG) throw new ZipError(`entry ${i + 1} has no local header`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + csize > cdOffset) throw new ZipError(`entry ${i + 1} data runs into the central directory`);
    const raw = buf.subarray(dataStart, dataStart + csize);

    let data: Buffer;
    if (method === 0) {
      if (csize !== usize) throw new ZipError(`stored entry ${i + 1} has mismatched sizes`);
      data = Buffer.from(raw);
    } else {
      try {
        // One byte over the declared size, so a lying size is caught instead of silently clipped.
        data = inflateRawSync(raw, { maxOutputLength: usize + 1 });
      } catch {
        throw new ZipError(`entry ${i + 1} doesn't inflate within its declared size`);
      }
    }
    if (data.length !== usize) throw new ZipError(`entry ${i + 1} is not its declared size`);
    if (crc32(data) !== crc) throw new ZipError(`entry ${i + 1} fails its CRC`);
    totalBytes += usize;
    out.push({ name, data });
    p = next;
  }
  return out;
}
