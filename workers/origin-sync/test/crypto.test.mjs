import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptTokens, encryptTokens, randomToken, sha256 } from '../src/crypto.mjs';

const key = Buffer.alloc(32, 7).toString('base64');
const tokens = { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer' };

test('token encryption roundtrips with independent random IVs and no plaintext', async () => {
  const first = await encryptTokens(tokens, key);
  const second = await encryptTokens(tokens, key);
  assert.deepEqual(await decryptTokens(first, key), tokens);
  assert.deepEqual(await decryptTokens(second, key), tokens);
  assert.equal(first.version, 1);
  assert.equal(Buffer.from(first.iv, 'base64').length, 12);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes(tokens.access_token));
});

test('wrong key and tampering cannot decrypt token envelopes', async () => {
  const envelope = await encryptTokens(tokens, key);
  await assert.rejects(decryptTokens(envelope, Buffer.alloc(32, 8).toString('base64')), /^Error: TOKEN_DECRYPT_FAILED$/);
  for (const field of ['iv', 'ciphertext']) {
    const bytes = Buffer.from(envelope[field], 'base64');
    bytes[0] ^= 1;
    await assert.rejects(decryptTokens({ ...envelope, [field]: bytes.toString('base64') }, key), /^Error: TOKEN_DECRYPT_FAILED$/);
  }
});

test('malformed keys and envelopes fail with fixed errors', async () => {
  for (const invalid of ['', 'private-malformed-key', Buffer.alloc(16).toString('base64')]) {
    await assert.rejects(encryptTokens(tokens, invalid), /^Error: INVALID_ENCRYPTION_KEY$/);
  }
  const envelope = await encryptTokens(tokens, key);
  for (const invalid of [null, { ...envelope, version: 2 }, { ...envelope, iv: 'invalid' }, { ...envelope, iv: 'AA==' }]) {
    await assert.rejects(decryptTokens(invalid, key), /^Error: INVALID_TOKEN_ENVELOPE$/);
  }
  await assert.rejects(encryptTokens(null, key), /^Error: INVALID_TOKEN_PAYLOAD$/);
});

test('hashing uses SHA256 and state tokens have 256 random bits', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const values = new Set(Array.from({ length: 32 }, randomToken));
  assert.equal(values.size, 32);
  for (const value of values) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
});
