import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { passwordHash, passwordVerify, seal, unseal } from "../src/security";
import { perform, inbound, conversation, enqueue } from "../src/service";
import { processInbox, deliver } from "../src/engine";
import { all, one, exec } from "../src/db";
import { defaults, uid, now, type Actor } from "../src/types";
const admin: Actor = {
  id: "admin",
  kind: "user",
  name: "Admin",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 10,
};
async function fixture() {
  const id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    id,
    "Teste",
    JSON.stringify(defaults),
    now(),
  );
  return id;
}
async function command(
  p: string,
  key: string,
  data: any,
  op = "conversation.create",
  actor = admin,
) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(p)).fetch(
    "https://coordinator/command",
    {
      method: "POST",
      body: JSON.stringify({
        profile: p,
        actor,
        operation: op,
        key,
        data,
        requestId: uid(),
      }),
    },
  );
}
describe("núcleo no runtime Workers", () => {
  it("protege senhas e credenciais", async () => {
    const h = passwordHash("senha de teste segura");
    expect(h).not.toContain("senha de teste segura");
    expect(passwordVerify("senha de teste segura", h)).toBe(true);
    expect(passwordVerify("errada", h)).toBe(false);
    const encrypted = await seal(env, { token: "secreto" });
    expect(encrypted).not.toContain("secreto");
    expect(await unseal(env, encrypted)).toEqual({ token: "secreto" });
  });
  it("publica health e contrato sem autenticação e protege API", async () => {
    expect((await SELF.fetch("https://test/api/health")).status).toBe(200);
    expect((await SELF.fetch("https://test/api/v1/profiles")).status).toBe(401);
    const spec = await (
      await SELF.fetch("https://test/api/openapi.json")
    ).json<any>();
    expect(spec.openapi).toBe("3.1.0");
  });
  it("repete comando com recibo e recusa conteúdo diferente", async () => {
    const p = await fixture(),
      key = uid();
    const data = { external_id: "cliente", text: "olá" };
    const a = await command(p, key, data);
    expect(a.status).toBe(200);
    const body = await a.json<any>();
    const b = await command(p, key, data);
    expect(await b.json()).toEqual(body);
    expect(b.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await command(p, key, { ...data, text: "diferente" })).status).toBe(
      409,
    );
    expect(
      (await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=?", p)).n,
    ).toBe(1);
  });
  it("isola identificadores externos de aplicações", async () => {
    const p = await fixture();
    const a = await inbound(
      env,
      p,
      { external_id: "123", message_id: "1", phone: "5511", text: "teste" },
      "app:a",
      null,
    );
    const b = await inbound(
      env,
      p,
      { external_id: "123", message_id: "1", phone: "5511", text: "teste" },
      "app:b",
      null,
    );
    expect(a.conversation_id).not.toBe(b.conversation_id);
    expect((await conversation(env, a.conversation_id, p)).phone).toBeNull();
    expect(
      (
        await inbound(
          env,
          p,
          { external_id: "123", message_id: "1", text: "teste" },
          "app:a",
          null,
        )
      ).duplicate,
    ).toBe(true);
  });
  it("tomada humana invalida resposta antiga", async () => {
    const p = await fixture();
    const i = await inbound(
      env,
      p,
      { external_id: "1", message_id: "1", text: "oi" },
      "app:a",
      null,
    );
    let c = await conversation(env, i.conversation_id, p);
    const out = await enqueue(
      env,
      c,
      "bot:attendant",
      "text",
      { text: "resposta antiga" },
      uid(),
    );
    await perform(
      env,
      admin,
      p,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    await deliver(env, await one(env, "SELECT * FROM outbox WHERE id=?", out));
    expect(
      (await one(env, "SELECT status FROM outbox WHERE id=?", out)).status,
    ).toBe("cancelled");
  });
  it("abre protocolo quando equipe está ausente", async () => {
    const p = await fixture();
    await inbound(
      env,
      p,
      { external_id: "1", message_id: "1", text: "quero falar com humano" },
      "app:a",
      null,
    );
    await processInbox(env, p);
    expect(
      (await all(env, "SELECT * FROM tickets WHERE profile_id=?", p)).length,
    ).toBe(1);
    await processInbox(env, p);
    expect(
      (await all(env, "SELECT * FROM tickets WHERE profile_id=?", p)).length,
    ).toBe(1);
  });
  it("recupera eventos de entrada e espelha para a equipe mesmo com automação pausada", async () => {
    const p = await fixture();
    await exec(
      env,
      "UPDATE profiles SET enabled=0,settings=? WHERE id=?",
      JSON.stringify({
        ...defaults,
        telegram_connection: "team-connection",
        telegram_group: "-1001",
      }),
      p,
    );
    const received = await inbound(
      env,
      p,
      { external_id: "1", message_id: "1", text: "Preciso de ajuda" },
      "app:a",
      null,
    );
    await exec(env, "DELETE FROM events WHERE profile_id=?", p);
    await processInbox(env, p);
    expect(
      await all(
        env,
        "SELECT * FROM events WHERE profile_id=? AND kind='message.received'",
        p,
      ),
    ).toHaveLength(1);
    expect(
      await all(
        env,
        "SELECT * FROM outbox WHERE conversation_id=? AND kind='team'",
        received.conversation_id,
      ),
    ).toHaveLength(1);
    await exec(env, "UPDATE inbox SET status='pending' WHERE profile_id=?", p);
    await processInbox(env, p);
    expect(
      await all(
        env,
        "SELECT * FROM outbox WHERE conversation_id=? AND kind='team'",
        received.conversation_id,
      ),
    ).toHaveLength(1);
  });
  it("recusa menus cíclicos antes de persistir", async () => {
    const p = await fixture();
    await expect(
      perform(
        env,
        admin,
        p,
        "settings",
        {
          menus: [
            { id: "a", label: "A", type: "submenu", parent_id: "b" },
            { id: "b", label: "B", type: "submenu", parent_id: "a" },
          ],
        },
        uid(),
      ),
    ).rejects.toThrow("ciclo");
  });
});
