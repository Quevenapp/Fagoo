import { env, SELF } from "cloudflare:test";
import { it, expect, vi, afterEach } from "vitest";
import { all, one, exec } from "../src/db";
import { Actor, defaults, uid, now, json } from "../src/types";
import { setSecret, sha, hmac } from "../src/security";
import { accountCommand, metaCredentials } from "../src/meta-accounts";
import {
  numberUsage,
  billingPeriod,
  observeMetaUsage,
  assertNumberQuotaDelivery,
} from "../src/number-quota";
import {
  routerCommand,
  routerView,
  selectPoolNumbers,
  routerLink,
  routedMessage,
} from "../src/number-router";
import { inbound, conversation, enqueue, perform } from "../src/service";
import { deliver, processInbox, processRun } from "../src/engine";
import {
  numberPolicyPresets,
  numberPolicy,
  type NumberPolicy,
} from "../src/number-policy";
import { finishDelivery } from "../src/delivery";
import { metaInbound } from "../src/meta-inbound";
import { visibleConversation } from "../src/visibility";
const admin: Actor = {
  id: "router-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 600,
  runLimit: 3,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(count = 2, baseline = 0) {
  const profile = uid(),
    account = uid(),
    waba = "123" + uid().replace(/\D/g, "");
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Teste roteador",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO meta_accounts(id,profile_id,name,waba_id,timezone,created) VALUES(?,?,?,?,?,?)",
    account,
    profile,
    "Conta teste",
    waba,
    "America/Sao_Paulo",
    now(),
  );
  await setSecret(env, "meta-account:" + account, {
    token: "fake-account-token",
    app_secret: "fake-app-secret",
    verify_token: "fake-verify-token",
  });
  const numbers: any[] = [];
  for (let i = 0; i < count; i++) {
    const id = uid(),
      phone = waba + String(i + 1),
      config = {
        meta_account_id: account,
        waba_id: waba,
        phone_id: phone,
        number: "551199999" + String(i + 1).padStart(4, "0"),
        verified_at: now(),
      };
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'meta','direct','active',?,?)",
      id,
      profile,
      "Número " + (i + 1),
      JSON.stringify(config),
      now(),
    );
    await exec(
      env,
      "INSERT INTO meta_numbers(connection_id,account_id,phone_id,service_limit,baseline_period,baseline_used,monitored_at) VALUES(?,?,?,1000,?,?,?)",
      id,
      account,
      phone,
      billingPeriod(now(), "America/Sao_Paulo"),
      baseline,
      now() - 1000,
    );
    numbers.push(await one(env, "SELECT * FROM connections WHERE id=?", id));
  }
  const appId = uid(),
    token = "fake-" + uid(),
    scopes = [
      "routing:read",
      "routing:send",
      "routing:paid",
      "conversations:read",
      "conversations:write",
      "media:read",
      "media:write",
    ];
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
    appId,
    "Aplicação teste",
    JSON.stringify([profile]),
    JSON.stringify(scopes),
    "[]",
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    appId,
    await sha(token),
    "fake",
    now() + 86400000,
    now(),
  );
  const actor: Actor = {
    ...admin,
    id: "app:" + appId,
    kind: "app",
    role: "service",
    profiles: [profile],
    scopes,
  };
  const pool = await routerCommand(
    env,
    admin,
    profile,
    "router.pool.save",
    {
      account_id: account,
      name: "Grupo teste",
      members: numbers.map((n) => n.id),
      strategy: "least_used",
      enabled: true,
      allow_paid: true,
      public_enabled: true,
    },
    uid(),
  );
  await routerCommand(
    env,
    admin,
    profile,
    "router.grants.save",
    {
      app_id: appId,
      numbers: numbers.map((n) => n.id),
      pools: [pool.id],
      allow_paid: true,
    },
    uid(),
  );
  return { profile, account, waba, numbers, appId, actor, token, pool };
}
async function customer(f: any, n = 0, to = "5511999991111", at = now()) {
  const r = await inbound(
    env,
    f.profile,
    { external_id: to, message_id: uid(), text: "Olá", customer_at: at },
    "channel:" + f.numbers[n].id,
    f.numbers[n].id,
  );
  return conversation(env, r.conversation_id, f.profile);
}
const service = (f: any, more: any = {}) => ({
  pool_id: f.pool.id,
  to: "5511999991111",
  external_id: "pedido-123",
  text: "Resposta de atendimento",
  ...more,
});
const paid = (f: any, more: any = {}) => ({
  pool_id: f.pool.id,
  to: "5511999992222",
  external_id: "pedido-pago",
  allow_paid: true,
  consent: {
    granted: true,
    category: "utility",
    reference: "Aceite no pedido 123",
  },
  template: {
    name: "pedido_atualizado",
    language: "pt_BR",
    components: [{ type: "body", parameters: [{ type: "text", text: "123" }] }],
  },
  ...more,
});
function metaMock(
  components: any[] = [{ type: "BODY", text: "Pedido {{1}} atualizado." }],
) {
  const sent: any[] = [];
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    expect(url.startsWith("https://graph.facebook.com/")).toBe(true);
    expect(init.headers.Authorization).toBe("Bearer fake-account-token");
    if (url.includes("/message_templates?"))
      return Response.json({
        data: [
          {
            name: "pedido_atualizado",
            language: "pt_BR",
            status: "APPROVED",
            category: "UTILITY",
            components,
          },
        ],
      });
    if (url.endsWith("/media")) return Response.json({ id: "provider-media" });
    if (url.endsWith("/messages")) {
      sent.push(JSON.parse(init.body));
      return Response.json({ messages: [{ id: "wamid." + uid() }] });
    }
    throw Error("Unexpected Graph call");
  });
  vi.stubGlobal("fetch", fetch);
  return { sent, fetch };
}

async function setPolicy(f: any, index: number, policy: NumberPolicy) {
  return routerCommand(
    env,
    admin,
    f.profile,
    "router.number.policy",
    {
      id: f.numbers[index].id,
      policy,
    },
    uid(),
  );
}

async function pairedVinki(f: any) {
  await exec(
    env,
    "INSERT INTO pairing_requests(id,client,instance_name,device_hash,user_hash,status,expires,profile_id,app_id,created,updated) VALUES(?,'vinki','Vinki teste',?,?,'consumed',?,?,?,?,?)",
    uid(),
    uid(),
    uid(),
    now() + 600000,
    f.profile,
    f.appId,
    now(),
    now(),
  );
}

