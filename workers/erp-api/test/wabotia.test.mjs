import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { handleWabotia, wabotiaOrigin } from "../src/wabotia.mjs";

test("origens de pareamento recusam credenciais, URLs privadas, caminhos e HTTP", () => {
  assert.equal(
    wabotiaOrigin("https://atendimento.exemplo.com"),
    "https://atendimento.exemplo.com",
  );
  for (const u of [
    "http://example.com",
    "https://127.0.0.1",
    "https://localhost",
    "https://u:p@example.com",
    "https://example.com/x",
    "https://example.com/?secret=y",
  ])
    assert.throws(() => wabotiaOrigin(u));
});
test("fluxo admin usa Postgres real: segredo cifrado, consulta limitada, troca e revogação", async () => {
  const db = new PGlite();
  await db.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
  );
  await db.exec(
    await readFile(
      new URL(
        "../../../supabase/migrations/202611090001_wabotia_pairing.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const calls = [],
    secret = "existing-service-role-key-for-tests-only";
  let approved = false;
  const settings = {
    baseUrl: "https://services.exemplo.com",
    key: secret,
    origins: ["https://erp.exemplo.com"],
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (url.endsWith("/rpc/erp_wabotia_state")) {
      assert.equal(init.headers.apikey, settings.key);
      const r = await db.query(
        "SELECT public.erp_wabotia_state($1,$2,$3) AS value",
        [body.p_action, body.p_lock, body.p_cipher],
      );
      return Response.json(r.rows[0].value);
    }
    if (url.endsWith("/api/pairing/start"))
      return Response.json({
        device_code: "a".repeat(64),
        user_code: "ABCD-2345",
        expires_in: 600,
      });
    if (url.endsWith("/api/pairing/token"))
      return Response.json(
        approved
          ? {
              status: "connected",
              access_token: "wab_backend_only",
              profile_id: "perfil",
              application_id: "app",
              scopes: ["tickets:read"],
              number_ids: [],
              pool_ids: [],
              bot_ids: [],
            }
          : { status: "authorization_pending" },
      );
    if (url.endsWith("/api/v1/pairings/disconnect")) {
      assert.equal(init.headers.Authorization, "Bearer wab_backend_only");
      return Response.json({ revoked: true });
    }
    throw new Error("unexpected request");
  };
  const authenticate = async (token) => {
    if (token !== "admin")
      throw Object.assign(new Error("forbidden"), { status: 403 });
    return "admin";
  };
  const call = (action = "", body = {}, token = "admin") =>
    handleWabotia({
      settings,
      fetchImpl,
      authenticate,
      request: new Request(
        "https://api.exemplo.com/v1/system/wabotia" +
          (action ? "/" + action : ""),
        {
          method: action ? "POST" : "GET",
          headers: {
            Authorization: "Bearer " + token,
            Origin: "https://erp.exemplo.com",
            "Content-Type": "application/json",
          },
          body: action ? JSON.stringify(body) : undefined,
        },
      ),
    });
  try {
    assert.equal((await call("", {}, "operator")).status, 403);
    assert.equal(calls.length, 0);
    const started = await call("start", {
      url: "https://wabotia.exemplo.com",
      name: "Fagoo Centro",
    });
    assert.equal(started.status, 200);
    const publicStart = await started.text();
    assert.match(publicStart, /ABCD-2345/);
    assert.doesNotMatch(publicStart, /aaaa|device_code/);
    assert.equal((await call("poll")).status, 429);
    assert.equal(
      (
        await call("start", {
          url: "https://wabotia.exemplo.com",
          name: "Outra",
        })
      ).status,
      409,
    );
    const saved = (await db.query("SELECT cipher FROM erp_wabotia_pairing"))
      .rows[0].cipher;
    assert.doesNotMatch(saved, /ABCD|aaaa/);
    await new Promise((r) => setTimeout(r, 5100));
    approved = true;
    const connected = await call("poll");
    assert.equal(connected.status, 200);
    const text = await connected.text();
    assert.match(text, /connected/);
    assert.doesNotMatch(text, /wab_backend|access_token/);
    assert.equal((await call("poll")).status, 409);
    assert.equal((await call("disconnect")).status, 200);
    assert.equal((await (await call()).json()).status, "disconnected");
    await db.query("UPDATE erp_wabotia_pairing SET cipher=$1", [saved]);
    settings.key = "rotated-existing-service-key";
    assert.equal((await (await call()).json()).status, "recovery_required");
    assert.equal((await call("forget", {})).status, 400);
    assert.equal(
      (await call("forget", { confirmed: true }, "operator")).status,
      403,
    );
    assert.equal(
      (await (await call("forget", { confirmed: true })).json())
        .remote_revocation_required,
      true,
    );
    assert.equal(
      (
        await call("start", {
          url: "https://wabotia.exemplo.com",
          name: "Instalação recuperada",
        })
      ).status,
      200,
    );
    await db.exec("SET ROLE authenticated;");
    await assert.rejects(() => db.query("SELECT erp_wabotia_state('read')"));
  } finally {
    await db.close();
  }
});
