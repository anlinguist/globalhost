import { createHmac, createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const TEAM = "test-team.cloudflareaccess.com";
export const ISSUER = `https://${TEAM}`;
export const AUD = "a".repeat(64);
export const OTHER_AUD = "b".repeat(64);
export const NOW = 1_800_000_000;

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: JsonWebKey;
}

export function makeKey(kid: string, bits = 2048): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return { kid, privateKey, publicKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: [AUD],
    email: "owner@example.com",
    sub: "user-1",
    type: "app",
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 3600,
    ...over,
  };
}

/** RS256-sign `payload` with `key`, with an overridable header. */
export function sign(key: TestKey, payload: Record<string, unknown> = claims(), header: Record<string, unknown> = {}): string {
  const input = `${b64({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(input).sign(key.privateKey).toString("base64url");
  return `${input}.${sig}`;
}

/** HS256 token keyed with the RSA public key's PEM: the classic alg-confusion forgery. */
export function signHs256WithPublicKey(key: TestKey, payload: Record<string, unknown> = claims()): string {
  const input = `${b64({ alg: "HS256", kid: key.kid, typ: "JWT" })}.${b64(payload)}`;
  const pem = key.publicKey.export({ format: "pem", type: "spki" });
  const sig = createHmac("sha256", pem).update(input).digest("base64url");
  return `${input}.${sig}`;
}

export function unsigned(key: TestKey, payload: Record<string, unknown> = claims()): string {
  return `${b64({ alg: "none", kid: key.kid, typ: "JWT" })}.${b64(payload)}.`;
}

export async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

export async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Local JWKS endpoint; mutate `state` to rotate keys or make it fail. */
export interface JwksServer {
  url: string;
  hits: number;
  state: { keys: JsonWebKey[]; status: number; body?: string };
  server: http.Server;
}

export async function startJwks(keys: JsonWebKey[]): Promise<JwksServer> {
  const s: JwksServer = { url: "", hits: 0, state: { keys, status: 200 }, server: http.createServer() };
  s.server.on("request", (_req, res) => {
    s.hits++;
    res.writeHead(s.state.status, { "content-type": "application/json" });
    res.end(s.state.body ?? JSON.stringify({ keys: s.state.keys }));
  });
  const port = await listen(s.server);
  s.url = `http://127.0.0.1:${port}/cdn-cgi/access/certs`;
  return s;
}