it("free_only reserva atomicamente a última unidade de uma linha legada sem bloquear clientes antigos", async () => {
  const f = await fixture(1, 999),
    c = await customer(f);
  const results = await Promise.allSettled(
    [1, 2].map((index) =>
      enqueue(
        env,
        c,
        f.actor.id,
        "text",
        { text: "somente saldo " + index, free_only: true },
        uid(),
      ),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason,
  ).toMatchObject({ code: "quota_exhausted" });
  expect(
    (await numberUsage(env, c.connection_id))!.service_overage_allowed,
  ).toBe(true);
  await expect(
    enqueue(env, c, f.actor.id, "text", { text: "legado" }, uid()),
  ).resolves.toBeTypeOf("string");
  expect((await numberUsage(env, c.connection_id))!.used).toBe(1001);
});

it("free_only seleciona saldo de linhas legadas e aparece no recibo sem expor payload privado", async () => {
  const f = await fixture(2, 1000);
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=999 WHERE connection_id=?",
    f.numbers[1].id,
  );
  await customer(f, 0);
  await customer(f, 1);
  const queued = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f, { free_only: true }),
    uid(),
  );
  expect(queued).toMatchObject({
    number_id: f.numbers[1].id,
    free_only: true,
    billing: { service_overage_allowed: false },
  });
  const receipt = await routedMessage(
    env,
    f.actor,
    f.profile,
    queued.delivery_id,
  );
  expect(receipt).toMatchObject({
    free_only: true,
    number_id: f.numbers[1].id,
  });
  expect(receipt).not.toHaveProperty("payload");
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      service(f, { free_only: true }),
      uid(),
    ),
  ).rejects.toMatchObject({ code: "quota_exhausted" });
});

it("Vinki pareado força free_only mesmo omitido ou falso e impede desvio pelo envio direto", async () => {
  const f = await fixture(1, 999),
    c = await customer(f);
  await pairedVinki(f);
  const queued = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f, { free_only: false }),
    uid(),
  );
  expect(queued.free_only).toBe(true);
  const row = await one(
    env,
    "SELECT * FROM outbox WHERE id=?",
    queued.delivery_id,
  );
  expect(json(row.payload).free_only).toBe(true);
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ code: "quota_exhausted" });
  await expect(
    enqueue(
      env,
      await conversation(env, c.id, f.profile),
      f.actor.id,
      "text",
      { text: "direto", free_only: false },
      uid(),
    ),
  ).rejects.toMatchObject({ code: "quota_exhausted" });
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", paid(f), uid()),
  ).rejects.toMatchObject({ code: "invalid_request" });
  const unmanagedId = uid();
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Sem contador','meta','direct','active',?,?)",
    unmanagedId,
    f.profile,
    f.numbers[0].config,
    now(),
  );
  const unmanaged = await customer({ ...f, numbers: [{ id: unmanagedId }] });
  await expect(
    assertNumberQuotaDelivery(env, { ...row, connection_id: unmanagedId }),
  ).rejects.toMatchObject({
    code: "quota_exhausted",
  });
  await expect(
    enqueue(
      env,
      unmanaged,
      f.actor.id,
      "text",
      { text: "sem contador" },
      uid(),
    ),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

it("cancela aviso que vence durante upload de mídia sem enviar a mensagem à Meta", async () => {
  const f = await fixture(1),
    media = uid();
  await customer(f);
  await env.MEDIA.put(f.profile + "/" + media, "fake-image");
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    media,
    f.profile,
    "foto.jpg",
    "image/jpeg",
    10,
    f.profile + "/" + media,
    f.actor.id,
    now(),
  );
  const expires_at = now() + 60000;
  const queued = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f, { text: "", attachments: [media], free_only: true, expires_at }),
    uid(),
  );
  const fetcher = vi.fn(async (url: any) => {
    expect(String(url)).toMatch(/\/media$/);
    vi.spyOn(Date, "now").mockReturnValue(expires_at + 1);
    return Response.json({ id: "provider-media" });
  });
  vi.stubGlobal("fetch", fetcher);
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", queued.delivery_id),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    await routedMessage(env, f.actor, f.profile, queued.delivery_id),
  ).toMatchObject({
    status: "cancelled",
    error: "Validade da mensagem encerrada antes do envio.",
  });
});

it("a restrição do pedido persiste na entrega quando a política da linha permite excedente", async () => {
  const f = await fixture(1, 999);
  await customer(f);
  await pairedVinki(f);
  await setPolicy(f, 0, {
    ...numberPolicyPresets.custom,
    service_overage: false,
  });
  const queued = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  await setPolicy(f, 0, numberPolicyPresets.custom);
  await exec(
    env,
    "UPDATE meta_numbers SET service_limit=999 WHERE connection_id=?",
    f.numbers[0].id,
  );
  const row = await one(
    env,
    "SELECT * FROM outbox WHERE id=?",
    queued.delivery_id,
  );
  await expect(assertNumberQuotaDelivery(env, row)).rejects.toMatchObject({
    code: "quota_exhausted",
  });
  const mock = metaMock();
  await deliver(env, row);
  expect(mock.sent).toHaveLength(0);
  expect((await routedMessage(env, f.actor, f.profile, row.id)).status).toBe(
    "cancelled",
  );
});

it("valida free_only e validade do aviso, preserva expires_at no recibo e cancela vencido sem rede", async () => {
  const f = await fixture(1),
    c = await customer(f);
  for (const expires_at of [
    now() - 1,
    now() + 86400001 + 60000,
    "2030-01-01",
    null,
    1.5,
  ])
    await expect(
      routerCommand(
        env,
        f.actor,
        f.profile,
        "router.send",
        service(f, { expires_at }),
        uid(),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      service(f, { free_only: "true" }),
      uid(),
    ),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      paid(f, { free_only: true }),
      uid(),
    ),
  ).rejects.toMatchObject({ code: "invalid_request" });
  const expires_at = now() + 60000;
  const queued = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f, { free_only: true, expires_at }),
    uid(),
  );
  expect(queued.expires_at).toBe(expires_at);
  expect(
    (await routedMessage(env, f.actor, f.profile, queued.delivery_id))
      .expires_at,
  ).toBe(expires_at);
  expect(
    json(
      (
        await one(
          env,
          "SELECT payload FROM outbox WHERE id=?",
          queued.delivery_id,
        )
      ).payload,
    ),
  ).toMatchObject({ expires_at, free_only: true });
  await exec(
    env,
    "UPDATE outbox SET payload=json_set(payload,'$.expires_at',?) WHERE id=?",
    now() - 1,
    queued.delivery_id,
  );
  const mock = metaMock();
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", queued.delivery_id),
  );
  expect(mock.sent).toHaveLength(0);
  expect(
    (await routedMessage(env, f.actor, f.profile, queued.delivery_id)).status,
  ).toBe("cancelled");
  expect((await numberUsage(env, c.connection_id))!.used).toBe(0);
});

it("preserva excedente de clientes antigos e aplica o novo preset Vinki somente ao salvar", async () => {
  const f = await fixture(1);
  expect(numberPolicy({}).service_overage).toBe(true);
  expect(
    numberPolicy({ number_policy: { purpose: "service_only" } })
      .service_overage,
  ).toBe(true);
  expect(numberPolicyPresets.service_only.service_overage).toBe(false);
  const { service_overage: _unused, ...oldPolicy } =
    numberPolicyPresets.service_only;
  const saved = await routerCommand(
    env,
    admin,
    f.profile,
    "router.number.policy",
    { id: f.numbers[0].id, policy: oldPolicy },
    uid(),
  );
  expect(saved.policy.service_overage).toBe(true);
  await setPolicy(f, 0, numberPolicyPresets.service_only);
  const preserved = await routerCommand(
    env,
    admin,
    f.profile,
    "router.number.policy",
    { id: f.numbers[0].id, policy: oldPolicy },
    uid(),
  );
  expect(preserved.policy.service_overage).toBe(false);
});

