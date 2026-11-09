import { env, SELF } from "cloudflare:test";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { exec, one, all, batch } from "../src/db";
import { uid, now, defaults, type Actor } from "../src/types";
import {
  passwordHash,
  passwordMatches,
  setSecret,
  secret,
  sha,
} from "../src/security";
import { inbound, perform, conversation } from "../src/service";
import { event } from "../src/events";
import {
  processPush,
  pushConfig,
  sendPush,
  prunePush,
  MAX_EVENT_AGE_MS,
  PUSH_LOG_RETENTION_MS,
} from "../src/push";
import { fcmMessage, sendFcm } from "../src/push-fcm";
import { MAX_DEVICES_PER_USER } from "../src/mobile-limits";

type Call = { url: URL; method: string; headers: Headers; body: any };
let calls: Call[] = [];
let responder: (call: Call) => Response | Promise<Response> | undefined;
const okResults = (call: Call) =>
  Response.json({
    results: (call.body?.messages || []).map((m: any) => ({
      token: m.token,
      status: "ok",
    })),
  });
beforeEach(async () => {
  calls = [];
  responder = () => undefined;
  // Storage is shared across tests here: admins from earlier tests would
  // otherwise receive pushes for every profile.
  await exec(env, "DELETE FROM devices");
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    new Request(input, init);
    const url = new URL(
      typeof input === "string" ? input : input.url || String(input),
    );
    let body: any = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const call: Call = {
      url,
      method: init.method || "GET",
      headers: new Headers(init.headers),
      body,
    };
    calls.push(call);
    const custom = await responder(call);
    if (custom) return custom;
    if (url.pathname.endsWith("/v1/push")) return okResults(call);
    throw new Error("Unexpected outbound request: " + url.href);
  });
});
afterEach(() => vi.unstubAllGlobals());

