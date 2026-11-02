import test from "node:test";
import assert from "node:assert/strict";
import { currency, decimal, quantity } from "../src/format.mjs";

test("unit prices retain ten decimal places without floating point conversion", () => {
  assert.equal(decimal("0,0000000001", { places: 10 }), "0.0000000001");
  assert.equal(currency("0.0000000001", 10), "R$\u00a00,0000000001");
  assert.equal(
    currency("999999999999999999.1234567891", 10),
    "R$\u00a0999.999.999.999.999.999,1234567891",
  );
  assert.equal(
    quantity("999999999999999999.123456"),
    "999.999.999.999.999.999,123456",
  );
  assert.throws(() => decimal("0.00000000001", { places: 10 }));
  assert.throws(() => decimal("0.0000001"));
});