it("reserva a última unidade atomicamente e mantém o recibo de uma repetição", async () => {
  const f = await fixture(1, 999),
    c = await customer(f);
  await setPolicy(f, 0, {
    ...numberPolicyPresets.custom,
    service_overage: false,
  });
  const keys = [uid(), uid()];
  const results = await Promise.allSettled(
    keys.map((key) => enqueue(env, c, admin.id, "text", { text: key }, key)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const rejected = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: "quota_exhausted" });
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    used: 1000,
    reserved: 1,
    service_overage_allowed: false,
  });
  const success = results.findIndex((r) => r.status === "fulfilled");
  const replay = await enqueue(
    env,
    c,
    admin.id,
    "text",
    { text: keys[success] },
    keys[success],
  );
  expect(replay).toBe(
    (results[success] as PromiseFulfilledResult<string>).value,
  );
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1000);
});

it("respeita ordem das reservas ao reduzir limite e cancela apenas o excedente antes da rede", async () => {
  const f = await fixture(1, 998),
    c = await customer(f);
  const first = await enqueue(
    env,
    c,
    admin.id,
    "text",
    { text: "primeira" },
    uid(),
  );
  const second = await enqueue(
    env,
    c,
    admin.id,
    "text",
    { text: "segunda" },
    uid(),
  );
  await setPolicy(f, 0, {
    ...numberPolicyPresets.custom,
    service_overage: false,
  });
  await exec(
    env,
    "UPDATE meta_numbers SET service_limit=999 WHERE connection_id=?",
    f.numbers[0].id,
  );
  const row1 = await one(env, "SELECT * FROM outbox WHERE id=?", first);
  const row2 = await one(env, "SELECT * FROM outbox WHERE id=?", second);
  await expect(assertNumberQuotaDelivery(env, row1)).resolves.toBeUndefined();
  await expect(assertNumberQuotaDelivery(env, row2)).rejects.toMatchObject({
    code: "quota_exhausted",
  });
  const mock = metaMock();
  await deliver(env, row2);
  expect(mock.sent).toHaveLength(0);
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", second)).status,
  ).toBe("cancelled");
  await deliver(env, row1);
  expect(mock.sent).toHaveLength(1);
});

it("recibos externos recebidos depois da reserva são conferidos novamente antes da entrega", async () => {
  const f = await fixture(1, 999),
    c = await customer(f);
  await setPolicy(f, 0, {
    ...numberPolicyPresets.custom,
    service_overage: false,
  });
  const id = await enqueue(
    env,
    c,
    admin.id,
    "text",
    { text: "aguardando" },
    uid(),
  );
  const row = await one(env, "SELECT * FROM outbox WHERE id=?", id);
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "external-" + uid(),
    status: "delivered",
    timestamp: now(),
    pricing: { category: "service", billable: false },
  });
  await expect(assertNumberQuotaDelivery(env, row)).rejects.toMatchObject({
    code: "quota_exhausted",
  });
});

it("pula linhas sem saldo no link público e retorna quota_exhausted se todas bloqueiam excedente", async () => {
  const f = await fixture(2, 1000);
  await setPolicy(f, 0, numberPolicyPresets.service_only);
  await setPolicy(f, 1, numberPolicyPresets.service_only);
  await expect(
    selectPoolNumbers(env, f.profile, f.pool.id),
  ).rejects.toMatchObject({ code: "quota_exhausted" });
  const pool = await one(
    env,
    "SELECT public_token FROM number_pools WHERE id=?",
    f.pool.id,
  );
  await expect(
    routerLink(env, f.profile, pool.public_token),
  ).rejects.toMatchObject({ code: "quota_exhausted" });
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=999 WHERE connection_id=?",
    f.numbers[1].id,
  );
  expect(
    (await selectPoolNumbers(env, f.profile, f.pool.id)).map((n) => n.id),
  ).toEqual([f.numbers[1].id]);
  expect((await routerLink(env, f.profile, pool.public_token)).url).toBe(
    "https://wa.me/" + json(f.numbers[1].config).number,
  );
});

it("não troca o remetente vinculado quando a franquia acaba e outra linha tem saldo", async () => {
  const f = await fixture(2, 999);
  await setPolicy(f, 0, numberPolicyPresets.service_only);
  await setPolicy(f, 1, numberPolicyPresets.service_only);
  await customer(f, 0);
  await customer(f, 1);
  await exec(
    env,
    "UPDATE number_pool_members SET last_selected=1 WHERE pool_id=? AND connection_id=?",
    f.pool.id,
    f.numbers[1].id,
  );
  const first = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  expect(first.number_id).toBe(f.numbers[0].id);
  expect(first.billing.service_overage_allowed).toBe(false);
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ code: "quota_exhausted" });
  expect(
    (
      await one(
        env,
        "SELECT connection_id FROM router_affinities WHERE profile_id=? AND actor=? AND external_id='pedido-123'",
        f.profile,
        f.actor.id,
      )
    ).connection_id,
  ).toBe(f.numbers[0].id);
});

it("o bloqueio de excedente de serviço não gasta saldo com leitura nem autoriza templates por conta própria", async () => {
  const f = await fixture(1, 1000),
    c = await customer(f);
  await setPolicy(f, 0, numberPolicyPresets.service_only);
  await expect(
    enqueue(
      env,
      c,
      f.actor.id,
      "text",
      { content: { type: "read", message_id: "sample" } },
      uid(),
    ),
  ).resolves.toBeTypeOf("string");
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      paid(f, { number_id: f.numbers[0].id, pool_id: undefined }),
      uid(),
    ),
  ).rejects.toMatchObject({ code: "number_policy_denied" });
  await setPolicy(f, 0, {
    ...numberPolicyPresets.custom,
    service_overage: false,
  });
  metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  expect(result.billing.mode).toBe("paid_template");
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1000);
});

it("salva permissões por número somente com administrador e preserva identidade, consumo e isolamento", async () => {
  const f = await fixture(2, 23);
  const original = json(f.numbers[0].config);
  expect((await routerView(env, admin, f.profile)).numbers[0].policy).toEqual(
    numberPolicyPresets.custom,
  );
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.number.policy",
      {
        id: f.numbers[0].id,
        policy: numberPolicyPresets.service_only,
      },
      uid(),
    ),
  ).rejects.toThrow();
  await expect(
    routerCommand(
      env,
      admin,
      uid(),
      "router.number.policy",
      {
        id: f.numbers[0].id,
        policy: numberPolicyPresets.service_only,
      },
      uid(),
    ),
  ).rejects.toThrow("neste perfil");
  await expect(
    setPolicy(f, 0, {
      ...numberPolicyPresets.official,
      templates: "false",
    } as any),
  ).rejects.toThrow("verdadeiro ou falso");
  await setPolicy(f, 0, numberPolicyPresets.official);
  const saved = await one(
    env,
    "SELECT * FROM connections WHERE id=?",
    f.numbers[0].id,
  );
  expect(json(saved.config)).toEqual({
    ...original,
    number_policy: numberPolicyPresets.official,
  });
  expect(saved.status).toBe("active");
  expect((await numberUsage(env, saved.id))!.used).toBe(23);
  const view = await routerView(env, f.actor, f.profile);
  expect(view.numbers.find((n: any) => n.id === saved.id).policy).toEqual(
    numberPolicyPresets.official,
  );
  expect(
    view.numbers.find((n: any) => n.id === f.numbers[1].id).policy,
  ).toEqual(numberPolicyPresets.custom);
});