const PASSWORD = "senha-forte-de-teste-123";
let ipCounter = 0;
async function profileFixture() {
  const p = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    p,
    "Perfil móvel",
    JSON.stringify(defaults),
    now(),
  );
  return p;
}
async function user(role: "admin" | "operator", profiles: string[] = []) {
  const id = uid(),
    email = `${id}@example.com`;
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
    id,
    email,
    role === "admin" ? "Admin" : "Atendente " + id.slice(0, 4),
    passwordHash(PASSWORD),
    role,
    JSON.stringify(profiles),
    now(),
  );
  return {
    id,
    email,
    actor: {
      id,
      kind: "user",
      name: "U",
      role,
      profiles,
      scopes: [],
      bots: [],
      rate: 300,
      runLimit: 10,
    } as Actor,
  };
}
async function login(
  email: string,
  password = PASSWORD,
  device: any = { platform: "android", name: "Pixel", app_version: "1.0.0" },
) {
  return SELF.fetch("https://test/api/auth/mobile/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "10.0.0." + ++ipCounter,
    },
    body: JSON.stringify({ email, password, device }),
  });
}
async function api(
  token: string,
  path: string,
  method = "GET",
  body?: any,
  extra: Record<string, string> = {},
) {
  return SELF.fetch("https://test/api/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body !== undefined
        ? { "Content-Type": "application/json", "Idempotency-Key": uid() }
        : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function device(
  userId: string,
  profiles: string[] = [],
  platform = "android",
) {
  const id = uid(),
    token = "tok_" + id;
  await exec(
    env,
    "INSERT INTO devices(id,user_id,platform,provider,token,name,app_version,profiles,origin,created,updated) VALUES(?,?,?,'fcm',?,'Aparelho','1.0',?,'https://srv.example.com',?,?)",
    id,
    userId,
    platform,
    token,
    JSON.stringify(profiles),
    now(),
    now(),
  );
  return { id, token };
}
const sentTokens = () =>
  calls
    .filter((c) => c.url.pathname.endsWith("/v1/push"))
    .flatMap((c) => c.body.messages.map((m: any) => m.token));
const sentMessages = () =>
  calls
    .filter((c) => c.url.pathname.endsWith("/v1/push"))
    .flatMap((c) => c.body.messages);

it("login móvel devolve token wabu_ e Bearer funciona sem Origin", async () => {
  const p = await profileFixture(),
    u = await user("operator", [p]);
  expect((await login(u.email, PASSWORD, { platform: "windows" })).status).toBe(
    400,
  );
  expect((await login(u.email, "errada-mas-longa-123")).status).toBe(401);
  const r = await login(u.email);
  expect(r.status).toBe(200);
  const body = await r.json<any>();
  expect(body.token.startsWith("wabu_")).toBe(true);
  expect(body.expires).toBeGreaterThan(now() + 29 * 86400000);
  expect(body.user).toMatchObject({
    id: u.id,
    email: u.email,
    role: "operator",
    profiles: [p],
  });
  const session = await one(
    env,
    "SELECT * FROM sessions WHERE hash=?",
    await sha(body.token),
  );
  expect(session.kind).toBe("bearer");
  expect(session.label).toBe("Pixel | 1.0.0");
  const me = await api(body.token, "/me");
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ id: u.id, kind: "user" });
  const presence = await api(body.token, `/profiles/${p}/presence`, "PUT", {
    present: true,
  });
  expect(presence.status).toBe(200);
  expect(await presence.json()).toEqual({ actor: u.id, present: true });
  expect((await api("wabu_" + "0".repeat(64), "/me")).status).toBe(401);
});
it("refresh invalida o token antigo e logout revoga a sessão Bearer", async () => {
  const u = await user("operator");
  const first = await (await login(u.email)).json<any>();
  const refreshed = await api(first.token, "/auth/mobile/refresh", "POST", {});
  expect(refreshed.status).toBe(200);
  const second = await refreshed.json<any>();
  expect(second.token).not.toBe(first.token);
  expect(second.token.startsWith("wabu_")).toBe(true);
  expect((await api(first.token, "/me")).status).toBe(401);
  expect((await api(second.token, "/me")).status).toBe(200);
  expect(
    (
      await one(
        env,
        "SELECT label FROM sessions WHERE hash=?",
        await sha(second.token),
      )
    ).label,
  ).toBe("Pixel | 1.0.0");
  expect((await api(second.token, "/logout", "POST", {})).status).toBe(200);
  expect((await api(second.token, "/me")).status).toBe(401);
  expect(
    await one(env, "SELECT * FROM sessions WHERE user_id=?", u.id),
  ).toBeNull();
});
it("registra, lista, migra e remove dispositivos", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]),
    b = await user("operator", [p]);
  const ta = (await (await login(a.email)).json<any>()).token,
    tb = (await (await login(b.email)).json<any>()).token;
  const payload = {
    platform: "android",
    provider: "fcm",
    token: "fcm-token-1",
    name: "Pixel 8",
    app_version: "1.0.0",
    profiles: [],
    enabled: true,
  };
  expect(
    (
      await api(ta, "/devices/device-aaaa", "PUT", {
        ...payload,
        platform: "web",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api(ta, "/devices/device-aaaa", "PUT", {
        ...payload,
        provider: "apns",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api(ta, "/devices/device-aaaa", "PUT", {
        ...payload,
        token: "x".repeat(4097),
      })
    ).status,
  ).toBe(400);
  const put = await api(ta, "/devices/device-aaaa", "PUT", payload);
  expect(put.status).toBe(200);
  const saved = await put.json<any>();
  expect(saved).toMatchObject({
    id: "device-aaaa",
    user_id: a.id,
    platform: "android",
    token: "fcm-token-1",
    profiles: [],
    enabled: 1,
    origin: "https://test",
  });
  const list = await (await api(ta, "/devices")).json<any>();
  expect(list.data.map((d: any) => d.id)).toEqual(["device-aaaa"]);
  // Same physical device, another person signs in: token moves to the new user.
  const migrated = await api(tb, "/devices/device-bbbb", "PUT", {
    ...payload,
    profiles: [p],
  });
  expect(migrated.status).toBe(200);
  expect((await (await api(ta, "/devices")).json<any>()).data).toHaveLength(0);
  const listB = (await (await api(tb, "/devices")).json<any>()).data;
  expect(listB).toHaveLength(1);
  expect(listB[0]).toMatchObject({ id: "device-bbbb", profiles: [p] });
  // Upsert by id keeps a single row.
  await api(tb, "/devices/device-bbbb", "PUT", {
    ...payload,
    token: "fcm-token-2",
  });
  expect(
    (await all(env, "SELECT * FROM devices WHERE user_id=?", b.id)).map(
      (d) => d.token,
    ),
  ).toEqual(["fcm-token-2"]);
  expect((await api(ta, "/devices/device-bbbb", "DELETE")).status).toBe(200);
  expect(
    await (await api(ta, "/devices/device-bbbb", "DELETE")).json(),
  ).toEqual({ deleted: false });
  expect(
    await (await api(tb, "/devices/device-bbbb", "DELETE")).json(),
  ).toEqual({ deleted: true });
  expect((await (await api(tb, "/devices")).json<any>()).data).toHaveLength(0);
  // Another person's device id with a different token is not taken over.
  expect(
    (
      await api(ta, "/devices/device-cccc", "PUT", {
        ...payload,
        token: "tok-a",
      })
    ).status,
  ).toBe(200);
  const stolen = await api(tb, "/devices/device-cccc", "PUT", {
    ...payload,
    token: "tok-b",
  });
  expect(stolen.status).toBe(409);
  expect((await stolen.json<any>()).error.code).toBe("device_conflict");
  expect(
    await one(env, "SELECT user_id,token FROM devices WHERE id='device-cccc'"),
  ).toEqual({ user_id: a.id, token: "tok-a" });
  // Same handset (same provider token) signing in as b: allowed.
  expect(
    (
      await api(tb, "/devices/device-cccc", "PUT", {
        ...payload,
        token: "tok-a",
      })
    ).status,
  ).toBe(200);
  expect(
    (await one(env, "SELECT user_id FROM devices WHERE id='device-cccc'"))
      .user_id,
  ).toBe(b.id);
  // Application keys cannot own devices.
  const appId = uid(),
    appToken = "wab_" + uid();
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
    appId,
    "App",
    JSON.stringify([p]),
    "[]",
    "[]",
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    appId,
    await sha(appToken),
    appToken.slice(0, 12),
    now() + 600000,
    now(),
  );
  expect((await api(appToken, "/devices")).status).toBe(403);
});
it("limita dispositivos por pessoa e a cadência de registros", async () => {
  const u = await user("operator");
  const t = (await (await login(u.email)).json<any>()).token;
  for (let i = 1; i <= 31; i++) {
    const r = await api(
      t,
      `/devices/device-${String(i).padStart(4, "0")}`,
      "PUT",
      {
        platform: "android",
        token: `fcm-token-${i}`,
        name: "Aparelho " + i,
      },
    );
    expect(r.status, `registro ${i}`).toBe(i <= 30 ? 200 : 429);
  }
  const list = (await (await api(t, "/devices")).json<any>()).data;
  expect(list).toHaveLength(MAX_DEVICES_PER_USER);
  expect(list.map((d: any) => d.id)).toEqual(
    Array.from(
      { length: MAX_DEVICES_PER_USER },
      (_, i) =>
        `device-${String(31 - MAX_DEVICES_PER_USER + i).padStart(4, "0")}`,
    ),
  );
});
it("login com e-mail desconhecido executa a mesma derivação de senha", () => {
  const stored = passwordHash(PASSWORD);
  expect(passwordMatches(PASSWORD, stored)).toBe(true);
  expect(passwordMatches("errada-mas-longa-123", stored)).toBe(false);
  expect(passwordMatches(PASSWORD, null)).toBe(false);
  expect(passwordMatches(PASSWORD, undefined)).toBe(false);
  expect(passwordMatches("", "")).toBe(false);
});
it("envia notificação de teste para o dispositivo", async () => {
  const u = await user("operator");
  const t = (await (await login(u.email)).json<any>()).token;
  await api(t, "/devices/device-test", "PUT", {
    platform: "ios",
    token: "ios-token",
  });
  const r = await api(t, "/devices/device-test/test", "POST", {});
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    results: [{ token: "ios-token", status: "ok" }],
  });
  const m = sentMessages()[0];
  expect(m).toMatchObject({
    token: "ios-token",
    platform: "ios",
    data: { type: "test", server: "https://test" },
  });
  expect((await api(t, "/devices/outro/test", "POST", {})).status).toBe(404);
});
it("notifica mensagens recebidas conforme o estado da conversa sem duplicar", async () => {
  const p = await profileFixture(),
    owner = await user("operator", [p]),
    other = await user("operator", [p]),
    boss = await user("admin"),
    outsider = await user("operator", [uid()]);
  const dOwner = await device(owner.id),
    dOther = await device(other.id, [p]),
    dBoss = await device(boss.id),
    dOutsider = await device(outsider.id),
    dOtherProfile = await device(other.id, [uid()]);
  const r = await inbound(
    env,
    p,
    { external_id: "5511999990001", message_id: uid(), text: "Olá" },
    "app:a",
    null,
  );
  await perform(
    env,
    owner.actor,
    p,
    "conversation.action",
    { id: r.conversation_id, action: "claim" },
    uid(),
  );
  // First run for the profile only seeds the cursor at the end of history.
  await processPush(env, p);
  expect(calls).toHaveLength(0);
  const seeded = (
    await one(
      env,
      "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
      p,
    )
  ).last_event_id;
  await inbound(
    env,
    p,
    {
      external_id: "5511999990001",
      message_id: uid(),
      text: "Preciso de ajuda com o pedido " + "x".repeat(200),
    },
    "app:a",
    null,
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([dOwner.token]);
  const m = sentMessages()[0];
  expect(m.title).toBe("5511999990001");
  expect(m.body.length).toBeLessThanOrEqual(120);
  expect(m.body.startsWith("Preciso de ajuda")).toBe(true);
  expect(m.data).toMatchObject({
    type: "message",
    profile_id: p,
    conversation_id: r.conversation_id,
    server: "https://srv.example.com",
  });
  expect(m.channel).toBe("messages");
  expect(m.category).toBe("MESSAGE");
  const cursor = await one(
    env,
    "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
    p,
  );
  expect(cursor.last_event_id).toBe(
    (await one(env, "SELECT max(id) m FROM events WHERE profile_id=?", p)).m,
  );
  // Reprocessing the same events must not resend (push_log dedupe).
  await exec(
    env,
    "UPDATE push_cursors SET last_event_id=? WHERE profile_id=?",
    seeded,
    p,
  );
  calls = [];
  await processPush(env, p);
  expect(sentTokens()).toEqual([]);
  expect(
    (
      await one(
        env,
        "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
        p,
      )
    ).last_event_id,
  ).toBe(cursor.last_event_id);
  // Waiting queue: everyone authorized on the profile, including admins.
  await exec(
    env,
    "UPDATE conversations SET state='waiting',owner=NULL WHERE id=?",
    r.conversation_id,
  );
  calls = [];
  await inbound(
    env,
    p,
    {
      external_id: "5511999990001",
      message_id: uid(),
      text: "",
      attachments: [],
    },
    "app:a",
    null,
  );
  await processPush(env, p);
  expect(sentTokens().sort()).toEqual(
    [dOwner.token, dOther.token, dBoss.token].sort(),
  );
  expect(sentTokens()).not.toContain(dOutsider.token);
  expect(sentTokens()).not.toContain(dOtherProfile.token);
  // AI conversations are silent.
  await exec(
    env,
    "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
    r.conversation_id,
  );
  calls = [];
  await inbound(
    env,
    p,
    { external_id: "5511999990001", message_id: uid(), text: "para a IA" },
    "app:a",
    null,
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([]);
  expect(
    (
      await all(
        env,
        "SELECT * FROM push_log WHERE profile_id=? AND status='ok'",
        p,
      )
    ).length,
  ).toBe(4);
});
it("avisa fila, transferência e protocolos excluindo quem agiu", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]),
    b = await user("operator", [p]);
  const da = await device(a.id),
    db = await device(b.id);
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  await processPush(env, p);
  calls = [];
  await event(env, p, "conversation.updated", r.conversation_id, {
    state: "waiting",
    reason: "humano",
  });
  await processPush(env, p);
  expect(sentTokens().sort()).toEqual([da.token, db.token].sort());
  expect(sentMessages()[0]).toMatchObject({
    body: "Novo atendimento na fila",
    channel: "queue",
    data: { type: "queue" },
  });
  await perform(
    env,
    a.actor,
    p,
    "conversation.action",
    { id: r.conversation_id, action: "claim" },
    uid(),
  );
  calls = [];
  await perform(
    env,
    a.actor,
    p,
    "conversation.action",
    { id: r.conversation_id, action: "transfer", target: b.id },
    uid(),
  );
  const ev = await one(
    env,
    "SELECT payload FROM events WHERE profile_id=? ORDER BY id DESC LIMIT 1",
    p,
  );
  expect(JSON.parse(ev.payload)).toEqual({
    action: "transfer",
    owner: b.id,
    actor: a.id,
  });
  await processPush(env, p);
  expect(sentTokens()).toEqual([db.token]);
  expect(sentMessages()[0]).toMatchObject({
    body: "Atendimento transferido para você",
    data: { type: "transfer", conversation_id: r.conversation_id },
  });
  // Ticket created by b: a and b are both on the profile but b owns it.
  calls = [];
  const ticket = await perform(
    env,
    b.actor,
    p,
    "ticket.create",
    { conversation_id: r.conversation_id, title: "Pedido atrasado" },
    uid(),
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([db.token]);
  expect(sentMessages()[0].title).toBe(`Protocolo ${ticket.number} aberto`);
  expect(sentMessages()[0]).toMatchObject({
    category: "TICKET",
    channel: "tickets",
    data: { type: "ticket", ticket_id: ticket.id },
  });
  // Ticket updated by its owner: nobody else to notify.
  calls = [];
  await perform(
    env,
    b.actor,
    p,
    "ticket.update",
    { id: ticket.id, status: "in_progress" },
    uid(),
  );
  const upd = await one(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind='ticket.updated' ORDER BY id DESC LIMIT 1",
    p,
  );
  expect(JSON.parse(upd.payload)).toEqual({
    status: "in_progress",
    previous_status: "open",
    owner: b.id,
    previous_owner: b.id,
    text_added: false,
    actor: b.id,
    number: ticket.number,
  });
  await processPush(env, p);
  expect(sentTokens()).toEqual([]);
  // Public update by an admin without a state change: the body says so
  // instead of announcing the unchanged state.
  const boss = await user("admin");
  calls = [];
  await perform(
    env,
    boss.actor,
    p,
    "ticket.update",
    { id: ticket.id, text: "Estamos verificando" },
    uid(),
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([db.token]);
  expect(sentMessages()[0].body).toBe("Novo andamento registrado");
  // Reassigned by the admin: the new owner a is told about the assignment.
  calls = [];
  await perform(
    env,
    boss.actor,
    p,
    "ticket.update",
    { id: ticket.id, owner: a.id },
    uid(),
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([da.token]);
  expect(sentMessages()[0].body).toBe("Protocolo atribuído a você");
  // Updated by an admin: owner a is notified with the new state.
  calls = [];
  await perform(
    env,
    boss.actor,
    p,
    "ticket.update",
    { id: ticket.id, status: "closed" },
    uid(),
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([da.token]);
  expect(sentMessages()[0].body).toBe("Novo estado: Concluído");
  // A closed ticket created before (or replayed) is not announced as open.
  calls = [];
  await event(
    env,
    p,
    "ticket.created",
    ticket.id,
    { number: ticket.number, actor: boss.id },
    uid(),
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([]);
});
it("ligação recebida gera notificação sensível ao tempo com categoria CALL", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]);
  const da = await device(a.id, [], "ios");
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  await processPush(env, p);
  calls = [];
  const callId = uid();
  await event(env, p, "call.updated", callId, {
    conversation_id: r.conversation_id,
    call_id: callId,
    status: "ringing",
    direction: "inbound",
  });
  await event(env, p, "call.updated", callId, {
    conversation_id: r.conversation_id,
    call_id: callId,
    status: "active",
    direction: "inbound",
  });
  await processPush(env, p);
  expect(sentMessages()).toHaveLength(1);
  expect(sentMessages()[0]).toMatchObject({
    token: da.token,
    platform: "ios",
    title: "Ligação recebida",
    priority: "high",
    channel: "calls",
    category: "CALL",
    time_sensitive: true,
    collapse_key: "call-" + callId,
    data: { type: "call", call_id: callId, conversation_id: r.conversation_id },
  });
});
it("alerta protocolo vencendo e atrasado uma única vez cada", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]),
    b = await user("operator", [p]);
  const da = await device(a.id);
  await device(b.id);
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  await processPush(env, p);
  const id = uid();
  await exec(
    env,
    "INSERT INTO tickets(id,number,profile_id,conversation_id,title,owner,response_due_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    id,
    "WA-TEST-1",
    p,
    r.conversation_id,
    "Sem resposta",
    a.id,
    now() + 30 * 60000,
    now(),
    now(),
  );
  calls = [];
  await processPush(env, p);
  expect(sentTokens()).toEqual([da.token]);
  expect(sentMessages()[0].title).toMatch(
    /^Protocolo WA-TEST-1 vence em \d+ min$/,
  );
  expect(sentMessages()[0].data).toMatchObject({
    type: "ticket_due",
    ticket_id: id,
  });
  calls = [];
  await processPush(env, p);
  expect(sentTokens()).toEqual([]);
  await exec(
    env,
    "UPDATE tickets SET response_due_at=? WHERE id=?",
    now() - 1000,
    id,
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([da.token]);
  expect(sentMessages()[0].title).toBe("Protocolo WA-TEST-1 atrasado");
  expect(sentMessages()[0].priority).toBe("high");
  calls = [];
  await processPush(env, p);
  expect(sentTokens()).toEqual([]);
  expect(
    (
      await all(
        env,
        "SELECT kind FROM ticket_alerts WHERE ticket_id=? ORDER BY kind",
        id,
      )
    ).map((x) => x.kind),
  ).toEqual(["due_soon", "overdue"]);
  // Alerts disabled: a fresh ticket produces nothing.
  await setSecret(env, "push:config", { ticket_alert_minutes: 0 });
  await exec(
    env,
    "INSERT INTO tickets(id,number,profile_id,conversation_id,title,owner,response_due_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    uid(),
    "WA-TEST-2",
    p,
    r.conversation_id,
    "Outro",
    a.id,
    now() - 1000,
    now(),
    now(),
  );
  calls = [];
  await processPush(env, p);
  expect(sentTokens()).toEqual([]);
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
});
it("primeiro ciclo de um perfil começa no fim do histórico e ignora eventos antigos", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]);
  const da = await device(a.id);
  // History from before the update: queue message, ticket and a call.
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "antiga" },
    "app:a",
    null,
  );
  await exec(
    env,
    "UPDATE conversations SET state='waiting' WHERE id=?",
    r.conversation_id,
  );
  await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "na fila" },
    "app:a",
    null,
  );
  const old = uid();
  await exec(
    env,
    "INSERT INTO tickets(id,number,profile_id,conversation_id,title,owner,response_due_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    old,
    "WA-OLD-1",
    p,
    r.conversation_id,
    "Antigo e atrasado",
    a.id,
    now() - 86400000,
    now() - 2 * 86400000,
    now() - 2 * 86400000,
  );
  await event(env, p, "ticket.created", old, { number: "WA-OLD-1" });
  expect(
    await one(env, "SELECT * FROM push_cursors WHERE profile_id=?", p),
  ).toBeNull();
  await processPush(env, p);
  expect(calls).toHaveLength(0);
  expect(
    (
      await one(
        env,
        "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
        p,
      )
    ).last_event_id,
  ).toBe(
    (await one(env, "SELECT max(id) m FROM events WHERE profile_id=?", p)).m,
  );
  expect(
    (
      await all(
        env,
        "SELECT kind FROM ticket_alerts WHERE ticket_id=? ORDER BY kind",
        old,
      )
    ).map((x) => x.kind),
  ).toEqual(["due_soon", "overdue"]);
  // Nothing old fires on the next cycles either.
  await processPush(env, p);
  expect(calls).toHaveLength(0);
  // A stale event (older than MAX_EVENT_AGE_MS) past the cursor is skipped
  // but the cursor still moves over it; a fresh one is delivered.
  await exec(
    env,
    "INSERT INTO events(profile_id,kind,resource_id,payload,created) VALUES(?,?,?,?,?)",
    p,
    "message.received",
    uid(),
    JSON.stringify({ conversation_id: r.conversation_id, text: "velha" }),
    now() - MAX_EVENT_AGE_MS - 1000,
  );
  await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "nova" },
    "app:a",
    null,
  );
  await processPush(env, p);
  expect(sentTokens()).toEqual([da.token]);
  expect(sentMessages()[0].body).toBe("nova");
  expect(
    (
      await one(
        env,
        "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
        p,
      )
    ).last_event_id,
  ).toBe(
    (await one(env, "SELECT max(id) m FROM events WHERE profile_id=?", p)).m,
  );
});
it("protocolo novo recebe alerta mesmo com mais de 100 antigos já alertados", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]);
  const da = await device(a.id);
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  await processPush(env, p);
  const rows: [string, any[]][] = [];
  for (let i = 0; i < 101; i++) {
    const id = uid();
    rows.push([
      "INSERT INTO tickets(id,number,profile_id,conversation_id,title,owner,response_due_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        id,
        `WA-BKL-${i}`,
        p,
        r.conversation_id,
        "Antigo",
        a.id,
        now() - 3600000 - i,
        now(),
        now(),
      ],
    ]);
    rows.push([
      "INSERT INTO ticket_alerts(ticket_id,kind,created) VALUES(?,'overdue',?)",
      [id, now()],
    ]);
    rows.push([
      "INSERT INTO ticket_alerts(ticket_id,kind,created) VALUES(?,'due_soon',?)",
      [id, now()],
    ]);
  }
  await batch(env, rows);
  const fresh = uid();
  await exec(
    env,
    "INSERT INTO tickets(id,number,profile_id,conversation_id,title,owner,response_due_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    fresh,
    "WA-NEW-1",
    p,
    r.conversation_id,
    "Novo",
    a.id,
    now() + 30 * 60000,
    now(),
    now(),
  );
  calls = [];
  await processPush(env, p);
  expect(sentTokens()).toEqual([da.token]);
  expect(sentMessages()[0].title).toMatch(
    /^Protocolo WA-NEW-1 vence em \d+ min$/,
  );
  // And the same ticket moves on to the overdue alert past the 100 old ones.
  await exec(
    env,
    "UPDATE tickets SET response_due_at=? WHERE id=?",
    now() - 1000,
    fresh,
  );
  calls = [];
  await processPush(env, p);
  expect(sentMessages().map((m) => m.title)).toEqual([
    "Protocolo WA-NEW-1 atrasado",
  ]);
  calls = [];
  await processPush(env, p);
  expect(calls).toHaveLength(0);
});
it("falha no meio do lote não avança o cursor além do evento processado nem perde envios", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]);
  const da = await device(a.id);
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  await exec(
    env,
    "UPDATE conversations SET state='waiting' WHERE id=?",
    r.conversation_id,
  );
  await processPush(env, p);
  calls = [];
  await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "primeira" },
    "app:a",
    null,
  );
  const first = (
    await one(env, "SELECT max(id) m FROM events WHERE profile_id=?", p)
  ).m;
  // A ticket event whose SELECT fails: the tickets table is renamed for a moment.
  await event(env, p, "ticket.created", uid(), { number: "WA-X" });
  await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "terceira" },
    "app:a",
    null,
  );
  await exec(env, "ALTER TABLE tickets RENAME TO tickets_offline");
  try {
    await processPush(env, p);
  } finally {
    await exec(env, "ALTER TABLE tickets_offline RENAME TO tickets");
  }
  // The first event was delivered; the cursor stopped right before the failure.
  expect(sentMessages().map((m) => m.body)).toEqual(["primeira"]);
  expect(
    (
      await one(
        env,
        "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
        p,
      )
    ).last_event_id,
  ).toBe(first);
  expect(
    await all(
      env,
      "SELECT * FROM push_log WHERE profile_id=? AND status='pending'",
      p,
    ),
  ).toEqual([]);
  // Next run resumes: the third event is delivered once, nothing repeated.
  calls = [];
  await processPush(env, p);
  expect(sentMessages().map((m) => m.body)).toEqual(["terceira"]);
  expect(sentTokens()).toEqual([da.token]);
  expect(
    (
      await one(
        env,
        "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
        p,
      )
    ).last_event_id,
  ).toBe(
    (await one(env, "SELECT max(id) m FROM events WHERE profile_id=?", p)).m,
  );
});
it("poda push_log antigo e alertas de protocolos concluídos", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]);
  const d = await device(a.id);
  const ins = async (id: string, created: number) =>
    exec(
      env,
      "INSERT INTO push_log(id,profile_id,user_id,device_id,kind,resource_id,dedupe,status,created) VALUES(?,?,?,?,?,?,?,'ok',?)",
      id,
      p,
      a.id,
      d.id,
      "message",
      null,
      `${d.id}:${id}`,
      created,
    );
  const oldLog = uid(),
    newLog = uid();
  await ins(oldLog, now() - PUSH_LOG_RETENTION_MS - 60000);
  await ins(newLog, now() - 60000);
  const closedOld = uid(),
    closedNew = uid(),
    open = uid();
  for (const [id, status, updated] of [
    [closedOld, "closed", now() - PUSH_LOG_RETENTION_MS - 60000],
    [closedNew, "closed", now() - 60000],
    [open, "open", now() - PUSH_LOG_RETENTION_MS - 60000],
  ] as const) {
    await exec(
      env,
      "INSERT INTO tickets(id,number,profile_id,conversation_id,title,status,owner,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      "WA-P-" + id.slice(0, 6),
      p,
      "conv",
      "T",
      status,
      a.id,
      now(),
      updated,
    );
    await exec(
      env,
      "INSERT INTO ticket_alerts(ticket_id,kind,created) VALUES(?,'overdue',?)",
      id,
      now(),
    );
  }
  const orphan = uid();
  await exec(
    env,
    "INSERT INTO ticket_alerts(ticket_id,kind,created) VALUES(?,'overdue',?)",
    orphan,
    now(),
  );
  await prunePush(env);
  expect(
    (await all(env, "SELECT id FROM push_log WHERE profile_id=?", p)).map(
      (x) => x.id,
    ),
  ).toEqual([newLog]);
  expect(
    (
      await all(
        env,
        "SELECT ticket_id FROM ticket_alerts WHERE ticket_id IN (?,?,?,?) ORDER BY ticket_id",
        closedOld,
        closedNew,
        open,
        orphan,
      )
    ).map((x) => x.ticket_id),
  ).toEqual([closedNew, open].sort());
});
it("modo gateway usa a URL configurada com segredo e desativa token inexistente", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]),
    b = await user("operator", [p]);
  const da = await device(a.id),
    db = await device(b.id);
  await setSecret(env, "push:config", {
    mode: "gateway",
    gateway_url: "https://gw.example.com",
    gateway_secret: "segredo-compartilhado",
    preview: "minimal",
  });
  responder = (call) =>
    call.url.hostname === "gw.example.com"
      ? Response.json({
          results: call.body.messages.map((m: any) => ({
            token: m.token,
            status: m.token === db.token ? "unregistered" : "ok",
            error: m.token === db.token ? "UNREGISTERED" : undefined,
          })),
        })
      : undefined;
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  await processPush(env, p);
  calls = [];
  await exec(
    env,
    "UPDATE conversations SET state='waiting' WHERE id=?",
    r.conversation_id,
  );
  await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "Maria disse algo" },
    "app:a",
    null,
  );
  await processPush(env, p);
  expect(calls).toHaveLength(1);
  expect(calls[0].url.href).toBe("https://gw.example.com/v1/push");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].headers.get("Authorization")).toBe(
    "Bearer segredo-compartilhado",
  );
  for (const m of calls[0].body.messages) {
    expect(m.title).toBe("Wabotia");
    expect(m.body).toBe("Nova mensagem");
  }
  const disabled = await one(env, "SELECT * FROM devices WHERE id=?", db.id);
  expect(disabled.enabled).toBe(0);
  expect(disabled.last_error).toBe("UNREGISTERED");
  expect(
    (await one(env, "SELECT enabled FROM devices WHERE id=?", da.id)).enabled,
  ).toBe(1);
  expect(
    (
      await all(env, "SELECT status FROM push_log WHERE device_id=?", db.id)
    ).map((x) => x.status),
  ).toEqual(["unregistered"]);
  // Network failure: logged, no retry, cursor still advances.
  responder = () => {
    throw new Error("gateway offline");
  };
  calls = [];
  await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "de novo" },
    "app:a",
    null,
  );
  await processPush(env, p);
  const failed = await all(
    env,
    "SELECT status,error FROM push_log WHERE device_id=? ORDER BY created DESC LIMIT 1",
    da.id,
  );
  expect(failed[0]).toEqual({ status: "error", error: "gateway offline" });
  expect(
    (
      await one(
        env,
        "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
        p,
      )
    ).last_event_id,
  ).toBe(
    (await one(env, "SELECT max(id) m FROM events WHERE profile_id=?", p)).m,
  );
  calls = [];
  await processPush(env, p);
  expect(calls).toHaveLength(0);
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
});
it("modo off não chama a rede e mantém o cursor", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]);
  await device(a.id);
  await setSecret(env, "push:config", { mode: "off" });
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  await exec(
    env,
    "UPDATE conversations SET state='waiting' WHERE id=?",
    r.conversation_id,
  );
  await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "fila" },
    "app:a",
    null,
  );
  await processPush(env, p);
  expect(calls).toHaveLength(0);
  expect(await sendPush(env, [])).toEqual([]);
  expect(
    (
      await one(
        env,
        "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
        p,
      )
    ).last_event_id,
  ).toBe(
    (await one(env, "SELECT max(id) m FROM events WHERE profile_id=?", p)).m,
  );
  expect(
    await all(env, "SELECT * FROM push_log WHERE profile_id=?", p),
  ).toEqual([]);
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
});
async function serviceAccount() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  let binary = "";
  for (const b of der) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  return {
    client_email: `push-${uid().slice(0, 8)}@proj.iam.gserviceaccount.com`,
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    project_id: "proj-teste",
    token_uri: "https://oauth2.googleapis.com/token",
    publicKey: pair.publicKey,
  };
}
it("fcmMessage monta android e apns; sendFcm só desativa token com errorCode UNREGISTERED", async () => {
  const body = fcmMessage({
    token: "t1",
    platform: "ios",
    title: "Maria",
    body: "Oi",
    data: { type: "call", call_id: "c1" },
    priority: "high",
    collapse_key: "call-c1",
    channel: "calls",
    category: "CALL",
    time_sensitive: true,
  });
  expect(body).toEqual({
    message: {
      token: "t1",
      notification: { title: "Maria", body: "Oi" },
      data: { type: "call", call_id: "c1" },
      android: {
        priority: "high",
        notification: { sound: "default", channel_id: "calls", tag: "call-c1" },
      },
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-push-type": "alert",
          "apns-collapse-id": "call-c1",
        },
        payload: {
          aps: {
            sound: "default",
            category: "CALL",
            "thread-id": "call-c1",
            "interruption-level": "time-sensitive",
            "mutable-content": 1,
          },
        },
      },
    },
  });
  const normal = fcmMessage({
    token: "t2",
    platform: "ios",
    title: "A",
    body: "B",
    data: {},
    priority: "normal",
  });
  expect(normal.message.android.priority).toBe("normal");
  expect(normal.message.apns.headers["apns-priority"]).toBe("5");
  expect(normal.message.apns.payload.aps["interruption-level"]).toBe("active");
  // Android: só dados (título e corpo em data), prioridade alta, sem bloco notification/apns.
  const android = fcmMessage({
    token: "t3",
    platform: "android",
    title: "Maria",
    body: "Oi",
    data: { type: "message", conversation_id: "c1" },
    priority: "normal",
    collapse_key: "conversa-c1",
    channel: "messages",
  });
  expect(android).toEqual({
    message: {
      token: "t3",
      data: {
        title: "Maria",
        body: "Oi",
        type: "message",
        conversation_id: "c1",
      },
      android: { priority: "high", collapse_key: "conversa-c1" },
    },
  });
  const sa = await serviceAccount();
  let assertion = "";
  responder = async (call) => {
    if (call.url.href === sa.token_uri) {
      assertion = new URLSearchParams(String(call.body)).get("assertion") || "";
      return Response.json({ access_token: "acesso-fcm", expires_in: 3600 });
    }
    if (call.url.hostname === "fcm.googleapis.com") {
      expect(call.url.pathname).toBe("/v1/projects/proj-teste/messages:send");
      expect(call.headers.get("Authorization")).toBe("Bearer acesso-fcm");
      const token = call.body.message.token;
      if (token === "morto")
        return Response.json(
          {
            error: {
              code: 404,
              status: "NOT_FOUND",
              details: [{ errorCode: "UNREGISTERED" }],
            },
          },
          { status: 404 },
        );
      if (token === "invalido")
        return Response.json(
          {
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message:
                "The registration token is not a valid FCM registration token",
              details: [{ errorCode: "INVALID_ARGUMENT" }],
            },
          },
          { status: 400 },
        );
      if (token === "quota")
        return Response.json(
          { error: { code: 429, status: "QUOTA_EXCEEDED" } },
          { status: 429 },
        );
      // Wrong project_id / API disabled: a 404 without UNREGISTERED.
      if (token === "projeto")
        return Response.json(
          {
            error: {
              code: 404,
              status: "NOT_FOUND",
              message: "Requested entity was not found.",
            },
          },
          { status: 404 },
        );
      if (token === "html404")
        return new Response("<html>not found</html>", { status: 404 });
      return Response.json({ name: "projects/proj-teste/messages/1" });
    }
    return undefined;
  };
  const base = {
    platform: "android" as const,
    title: "T",
    body: "B",
    data: {},
    priority: "normal" as const,
  };
  const results = await sendFcm(sa, [
    { ...base, token: "vivo" },
    { ...base, token: "morto" },
    { ...base, token: "invalido" },
    { ...base, token: "quota" },
    { ...base, token: "projeto" },
    { ...base, token: "html404" },
  ]);
  expect(results).toEqual([
    { token: "vivo", status: "ok" },
    { token: "morto", status: "unregistered", error: "UNREGISTERED" },
    { token: "invalido", status: "unregistered", error: "INVALID_ARGUMENT" },
    { token: "quota", status: "error", error: "HTTP 429 QUOTA_EXCEEDED" },
    { token: "projeto", status: "error", error: "HTTP 404 NOT_FOUND" },
    { token: "html404", status: "error", error: "HTTP 404" },
  ]);
  // The JWT is RS256-signed with the service account key.
  const [h, c, s] = assertion.split(".");
  const decode = (v: string) =>
    JSON.parse(atob(v.replace(/-/g, "+").replace(/_/g, "/")));
  expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT" });
  expect(decode(c)).toMatchObject({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri,
  });
  const sig = Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/")),
    (ch) => ch.charCodeAt(0),
  );
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      sa.publicKey,
      sig,
      new TextEncoder().encode(`${h}.${c}`),
    ),
  ).toBe(true);
  // Token is cached: a second batch does not hit OAuth again.
  const oauthCalls = calls.filter((x) => x.url.href === sa.token_uri).length;
  await sendFcm(sa, [{ ...base, token: "vivo" }]);
  expect(calls.filter((x) => x.url.href === sa.token_uri)).toHaveLength(
    oauthCalls,
  );
  // processPush in fcm mode goes through sendFcm.
  const p = await profileFixture(),
    a = await user("operator", [p]);
  const da = await device(a.id);
  await setSecret(env, "push:config", {
    mode: "fcm",
    service_account: {
      client_email: sa.client_email,
      private_key: sa.private_key,
      project_id: sa.project_id,
      token_uri: sa.token_uri,
    },
  });
  const r = await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  await processPush(env, p);
  await exec(
    env,
    "UPDATE conversations SET state='waiting' WHERE id=?",
    r.conversation_id,
  );
  calls = [];
  await inbound(
    env,
    p,
    { external_id: "c1", message_id: uid(), text: "fila" },
    "app:a",
    null,
  );
  await processPush(env, p);
  const sent = calls.filter((x) => x.url.hostname === "fcm.googleapis.com");
  expect(sent.map((x) => x.body.message.token)).toEqual([da.token]);
  expect(sent[0].body.message.data.server).toBe("https://srv.example.com");
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
});
it("system/push/configure exige administrador, valida e não devolve a chave privada", async () => {
  const p = await profileFixture(),
    op = await user("operator", [p]),
    boss = await user("admin");
  const top = (await (await login(op.email)).json<any>()).token,
    tb = (await (await login(boss.email)).json<any>()).token;
  expect(
    (await api(top, "/system/push/configure", "POST", { mode: "off" })).status,
  ).toBe(403);
  expect((await api(top, "/system/push")).status).toBe(403);
  const initial = await api(tb, "/system/push");
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({
    mode: "gateway",
    gateway_url: "https://push.wabotia.queven.app",
    preview: "preview",
    ticket_alert_minutes: 60,
    fcm_configured: false,
  });
  expect(
    (await api(tb, "/system/push/configure", "POST", { mode: "sms" })).status,
  ).toBe(400);
  expect(
    (
      await api(tb, "/system/push/configure", "POST", {
        ticket_alert_minutes: 1441,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api(tb, "/system/push/configure", "POST", {
        gateway_url: "http://gw.example.com",
      })
    ).status,
  ).toBe(400);
  expect(
    (await api(tb, "/system/push/configure", "POST", { mode: "fcm" })).status,
  ).toBe(400);
  expect(
    (
      await api(tb, "/system/push/configure", "POST", {
        mode: "fcm",
        service_account: { client_email: "x@y", project_id: "p" },
      })
    ).status,
  ).toBe(400);
  const sa = await serviceAccount();
  const saved = await api(tb, "/system/push/configure", "POST", {
    mode: "fcm",
    service_account: JSON.stringify({
      client_email: sa.client_email,
      private_key: sa.private_key,
      project_id: sa.project_id,
      token_uri: sa.token_uri,
    }),
    preview: "minimal",
    ticket_alert_minutes: 30,
    gateway_url: "https://gw.example.com/",
    gateway_secret: "abc",
  });
  expect(saved.status).toBe(200);
  const body = await saved.json<any>();
  expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  expect(JSON.stringify(body)).not.toContain("abc");
  expect(body).toMatchObject({
    mode: "fcm",
    preview: "minimal",
    ticket_alert_minutes: 30,
    gateway_url: "https://gw.example.com",
    gateway_secret_configured: true,
    fcm_configured: true,
    fcm_project_id: "proj-teste",
  });
  const cfg = await pushConfig(env);
  expect(cfg.service_account?.private_key).toBe(sa.private_key);
  // Omitting service_account keeps the stored one.
  const again = await api(tb, "/system/push/configure", "POST", {
    preview: "preview",
  });
  expect(await again.json()).toMatchObject({
    mode: "fcm",
    preview: "preview",
    fcm_configured: true,
  });
  expect((await pushConfig(env)).service_account?.client_email).toBe(
    sa.client_email,
  );
  const shown = await (await api(tb, "/system/push")).json<any>();
  expect(JSON.stringify(shown)).not.toContain("PRIVATE KEY");
  expect(shown.fcm_configured).toBe(true);
  // Admin test needs a registered device.
  expect((await api(tb, "/system/push/test", "POST", {})).status).toBe(400);
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
});
it("lista protocolos atrasados e detalha protocolo com andamento e conversa", async () => {
  const p = await profileFixture(),
    a = await user("operator", [p]);
  const t = (await (await login(a.email)).json<any>()).token;
  const r = await inbound(
    env,
    p,
    { external_id: "5511888880000", message_id: uid(), text: "oi" },
    "app:a",
    null,
  );
  const late = uid(),
    fine = uid(),
    answered = uid();
  for (const [id, number, due, first, status] of [
    [late, "WA-LATE", now() - 60000, null, "open"],
    [fine, "WA-FINE", now() + 3600000, null, "in_progress"],
    [answered, "WA-ANSW", now() - 60000, now() - 30000, "open"],
  ] as const)
    await exec(
      env,
      "INSERT INTO tickets(id,number,profile_id,conversation_id,title,status,owner,response_due_at,first_response_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id,
      number,
      p,
      r.conversation_id,
      "Título " + number,
      status,
      a.id,
      due,
      first,
      now(),
      now(),
    );
  await exec(
    env,
    "INSERT INTO ticket_updates(id,ticket_id,actor,text,created) VALUES(?,?,?,?,?)",
    uid(),
    late,
    a.id,
    "Estamos verificando",
    now(),
  );
  const overdue = await (
    await api(t, `/profiles/${p}/tickets?overdue=1`)
  ).json<any>();
  expect(overdue.data.map((x: any) => x.id)).toEqual([late]);
  const progress = await (
    await api(t, `/profiles/${p}/tickets?status=in_progress`)
  ).json<any>();
  expect(progress.data.map((x: any) => x.id)).toEqual([fine]);
  expect(
    (await (await api(t, `/profiles/${p}/tickets`)).json<any>()).data,
  ).toHaveLength(3);
  expect((await api(t, `/profiles/${p}/tickets?status=weird`)).status).toBe(
    400,
  );
  const detail = await api(t, `/profiles/${p}/tickets/${late}`);
  expect(detail.status).toBe(200);
  const d = await detail.json<any>();
  expect(d.ticket).toMatchObject({ id: late, number: "WA-LATE" });
  expect(d.updates).toHaveLength(1);
  expect(d.updates[0].text).toBe("Estamos verificando");
  expect(d.conversation).toEqual({
    id: r.conversation_id,
    phone: null,
    external_id: "5511888880000",
    title: "",
    state: "ai",
    owner: null,
    contact_name: null,
  });
  expect((await api(t, `/profiles/${p}/tickets/${uid()}`)).status).toBe(404);
  const other = await user("operator", [uid()]);
  const to = (await (await login(other.email)).json<any>()).token;
  expect((await api(to, `/profiles/${p}/tickets/${late}`)).status).toBe(404);
});
