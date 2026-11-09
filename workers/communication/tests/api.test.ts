import { env, SELF } from "cloudflare:test";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { exec, one, all } from "../src/db";
import { uid, now, defaults, type Actor } from "../src/types";
import { sha, setSecret, hmac, seal, unseal } from "../src/security";
import { createRun, inbound, perform, conversation } from "../src/service";
import { processRun, deliverWebhook, importDocument } from "../src/engine";
import { event } from "../src/events";
const mocks: any[] = [];
const realFetch = globalThis.fetch;
const fetchMock = {
  get: (origin: string) => ({
    intercept: (match: any) => ({
      reply: (status: any, data?: any) =>
        mocks.push({ origin, ...match, status, data }),
      replyWithError: (error: Error) => mocks.push({ origin, ...match, error }),
    }),
  }),
  assertNoPendingInterceptors: () => expect(mocks).toHaveLength(0),
};
beforeAll(() =>
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    let u: URL;
    try {
      u = new URL(
        typeof input === "string" ? input : input.url || String(input),
      );
    } catch {
      return realFetch(input, init);
    }
    const i = mocks.findIndex(
      (m) =>
        m.origin === u.origin &&
        m.path === u.pathname + u.search &&
        (m.method || "GET") === (init.method || "GET"),
    );
    if (i < 0)
      throw new Error("Unexpected outbound request: " + u.origin + u.pathname);
    const m = mocks.splice(i, 1)[0];
    if (m.error) throw m.error;
    if (typeof m.status === "function") {
      const r = m.status({ headers: init.headers, body: init.body });
      return new Response(r.statusCode === 204 ? null : r.data, {
        status: r.statusCode,
      });
    }
    return new Response(
      typeof m.data === "string" ? m.data : JSON.stringify(m.data),
      { status: m.status, headers: { "Content-Type": "application/json" } },
    );
  }),
);
afterAll(() => vi.unstubAllGlobals());
async function fixture(
  scopes = [
    "conversations:read",
    "conversations:write",
    "bots:read",
    "bots:invoke",
    "tickets:write",
    "tickets:read",
    "events:read",
    "webhooks:manage",
  ],
  bots: string[] = [],
) {
  const p = uid(),
    id = uid(),
    token = "wab_" + uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    p,
    "Test",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
    id,
    "App",
    JSON.stringify([p]),
    JSON.stringify(scopes),
    JSON.stringify(bots),
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    id,
    await sha(token),
    token.slice(0, 12),
    now() + 600000,
    now(),
  );
  const actor: Actor = {
    id: "app:" + id,
    kind: "app",
    name: "App",
    role: "service",
    profiles: [p],
    scopes,
    bots,
    rate: 60,
    runLimit: 3,
  };
  return { p, id, token, actor };
}
async function request(
  f: any,
  path: string,
  body?: any,
  key = uid(),
  method = body === undefined ? "GET" : "POST",
) {
  return SELF.fetch("https://test/api/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + f.token,
      "Content-Type": "application/json",
      ...(body !== undefined ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function botFixture() {
  const f = await fixture(),
    cid = uid(),
    bid = uid();
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'hermes','direct','active',?,?)",
    cid,
    f.p,
    "Hermes",
    JSON.stringify({
      url: "https://hermes.example.com",
      api_url: "https://hermes.example.com",
    }),
    now(),
  );
  await setSecret(env, "connection:" + cid, {
    profile_keys: { default: "test-hermes-key" },
  });
  await exec(
    env,
    "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,?,?,1)",
    bid,
    f.p,
    cid,
    "default",
    "Atendente",
  );
  f.actor.bots = [bid];
  await exec(
    env,
    "UPDATE applications SET bots=? WHERE id=?",
    JSON.stringify([bid]),
    f.id,
  );
  return { ...f, cid, bid };
}
it("recusa chave expirada e revogada", async () => {
  const f = await fixture();
  expect((await request(f, "/profiles")).status).toBe(200);
  await exec(
    env,
    "UPDATE api_keys SET expires=? WHERE app_id=?",
    now() - 1,
    f.id,
  );
  expect((await request(f, "/profiles")).status).toBe(401);
  await exec(
    env,
    "UPDATE api_keys SET expires=?,revoked=1 WHERE app_id=?",
    now() + 600000,
    f.id,
  );
  expect((await request(f, "/profiles")).status).toBe(401);
});
it("isola perfis, bots e configurações do administrador", async () => {
  const f = await botFixture(),
    other = await fixture();
  expect((await request(other, `/profiles/${f.p}/bots`)).status).toBe(404);
  expect(
    (await (await request(f, `/profiles/${f.p}/bots`)).json<any>()).data.map(
      (x: any) => x.id,
    ),
  ).toEqual([f.bid]);
  await exec(env, "UPDATE applications SET bots='[]' WHERE id=?", f.id);
  expect(
    (await (await request(f, `/profiles/${f.p}/bots`)).json<any>()).data,
  ).toHaveLength(0);
  expect((await request(f, `/profiles/${f.p}/status`)).status).toBe(403);
  expect(
    JSON.stringify(await (await request(f, "/profiles")).json()),
  ).not.toContain("instructions");
});
it("API exige idempotência e fixa a identidade da aplicação", async () => {
  const f = await fixture();
  const path = `/profiles/${f.p}/conversations`;
  const noKey = await SELF.fetch("https://test/api/v1" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ external_id: "x" }),
  });
  expect(noKey.status).toBe(400);
  const key = uid(),
    body = {
      external_id: "x",
      text: "oi",
      actor: "admin",
      phone: "5511999999999",
    };
  const r = await request(f, path, body, key);
  const value = await r.json<any>();
  expect(r.status).toBe(200);
  const replay = await request(
    f,
    path,
    { phone: body.phone, text: "oi", external_id: "x", actor: "admin" },
    key,
  );
  expect(await replay.json()).toEqual(value);
  const c = await conversation(env, value.conversation_id, f.p);
  expect(c.external_namespace).toBe("app:" + f.actor.id);
  expect(c.phone).toBeNull();
  await request(f, path + "/" + c.id + "/actions", {
    action: "claim",
    actor: "admin",
  });
  expect((await conversation(env, c.id, f.p)).owner).toBe(f.actor.id);
});
it("não acessa conversa externa de outra aplicação no mesmo perfil", async () => {
  const f = await fixture();
  const c = await inbound(
    env,
    f.p,
    { external_id: "1", message_id: "1", text: "privado" },
    "app:app:another",
    null,
  );
  expect(
    (await request(f, `/profiles/${f.p}/conversations/${c.conversation_id}`))
      .status,
  ).toBe(404);
  const list = await (
    await request(f, `/profiles/${f.p}/conversations`)
  ).json<any>();
  expect(list.data).toHaveLength(0);
  const events = await (
    await request(f, `/profiles/${f.p}/events`)
  ).json<any>();
  expect(events.data).toHaveLength(0);
});
it("inicia bots com 202, limita execuções e permite cancelar", async () => {
  const f = await botFixture();
  const response = await request(f, "/bot-runs", {
    profile_id: f.p,
    bot_id: f.bid,
    input: "teste",
  });
  expect(response.status).toBe(202);
  const run = await response.json<any>();
  expect((await request(f, "/bot-runs/" + run.id)).status).toBe(200);
  await exec(env, "UPDATE applications SET run_limit=1 WHERE id=?", f.id);
  expect(
    (
      await request(f, "/bot-runs", {
        profile_id: f.p,
        bot_id: f.bid,
        input: "outro",
      })
    ).status,
  ).toBe(429);
  expect(
    (await request(f, `/profiles/${f.p}/bot-runs/${run.id}/cancel`, {})).status,
  ).toBe(200);
  expect(
    (await one(env, "SELECT status FROM bot_runs WHERE id=?", run.id)).status,
  ).toBe("cancelled");
});
it("página por cursor não repete registros e limita requisições", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++)
    await inbound(
      env,
      f.p,
      { external_id: String(i), message_id: "1", text: "oi" },
      "app:" + f.actor.id,
      null,
    );
  const a = await (
    await request(f, `/profiles/${f.p}/conversations?limit=2`)
  ).json<any>();
  expect(a.data).toHaveLength(2);
  const b = await (
    await request(
      f,
      `/profiles/${f.p}/conversations?limit=2&cursor=${encodeURIComponent(a.next_cursor)}`,
    )
  ).json<any>();
  expect(b.data).toHaveLength(1);
  expect(a.data.some((x: any) => x.id === b.data[0].id)).toBe(false);
  await exec(env, "UPDATE applications SET rate=1 WHERE id=?", f.id);
  expect((await request(f, "/profiles")).status).toBe(429);
});
it("não reenvia criação de bot após timeout ambíguo", async () => {
  const f = await botFixture();
  const r = await createRun(env, f.actor, f.p, {
    bot_id: f.bid,
    input: "teste",
  });
  fetchMock
    .get("https://hermes.example.com")
    .intercept({ path: "/v1/runs", method: "POST" })
    .replyWithError(new Error("timeout"));
  await processRun(
    env,
    await one(env, "SELECT * FROM bot_runs WHERE id=?", r.id),
  );
  expect(
    (await one(env, "SELECT status FROM bot_runs WHERE id=?", r.id)).status,
  ).toBe("unknown");
  fetchMock.assertNoPendingInterceptors();
});
it("guarda o resultado de bot e suprime resposta após tomada humana", async () => {
  const f = await botFixture();
  await exec(env, "UPDATE profiles SET enabled=1 WHERE id=?", f.p);
  const conv = await inbound(
      env,
      f.p,
      { external_id: "x", message_id: "1", text: "oi" },
      "app:" + f.actor.id,
      null,
    ),
    c = await conversation(env, conv.conversation_id, f.p);
  const r = await createRun(
    env,
    f.actor,
    f.p,
    { bot_id: f.bid, input: "teste" },
    {
      conversation_id: c.id,
      epoch: c.epoch,
      phase: "attendant",
      context: { sources: [{ id: 1, text: "fonte" }] },
    },
  );
  await exec(
    env,
    "UPDATE bot_runs SET status='running',remote_id='remote1' WHERE id=?",
    r.id,
  );
  await perform(
    env,
    f.actor,
    f.p,
    "conversation.action",
    { id: c.id, action: "claim" },
    uid(),
  );
  fetchMock
    .get("https://hermes.example.com")
    .intercept({ path: "/v1/runs/remote1" })
    .reply(200, {
      status: "completed",
      output: JSON.stringify({
        action: "answer",
        text: "resposta antiga",
        citations: [1],
      }),
    });
  await processRun(
    env,
    await one(env, "SELECT * FROM bot_runs WHERE id=?", r.id),
  );
  expect(
    (await one(env, "SELECT status FROM bot_runs WHERE id=?", r.id)).status,
  ).toBe("completed");
  expect(
    await all(env, "SELECT * FROM outbox WHERE conversation_id=?", c.id),
  ).toHaveLength(0);
});
it("assina webhooks, mantém evento estável e registra retentativas", async () => {
  const f = await fixture();
  const c = await inbound(
    env,
    f.p,
    { external_id: "x", message_id: "1", text: "teste" },
    "app:" + f.actor.id,
    null,
  );
  const sub = await perform(
    env,
    f.actor,
    f.p,
    "webhook.create",
    { url: "https://receiver.example.com/events", events: ["message.sent"] },
    uid(),
  );
  const eid = await event(env, f.p, "message.sent", "msg1", {
    conversation_id: c.conversation_id,
    text: "olá",
  });
  await event(env, f.p, "message.sent", "msg1", {
    conversation_id: c.conversation_id,
    text: "olá",
  });
  const delivery = await one(
    env,
    "SELECT * FROM webhook_deliveries WHERE subscription_id=?",
    sub.id,
  );
  expect(
    await all(
      env,
      "SELECT * FROM webhook_deliveries WHERE subscription_id=?",
      sub.id,
    ),
  ).toHaveLength(1);
  fetchMock
    .get("https://receiver.example.com")
    .intercept({ path: "/events", method: "POST" })
    .reply(503, "offline");
  await deliverWebhook(env, delivery);
  const retry = await one(
    env,
    "SELECT * FROM webhook_deliveries WHERE id=?",
    delivery.id,
  );
  expect(retry.attempts).toBe(1);
  expect(retry.status).toBe("pending");
  let headers: any,
    body = "";
  fetchMock
    .get("https://receiver.example.com")
    .intercept({ path: "/events", method: "POST" })
    .reply((options) => {
      headers = options.headers;
      body = String(options.body);
      return { statusCode: 204, data: "" };
    });
  await deliverWebhook(env, retry);
  const h = new Headers(headers);
  expect(h.get("Wabotia-Event-Id")).toBe(String(eid));
  expect(h.get("Wabotia-Signature")).toBe(
    "v1=" +
      (await hmac(sub.signing_secret, h.get("Wabotia-Timestamp") + "." + body)),
  );
  expect(
    (
      await one(
        env,
        "SELECT status FROM webhook_deliveries WHERE id=?",
        delivery.id,
      )
    ).status,
  ).toBe("delivered");
  expect(
    await all(
      env,
      "SELECT * FROM webhook_attempts WHERE delivery_id=?",
      delivery.id,
    ),
  ).toHaveLength(2);
});
it("importa arquivos de texto pelo armazenamento privado", async () => {
  const f = await fixture(),
    id = uid(),
    mid = uid();
  await env.MEDIA.put(mid, "Atendimento das 9h às 18h.");
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    mid,
    f.p,
    "horarios.txt",
    "text/plain",
    30,
    mid,
    f.actor.id,
    now(),
  );
  await exec(
    env,
    "INSERT INTO documents(id,profile_id,title,kind,media_id,created) VALUES(?,?,?,?,?,?)",
    id,
    f.p,
    "Horários",
    "file",
    mid,
    now(),
  );
  await importDocument(
    env,
    await one(env, "SELECT * FROM documents WHERE id=?", id),
  );
  expect(
    (await one(env, "SELECT status FROM documents WHERE id=?", id)).status,
  ).toBe("ready");
  expect(
    await all(env, "SELECT * FROM chunks WHERE document_id=?", id),
  ).toHaveLength(1);
});

