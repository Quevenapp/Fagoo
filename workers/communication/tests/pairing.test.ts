import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { exec, one } from "../src/db";
import { authenticate } from "../src/security";
import { type Actor, now, uid } from "../src/types";
import {
  pairingStart,
  pairingLookup,
  pairingApprove,
  pairingToken,
  pairingRevoke,
  pairingDeny,
  pairingList,
  pairingDisconnect,
  prunePairings,
} from "../src/pairing";

const admin: Actor = {
  id: "pair-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 3,
};
async function fixture(client = "vinki") {
  const profile = uid(),
    ip = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,?,?)",
    profile,
    "Pareamento",
    now(),
  );
  const session = await pairingStart(
    env,
    { client, instance_name: "Loja de teste" },
    "https://wabotia.test",
    ip,
  );
  const request = await pairingLookup(
    env,
    { ...admin, id: uid() },
    session.user_code,
  );
  return {
    profile,
    ip,
    session,
    request,
    body: { client, device_code: session.device_code },
  };
}

describe("pareamento entre sistemas", () => {
  it("desconecta somente a própria aplicação e limpa acessos expirados sem revogar vínculos consumidos", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const item of [f, other])
      await pairingApprove(env, admin, item.request.id, {
        profile_id: item.profile,
        scopes: ["routing:read"],
      });
    const token = await pairingToken(env, f.body, f.ip);
    const actor = await authenticate(
      env,
      new Request("https://wabotia.test", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }),
    );
    await expect(pairingDisconnect(env, admin)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      pairingDisconnect(env, { ...actor, id: "app:other" }),
    ).rejects.toMatchObject({ status: 404 });
    await exec(
      env,
      "UPDATE pairing_requests SET expires=0 WHERE id IN (?,?)",
      f.request.id,
      other.request.id,
    );
    await prunePairings(env);
    expect(
      (
        await one(
          env,
          "SELECT credential FROM pairing_requests WHERE id=?",
          other.request.id,
        )
      ).credential,
    ).toBeNull();
    expect(
      (
        await one(
          env,
          "SELECT k.revoked FROM api_keys k JOIN pairing_requests p ON p.key_id=k.id WHERE p.id=?",
          other.request.id,
        )
      ).revoked,
    ).toBe(1);
    expect(
      (
        await authenticate(
          env,
          new Request("https://wabotia.test", {
            headers: { Authorization: `Bearer ${token.access_token}` },
          }),
        )
      ).id,
    ).toBe(actor.id);
    await pairingDisconnect(env, actor);
    await expect(
      authenticate(
        env,
        new Request("https://wabotia.test", {
          headers: { Authorization: `Bearer ${token.access_token}` },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("entrega chave apenas ao servidor iniciador depois da aprovação; repetições não geram outro acesso", async () => {
    const f = await fixture();
    expect(f.session.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(f.session.verification_uri).toBe("https://wabotia.test/app?pair=1");
    expect((await pairingToken(env, f.body, f.ip)).status).toBe(
      "authorization_pending",
    );
    await expect(pairingToken(env, f.body, f.ip)).rejects.toMatchObject({
      code: "slow_down",
    });
    const approved = await pairingApprove(env, admin, f.request.id, {
      profile_id: f.profile,
      scopes: ["routing:read"],
      number_ids: [],
      pool_ids: [],
      bot_ids: [],
    });
    expect(JSON.stringify(approved)).not.toContain("wab_");
    expect(JSON.stringify(await pairingList(env, admin))).not.toContain(
      "device_hash",
    );
    const stored = await one(
      env,
      "SELECT * FROM pairing_requests WHERE id=?",
      f.request.id,
    );
    expect(stored.device_hash).not.toBe(f.session.device_code);
    expect(stored.user_hash).not.toContain(
      f.session.user_code.replace("-", ""),
    );
    expect(stored.credential).not.toContain("wab_");
    await expect(
      pairingApprove(env, admin, f.request.id, {
        profile_id: f.profile,
        scopes: ["routing:read"],
      }),
    ).rejects.toMatchObject({ code: "pairing_not_found" });
    await exec(
      env,
      "UPDATE pairing_requests SET next_poll_at=0 WHERE id=?",
      f.request.id,
    );
    const token = await pairingToken(env, f.body, f.ip);
    expect(token.status).toBe("connected");
    const actor = await authenticate(
      env,
      new Request("https://wabotia.test/api/v1/profiles", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }),
    );
    expect(actor.profiles).toEqual([f.profile]);
    expect(actor.scopes).toEqual(["routing:read"]);
    expect(
      (
        await one(
          env,
          "SELECT credential FROM pairing_requests WHERE id=?",
          f.request.id,
        )
      ).credential,
    ).toBeNull();
    await expect(pairingToken(env, f.body, f.ip)).rejects.toMatchObject({
      code: "invalid_grant",
    });
    await pairingRevoke(env, admin, f.request.id);
    await expect(
      authenticate(
        env,
        new Request("https://wabotia.test/api/v1/profiles", {
          headers: { Authorization: `Bearer ${token.access_token}` },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("recusa operador, escopo pago e recursos de outro perfil sem criar aplicação", async () => {
    const f = await fixture();
    const operator = { ...admin, role: "operator" } as Actor;
    await expect(
      pairingLookup(env, operator, f.session.user_code),
    ).rejects.toMatchObject({ code: "admin_required" });
    await expect(
      pairingApprove(env, operator, f.request.id, {}),
    ).rejects.toMatchObject({ code: "admin_required" });
    await expect(
      pairingApprove(env, admin, f.request.id, {
        profile_id: f.profile,
        scopes: ["routing:paid"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      pairingApprove(env, admin, f.request.id, {
        profile_id: f.profile,
        scopes: ["routing:send"],
        number_ids: [uid()],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      pairingApprove(env, admin, f.request.id, {
        profile_id: uid(),
        scopes: ["routing:read"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(
      (
        await one(
          env,
          "SELECT app_id FROM pairing_requests WHERE id=?",
          f.request.id,
        )
      ).app_id,
    ).toBeNull();
  });

  it("código expirado, recusa e client diferente não entregam credenciais", async () => {
    const expired = await fixture(),
      denied = await fixture("fagoo");
    await exec(
      env,
      "UPDATE pairing_requests SET expires=? WHERE id=?",
      now() - 1,
      expired.request.id,
    );
    await expect(
      pairingLookup(env, admin, expired.session.user_code),
    ).rejects.toMatchObject({ code: "pairing_not_found" });
    await expect(
      pairingToken(env, expired.body, expired.ip),
    ).rejects.toMatchObject({ code: "expired_token" });
    await expect(
      pairingToken(env, { ...denied.body, client: "vinki" }, denied.ip),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await pairingDeny(env, admin, denied.request.id);
    await expect(
      pairingToken(env, denied.body, denied.ip),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(
      (await pairingList(env, admin)).data.some(
        (r) => r.id === denied.request.id,
      ),
    ).toBe(false);
  });

  it("aprova atomicamente uma vez mesmo com duas requisições concorrentes", async () => {
    const f = await fixture("fagoo"),
      body = { profile_id: f.profile, scopes: ["tickets:read"] };
    const result = await Promise.allSettled([
      pairingApprove(env, admin, f.request.id, body),
      pairingApprove(env, admin, f.request.id, body),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await one(
          env,
          "SELECT count(*) n FROM applications WHERE profiles=?",
          JSON.stringify([f.profile]),
        )
      ).n,
    ).toBe(1);
    const poll = await Promise.allSettled([
      pairingToken(env, f.body, f.ip),
      pairingToken(env, f.body, f.ip),
    ]);
    expect(poll.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("limita criação e busca de códigos e não aceita clientes arbitrários", async () => {
    await expect(
      pairingStart(
        env,
        { client: "unknown", instance_name: "Teste" },
        "https://test",
        uid(),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const actor = { ...admin, id: uid() };
    for (let i = 0; i < 12; i++)
      await expect(
        pairingLookup(env, actor, "ZZZZ-ZZZZ"),
      ).rejects.toMatchObject({ code: "pairing_not_found" });
    await expect(pairingLookup(env, actor, "ZZZZ-ZZZZ")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});
