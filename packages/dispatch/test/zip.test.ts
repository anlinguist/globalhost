// The artifact zip reader against hostile archives (traversal, links, special files, bombs, lies).
import { describe, expect, it } from "vitest";
import { isSafeZipName, readZip, ZipError } from "../src/zip.js";
import { S_IFIFO, S_IFLNK, S_IFREG, png, writeZip } from "./zip-fixture.js";

const all = () => true;

describe("readZip", () => {
  it("reads stored and deflated entries, skipping directories and unselected entries", () => {
    const zip = writeZip([
      { name: "screenshots/" },
      { name: "screenshots/a.png", data: png("aaaa") },
      { name: "screenshots/b.png", data: png("b".repeat(5000)), deflate: true },
      { name: "playwright-report/index.html", data: "<html>" },
    ]);
    const got = readZip(zip, (n) => n.endsWith(".png"));
    expect(got.map((e) => e.name)).toEqual(["screenshots/a.png", "screenshots/b.png"]);
    expect(got[1]!.data.equals(png("b".repeat(5000)))).toBe(true);
  });

  it("accepts entries with no Unix mode recorded (non-Unix host)", () => {
    expect(readZip(writeZip([{ name: "a.png", data: "x", host: 0, mode: 0 }]), all)).toHaveLength(1);
  });

  it.each([
    ["parent traversal", "../escape.png"],
    ["nested traversal", "screenshots/../../escape.png"],
    ["absolute path", "/etc/passwd"],
    ["backslash", "screenshots\\..\\x.png"],
    ["drive letter", "C:/x.png"],
    ["dot segment", "./x.png"],
    ["empty segment", "a//b.png"],
    ["NUL in name", "a\u0000.png"],
    ["newline in name", "a\n.png"],
  ])("refuses an entry named with %s", (_label, name) => {
    expect(() => readZip(writeZip([{ name, data: "x" }]), all)).toThrow(ZipError);
  });

  it("refuses the whole archive for a bad name even when that entry isn't selected", () => {
    const zip = writeZip([{ name: "screenshots/a.png", data: png() }, { name: "../evil", data: "x" }]);
    expect(() => readZip(zip, (n) => n.startsWith("screenshots/"))).toThrow(/unsafe name/);
  });

  it.each([
    ["symlink", S_IFLNK | 0o777],
    ["FIFO", S_IFIFO | 0o644],
    ["directory mode on a file name", 0o040755],
  ])("refuses a %s entry", (_label, mode) => {
    expect(() => readZip(writeZip([{ name: "screenshots/a.png", data: "/etc/passwd", mode }]), all)).toThrow(/not a regular file/);
  });

  it("refuses a regular-file mode on a directory name", () => {
    expect(() => readZip(writeZip([{ name: "screenshots/", mode: S_IFREG | 0o644 }]), all)).toThrow(/not a regular file/);
  });

  it("refuses duplicate names, case-insensitively", () => {
    expect(() => readZip(writeZip([{ name: "a.png", data: "1" }, { name: "A.PNG", data: "2" }]), all)).toThrow(/repeats/);
  });

  it("refuses encrypted entries", () => {
    expect(() => readZip(writeZip([{ name: "a.png", data: "x", flags: 1 }]), all)).toThrow(/encrypted/);
  });

  it("refuses an entry over the per-entry cap without inflating it", () => {
    const zip = writeZip([{ name: "a.png", data: Buffer.alloc(2048), deflate: true }]);
    expect(() => readZip(zip, all, { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 10_000 })).toThrow(/max 1024/);
  });

  it("refuses a bomb that lies about its size", () => {
    // 10 MB of zeros declared as 100 bytes: inflation stops one byte past the declared size.
    const zip = writeZip([{ name: "a.png", data: Buffer.alloc(10 * 1024 * 1024), deflate: true, declaredSize: 100 }]);
    expect(() => readZip(zip, all)).toThrow(/declared size/);
  });

  it("refuses selected entries that add up past the total cap", () => {
    const zip = writeZip([
      { name: "a.png", data: Buffer.alloc(600) },
      { name: "b.png", data: Buffer.alloc(600) },
    ]);
    expect(() => readZip(zip, all, { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 1000 })).toThrow(/exceed/);
  });

  it("refuses too many entries", () => {
    const zip = writeZip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: "x" })));
    expect(() => readZip(zip, all, { maxEntries: 10, maxEntryBytes: 10, maxTotalBytes: 100 })).toThrow(/too many entries/);
  });

  it("refuses a CRC mismatch", () => {
    expect(() => readZip(writeZip([{ name: "a.png", data: "hello", crc: 1 }]), all)).toThrow(/CRC/);
  });

  it("refuses truncated and garbage input", () => {
    const zip = writeZip([{ name: "a.png", data: png() }]);
    expect(() => readZip(zip.subarray(0, zip.length - 5), all)).toThrow(ZipError);
    expect(() => readZip(Buffer.from("not a zip at all, just text padding it out"), all)).toThrow(ZipError);
    expect(() => readZip(Buffer.alloc(0), all)).toThrow(ZipError);
  });

  it("refuses a central directory that points a local header past the data", () => {
    const zip = writeZip([{ name: "a.png", data: png() }]);
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(cd + 4, cd + 42); // local header offset inside the central directory
    expect(() => readZip(zip, all)).toThrow(ZipError);
  });

  it("refuses zip64 markers", () => {
    const zip = writeZip([{ name: "a.png", data: png() }]);
    const eocd = zip.length - 22;
    zip.writeUInt16LE(0xffff, eocd + 8);
    zip.writeUInt16LE(0xffff, eocd + 10);
    expect(() => readZip(zip, all)).toThrow(/zip64/);
  });
});

describe("isSafeZipName", () => {
  it("accepts plain relative names", () => {
    expect(isSafeZipName("screenshots/desktop-home.png")).toBe(true);
    expect(isSafeZipName("dir/")).toBe(true);
  });
  it("refuses overlong names", () => {
    expect(isSafeZipName(`${"a".repeat(256)}.png`)).toBe(false);
  });
});
