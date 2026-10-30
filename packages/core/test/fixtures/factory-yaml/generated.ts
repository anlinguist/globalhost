// Fixtures that are impractical as committed files (64 KiB of padding, deliberately invalid UTF-8).
const VALID_HEAD = `version: 1
product: sample
owners:
  - { login: octo-owner, id: 1001 }
parts:
  app: { path: ., profile: fake-ext }
`;

/** A valid file padded with a comment to exactly `size` bytes. */
export function paddedTo(size: number): Uint8Array {
  const head = new TextEncoder().encode(VALID_HEAD);
  const out = new Uint8Array(size);
  out.set(head);
  out[head.length] = 0x23; // '#'
  out.fill(0x78, head.length + 1, size - 1); // 'x'
  out[size - 1] = 0x0a;
  return out;
}

export interface GeneratedInvalidFixture {
  name: string;
  bytes: Uint8Array;
  expected: Array<{ path: string; code: string }>;
}

export const generatedInvalid: GeneratedInvalidFixture[] = [
  { name: "64 KiB + 1 byte", bytes: paddedTo(64 * 1024 + 1), expected: [{ path: "", code: "yaml_too_large" }] },
  {
    name: "invalid UTF-8 (lone continuation byte)",
    bytes: new Uint8Array([...new TextEncoder().encode(VALID_HEAD), 0x23, 0x80, 0x0a]),
    expected: [{ path: "", code: "yaml_encoding" }],
  },
  {
    name: "invalid UTF-8 (overlong encoding of '/')",
    bytes: new Uint8Array([...new TextEncoder().encode(VALID_HEAD), 0x23, 0xc0, 0xaf, 0x0a]),
    expected: [{ path: "", code: "yaml_encoding" }],
  },
];
