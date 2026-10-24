// Copied from capsule-host's src/webauthn.ts (same owner), unchanged but for this note.
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";

// Server-side WebAuthn checks for exactly what this app uses: attestation "none", user verification required, ES256 or RS256.
// The public key arrives as the SPKI from the browser's getPublicKey(), so no CBOR is parsed. Only the credential id and the
// public key are kept. Every failure is the same Error("passkey"): callers must not learn which check refused them.
export type Passkey = { id: string; publicKey: string; algorithm: -7 | -257; counter: number; created: number };
type Expected = { challenge: string; origin: string; rpId: string };
const UP = 0x01, UV = 0x04, AT = 0x40;
const refuse = (): never => { throw new Error("passkey"); };
const bytes = (value: string) => Buffer.from(value, "base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

function ceremony(type: string, clientDataJSON: Buffer, authenticatorData: Buffer, expected: Expected, flags: number) {
  let client: { type?: unknown; challenge?: unknown; origin?: unknown } | null;
  try { client = JSON.parse(clientDataJSON.toString("utf8")); } catch { return refuse(); }
  if (!client || typeof client !== "object") refuse();
  if (client!.type !== type || client!.challenge !== expected.challenge || client!.origin !== expected.origin) refuse();
  if (authenticatorData.length < 37 || !timingSafeEqual(authenticatorData.subarray(0, 32), sha256(expected.rpId))) refuse();
  if ((authenticatorData[32]! & flags) !== flags) refuse();
  return authenticatorData.readUInt32BE(33);
}
function publicKey(spki: string, algorithm: number): KeyObject {
  let key: KeyObject;
  try { key = createPublicKey({ key: bytes(spki), format: "der", type: "spki" }); } catch { return refuse(); }
  const matches = algorithm === -7 ? key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" : algorithm === -257 && key.asymmetricKeyType === "rsa";
  return matches ? key : refuse();
}

export function verifyRegistration(input: { clientDataJSON: string; authenticatorData: string; publicKey: string; algorithm: number }, expected: Expected, now: number): Passkey {
  const data = bytes(input.authenticatorData), counter = ceremony("webauthn.create", bytes(input.clientDataJSON), data, expected, UP | UV | AT);
  publicKey(input.publicKey, input.algorithm);
  // Attested credential data: AAGUID (16) at 37, then the id's length (2) at 53 and the id itself.
  if (data.length < 55) refuse();
  const length = data.readUInt16BE(53);
  if (length < 1 || length > 1023 || data.length < 55 + length) refuse();
  return { id: data.subarray(55, 55 + length).toString("base64url"), publicKey: input.publicKey, algorithm: input.algorithm as -7 | -257, counter, created: now };
}

// Returns the counter to store. An authenticator that counts must move forward; one that never counts reports 0 every time.
export function verifyAssertion(input: { clientDataJSON: string; authenticatorData: string; signature: string }, expected: Expected, passkey: Passkey): number {
  const client = bytes(input.clientDataJSON), data = bytes(input.authenticatorData), counter = ceremony("webauthn.get", client, data, expected, UP | UV);
  let valid = false;
  try { valid = verify("sha256", Buffer.concat([data, sha256(client)]), publicKey(passkey.publicKey, passkey.algorithm), bytes(input.signature)); } catch { refuse(); }
  if (!valid || ((counter !== 0 || passkey.counter !== 0) && counter <= passkey.counter)) refuse();
  return counter;
}

export const rpIdOf = (origin: string) => new URL(origin).hostname;
