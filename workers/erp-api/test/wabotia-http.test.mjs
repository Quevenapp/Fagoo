import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.mjs";
const actor = "10000000-0000-4000-8000-000000000001",
  session = "10000000-0000-4000-8000-000000000002";
const token =
  "h." +
  Buffer.from(JSON.stringify({ session_id: session, aal: "aal2" })).toString(
    "base64url",
  ) +
  ".s";
const env = {
  SUPABASE_DEPLOYMENT: "self-hosted",
  SUPABASE_URL: "https://services.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
  ALLOWED_ORIGINS: "https://erp.example.test",
};
test("a rota instalada exige administrador autenticado, MFA e origem autorizada antes de ler a conexão", async () => {
  for (const [role, mfa, origin, status] of [
    ["vendas", true, "https://erp.example.test", 403],
    ["admin", false, "https://erp.example.test", 403],
    ["admin", true, "https://evil.example", 403],
    ["admin", true, "https://erp.example.test", 200],
  ]) {
    let read = false;
    const handler = createHandler({
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path === "/auth/v1/user")
          return Response.json({ id: actor, is_anonymous: false });
        if (path === "/rest/v1/rpc/erp_access_gate_v2")
          return Response.json({
            scope: "access_gate",
            user_id: actor,
            open: true,
            mfa_required: true,
            mfa_ok: mfa,
          });
        if (path === "/rest/v1/rpc/erp_access_me")
          return Response.json({ user_id: actor, role });
        if (path === "/rest/v1/rpc/erp_wabotia_state") {
          read = true;
          return Response.json({ cipher: "" });
        }
        throw new Error("Unexpected upstream");
      },
    });
    const response = await handler(
      new Request("https://api.example.test/v1/system/wabotia", {
        headers: { Authorization: "Bearer " + token, Origin: origin },
      }),
      env,
    );
    assert.equal(response.status, status);
    assert.equal(read, status === 200);
  }
});
