import { constants, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import type { Queryable } from '../db.js';

/**
 * WhatsApp forms that load live data talk to us through an encrypted endpoint:
 *  - WhatsApp encrypts each request with a fresh AES-128 key, and encrypts that key with our RSA public key.
 *  - We decrypt the AES key with our private key, read the request, and answer encrypted with the same AES key
 *    and the bit-flipped IV.
 * The key pair is made once by the server and kept in the database (or given as FLOWS_PRIVATE_KEY on Render).
 * The public half is registered with Meta on start.
 */

export interface DecryptedRequest { body: Record<string, any>; aesKey: Buffer; iv: Buffer }

export class FlowDecryptError extends Error {}

export function decryptRequest(req: { encrypted_flow_data?: string; encrypted_aes_key?: string; initial_vector?: string }, privateKeyPem: string): DecryptedRequest {
  if (!req.encrypted_flow_data || !req.encrypted_aes_key || !req.initial_vector) throw new FlowDecryptError('missing fields');
  let aesKey: Buffer;
  try {
    aesKey = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(req.encrypted_aes_key, 'base64'));
  } catch (e) {
    throw new FlowDecryptError(`can't decrypt the AES key: ${(e as Error).message}`);
  }
  const data = Buffer.from(req.encrypted_flow_data, 'base64');
  const iv = Buffer.from(req.initial_vector, 'base64');
  const tag = data.subarray(-16);
  const decipher = createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8');
  return { body: JSON.parse(plain), aesKey, iv };
}

export function encryptResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((b) => b ^ 0xff));
  const cipher = createCipheriv('aes-128-gcm', aesKey, flipped);
  const out = Buffer.concat([cipher.update(JSON.stringify(response), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return out.toString('base64');
}

/** What WhatsApp does on its side (used by tests and the local preview). */
export function encryptRequestForTest(body: unknown, publicKeyPem: string): { request: { encrypted_flow_data: string; encrypted_aes_key: string; initial_vector: string }; aesKey: Buffer; iv: Buffer } {
  const aesKey = randomBytes(16), iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-gcm', aesKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const key = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
  return { request: { encrypted_flow_data: data.toString('base64'), encrypted_aes_key: key.toString('base64'), initial_vector: iv.toString('base64') }, aesKey, iv };
}

export function decryptResponseForTest(text: string, aesKey: Buffer, iv: Buffer): any {
  const data = Buffer.from(text, 'base64');
  const flipped = Buffer.from(iv.map((b) => b ^ 0xff));
  const d = createDecipheriv('aes-128-gcm', aesKey, flipped);
  d.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, -16)), d.final()]).toString('utf8'));
}

export interface FlowKeys { privateKeyPem: string; publicKeyPem: string; source: 'env' | 'database' | 'new' }

/** The endpoint's key pair: FLOWS_PRIVATE_KEY if set, else the one the server made earlier, else a new one (saved). */
export async function flowKeys(db: Queryable, envPem?: string | null): Promise<FlowKeys> {
  const fromPem = (pem: string, source: FlowKeys['source']): FlowKeys => ({
    privateKeyPem: pem, publicKeyPem: createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }).toString(), source,
  });
  if (envPem && envPem.includes('PRIVATE KEY')) return fromPem(envPem.replace(/\\n/g, '\n'), 'env');
  const r = await db.query(`SELECT value FROM app_secrets WHERE key='flows_private_key'`);
  if (r.rows[0]) return fromPem(r.rows[0].value, 'database');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await db.query(`INSERT INTO app_secrets (key, value) VALUES ('flows_private_key', $1) ON CONFLICT (key) DO NOTHING`, [pem]);
  const again = await db.query(`SELECT value FROM app_secrets WHERE key='flows_private_key'`); // another instance may have won the race
  return fromPem(again.rows[0].value, 'new');
}