it("roteia a entrada para a linha Vinki, permite sua API e recusa templates e atendimento manual", async () => {
  const f = await fixture();
  await setPolicy(f, 0, numberPolicyPresets.official);
  await setPolicy(f, 1, numberPolicyPresets.service_only);
  const pool = await one(
    env,
    "SELECT public_token FROM number_pools WHERE id=?",
    f.pool.id,
  );
  expect((await routerLink(env, f.profile, pool.public_token)).url).toBe(
    `https://wa.me/${json(f.numbers[1].config).number}`,
  );
  const c = await customer(f, 1);
  await expect(
    perform(
      env,
      admin,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    ),
  ).rejects.toMatchObject({ code: "number_policy_denied" });
  const mock = metaMock();
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      {
        ...paid(f),
        pool_id: undefined,
        number_id: f.numbers[1].id,
      },
      uid(),
    ),
  ).rejects.toMatchObject({ code: "number_policy_denied" });
  expect(mock.fetch).not.toHaveBeenCalled();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  const row = await one(
    env,
    "SELECT * FROM outbox WHERE id=?",
    result.delivery_id,
  );
  expect(row.connection_id).toBe(f.numbers[1].id);
  await deliver(env, row);
  expect(mock.sent).toHaveLength(1);
  expect(mock.sent[0].text.body).toBe("Resposta de atendimento");
});

it("restrições do número prevalecem sobre grupos e impedem envio direto por outra rota da API", async () => {
  const f = await fixture();
  const c0 = await customer(f, 0);
  await customer(f, 1);
  await setPolicy(f, 0, { ...numberPolicyPresets.custom, api: false });
  await expect(
    enqueue(env, c0, f.actor.id, "text", { text: "Tentativa por fora" }, uid()),
  ).rejects.toMatchObject({ code: "number_policy_denied" });
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  const row = await one(
    env,
    "SELECT * FROM outbox WHERE id=?",
    result.delivery_id,
  );
  expect(row.connection_id).toBe(f.numbers[1].id);
  await setPolicy(f, 1, { ...numberPolicyPresets.custom, api: false });
  const mock = metaMock();
  await deliver(env, row);
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", row.id)).status,
  ).toBe("cancelled");
  expect(mock.fetch).not.toHaveBeenCalled();
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ code: "sender_unavailable" });
});

it("recebe e registra opt-out numa linha Vinki sem disparar menu, saudação, bot ou aviso automático", async () => {
  const f = await fixture(1);
  await setPolicy(f, 0, numberPolicyPresets.service_only);
  await exec(env, "UPDATE profiles SET enabled=1 WHERE id=?", f.profile);
  const c = await customer(f);
  await processInbox(env, f.profile);
  for (const text of ["menu", "falar com humano", "REVOGAR"]) {
    await inbound(
      env,
      f.profile,
      { external_id: c.external_id, message_id: uid(), text },
      "channel:" + c.connection_id,
      c.connection_id,
    );
    await processInbox(env, f.profile);
  }
  expect(
    await all(
      env,
      "SELECT id FROM messages WHERE conversation_id=? AND direction='customer'",
      c.id,
    ),
  ).toHaveLength(4);
  expect(
    await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile),
  ).toHaveLength(0);
  expect(
    await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile),
  ).toHaveLength(0);
  expect(
    (
      await one(
        env,
        "SELECT status FROM consents WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
        c.id,
      )
    ).status,
  ).toBe("revoked");
  expect(
    await all(
      env,
      "SELECT id FROM events WHERE profile_id=? AND kind='message.received'",
      f.profile,
    ),
  ).toHaveLength(4);
});

it("processa menu sem executar Hermes e cancela saudação enfileirada se o menu for desligado", async () => {
  const f = await fixture(1);
  await setPolicy(f, 0, { ...numberPolicyPresets.official, bots: false });
  await exec(env, "UPDATE profiles SET enabled=1 WHERE id=?", f.profile);
  const c = await customer(f);
  await processInbox(env, f.profile);
  const row = await one(
    env,
    "SELECT * FROM outbox WHERE conversation_id=?",
    c.id,
  );
  expect(json(row.payload).text).toContain("Olá! Como podemos ajudar?");
  expect(
    await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile),
  ).toHaveLength(0);
  await setPolicy(f, 0, { ...numberPolicyPresets.official, menu: false });
  const mock = metaMock();
  await deliver(env, row);
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", row.id)).status,
  ).toBe("cancelled");
  expect(mock.fetch).not.toHaveBeenCalled();
});

it("bloqueia template já na fila quando a linha passa a ser exclusiva de serviço", async () => {
  const f = await fixture(1);
  const mock = metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  await setPolicy(f, 0, numberPolicyPresets.service_only);
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent).toHaveLength(0);
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", result.delivery_id))
      .status,
  ).toBe("cancelled");
});

it("configura número para templates apenas sem gastar cota de serviço ou permitir resposta livre", async () => {
  const f = await fixture(1, 1000);
  await setPolicy(f, 0, { ...numberPolicyPresets.custom, service: false });
  const c = await customer(f);
  await expect(
    enqueue(env, c, admin.id, "text", { text: "Livre" }, uid()),
  ).rejects.toMatchObject({ code: "number_policy_denied" });
  const mock = metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent).toHaveLength(1);
  expect(mock.sent[0].type).toBe("template");
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1000);
});

it("desligar bots impede novas execuções e cancela respostas antigas já na fila", async () => {
  const f = await fixture(1),
    c = await customer(f);
  const runId = uid();
  await exec(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,input,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    runId,
    f.profile,
    uid(),
    "bot:attendant",
    c.id,
    c.epoch,
    "Pergunta",
    now(),
    now(),
  );
  const id = await enqueue(
    env,
    c,
    "bot:attendant",
    "text",
    { text: "Resposta antiga" },
    uid(),
  );
  await setPolicy(f, 0, { ...numberPolicyPresets.official, bots: false });
  const mock = metaMock();
  await processRun(
    env,
    (await one(env, "SELECT * FROM bot_runs WHERE id=?", runId))!,
  );
  await deliver(env, await one(env, "SELECT * FROM outbox WHERE id=?", id));
  expect(
    (await one(env, "SELECT status FROM bot_runs WHERE id=?", runId)).status,
  ).toBe("cancelled");
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", id)).status,
  ).toBe("cancelled");
  expect(mock.fetch).not.toHaveBeenCalled();
});