it("extrai PDF no runtime Workers sem navegador", async () => {
  const content =
    "BT /F1 12 Tf 50 700 Td (Atendimento em horario comercial) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n",
    offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => String(o).padStart(10, "0") + " 00000 n ")
    .join(
      "\n",
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const f = await fixture(),
    id = uid(),
    mid = uid();
  await env.MEDIA.put(mid, pdf);
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    mid,
    f.p,
    "teste.pdf",
    "application/pdf",
    pdf.length,
    mid,
    f.actor.id,
    now(),
  );
  await exec(
    env,
    "INSERT INTO documents(id,profile_id,title,kind,media_id,created) VALUES(?,?,?,?,?,?)",
    id,
    f.p,
    "PDF",
    "file",
    mid,
    now(),
  );
  await importDocument(
    env,
    await one(env, "SELECT * FROM documents WHERE id=?", id),
  );
  const doc = await one(env, "SELECT * FROM documents WHERE id=?", id);
  expect(doc.error).toBeNull();
  expect(doc.status).toBe("ready");
  expect(
    (await one(env, "SELECT text FROM chunks WHERE document_id=?", id)).text,
  ).toContain("horario comercial");
});

it("upload repetido preserva arquivo original em conflito", async () => {
  const f = await fixture(["media:read", "media:write"]);
  const key = uid();
  async function upload(name: string) {
    const form = new FormData();
    form.set(
      "file",
      new File(["arquivo privado"], name, { type: "text/plain" }),
    );
    return SELF.fetch(`https://test/api/v1/profiles/${f.p}/media`, {
      method: "POST",
      headers: { Authorization: "Bearer " + f.token, "Idempotency-Key": key },
      body: form,
    });
  }
  const a = await upload("original.txt");
  expect(a.status).toBe(200);
  const body = await a.json<any>();
  expect((await upload("outro-nome.txt")).status).toBe(409);
  const content = await request(f, `/profiles/${f.p}/media/${body.id}/content`);
  expect(content.status).toBe(200);
  expect(await content.text()).toBe("arquivo privado");
});
