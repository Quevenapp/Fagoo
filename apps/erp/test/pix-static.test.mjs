import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from '../../../packages/fiscal-danfe/node_modules/jsqr/dist/jsQR.js';
import { crc16, pixFields, pixKey, pixPayload, pixText } from '../src/lib/pix-static.ts';
import { qrCapacity, qrEncode, qrPath, QR_MAX_VERSION } from '../src/lib/qr-code.ts';

// Synthetic keys only. "Pix - QR Code Impresso (QR estático)" of the Frente de caixa: BR Code payload and the local QR encoder.
function decode(text) {
  const matrix = qrEncode(text), scale = 4, quiet = 4, side = (matrix.size + quiet * 2) * scale, pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  matrix.modules.forEach((row, r) => row.forEach((dark, c) => {
    if (!dark) return;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) { const index = (((r + quiet) * scale + y) * side + (c + quiet) * scale + x) * 4; pixels[index] = pixels[index + 1] = pixels[index + 2] = 0; }
  }));
  return { matrix, result: jsQR(pixels, side, side) };
}

test('CRC16 CCITT-FALSE, keys and texts as the BR Code expects', () => {
  assert.equal(crc16('123456789'), '29B1');
  assert.equal(pixKey('cpf', '123.456.789-09'), '12345678909');
  assert.equal(pixKey('cnpj', '12.345.678/0001-95'), '12345678000195');
  assert.equal(pixKey('phone', '(11) 91234-5678'), '+5511912345678');
  assert.equal(pixKey('phone', '+55 11 91234-5678'), '+5511912345678');
  assert.equal(pixKey('email', ' Pix@Sintetico.Test '), 'pix@sintetico.test');
  assert.throws(() => pixKey('random', 'abc'), /chave aleatória/);
  assert.equal(pixText('São Paulo — Centro', 15), 'SAO PAULO CENTR');
});

test('Static Pix payload with amount and txid; the fields read back and the CRC closes the payload', () => {
  const payload = pixPayload({ keyType: 'email', key: 'pix@sintetico.test', merchantName: 'Loja Sintética Ltda', merchantCity: 'São Paulo', amountCents: '12345', reference: 'PDV-42' });
  const fields = pixFields(payload);
  assert.equal(fields.get('00'), '01');
  assert.equal(fields.get('26'), '0014br.gov.bcb.pix0118pix@sintetico.test');
  assert.deepEqual([fields.get('52'), fields.get('53'), fields.get('54'), fields.get('58'), fields.get('59'), fields.get('60'), fields.get('62')], ['0000', '986', '123.45', 'BR', 'LOJA SINTETICA LTDA', 'SAO PAULO', '0505PDV42']);
  assert.match(payload, /6304[0-9A-F]{4}$/);
  const fixed = pixFields(pixPayload({ keyType: 'random', key: '123e4567-e89b-42d3-a456-426614174000', merchantName: 'Loja', merchantCity: 'Campinas' }));
  assert.equal(fixed.has('54'), false, 'the QR code fixo has no amount');
  assert.equal(fixed.get('62'), '0503***');
  assert.throws(() => pixPayload({ keyType: 'cpf', key: '12345678909', merchantName: 'Loja', merchantCity: 'X', amountCents: '0' }), /PIX_AMOUNT_INVALID/);
});

test('The local QR encoder produces codes a standard decoder reads, from version 1 to 15', () => {
  for (const text of ['PDV', 'https://synthetic.invalid/frente-caixa', pixPayload({ keyType: 'email', key: 'pix@sintetico.test', merchantName: 'Loja Sintética', merchantCity: 'São Paulo', amountCents: '999', reference: 'PDV1' })]) {
    const { result } = decode(text);
    assert.ok(result, `decoded ${text.slice(0, 20)}`); assert.equal(result.data, text);
  }
  for (const version of [5, 7, 9, 10, 12, 14, QR_MAX_VERSION]) {
    const text = 'B'.repeat(qrCapacity(version)), { matrix, result } = decode(text);
    assert.equal(matrix.version, version); assert.ok(result, `version ${version}`); assert.equal(result.data, text);
  }
  assert.throws(() => qrEncode('x'.repeat(qrCapacity(QR_MAX_VERSION) + 1)), /QR_TOO_LONG/);
  assert.match(qrPath(qrEncode('PDV')), /^M\d+ \d+h1v1h-1z/);
});
