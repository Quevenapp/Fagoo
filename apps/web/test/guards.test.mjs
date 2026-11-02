import test from "node:test";
import assert from "node:assert/strict";
import { loginContinuation, consentContinuation } from "../src/redirect.mjs";
import edge from "../worker.mjs";

test("login continuation cannot forward credentials or flow to another origin", () => {
  assert.equal(
    loginContinuation(
      "/api/auth/oauth2/authorize?x=1",
      "https://erp.example.test",
    ),
    "https://erp.example.test/api/auth/oauth2/authorize?x=1",
  );
  for (const value of [
    "https://other.example.test/api/auth/oauth2/authorize",
    "//other.example.test/api/auth/oauth2/authorize",
    "javascript:alert(1)",
    "/api/v1/products",
  ])
    assert.throws(() => loginContinuation(value, "https://erp.example.test"));
});
test("consent continuation rejects executable, local-file and insecure remote schemes", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///tmp/private",
    "http://remote.example.test/cb",
    "https://username:password@example.test/cb",
    "custom-unknown://return",
    "app.fagoo://other/callback",
    "app.fagoo://oauth/other",
  ])
    assert.throws(() => consentContinuation(value));
  assert.equal(
    consentContinuation("app.fagoo://oauth/callback?code=opaque"),
    "app.fagoo://oauth/callback?code=opaque",
  );
  assert.equal(
    consentContinuation("https://client.example.test/callback"),
    "https://client.example.test/callback",
  );
  assert.equal(
    consentContinuation("http://127.0.0.1:8765/callback"),
    "http://127.0.0.1:8765/callback",
  );
});
test("edge proxy replaces caller secret, forwards cookies, preserves status and prevents caching", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (request) => {
    seen = request;
    return Response.json(
      { ok: true },
      {
        status: 201,
        headers: { "Set-Cookie": "session=opaque; HttpOnly; Secure" },
      },
    );
  };
  try {
    const response = await edge.fetch(
      new Request("https://erp.example.test/api/v1/products?limit=1", {
        headers: {
          "X-Fagoo-Proxy-Secret": "caller-value",
          Cookie: "session=current",
        },
      }),
      {
        FAGOO_API_ORIGIN: "https://origin.example.test",
        FAGOO_PROXY_SECRET: "trusted-proxy-secret",
      },
    );
    assert.equal(
      seen.url,
      "https://origin.example.test/api/v1/products?limit=1",
    );
    assert.equal(
      seen.headers.get("x-fagoo-proxy-secret"),
      "trusted-proxy-secret",
    );
    assert.equal(seen.headers.get("cookie"), "session=current");
    assert.equal(seen.headers.get("x-forwarded-host"), "erp.example.test");
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("set-cookie"),
      "session=opaque; HttpOnly; Secure",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("edge proxy does not call malformed or recursive origins", async () => {
  for (const origin of [
    "",
    "http://origin.example.test",
    "https://erp.example.test",
    "https://user:pass@origin.example.test",
    "https://origin.example.test/path",
  ]) {
    const response = await edge.fetch(
      new Request("https://erp.example.test/api/auth/get-session"),
      { FAGOO_API_ORIGIN: origin },
    );
    assert.equal(response.status, 503);
  }
});
