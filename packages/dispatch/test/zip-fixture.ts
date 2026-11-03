// Builds zips in memory for the artifact-reader tests, including malformed ones a real zip tool won't make.
import { crc32, deflateRawSync } from "node:zlib";

export interface FixtureEntry {
  name: string;
  data?: Buffer | string;
  /** Full Unix mode (type + permission bits); default a regular file or directory by name. */
  mode?: number;
  deflate?: boolean;
  /** Overrides for the central directory record. */
  declaredSize?: number;
  crc?: number;
  flags?: number;
  /** Host OS byte of "version made by" (3 = Unix). */
  host?: number;
}

export const S_IFLNK = 0o120000;
export const S_IFIFO = 0o010000;
export const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export function writeZip(entries: readonly FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data ?? "");
    const body = e.deflate ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const usize = e.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((e.host ?? 3) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (e.name.endsWith("/") ? S_IFDIR | 0o755 : S_IFREG | 0o644);
    central.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** A minimal valid PNG header followed by filler bytes. */
export const png = (fill = "x") => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(fill)]);