it("contabiliza serviço e templates separadamente sem descontar template da franquia de serviço", async () => {
  const f = await fixture(1);
  for (const category of [
    "service",
    "utility",
    "marketing",
    "authentication",
  ]) {
    await observeMetaUsage(env, f.numbers[0], {
      message_id: uid(),
      status: "delivered",
      timestamp: now(),
      pricing: { category, billable: category !== "service" },
    });
  }
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    used: 1,
    delivered: 4,
    service_delivered: 1,
    template_delivered: 3,
    free_confirmed: 1,
    billable_confirmed: 3,
  });
});
it("contabiliza envios concorrentes ao cruzar a franquia e permite o excedente pago", async () => {
  const f = await fixture(1, 999),
    c = await customer(f);
  const results = await Promise.allSettled([
    enqueue(env, c, admin.id, "text", { text: "A" }, uid()),
    enqueue(env, c, admin.id, "text", { text: "B" }, uid()),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    used: 1001,
    remaining: 0,
    free_remaining: 0,
    paid_service_estimated: 1,
    service_overage_allowed: true,
    reserved: 2,
  });
});
it("conta mensagens confirmadas uma vez, mesmo com webhooks duplicados e fora de ordem", async () => {
  const f = await fixture(1),
    c = await customer(f),
    id = await enqueue(
      env,
      c,
      admin.id,
      "text",
      { text: "Olá" },
      "quota:" + uid(),
    );
  await finishDelivery(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", id),
    "wamid.one",
  );
  const event = {
    message_id: "wamid.one",
    status: "delivered",
    timestamp: now(),
    pricing: {
      category: "service",
      billable: false,
      type: "free_customer_service",
    },
  };
  await observeMetaUsage(env, f.numbers[0], event);
  await observeMetaUsage(env, f.numbers[0], event);
  await observeMetaUsage(env, f.numbers[0], {
    ...event,
    status: "sent",
    timestamp: now() - 1000,
  });
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    used: 1,
    reserved: 0,
    free_confirmed: 1,
  });
});
it("libera falha confirmada e preserva reserva sem confirmação", async () => {
  const f = await fixture(1),
    c = await customer(f),
    id = await enqueue(env, c, admin.id, "text", { text: "Olá" }, uid());
  await exec(env, "UPDATE outbox SET status='unknown' WHERE id=?", id);
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1);
  await exec(
    env,
    "UPDATE outbox SET external_id='wamid.failed' WHERE id=?",
    id,
  );
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "wamid.failed",
    status: "failed",
    timestamp: now(),
  });
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(0);
});
it("troca o mês no fuso Meta sem descartar mensagens ainda reservadas", async () => {
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-11-30T23:59:00-03:00"),
  );
  const f = await fixture(1, 900),
    c = await customer(f),
    id = await enqueue(env, c, admin.id, "text", { text: "Olá" }, uid());
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(901);
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-12-01T00:01:00-03:00"),
  );
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    period: "2026-12",
    baseline: 0,
    used: 1,
  });
  await exec(
    env,
    "UPDATE outbox SET external_id='wamid.month',status='sent' WHERE id=?",
    id,
  );
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "wamid.month",
    status: "delivered",
    timestamp: now() - 180000,
    pricing: { category: "service", billable: false },
  });
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(0);
});
it("conta entregas de outros sistemas e separa modelos pagos da cota de atendimento", async () => {
  const f = await fixture(1);
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "outside-service",
    status: "delivered",
    timestamp: now(),
    pricing: { category: "service", billable: false },
  });
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "outside-template",
    status: "delivered",
    timestamp: now(),
    pricing: { category: "marketing", billable: true },
  });
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    used: 1,
    delivered: 2,
    free_confirmed: 1,
    billable_confirmed: 1,
  });
});
it("prioriza franquia para entrada e continua pago no mesmo remetente quando ela acaba", async () => {
  const f = await fixture();
  await customer(f, 0);
  await customer(f, 1);
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=1000 WHERE connection_id=?",
    f.numbers[0].id,
  );
  const first = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  expect(first.number_id).toBe(f.numbers[1].id);
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=999 WHERE connection_id=?",
    f.numbers[1].id,
  );
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=0 WHERE connection_id=?",
    f.numbers[0].id,
  );
  const second = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  expect(second.number_id).toBe(first.number_id);
  expect(second.billing).toMatchObject({
    mode: "service_paid",
    category: "service",
    estimated: true,
  });
  expect(second.usage).toMatchObject({
    used: 1001,
    free_remaining: 0,
    paid_service_estimated: 1,
  });
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      service(f, { pool_id: undefined, number_id: f.numbers[0].id }),
      uid(),
    ),
  ).rejects.toMatchObject({ code: "sender_pinned" });
});
it("recusa janela falsa, destinatário sem mensagem e número não autorizado", async () => {
  const f = await fixture();
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ code: "no_eligible_sender" });
  await customer(f, 0, "5511999991111", now() - 25 * 3600000);
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ code: "no_eligible_sender" });
  await exec(env, "DELETE FROM number_router_grants WHERE app_id=?", f.appId);
  expect((await routerView(env, f.actor, f.profile)).numbers).toHaveLength(0);
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ status: 403 });
});
it("link público alterna números ativos e continua com serviço pago quando a franquia acaba", async () => {
  const f = await fixture(),
    pool = await one(env, "SELECT * FROM number_pools WHERE id=?", f.pool.id);
  const a = await routerLink(env, f.profile, pool.public_token),
    b = await routerLink(env, f.profile, pool.public_token);
  expect(a.url).not.toBe(b.url);
  expect(a.url).toMatch(/^https:\/\/wa.me\/\d+$/);
  await exec(
    env,
    "UPDATE connections SET status='paused' WHERE id=?",
    f.numbers[0].id,
  );
  expect(
    (await selectPoolNumbers(env, f.profile, pool.id)).map((n) => n.id),
  ).toEqual([f.numbers[1].id]);
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=1000 WHERE connection_id=?",
    f.numbers[1].id,
  );
  expect((await routerLink(env, f.profile, pool.public_token)).url).toBe(
    `https://wa.me/${json(f.numbers[1].config).number}`,
  );
  await exec(
    env,
    "UPDATE connections SET status='paused' WHERE id=?",
    f.numbers[1].id,
  );
  await expect(
    routerLink(env, f.profile, pool.public_token),
  ).rejects.toMatchObject({ code: "pool_exhausted" });
});
it("faz rodízio desde a primeira entrada mesmo com consumo desigual e estratégia legada", async () => {
  const f = await fixture(3),
    pool = await one(env, "SELECT * FROM number_pools WHERE id=?", f.pool.id);
  await exec(
    env,
    "UPDATE number_pools SET strategy='least_used' WHERE id=?",
    f.pool.id,
  );
  for (let i = 0; i < f.numbers.length; i++)
    await exec(
      env,
      "UPDATE meta_numbers SET baseline_used=? WHERE connection_id=?",
      i * 300,
      f.numbers[i].id,
    );
  const turns = [];
  for (let i = 0; i < 6; i++)
    turns.push((await routerLink(env, f.profile, pool.public_token)).url);
  expect(new Set(turns.slice(0, 3)).size).toBe(3);
  expect(turns.slice(0, 3)).toEqual(turns.slice(3));
  expect((await routerView(env, f.actor, f.profile)).pools[0].strategy).toBe(
    "round_robin",
  );
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=1000 WHERE connection_id=?",
    f.numbers[0].id,
  );
  const available = new Set(
    f.numbers.slice(1).map((n) => `https://wa.me/${json(n.config).number}`),
  );
  const after = [];
  for (let i = 0; i < 4; i++)
    after.push((await routerLink(env, f.profile, pool.public_token)).url);
  expect(new Set(after)).toEqual(available);
  expect(after[0]).not.toBe(after[1]);
  expect(after.slice(0, 2)).toEqual(after.slice(2));
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=1000 WHERE account_id=?",
    f.account,
  );
  const paidTurns = [];
  for (let i = 0; i < 3; i++)
    paidTurns.push((await routerLink(env, f.profile, pool.public_token)).url);
  expect(new Set(paidTurns).size).toBe(3);
});
it("serializa entradas públicas concorrentes sem concentrar o rodízio em um número", async () => {
  const f = await fixture(3),
    pool = await one(
      env,
      "SELECT public_token FROM number_pools WHERE id=?",
      f.pool.id,
    );
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      SELF.fetch(`https://test/api/public/whatsapp/${pool.public_token}`, {
        redirect: "manual",
      }),
    ),
  );
  const counts = new Map<string, number>();
  for (const response of responses) {
    expect(response.status).toBe(302);
    const url = response.headers.get("Location")!;
    counts.set(url, (counts.get(url) || 0) + 1);
  }
  expect([...counts.values()]).toEqual([4, 4, 4]);
});
it("entrega serviço excedente sem autorizar templates e mantém a janela de 24h", async () => {
  const f = await fixture(1, 1000);
  const c = await customer(f);
  await setPolicy(f, 0, {
    ...numberPolicyPresets.service_only,
    service_overage: true,
  });
  await exec(env, "UPDATE number_pools SET allow_paid=0 WHERE id=?", f.pool.id);
  await exec(
    env,
    "UPDATE number_router_grants SET allow_paid=0 WHERE app_id=?",
    f.appId,
  );
  const actor = {
    ...f.actor,
    scopes: f.actor.scopes.filter((scope) => scope !== "routing:paid"),
  };
  const mock = metaMock();
  const result = await routerCommand(
    env,
    actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  expect(result.number_id).toBe(f.numbers[0].id);
  expect(result.billing.mode).toBe("service_paid");
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent).toHaveLength(1);
  expect(mock.sent[0]).toMatchObject({
    type: "text",
    text: { body: "Resposta de atendimento" },
  });
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", result.delivery_id))
      .status,
  ).toBe("sent");
  const pending = await routerCommand(
    env,
    actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  await exec(
    env,
    "UPDATE conversations SET last_customer=? WHERE id=?",
    now() - 25 * 3600000,
    c.id,
  );
  await expect(
    routerCommand(env, actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toThrow("24 horas");
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", pending.delivery_id),
  );
  expect(mock.sent).toHaveLength(1);
  expect(
    await one(
      env,
      "SELECT status,error FROM outbox WHERE id=?",
      pending.delivery_id,
    ),
  ).toMatchObject({ status: "failed" });
});
it("respostas já vinculadas não alteram a vez dos próximos atendimentos", async () => {
  const f = await fixture();
  await customer(f, 0);
  const initial = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  const before = await all(
    env,
    "SELECT connection_id,last_selected FROM number_pool_members WHERE pool_id=? ORDER BY connection_id",
    f.pool.id,
  );
  for (let i = 0; i < 3; i++)
    expect(
      (
        await routerCommand(
          env,
          f.actor,
          f.profile,
          "router.send",
          service(f),
          uid(),
        )
      ).number_id,
    ).toBe(initial.number_id);
  expect(
    await all(
      env,
      "SELECT connection_id,last_selected FROM number_pool_members WHERE pool_id=? ORDER BY connection_id",
      f.pool.id,
    ),
  ).toEqual(before);
});
it("webhook compartilhado valida assinatura e WABA, separa números e deduplica entradas", async () => {
  const f = await fixture(20);
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: f.waba,
        changes: f.numbers.map((n: any, i: number) => ({
          value: {
            metadata: { phone_number_id: json(n.config).phone_id },
            messages: [
              {
                id: "shared-" + i,
                from: "5511999994444",
                timestamp: String(Math.floor(now() / 1000)),
                type: "text",
                text: { body: "Olá " + i },
              },
            ],
          },
        })),
      },
      {
        id: "other-waba",
        changes: [
          {
            value: {
              metadata: { phone_number_id: json(f.numbers[0].config).phone_id },
              messages: [
                {
                  id: "wrong-account",
                  from: "5511999994444",
                  type: "text",
                  text: { body: "Não aceitar" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(body),
    url = "https://test/webhooks/meta-accounts/" + f.account;
  expect(
    (
      await SELF.fetch(url, {
        method: "POST",
        body: raw,
        headers: { "X-Hub-Signature-256": "invalid" },
      })
    ).status,
  ).toBe(403);
  for (let i = 0; i < 2; i++)
    expect(
      (
        await SELF.fetch(url, {
          method: "POST",
          body: raw,
          headers: {
            "X-Hub-Signature-256":
              "sha256=" + (await hmac("fake-app-secret", raw)),
          },
        })
      ).status,
    ).toBe(200);
  const convs = await all(
    env,
    "SELECT * FROM conversations WHERE profile_id=?",
    f.profile,
  );
  expect(convs).toHaveLength(20);
  expect(
    (
      await one(
        env,
        "SELECT count(*) n FROM messages WHERE profile_id=?",
        f.profile,
      )
    ).n,
  ).toBe(20);
  expect(
    (
      await SELF.fetch(
        url +
          "?hub.mode=subscribe&hub.verify_token=fake-verify-token&hub.challenge=123",
      )
    ).status,
  ).toBe(200);
  expect(await metaCredentials(env, f.numbers[0])).toMatchObject({
    token: "fake-account-token",
  });
});
it("API exige idempotência, repete o recibo e recusa conteúdo diferente com a mesma chave", async () => {
  const f = await fixture();
  await customer(f, 0);
  const url = `https://test/api/v1/profiles/${f.profile}/router/messages`,
    headers = {
      Authorization: "Bearer " + f.token,
      "Content-Type": "application/json",
      "Idempotency-Key": uid(),
    };
  const first = await SELF.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(service(f)),
  });
  expect(first.status).toBe(202);
  const saved = await first.json<any>();
  const second = await SELF.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(service(f)),
  });
  expect(second.headers.get("Idempotency-Replayed")).toBe("true");
  expect((await second.json<any>()).delivery_id).toBe(saved.delivery_id);
  expect(
    (
      await SELF.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(service(f, { text: "Outra mensagem" })),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await SELF.fetch(url, {
        method: "POST",
        headers: { Authorization: headers.Authorization },
        body: JSON.stringify(service(f)),
      })
    ).status,
  ).toBe(400);
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1);
});
it("modelo pago exige autorização por pedido, escopo, origem e consentimento da categoria", async () => {
  const f = await fixture();
  const mock = metaMock();
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      paid(f, { allow_paid: false }),
      uid(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    routerCommand(
      env,
      {
        ...f.actor,
        scopes: f.actor.scopes.filter((s) => s !== "routing:paid"),
      },
      f.profile,
      "router.send",
      paid(f),
      uid(),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      paid(f, {
        consent: { granted: true, category: "marketing", reference: "Prova" },
      }),
      uid(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await exec(env, "UPDATE number_pools SET allow_paid=0 WHERE id=?", f.pool.id);
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", paid(f), uid()),
  ).rejects.toMatchObject({ code: "paid_disabled" });
  expect(mock.sent).toHaveLength(0);
});
it("envia modelo aprovado ao telefone real sem abrir janela artificial e isola a conversa da aplicação", async () => {
  const f = await fixture(1, 1000),
    mock = metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  let c = await conversation(env, result.conversation_id, f.profile, f.actor);
  expect(c.last_customer).toBe(0);
  expect(c.external_id).toBe("pedido-pago");
  expect(c.recipient_id).toBe("5511999992222");
  expect(visibleConversation({ ...f.actor, id: "app:other" }, c)).toBe(false);
  await expect(
    inbound(
      env,
      f.profile,
      { external_id: "pedido-pago", message_id: "spoof", text: "Falso" },
      "app:" + f.actor.id,
      null,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent).toHaveLength(1);
  expect(mock.sent[0]).toMatchObject({
    to: "5511999992222",
    type: "template",
    template: { name: "pedido_atualizado" },
  });
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1000);
  const response = await inbound(
    env,
    f.profile,
    {
      external_id: "5511999992222",
      message_id: "reply-real",
      text: "Obrigado",
      customer_at: now(),
    },
    "channel:" + f.numbers[0].id,
    f.numbers[0].id,
  );
  expect(response.conversation_id).toBe(c.id);
  c = await conversation(env, c.id, f.profile);
  expect(c.last_customer).toBeGreaterThan(0);
  expect(
    (
      await one(
        env,
        "SELECT count(*) n FROM conversations WHERE profile_id=?",
        f.profile,
      )
    ).n,
  ).toBe(1);
});
it("modelo com mídia usa arquivo privado autorizado e envia somente o ID Meta", async () => {
  const f = await fixture(1),
    mock = metaMock([
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Pedido {{1}} atualizado." },
    ]),
    media = uid();
  await env.MEDIA.put(f.profile + "/" + media, "fake-image");
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    media,
    f.profile,
    "foto.jpg",
    "image/jpeg",
    10,
    f.profile + "/" + media,
    f.actor.id,
    now(),
  );
  const body = paid(f);
  body.template.components.unshift({
    type: "header",
    parameters: [{ type: "image", media_id: media }],
  } as any);
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    body,
    uid(),
  );
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent[0].template.components[0]).toEqual({
    type: "header",
    parameters: [{ type: "image", image: { id: "provider-media" } }],
  });
  expect(JSON.stringify(mock.sent)).not.toContain("wabotia_media_id");
});
it("revogar origem antes da entrega cancela o envio e libera a reserva", async () => {
  const f = await fixture(1);
  await customer(f);
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  const mock = metaMock();
  await exec(env, "DELETE FROM number_router_grants WHERE app_id=?", f.appId);
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", result.delivery_id))
      .status,
  ).toBe("cancelled");
  expect(mock.sent).toHaveLength(0);
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(0);
});
it("cadastra e roteia mais de 20 números, mantendo confirmação e validação da conta", async () => {
  const f = await fixture(20);
  const phone = f.waba + "999";
  await exec(
    env,
    "UPDATE meta_accounts SET discovered=?,discovered_at=? WHERE id=?",
    JSON.stringify([
      { phone_id: phone, number: "5511999988888", name: "Extra" },
    ]),
    now(),
    f.account,
  );
  await expect(
    accountCommand(env, admin, f.profile, "meta-number.save", {
      account_id: f.account,
      phone_id: phone,
      baseline_used: 0,
    }),
  ).rejects.toThrow(/contador inicial/);
  const added = await accountCommand(
    env,
    admin,
    f.profile,
    "meta-number.save",
    {
      account_id: f.account,
      phone_id: phone,
      baseline_used: 0,
      baseline_confirmed: true,
    },
  );
  expect(added.status).toBe("paused");
  expect(
    (
      await one(
        env,
        "SELECT count(*) n FROM meta_numbers WHERE account_id=?",
        f.account,
      )
    ).n,
  ).toBe(21);
  await expect(
    accountCommand(env, admin, f.profile, "meta-number.save", {
      account_id: f.account,
      phone_id: phone,
      baseline_used: 0,
      baseline_confirmed: true,
    }),
  ).rejects.toThrow(/já está no roteador/);
  const members = [...f.numbers.map((n) => n.id), added.id];
  const savePool = (selected: string[]) =>
    routerCommand(
      env,
      admin,
      f.profile,
      "router.pool.save",
      {
        id: f.pool.id,
        account_id: f.account,
        name: "Todas as filiais",
        enabled: true,
        public_enabled: true,
        members: selected,
      },
      uid(),
    );
  await savePool(members);
  await exec(
    env,
    "UPDATE connections SET status='active' WHERE id=?",
    added.id,
  );
  expect(await selectPoolNumbers(env, f.profile, f.pool.id)).toHaveLength(21);
  const view = await routerView(env, admin, f.profile);
  expect(view.numbers).toHaveLength(21);
  expect(view.pools.find((p: any) => p.id === f.pool.id).members).toEqual(
    expect.arrayContaining(members),
  );
  await expect(savePool([...members, members[0]])).rejects.toThrow(
    /sem repetições/,
  );
  const other = await fixture(1);
  await expect(savePool([...members, other.numbers[0].id])).rejects.toThrow(
    /mesma conta Meta/,
  );
  expect(
    (await selectPoolNumbers(env, f.profile, f.pool.id)).map((n) => n.id),
  ).toEqual(expect.arrayContaining(members));
});
it("consulta e cancela somente envios autorizados ainda na fila, liberando a reserva", async () => {
  const f = await fixture(1);
  await customer(f);
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  const row = await one(
    env,
    "SELECT * FROM outbox WHERE id=?",
    result.delivery_id,
  );
  expect(await routedMessage(env, f.actor, f.profile, row.id)).toMatchObject({
    status: "pending",
    number_id: f.numbers[0].id,
    billable: null,
  });
  await expect(
    routedMessage(env, { ...f.actor, id: "app:other" }, f.profile, row.id),
  ).rejects.toMatchObject({ status: 404 });
  await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.cancel",
    { id: row.id },
    uid(),
  );
  expect((await numberUsage(env, f.numbers[0].id))!.reserved).toBe(0);
  const mock = metaMock();
  await deliver(env, row);
  expect(mock.sent).toHaveLength(0);
  const next = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  await exec(
    env,
    "UPDATE outbox SET status='sending' WHERE id=?",
    next.delivery_id,
  );
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.cancel",
      { id: next.delivery_id },
      uid(),
    ),
  ).rejects.toThrow(/fila/);
});
it("não transforma notificações automáticas em modelos pagos fora da janela", async () => {
  const f = await fixture(1),
    c = await customer(f, 0, "5511999991111", now() - 25 * 3600000),
    mock = metaMock();
  const id = await enqueue(
    env,
    c,
    admin.id,
    "notification",
    { text: "Protocolo atualizado" },
    uid(),
  );
  await deliver(env, await one(env, "SELECT * FROM outbox WHERE id=?", id));
  expect(
    await one(env, "SELECT status,error FROM outbox WHERE id=?", id),
  ).toMatchObject({
    status: "failed",
    error: expect.stringContaining("autorização explícita"),
  });
  expect(mock.fetch).not.toHaveBeenCalled();
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(0);
});
it("consentimento revogado impede modelo e uma declaração não substitui a revogação", async () => {
  const f = await fixture(1),
    mock = metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  await exec(
    env,
    "INSERT INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES(?,?,?,'revoked','Cliente retirou autorização',?)",
    uid(),
    f.profile,
    result.conversation_id,
    now(),
  );
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", result.delivery_id))
      .status,
  ).toBe("failed");
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", paid(f), uid()),
  ).rejects.toMatchObject({ code: "consent_revoked" });
  expect(mock.sent).toHaveLength(0);
});
it("confere a revogação novamente depois de preparar uma mídia paga", async () => {
  const f = await fixture(1),
    mock = metaMock([{ type: "HEADER", format: "IMAGE" }]),
    media = uid();
  await env.MEDIA.put(f.profile + "/" + media, "fake-image");
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    media,
    f.profile,
    "foto.jpg",
    "image/jpeg",
    10,
    f.profile + "/" + media,
    f.actor.id,
    now(),
  );
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f, {
      template: {
        name: "pedido_atualizado",
        language: "pt_BR",
        components: [
          { type: "header", parameters: [{ type: "image", media_id: media }] },
        ],
      },
    }),
    uid(),
  );
  const original = mock.fetch.getMockImplementation()!;
  mock.fetch.mockImplementation(async (input: any, init: any) => {
    const response = await original(input, init);
    if (String(input).endsWith("/media"))
      await exec(
        env,
        "INSERT INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES(?,?,?,'revoked','Retirado durante upload',?)",
        uid(),
        f.profile,
        result.conversation_id,
        now(),
      );
    return response;
  });
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent).toHaveLength(0);
});
it("nova tentativa de modelo exige nova autorização explícita e registra o administrador", async () => {
  const f = await fixture(1);
  metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  await exec(
    env,
    "UPDATE outbox SET status='unknown' WHERE id=?",
    result.delivery_id,
  );
  await expect(
    perform(
      env,
      admin,
      f.profile,
      "delivery.reconcile",
      { id: result.delivery_id, status: "pending" },
      uid(),
    ),
  ).rejects.toThrow(/autorização explícita/);
  const retry = await perform(
    env,
    admin,
    f.profile,
    "delivery.reconcile",
    { id: result.delivery_id, status: "pending", allow_paid: true },
    uid(),
  );
  const saved = await one(env, "SELECT * FROM outbox WHERE id=?", retry.id);
  expect(json(saved.payload).retry_authorization.actor).toBe(admin.id);
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", result.delivery_id))
      .status,
  ).toBe("cancelled");
});
it("escopo pago não substitui permissão paga da origem e números pausados nunca entram no sorteio", async () => {
  const f = await fixture(3),
    mock = metaMock();
  await exec(
    env,
    "UPDATE number_router_grants SET allow_paid=0 WHERE app_id=?",
    f.appId,
  );
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", paid(f), uid()),
  ).rejects.toMatchObject({ code: "source_not_allowed" });
  await exec(
    env,
    "UPDATE number_pools SET strategy='random' WHERE id=?",
    f.pool.id,
  );
  await exec(
    env,
    "UPDATE connections SET status='paused' WHERE id=?",
    f.numbers[0].id,
  );
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=1000 WHERE connection_id=?",
    f.numbers[1].id,
  );
  expect(
    (await selectPoolNumbers(env, f.profile, f.pool.id)).map((n) => n.id),
  ).toEqual([f.numbers[2].id, f.numbers[1].id]);
  expect(mock.sent).toHaveLength(0);
});
it("descobre todas as páginas da WABA sem teto local de números", async () => {
  const f = await fixture(1);
  const mock = vi.fn(async (input: any) => {
    const url = new URL(String(input));
    expect(url.pathname).toContain(`/${f.waba}/phone_numbers`);
    const page = Number(url.searchParams.get("after") || 0);
    return Response.json({
      data: Array.from({ length: page === 5 ? 1 : 100 }, (_, index) => ({
        id: String(900000 + page * 100 + index),
        display_phone_number:
          "5511999" + String(page * 100 + index).padStart(6, "0"),
        verified_name: `Filial ${page * 100 + index + 1}`,
      })),
      ...(page < 5
        ? {
            paging: {
              next: "https://graph.facebook.com/next",
              cursors: { after: String(page + 1) },
            },
          }
        : {}),
    });
  });
  vi.stubGlobal("fetch", mock);
  const result = await accountCommand(
    env,
    admin,
    f.profile,
    "meta-account.discover",
    { id: f.account },
  );
  expect(result.data).toHaveLength(501);
  expect(mock).toHaveBeenCalledTimes(6);
  expect(
    json(
      (
        await one(
          env,
          "SELECT discovered FROM meta_accounts WHERE id=?",
          f.account,
        )
      ).discovered,
      [],
    ),
  ).toHaveLength(501);
});
it("recusa ciclos na paginação Meta sem salvar uma descoberta parcial", async () => {
  const f = await fixture(1);
  const mock = vi.fn(async (input: any) => {
    const cursor = new URL(String(input)).searchParams.get("after");
    return Response.json({
      data: [{ id: "99887766", display_phone_number: "+55 11 99999-3333" }],
      paging: {
        next: "https://graph.facebook.com/next",
        cursors: { after: cursor === "first" ? "second" : "first" },
      },
    });
  });
  vi.stubGlobal("fetch", mock);
  await expect(
    accountCommand(env, admin, f.profile, "meta-account.discover", {
      id: f.account,
    }),
  ).rejects.toThrow(/Paginação Meta inválida/);
  expect(mock).toHaveBeenCalledTimes(3);
  expect(
    (
      await one(
        env,
        "SELECT discovered_at FROM meta_accounts WHERE id=?",
        f.account,
      )
    ).discovered_at,
  ).toBe(0);
});
it("descobre na WABA e adiciona número pausado com histórico, sem expor as credenciais", async () => {
  const f = await fixture(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      expect(String(input)).toContain(`/${f.waba}/phone_numbers?`);
      return Response.json({
        data: [
          {
            id: "99887766",
            display_phone_number: "+55 11 99999-3333",
            verified_name: "Loja",
          },
        ],
      });
    }),
  );
  await accountCommand(env, admin, f.profile, "meta-account.discover", {
    id: f.account,
  });
  const result = await accountCommand(
    env,
    admin,
    f.profile,
    "meta-number.save",
    {
      account_id: f.account,
      phone_id: "99887766",
      baseline_used: 345,
      baseline_confirmed: true,
    },
  );
  expect(result).toMatchObject({
    status: "paused",
    usage: { used: 345, remaining: 655 },
  });
  const view = await routerView(env, admin, f.profile);
  expect(view.numbers.find((n: any) => n.id === result.id).number).toBe(
    "5511999993333",
  );
  expect(JSON.stringify(view)).not.toContain("fake-account-token");
});
