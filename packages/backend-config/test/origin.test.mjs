import test from 'node:test';
import assert from 'node:assert/strict';
import { isConfiguredBackendOrigin as valid } from '../src/origin.mjs';

test('hosted remains the default and requires the original project reference', () => {
  assert.equal(valid('https://abcdefghijklmnopqrst.supabase.co'), true);
  for (const value of ['https://short.supabase.co', 'https://backend.example.com', 'https://evil.invalid']) assert.equal(valid(value), false);
  assert.equal(valid('https://short.supabase.co', 'hosted', { legacyHosted: true }), true);
});
test('self-hosted requires explicit deployment and a canonical HTTPS origin', () => {
  assert.equal(valid('https://backend.example.com', 'self-hosted'), true);
  for (const value of ['http://backend.example.com', 'https://u:p@backend.example.com', 'https://backend.example.com:8443',
    'https://backend.example.com:443', 'https://backend.example.com/path', 'https://backend.example.com/a/..',
    'https://backend.example.com?x=1', 'https://backend.example.com#x', 'https://backend.example.com/',
    ' https://backend.example.com', 'https://BACKEND.example.com', 'https://backend.example.com\n',
    'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://bad_.example.com', 'https://backend.example.com.']) {
    assert.equal(valid(value, 'self-hosted'), false, value);
  }
  assert.equal(valid('https://backend.example.com/', 'self-hosted', { allowTrailingSlash: true }), true);
  assert.equal(valid('https://backend.example.com', 'automatic'), false);
});
