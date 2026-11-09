import { env, SELF } from "cloudflare:test";
import { it, expect } from "vitest";
import { exec } from "../src/db";
import { sha, random } from "../src/security";
import { uid, now, defaults } from "../src/types";
import { inbound, conversation, openTicket } from "../src/service";
import { openapi } from "../src/openapi";

async function fixture(role = "admin") {
  const profile = uid(),
    user = uid(),
    token = "wabu_" + random();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Teste",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
    user,
    `${user}@example.test`,
    "Teste",
    "unused",
    role,
    JSON.stringify([profile]),
    now(),
  );
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created) VALUES(?,?,?,'bearer',?)",
    await sha(token),
    user,
    now() + 600000,
    now(),
  );
  return { profile, token };
}
const request = (path: string, token?: string, body?: unknown) =>
  SELF.fetch("https://test" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      "CF-Connecting-IP": uid(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

it("expõe pareamento público e restringe aprovação a administrador, sem exigir Idempotency-Key", async () => {
  const admin = await fixture(),
    operator = await fixture("operator");
  const start = await request("/api/pairing/start", undefined, {
    client: "vinki",
    instance_name: "Loja",
  });
  expect(start.status).toBe(201);
  const session = await start.json<any>();
  expect(
    (
      await request("/api/v1/pairings/lookup", operator.token, {
        user_code: session.user_code,
      })
    ).status,
  ).toBe(403);
  const found = await request("/api/v1/pairings/lookup", admin.token, {
    user_code: session.user_code,
  });
  expect(found.status).toBe(200);
  const pairing = await found.json<any>();
  expect(pairing.device_hash).toBeUndefined();
  const approved = await request(
    `/api/v1/pairings/${pairing.id}/approve`,
    admin.token,
    {
      profile_id: admin.profile,
      scopes: ["routing:read"],
      number_ids: [],
      pool_ids: [],
      bot_ids: [],
    },
  );
  expect(approved.status).toBe(200);
  const polled = await request("/api/pairing/token", undefined, {
    client: "vinki",
    device_code: session.device_code,
  });
  expect(polled.status).toBe(200);
  const credential = await polled.json<any>();
  expect(credential.status).toBe("connected");
  const disconnected = await request(
    "/api/v1/pairings/disconnect",
    credential.access_token,
    {},
  );
  expect(disconnected.status).toBe(200);
  expect((await request("/api/v1/me", credential.access_token)).status).toBe(
    401,
  );
});

it("busca protocolo por número ou telefone e filtra conversas por setor dentro do perfil autorizado", async () => {
  const f = await fixture("operator"),
    other = await fixture("operator");
  const records = [];
  for (const [profile, phone, department] of [
    [f.profile, "5511999999001", "financeiro"],
    [f.profile, "5511999999002", "suporte"],
    [other.profile, "5511999999001", "financeiro"],
  ]) {
    const result = await inbound(
      env,
      profile,
      { external_id: phone, message_id: uid(), text: "Ajuda" },
      "app:test-query",
      null,
    );
    await exec(
      env,
      "UPDATE conversations SET phone=?,department_id=? WHERE id=?",
      phone,
      department,
      result.conversation_id,
    );
    records.push(
      await openTicket(
        env,
        await conversation(env, result.conversation_id, profile),
        "system",
        "Solicitação",
      ),
    );
  }
  const prefix = `/api/v1/profiles/${f.profile}`;
  for (const q of [records[0]!.number, "5511999999001"]) {
    const r = await request(
      `${prefix}/tickets?q=${encodeURIComponent(q)}`,
      f.token,
    );
    expect(r.status).toBe(200);
    expect((await r.json<any>()).data.map((r: any) => r.id)).toEqual([
      records[0]!.id,
    ]);
  }
  const filtered = await request(
    prefix + "/conversations?department_id=financeiro",
    f.token,
  );
  expect((await filtered.json<any>()).data.map((r: any) => r.id)).toEqual([
    records[0]!.conversation_id,
  ]);
  expect(
    (
      await request(
        `/api/v1/profiles/${other.profile}/tickets?q=5511999999001`,
        f.token,
      )
    ).status,
  ).toBe(404);
});

it("publica contratos de pareamento, atualização, protocolos e setor com bases e autenticação corretas", () => {
  const spec = openapi("https://test");
  const start = spec.paths["/pairing/start"].post;
  expect(start.security).toEqual([]);
  expect(start.servers).toEqual([{ url: "https://test/api" }]);
  expect(start.responses["201"]).toBeDefined();
  expect(start.parameters.some((p: any) => p.name === "Idempotency-Key")).toBe(
    false,
  );
  expect(
    spec.paths["/system/updates/automatic"].post.parameters.some(
      (p: any) => p.name === "Idempotency-Key",
    ),
  ).toBe(true);
  expect(spec.components.schemas.Action.properties.action.enum).toContain(
    "protocols",
  );
  expect(
    spec.paths["/profiles/{profile}/conversations"].get.parameters.some(
      (p: any) => p.name === "department_id",
    ),
  ).toBe(true);
});
