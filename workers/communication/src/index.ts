import { capabilities } from "./whatsapp";
import { WorkerEntrypoint } from 'cloudflare:workers';
import {sendQueueNotice,queueNoticeStatus} from './queue-notices';
import { actorFromGrant, syncGrant, managedRequest, managed, configured,attachAliases,actorIds,canonicalActor } from './managed';
import { authorizedMedia, mediaResponse, uploadPart } from "./media";
import { callView, callPermission } from "./calls";
import { metaInbound } from "./meta-inbound";
import { metaCredentials } from "./meta-accounts";
import { routerView, routedMessage } from "./number-router";
import { listLines, listMenus } from "./line-service";
import { teamDirectory, listInternalChats, internalChatDetail } from "./team";
import { MAX_DEVICES_PER_USER } from "./mobile-limits";
import { report } from "./reports";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { visibleEvent, visibleConversation } from "./visibility";
import { setCookie, deleteCookie } from "hono/cookie";
import {
  type Bindings,
  type Env,
  type Actor,
  ApiError,
  uid,
  now,
  json,
  requireValue,
} from "./types";
import { all, one, exec, batch } from "./db";
import {
  authenticate,
  access,
  admin,
  canProfile,
  sha,
  random,
  passwordHash,
  passwordMatches,
  rate,
  secret,
  setSecret,
  equal,
  hmac,
  hex,
  MOBILE_TOKEN_PREFIX,
} from "./security";
import { pushConfig, publicPushConfig, sendTest, prunePush } from "./push";
import { wake } from "./events";
import { settings, scopes, eventTypes, conversation, perform } from "./service";
import {
  discover,
  probe,
  configureTelegram,
  telegramFile,
  storeRemoteMedia,
  telegram,
} from "./integrations";
import { openapi } from "./openapi";
import { buildInfo } from "./build-info.generated";
import {
  listContacts,
  contactDetail,
  conversationContact,
  contactNamespace,
  previewContactCsv,
} from "./contacts";
import { checkUpdate, updatePlan, updateStatus } from "./updates";
import {
  pairingStart,
  pairingToken,
  pairingList,
  pairingLookup,
  pairingApprove,
  pairingDeny,
  pairingRevoke,
  pairingDisconnect,
  prunePairings,
} from "./pairing";
import {
  cloudflareJobs,
  cloudflareSettings,
  connectorDownload,
} from "./cloudflare";
export { Coordinator } from "./coordinator";
export const app = new Hono<Bindings>();
app.use('*',async(c,next)=>{
  if(managed(c.env) && !c.env.FAGOO_ACTOR && !c.req.path.startsWith('/api/v1/') && !/^\/(?:webhooks\/(?:meta|meta-accounts|telegram)\/[^/]+|internal\/v1\/connectors\/[^/]+\/.*|api\/public\/whatsapp\/[^/]+|api\/health)$/.test(c.req.path)) return c.json({error:{code:'fagoo_login_required',message:'Use o Fagoo.'}},403);
  if(managed(c.env) && /^\/api\/(?:auth|pairing|system)(?:\/|$)|^\/api\/v1\/(?:auth|users|profiles$|pairings|system|logout)(?:\/|$)/.test(c.req.path)) return c.json({error:{code:'managed_by_fagoo',message:'Gerenciado pelo Fagoo.'}},403);
  await next();
});
app.use("*", async (c, next) => {
  if (/^\/internal\/v1\/connectors\/[^/]+\/media-content$/.test(c.req.path))
    return next();
  return bodyLimit({
    maxSize: 21 * 1024 * 1024,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "payload_too_large",
            message: "Limite de 20 MB por arquivo.",
          },
        },
        413,
      ),
  })(c, next);
});
app.use("*", async (c, next) => {
  c.set("requestId", uid());
  await next();
  c.header("X-Request-Id", c.get("requestId"));
  if (c.res.status === 429) c.header("Retry-After", "60");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});
app.onError((error, c) => {
  const known = error instanceof ApiError;
  if (known && error.status === 429) c.header("Retry-After", "60");
  if (!known)
    console.error(
      JSON.stringify({
        request_id: c.get("requestId"),
        error: error instanceof SyntaxError ? "invalid_json" : "internal_error",
      }),
    );
  return c.json(
    {
      error: {
        code: known ? error.code : "internal_error",
        message: known
          ? error.message
          : "Não foi possível concluir a operação.",
        request_id: c.get("requestId"),
      },
    },
    (known ? error.status : 500) as any,
  );
});
app.get("/api/health", (c) =>
  c.json({
    service: "wabotia",
    ...buildInfo,
    runtime: "cloudflare-workers",
  }),
);
app.get("/api/system/update-plan", async (c) =>
  c.json(await updatePlan(c.env)),
);
app.get("/api/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin)));
app.use("/api/pairing/*", bodyLimit({ maxSize: 4096 }));
app.post("/api/pairing/start", async (c) =>
  c.json(
    await pairingStart(
      c.env,
      await c.req.json(),
      new URL(c.req.url).origin,
      c.req.header("CF-Connecting-IP") || "local",
    ),
    201,
  ),
);
app.post("/api/pairing/token", async (c) =>
  c.json(
    await pairingToken(
      c.env,
      await c.req.json(),
      c.req.header("CF-Connecting-IP") || "local",
    ),
  ),
);
app.get("/api/auth/status", async (c) => {
  const count = await one(c.env, "SELECT count(*) n FROM users");
  return c.json({
    initialized: count.n > 0,
    configured: !!c.env.MASTER_KEY && !!c.env.SETUP_TOKEN,
  });
});
app.use("/api/auth/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (c.req.method === "POST" && origin && origin !== new URL(c.req.url).origin)
    throw new ApiError(403, "invalid_origin", "Origem inválida.");
  await next();
});
app.post("/api/auth/setup", async (c) => {
  await rate(
    c.env,
    `setup:${c.req.header("CF-Connecting-IP") || "local"}`,
    5,
    600000,
  );
  requireValue(
    c.env.SETUP_TOKEN && c.env.MASTER_KEY,
    "Configure SETUP_TOKEN e MASTER_KEY antes de continuar.",
  );
  const data = await c.req.json();
  if (!equal(data.token || "", c.env.SETUP_TOKEN))
    throw new ApiError(
      403,
      "invalid_setup_token",
      "Código de instalação inválido.",
    );
  if ((await one(c.env, "SELECT count(*) n FROM users")).n)
    throw new ApiError(
      409,
      "already_initialized",
      "Instalação já configurada.",
    );
  requireValue(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || ""),
    "E-mail inválido.",
  );
  const id = uid();
  await batch(c.env, [
    [
      "INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,?,?)",
      ["installation", "bootstrap", "bootstrap", "{}", 200, now()],
    ],
    [
      "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      [
        id,
        String(data.email || "")
          .trim()
          .toLowerCase(),
        String(data.name || "Administrador").slice(0, 100),
        passwordHash(data.password),
        "admin",
        "[]",
        now(),
      ],
    ],
  ]);
  return c.json({ created: true }, 201);
});
app.post("/api/auth/login", async (c) => {
  await rate(
    c.env,
    `login:${c.req.header("CF-Connecting-IP") || "local"}`,
    10,
    600000,
  );
  const data = await c.req.json();
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE email=? AND disabled=0",
    String(data.email || "").toLowerCase(),
  );
  if (!passwordMatches(String(data.password || ""), user?.password))
    throw new ApiError(
      401,
      "invalid_credentials",
      "E-mail ou senha inválidos.",
    );
  const token = random();
  await exec(
    c.env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created) VALUES(?,?,?,'cookie',?)",
    await sha(token),
    user.id,
    now() + 43200000,
    now(),
  );
  setCookie(c, "wabotia", token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: 43200,
  });
  return c.json({ ok: true });
});
const MOBILE_SESSION_MS = 30 * 86400000;
const mobilePlatforms = ["android", "ios"];
function mobileLabel(device: any) {
  return [device?.name, device?.app_version]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 200);
}
async function createMobileSession(env: Env, userId: string, label: string) {
  const token = MOBILE_TOKEN_PREFIX + random(),
    expires = now() + MOBILE_SESSION_MS;
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created,label,last_used) VALUES(?,?,?,'bearer',?,?,?)",
    await sha(token),
    userId,
    expires,
    now(),
    label || null,
    now(),
  );
  return { token, expires };
}
const mobileUser = (user: any) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  profiles: json(user.profiles, []),
});
app.post("/api/auth/mobile/login", async (c) => {
  await rate(
    c.env,
    `login:${c.req.header("CF-Connecting-IP") || "local"}`,
    10,
    600000,
  );
  const data = await c.req.json();
  requireValue(
    data.device &&
      typeof data.device === "object" &&
      mobilePlatforms.includes(data.device.platform),
    "Informe device.platform como android ou ios.",
  );
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE email=? AND disabled=0",
    String(data.email || "")
      .trim()
      .toLowerCase(),
  );
  if (!passwordMatches(String(data.password || ""), user?.password))
    throw new ApiError(
      401,
      "invalid_credentials",
      "E-mail ou senha inválidos.",
    );
  const session = await createMobileSession(
    c.env,
    user.id,
    mobileLabel(data.device),
  );
  return c.json({ ...session, user: mobileUser(user) });
});
app.use("/api/v1/*", async (c, next) => {
  c.set("actor", await authenticate(c.env, c.req.raw));
  const response=await managedRequest(c.env,c.get('actor'),c.req.raw);
  if(response) return response;
  await next();
});
const mobileToken = (c: any) => {
  const bearer = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  return bearer && bearer.startsWith(MOBILE_TOKEN_PREFIX) ? bearer : null;
};
app.get("/api/v1/me", (c) => c.json(c.get("actor")));
app.get("/api/v1/pairings", async (c) =>
  c.json(await pairingList(c.env, c.get("actor"))),
);
app.post("/api/v1/pairings/disconnect", async (c) =>
  c.json(await pairingDisconnect(c.env, c.get("actor"))),
);
app.post("/api/v1/pairings/lookup", async (c) =>
  c.json(
    await pairingLookup(c.env, c.get("actor"), (await c.req.json()).user_code),
  ),
);
app.post("/api/v1/pairings/:id/approve", async (c) =>
  c.json(
    await pairingApprove(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      await c.req.json(),
    ),
  ),
);
app.post("/api/v1/pairings/:id/deny", async (c) =>
  c.json(await pairingDeny(c.env, c.get("actor"), c.req.param("id"))),
);
app.delete("/api/v1/pairings/:id", async (c) =>
  c.json(await pairingRevoke(c.env, c.get("actor"), c.req.param("id"))),
);
app.post("/api/v1/auth/mobile/refresh", async (c) => {
  const token = mobileToken(c);
  if (!token || c.get("actor").kind !== "user")
    throw new ApiError(
      400,
      "invalid_request",
      "A renovação exige uma sessão móvel (Bearer wabu_).",
    );
  const hash = await sha(token);
  const old = await one(
    c.env,
    "SELECT label FROM sessions WHERE hash=? AND kind='bearer'",
    hash,
  );
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE id=?",
    c.get("actor").id,
  );
  const session = await createMobileSession(
    c.env,
    c.get("actor").id,
    old?.label || "",
  );
  await exec(c.env, "DELETE FROM sessions WHERE hash=?", hash);
  return c.json({ ...session, user: mobileUser(user) });
});
app.post("/api/v1/logout", async (c) => {
  const cookie = c.req.header("Cookie")?.match(/wabotia=([^;]+)/)?.[1];
  if (cookie)
    await exec(c.env, "DELETE FROM sessions WHERE hash=?", await sha(cookie));
  const bearer = mobileToken(c);
  if (bearer)
    await exec(c.env, "DELETE FROM sessions WHERE hash=?", await sha(bearer));
  deleteCookie(c, "wabotia", { path: "/" });
  return c.json({ ok: true });
});
function requireUser(actor: Actor) {
  if (actor.kind !== "user")
    throw new ApiError(
      403,
      "user_required",
      "Dispositivos pertencem a contas de atendente.",
    );
}
const deviceView = (d: any) => ({ ...d, profiles: json(d.profiles, []) });
app.get("/api/v1/devices", async (c) => {
  const actor = c.get("actor");
  requireUser(actor);
  return c.json({
    data: (
      await all(
        c.env,
        "SELECT * FROM devices WHERE user_id=? ORDER BY created",
        actor.id,
      )
    ).map(deviceView),
  });
});
app.put("/api/v1/devices/:id", async (c) => {
  const actor = c.get("actor"),
    id = c.req.param("id");
  requireUser(actor);
  requireValue(
    /^[A-Za-z0-9_-]{8,100}$/.test(id),
    "Identificador do dispositivo inválido.",
  );
  const data = await c.req.json();
  requireValue(
    mobilePlatforms.includes(data.platform),
    "Informe platform como android ou ios.",
  );
  const provider = data.provider ?? "fcm";
  requireValue(provider === "fcm", "Provedor de push não suportado.");
  requireValue(
    typeof data.token === "string" &&
      data.token.trim().length > 0 &&
      data.token.length <= 4096,
    "Informe o token do provedor (até 4096 caracteres).",
  );
  const profiles = actor.fagoo ? actor.profiles : data.profiles ?? [];
  requireValue(
    Array.isArray(profiles) &&
      profiles.length <= 50 &&
      profiles.every(
        (p: any) => typeof p === "string" && p.length > 0 && p.length <= 100,
      ),
    "profiles deve ser uma lista de até 50 identificadores.",
  );
  const token = data.token.trim(),
    origin = new URL(c.req.url).origin;
  await rate(c.env, `devices:${actor.id}`, 30);
  // Taking over another person's device id needs proof of possession: the
  // same provider token (another person signing in on the same handset).
  const existing = await one(
    c.env,
    "SELECT user_id,provider,token FROM devices WHERE id=?",
    id,
  );
  if (
    existing &&
    existing.user_id !== actor.id &&
    !(existing.provider === provider && existing.token === token)
  )
    throw new ApiError(
      409,
      "device_conflict",
      "Este identificador de dispositivo pertence a outra pessoa.",
    );
  await batch(c.env, [
    [
      "DELETE FROM devices WHERE provider=? AND token=? AND id!=?",
      [provider, token, id],
    ],
    [
      "INSERT INTO devices(id,user_id,platform,provider,token,name,app_version,profiles,origin,enabled,last_error,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,platform=excluded.platform,provider=excluded.provider,token=excluded.token,name=excluded.name,app_version=excluded.app_version,profiles=excluded.profiles,origin=excluded.origin,enabled=excluded.enabled,last_error=NULL,updated=excluded.updated",
      [
        id,
        actor.id,
        data.platform,
        provider,
        token,
        String(data.name || "").slice(0, 100),
        String(data.app_version || "").slice(0, 50),
        JSON.stringify(profiles),
        origin,
        data.enabled === undefined || data.enabled ? 1 : 0,
        now(),
        now(),
      ],
    ],
    // At most MAX_DEVICES_PER_USER rows per person: the oldest are dropped.
    [
      "DELETE FROM devices WHERE user_id=? AND id NOT IN (SELECT id FROM devices WHERE user_id=? ORDER BY updated DESC,created DESC,id DESC LIMIT ?)",
      [actor.id, actor.id, MAX_DEVICES_PER_USER],
    ],
  ]);
  return c.json(
    deviceView(await one(c.env, "SELECT * FROM devices WHERE id=?", id)),
  );
});
app.delete("/api/v1/devices/:id", async (c) => {
  const actor = c.get("actor");
  requireUser(actor);
  const result = await exec(
    c.env,
    "DELETE FROM devices WHERE id=? AND user_id=?",
    c.req.param("id"),
    actor.id,
  );
  return c.json({ deleted: (result.meta?.changes || 0) > 0 });
});
app.post("/api/v1/devices/:id/test", async (c) => {
  const actor = c.get("actor");
  requireUser(actor);
  await rate(c.env, `push-test:${actor.id}`, 5);
  const device = await one(
    c.env,
    "SELECT * FROM devices WHERE id=? AND user_id=?",
    c.req.param("id"),
    actor.id,
  );
  if (!device)
    throw new ApiError(404, "not_found", "Dispositivo não encontrado.");
  return c.json({ results: await sendTest(c.env, [device], new URL(c.req.url).origin) });
});
app.get("/api/v1/profiles", async (c) =>
  c.json(
    (await all(c.env, "SELECT * FROM profiles ORDER BY created"))
      .filter((p) => canProfile(c.get("actor"), p.id))
      .map((p) =>
        c.get("actor").kind === "app"
          ? { id: p.id, name: p.name, enabled: p.enabled }
          : { ...p, settings: json(p.settings) },
      ),
  ),
);
app.get("/api/v1/users", async (c) => {
  admin(c.get("actor"));
  return c.json(
    await all(
      c.env,
      "SELECT id,email,name,role,profiles,telegram_id,disabled FROM users ORDER BY created",
    ),
  );
});
app.get("/api/v1/applications", async (c) => {
  admin(c.get("actor"));
  return c.json({
    applications: await all(
      c.env,
      "SELECT * FROM applications WHERE ?=0 OR EXISTS(SELECT 1 FROM json_each(profiles) WHERE value=?) ORDER BY created DESC",
      c.get("actor").fagoo?1:0,c.get("actor").profiles[0] || "",
    ),
    keys: await all(
      c.env,
      "SELECT id,app_id,prefix,expires,revoked,created FROM api_keys WHERE ?=0 OR app_id IN(SELECT id FROM applications WHERE EXISTS(SELECT 1 FROM json_each(profiles) WHERE value=?))",
      c.get("actor").fagoo?1:0,c.get("actor").profiles[0] || "",
    ),
    scopes,
    event_types: eventTypes,
  });
});
async function mutate(c: any, op: string, profile: string, data: any) {
  const key = c.req.header("Idempotency-Key");
  requireValue(
    key && key.length <= 200 && /^[\x21-\x7e]+$/.test(key),
    "Envie Idempotency-Key (até 200 caracteres ASCII).",
  );
  if (profile !== "_admin" && !canProfile(c.get("actor"), profile))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  return c.env.COORDINATOR.get(c.env.COORDINATOR.idFromName(profile)).fetch(
    "https://coordinator/command",
    {
      method: "POST",
      body: JSON.stringify({
        profile,
        operation: op,
        actor: c.get("actor"),
        data,
        key,
        requestId: c.get("requestId"),
      }),
    },
  );
}
app.get("/api/v1/system", async (c) => {
  admin(c.get("actor"));
  return c.json({
    updates: await updateStatus(c.env),
    cloudflare: await cloudflareSettings(c.env),
    deployments: await cloudflareJobs(c.env),
  });
});
app.get("/api/v1/system/updates/check", async (c) => {
  admin(c.get("actor"));
  await rate(c.env, `updates:${c.get("actor").id}`, 5);
  await checkUpdate(c.env);
  return c.json(await updateStatus(c.env));
});
app.get("/api/v1/system/push", async (c) => {
  admin(c.get("actor"));
  return c.json({
    ...publicPushConfig(await pushConfig(c.env)),
    devices: (
      await one(c.env, "SELECT count(*) n FROM devices WHERE enabled=1")
    )?.n,
  });
});
app.post("/api/v1/system/push/test", async (c) => {
  admin(c.get("actor"));
  await rate(c.env, `push-test:${c.get("actor").id}`, 5);
  const devices = await all(
    c.env,
    "SELECT * FROM devices WHERE user_id=? AND enabled=1",
    c.get("actor").id,
  );
  requireValue(
    devices.length > 0,
    "Nenhum dispositivo ativo registrado para a sua conta. Entre no aplicativo antes de testar.",
  );
  return c.json({ results: await sendTest(c.env, devices) });
});
app.get("/api/v1/system/cloudflare/:id/connector", async (c) => {
  admin(c.get("actor"));
  return c.json(
    await connectorDownload(c.env, c.get("actor"), c.req.param("id")),
  );
});
for (const [path, operation] of [
  ["cloudflare/configure", "cloudflare.save"],
  ["cloudflare/deploy", "cloudflare.create"],
  ["cloudflare/retry", "cloudflare.retry"],
  ["updates/configure", "updates.configure"],
  ["updates/automatic", "updates.automatic"],
  ["updates/start", "updates.start"],
  ["updates/reset", "updates.reset"],
  ["push/configure", "push.configure"],
])
  app.post("/api/v1/system/" + path, async (c) => {
    admin(c.get("actor"));
    return mutate(c, "system." + operation, "_admin", await c.req.json());
  });
for (const [method, path, op] of [
  ["post", "profiles", "profile.create"],
  ["post", "users", "user.create"],
  ["patch", "users/:id", "user.update"],
  ["post", "applications", "application.create"],
  ["patch", "applications/:id", "application.update"],
  ["post", "applications/:id/keys", "key.create"],
  ["delete", "keys/:id", "key.revoke"],
] as const) {
  app.on(method.toUpperCase(), `/api/v1/${path}`, async (c) => {
    admin(c.get("actor"));
    const data = method === "delete" ? {} : await c.req.json();
    return mutate(c, op, "_admin", {
      ...data,
      id: c.req.param("id"),
      ...(op === "key.create" ? { app_id: c.req.param("id") } : {}),
    });
  });
}
const commands = [
  ["PUT", "lines/:id", "line.save"],
  ["POST", "internal-chats", "internal.create"],
  ["POST", "internal-chats/:id/messages", "internal.send"],
  ["POST", "router/accounts", "meta-account.save"],
  ["POST", "router/accounts/:id/discover", "meta-account.discover"],
  ["POST", "router/numbers", "meta-number.save"],
  ["PUT", "router/numbers/:id/limit", "router.number.limit"],
  ["PUT", "router/numbers/:id/policy", "router.number.policy"],
  ["POST", "router/pools", "router.pool.save"],
  ["PUT", "router/grants", "router.grants.save"],
  ["POST", "router/messages", "router.send"],
  ["POST", "router/messages/:id/cancel", "router.cancel"],
  ["PUT", "settings", "settings"],
  ["POST", "activate", "activate"],
  ["POST", "pause", "pause"],
  ["POST", "connections", "connection.save"],
  ["PUT", "connections/:id/state", "connection.state"],
  ["PATCH", "bots/:id", "bot.update"],
  ["POST", "conversations", "conversation.create"],
  ["POST", "inbound", "inbound"],
  ["POST", "media/uploads", "upload.create"],
  ["POST", "media/uploads/:id/complete", "upload.complete"],
  ["POST", "media/uploads/:id/abort", "upload.abort"],
  ["POST", "conversations/:id/message-actions", "message.action"],
  ["POST", "groups/actions", "group.action"],
  ["POST", "group-operations/:id/reconcile", "group.reconcile"],
  ["POST", "groups/:id/actions", "group.action"],
  ["PUT", "groups/:id/policy", "group.policy"],
  ["POST", "calls", "call.start"],
  ["POST", "calls/permission", "call.permission"],
  ["POST", "calls/:id/claim", "call.claim"],
  ["POST", "calls/:id/pre_accept", "call.pre_accept"],
  ["POST", "calls/:id/accept", "call.accept"],
  ["POST", "calls/:id/reject", "call.reject"],
  ["POST", "calls/:id/terminate", "call.terminate"],
  ["POST", "calls/:id/keepalive", "call.keepalive"],
  ["POST", "calls/:id/reconcile", "call.reconcile"],
  ["PUT", "connections/:id/calling", "call.configure"],
  ["POST", "conversations/:id/actions", "conversation.action"],
  ["POST", "contacts", "contact.create"],
  ["PATCH", "contacts/:id", "contact.update"],
  ["POST", "contacts/import", "contact.import"],
  ["PUT", "conversations/:id/contact", "contact.from-conversation"],
  ["DELETE", "conversations/:id/contact", "contact.unlink"],
  ["PUT", "presence", "presence"],
  ["POST", "tickets", "ticket.create"],
  ["PATCH", "tickets/:id", "ticket.update"],
  ["POST", "consents/request", "consent.request"],
  ["POST", "bot-runs", "run.create"],
  ["POST", "bot-runs/:id/cancel", "run.cancel"],
  ["POST", "knowledge", "knowledge.create"],
  ["DELETE", "knowledge/:id", "knowledge.delete"],
  ["POST", "webhook-subscriptions", "webhook.create"],
  ["DELETE", "webhook-subscriptions/:id", "webhook.disable"],
  ["POST", "webhook-deliveries/:id/retry", "webhook.retry"],
  ["POST", "deliveries/:id/reconcile", "delivery.reconcile"],
  ["POST", "bot-runs/:id/reconcile", "run.reconcile"],
];
for (const [method, path, op] of commands)
  app.on(method, `/api/v1/profiles/:profile/${path}`, async (c) =>
    mutate(c, op, c.req.param("profile")!, {
      ...(method === "DELETE" && op !== "contact.unlink"
        ? {}
        : await c.req.json().catch(() => ({}))),
      ...(c.req.param("id") ? { id: c.req.param("id") } : {}),
    }),
  );
app.post("/api/v1/bot-runs", async (c) => {
  const data = await c.req.json();
  requireValue(typeof data.profile_id === "string", "Informe profile_id.");
  return mutate(c, "run.create", data.profile_id, data);
});
app.get("/api/v1/bot-runs/:id", async (c) => {
  const run = await one(
    c.env,
    "SELECT * FROM bot_runs WHERE id=?",
    c.req.param("id"),
  );
  if (!run) throw new ApiError(404, "not_found", "Execução não encontrada.");
  access(c.get("actor"), run.profile_id, "bots:invoke");
  if (
    (c.get("actor").kind === "app" || json(run.context).internal_chat_id) &&
    run.actor !== c.get("actor").id
  )
    throw new ApiError(404, "not_found", "Execução não encontrada.");
  run.attachments = json(run.result, {}).attachments || [];
  delete run.context;
  delete run.request_body;
  return c.json(run);
});
app.use("/api/v1/profiles/:profile/*", async (c, next) => {
  if (!canProfile(c.get("actor"), c.req.param("profile")!))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  await next();
});
app.get("/api/v1/profiles/:profile/status", async (c) => {
  const p = c.req.param("profile");
  if (c.get("actor").kind === "app")
    throw new ApiError(
      403,
      "panel_only",
      "Use os recursos autorizados da API.",
    );
  return c.json({
    settings: await settings(c.env, p),
    enabled: (await one(c.env, "SELECT enabled FROM profiles WHERE id=?", p))
      ?.enabled,
    conversations: await all(
      c.env,
      "SELECT state,count(*) count FROM conversations WHERE profile_id=? GROUP BY state",
      p,
    ),
    deliveries: await all(
      c.env,
      "SELECT status,count(*) count FROM outbox WHERE profile_id=? GROUP BY status",
      p,
    ),
    connections: await all(
      c.env,
      "SELECT id,name,kind,status,last_seen FROM connections WHERE profile_id=?",
      p,
    ),
  });
});
app.get("/api/v1/profiles/:profile/router", async (c) =>
  c.json(await routerView(c.env, c.get("actor"), c.req.param("profile"))),
);
app.get("/api/v1/profiles/:profile/lines", async (c) =>
  c.json(await listLines(c.env, c.get("actor"), c.req.param("profile"))),
);
app.get("/api/v1/profiles/:profile/menus", async (c) =>
  c.json(
    await listMenus(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.query("connection_id"),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/team", async (c) =>
  c.json(await teamDirectory(c.env, c.get("actor"), c.req.param("profile"))),
);
app.get("/api/v1/profiles/:profile/internal-chats", async (c) =>
  c.json(
    await listInternalChats(c.env, c.get("actor"), c.req.param("profile")),
  ),
);
app.get("/api/v1/profiles/:profile/internal-chats/:id", async (c) =>
  c.json(
    await internalChatDetail(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/router/messages/:id", async (c) =>
  c.json(
    await routedMessage(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
app.get("/api/public/whatsapp/:token", async (c) => {
  await rate(
    c.env,
    "router-link:" + (c.req.header("CF-Connecting-IP") || "local"),
    30,
  );
  const pool = await one(
    c.env,
    "SELECT profile_id FROM number_pools WHERE public_token=? AND enabled=1",
    c.req.param("token"),
  );
  if (!pool)
    throw new ApiError(404, "not_found", "Link de atendimento indisponível.");
  const response = await c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(pool.profile_id),
  ).fetch("https://coordinator/router-link", {
    method: "POST",
    body: JSON.stringify({
      profile: pool.profile_id,
      token: c.req.param("token"),
    }),
  });
  if (!response.ok) return response;
  const result = await response.json<any>();
  return c.redirect(result.url, 302);
});
app.get("/api/v1/profiles/:profile/connections", async (c) => {
  admin(c.get("actor"));
  return c.json(
    await all(
      c.env,
      "SELECT * FROM connections WHERE profile_id=?",
      c.req.param("profile"),
    ),
  );
});
for (const op of ["test", "discover", "telegram-webhook", "connector-token"])
  app.post("/api/v1/profiles/:profile/connections/:id/" + op, async (c) => {
    admin(c.get("actor"));
    return mutate(c, "connection." + op, c.req.param("profile")!, {
      id: c.req.param("id"),
      origin: new URL(c.req.url).origin,
    });
  });
app.post("/api/v1/profiles/:profile/jev", async (c) =>
  mutate(c, "jev", c.req.param("profile"), await c.req.json()),
);
const readLists: Record<string, [string, string]> = {
  bots: ["bots", "bots:read"],
  tickets: ["tickets", "tickets:read"],
  knowledge: ["documents", "knowledge:read"],
  surveys: ["surveys", "reports:read"],
  consents: ["consents", "conversations:read"],
  deliveries: ["outbox", "conversations:read"],
  "bot-runs": ["bot_runs", "bots:invoke"],
  media: ["media", "media:read"],
};
for (const [path, [table, scope]] of Object.entries(readLists))
  app.get(`/api/v1/profiles/:profile/${path}`, async (c) => {
    const p = c.req.param("profile")!;
    access(c.get("actor"), p, scope);
    const actor = c.get("actor"),
      limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 100)),
      cursor = c.req.query("cursor") || "";
    let filter = "",
      params: any[] = [p, cursor];
    if (table === "bot_runs") {
      filter +=
        " AND (json_extract(context,'$.internal_chat_id') IS NULL OR actor=?)";
      params.push(actor.id);
    }
    if(actor.fagoo && !configured(actor)) {
      if(table==='media') { filter+=' AND actor=? AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.profile_id=media.profile_id AND EXISTS(SELECT 1 FROM json_each(m.attachments) WHERE value=media.id) AND m.conversation_id IN(SELECT id FROM conversations WHERE owner IS NULL OR owner!=?))'; params.push(actor.id,actor.id); }
      else if(table==='bots') {filter+=' AND id IN(SELECT value FROM json_each(?))';params.push(JSON.stringify(actor.bots));}
      else if(['tickets','surveys','consents','outbox'].includes(table)) {filter+=" AND conversation_id IN(SELECT id FROM conversations WHERE profile_id=? AND owner IN(SELECT value FROM json_each(?)) AND state='human' AND (?=1 OR department_id IS NULL OR department_id IN(SELECT value FROM json_each(?))))";params.push(p,JSON.stringify(actorIds(actor)),actor.fagoo.administrator?1:0,JSON.stringify(actor.fagoo.teamIds));}
      else if(table==='bot_runs') {filter+=' AND actor=?';params.push(actor.id);}
    }
    if (actor.kind === "app") {
      if (table === "bots") {
        filter += " AND id IN (SELECT value FROM json_each(?))";
        params.push(JSON.stringify(actor.bots));
      }
      if (table === "bot_runs" || table === "media") {
        filter += " AND actor=?";
        params.push(actor.id);
      }
      if (["tickets", "surveys", "consents", "outbox"].includes(table)) {
        filter += ` AND conversation_id IN (SELECT id FROM conversations WHERE external_namespace NOT LIKE 'app:%' OR external_namespace=?)`;
        params.push("app:" + actor.id);
      }
    }
    if (table === "tickets") {
      const q = (c.req.query("q") || "").trim().slice(0, 200);
      if (q) {
        const phone = q.replace(/\D/g, "");
        filter +=
          " AND (number LIKE ? OR conversation_id IN (SELECT id FROM conversations WHERE profile_id=? AND ?!='' AND phone LIKE ?))";
        params.push(`%${q}%`, p, phone, `%${phone}%`);
      }
      const status = c.req.query("status");
      if (status) {
        requireValue(
          ["open", "in_progress", "closed"].includes(status),
          "Estado inválido.",
        );
        filter += " AND status=?";
        params.push(status);
      }
      if (c.req.query("overdue") === "1") {
        filter +=
          " AND response_due_at<? AND first_response_at IS NULL AND status!='closed'";
        params.push(now());
      }
    }
    const rows = await all(
      c.env,
      `SELECT * FROM ${table} WHERE profile_id=? AND id>? ${filter} ORDER BY id LIMIT ?`,
      ...params,
      limit + 1,
    );
    const more = rows.length > limit;
    rows.splice(limit);
    for (const row of rows) {
      if(actor.fagoo && row.owner)row.owner=canonicalActor(actor,row.owner);
      delete row.object_key;
      delete row.context;
      delete row.request_body;
    }
    return c.json({ data: rows, next_cursor: more ? rows.at(-1)?.id : null });
  });
app.get("/api/v1/profiles/:profile/tickets/:id", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "tickets:read");
  const ticket = await one(
    c.env,
    "SELECT * FROM tickets WHERE id=? AND profile_id=?",
    c.req.param("id"),
    p,
  );
  if (!ticket)
    throw new ApiError(404, "not_found", "Protocolo não encontrado.");
  const conv = await conversation(c.env, ticket.conversation_id, p, actor);
  const contact =
    actor.kind === "user" || actor.scopes.includes("contacts:read")
      ? await one(
          c.env,
          "SELECT ct.name FROM conversation_contacts l JOIN contacts ct ON ct.id=l.contact_id AND ct.profile_id=l.profile_id WHERE l.profile_id=? AND l.conversation_id=? AND (?=1 OR ct.namespace=?)",
          p,
          conv.id,
          actor.kind === "user" ? 1 : 0,
          contactNamespace(actor),
        )
      : null;
  return c.json({
    ticket,
    updates: await all(
      c.env,
      "SELECT * FROM ticket_updates WHERE ticket_id=? ORDER BY created,id",
      ticket.id,
    ),
    conversation: {
      id: conv.id,
      phone: conv.phone,
      external_id: conv.external_id,
      title: conv.title,
      state: conv.state,
      owner: conv.owner,
      contact_name: contact?.name || null,
    },
  });
});
app.get("/api/v1/profiles/:profile/contacts", async (c) =>
  c.json(
    await listContacts(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.query(),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/contacts/:id", async (c) =>
  c.json(
    await contactDetail(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
app.post("/api/v1/profiles/:profile/contacts/import/preview", async (c) => {
  await rate(c.env, `contacts-preview:${c.get("actor").id}`, 20);
  const data = await c.req.json();
  return c.json(
    await previewContactCsv(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      data.csv,
    ),
  );
});
app.get("/api/v1/profiles/:profile/conversations", async (c) => {
  const p = c.req.param("profile");
  access(c.get("actor"), p, "conversations:read");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
  let after: any = null;
  try {
    after = c.req.query("cursor")
      ? JSON.parse(atob(c.req.query("cursor")!))
      : null;
  } catch {
    throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
  }
  const state = c.req.query("state") || "",
    department = (c.req.query("department_id") || "").slice(0, 100),
    q = (c.req.query("q") || "").slice(0, 200);
  const rows = await all(
    c.env,
    "SELECT c.*,ct.name contact_name,ct.id contact_id FROM conversations c LEFT JOIN conversation_contacts l ON l.conversation_id=c.id AND l.profile_id=c.profile_id LEFT JOIN contacts ct ON ct.id=l.contact_id AND ct.profile_id=c.profile_id AND ?=1 AND (?=1 OR ct.namespace=?) WHERE c.profile_id=? AND (?=0 OR (c.owner IN(SELECT value FROM json_each(?)) AND c.state='human' AND (?=1 OR c.department_id IS NULL OR c.department_id IN (SELECT value FROM json_each(?))))) AND (?='' OR c.state=?) AND (?='' OR c.department_id=?) AND (c.external_id LIKE ? OR c.phone LIKE ? OR ct.name LIKE ?) AND (?=1 OR c.external_namespace NOT LIKE 'app:%' OR c.external_namespace=?) AND (? IS NULL OR c.updated<? OR (c.updated=? AND c.id<?)) ORDER BY c.updated DESC,c.id DESC LIMIT ?",
    c.get("actor").kind === "user" ||
      c.get("actor").scopes.includes("contacts:read")
      ? 1
      : 0,
    c.get("actor").kind === "user" ? 1 : 0,
    contactNamespace(c.get("actor")),
    p,
    c.get("actor").fagoo && !configured(c.get("actor")) ? 1 : 0,
    JSON.stringify(actorIds(c.get("actor"))),
    c.get("actor").fagoo?.administrator ? 1 : 0,
    JSON.stringify(c.get("actor").fagoo?.teamIds || []),
    state,
    state,
    department,
    department,
    `%${q}%`,
    `%${q}%`,
    `%${q}%`,
    c.get("actor").kind !== "app" ? 1 : 0,
    "app:" + c.get("actor").id,
    after?.[0] ?? null,
    after?.[0] ?? 0,
    after?.[0] ?? 0,
    after?.[1] ?? "",
    limit + 1,
  );
  const more = rows.length > limit;
  rows.splice(limit);
  if(c.get("actor").fagoo)for(const row of rows)row.owner=canonicalActor(c.get("actor"),row.owner);
  const last = rows.at(-1);
  return c.json({
    data: rows,
    next_cursor:
      more && last ? btoa(JSON.stringify([last.updated, last.id])) : null,
  });
});
app.get("/api/v1/profiles/:profile/conversations/:id", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "conversations:read");
  const conv = await conversation(c.env, c.req.param("id"), p, actor);
  const notes = actor.kind !== "app" || actor.scopes.includes("notes:read");
  const conn = conv.connection_id
    ? await one(
        c.env,
        "SELECT * FROM connections WHERE id=?",
        conv.connection_id,
      )
    : null;
  const media = await all(
    c.env,
    "SELECT DISTINCT a.id,a.name,a.type,a.size FROM media a JOIN messages m ON m.profile_id=a.profile_id AND EXISTS(SELECT 1 FROM json_each(m.attachments) WHERE value=a.id) WHERE m.conversation_id=? AND (?=1 OR m.direction!='note')",
    conv.id,
    notes ? 1 : 0,
  );
  return c.json({
    conversation: conv,
    media,
    capabilities: conn ? capabilities(conn, conv.chat_type) : {},
    group:
      conv.chat_type === "group"
        ? await one(
            c.env,
            "SELECT * FROM whatsapp_groups WHERE conversation_id=?",
            conv.id,
          )
        : null,
    contact: await conversationContact(c.env, actor, p, conv.id),
    messages: (await all(
      c.env,
      "SELECT * FROM messages WHERE conversation_id=? AND (?=1 OR direction!='note') ORDER BY created,id",
      conv.id,
      notes ? 1 : 0,
    )).map(m=>actor.fagoo?{...m,source_author:m.author,author:canonicalActor(actor,m.author)}:m),
    deliveries: await all(
      c.env,
      "SELECT id,status,error,created FROM outbox WHERE conversation_id=? ORDER BY created",
      conv.id,
    ),
  });
});
app.get("/api/v1/profiles/:profile/presence", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "presence:read");
  return c.json(
    await all(
      c.env,
      "SELECT u.id actor,u.name,coalesce(p.present,0) present,u.telegram_id FROM users u LEFT JOIN presence p ON p.actor=u.id AND p.profile_id=? WHERE u.disabled=0 AND (u.role='admin' OR EXISTS(SELECT 1 FROM json_each(u.profiles) WHERE value=?))",
      c.req.param("profile"),
      c.req.param("profile"),
    ),
  );
});
app.get("/api/v1/profiles/:profile/events", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "events:read");
  const after = Number(c.req.query("after")) || 0;
  const rows = await all(
    c.env,
    "SELECT * FROM events WHERE profile_id=? AND id>? ORDER BY id LIMIT 100",
    c.req.param("profile"),
    after,
  );
  return c.json({
    data: (
      await Promise.all(
        rows.map(async (e) =>
          (await visibleEvent(c.env, c.get("actor"), e))
            ? { ...e, payload: json(e.payload) }
            : null,
        ),
      )
    ).filter(Boolean),
    cursor: rows.at(-1)?.id || after,
  });
});
app.get("/api/v1/profiles/:profile/webhook-subscriptions", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "webhooks:manage");
  return c.json(
    await all(
      c.env,
      "SELECT * FROM webhook_subscriptions WHERE profile_id=? AND (?=1 OR app_id=?)",
      c.req.param("profile"),
      c.get("actor").role === "admin" ? 1 : 0,
      c.get("actor").id.slice(4),
    ),
  );
});
app.get("/api/v1/profiles/:profile/webhook-deliveries", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "webhooks:manage");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 100));
  const rows = await all(
    c.env,
    "SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND (?=1 OR s.app_id=?) AND d.id>? ORDER BY d.id LIMIT ?",
    c.req.param("profile"),
    c.get("actor").role === "admin" ? 1 : 0,
    c.get("actor").id.slice(4),
    c.req.query("cursor") || "",
    limit + 1,
  );
  const more = rows.length > limit;
  rows.splice(limit);
  return c.json({ data: rows, next_cursor: more ? rows.at(-1)?.id : null });
});
app.get("/api/v1/profiles/:profile/reports", (c) =>
  report(
    c.env,
    c.get("actor"),
    c.req.param("profile"),
    new URL(c.req.url).searchParams,
  ),
);
app.post("/api/v1/profiles/:profile/media", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "media:write");
  const form = await c.req.formData(),
    file = form.get("file");
  requireValue(
    file instanceof File && file.size > 0 && file.size <= 20 * 1024 * 1024,
    "Envie um arquivo de até 20 MB.",
  );
  const idem = c.req.header("Idempotency-Key");
  requireValue(idem && idem.length <= 200, "Envie Idempotency-Key.");
  const bytes = await file.arrayBuffer(),
    digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  const id = (await sha(actor.id + ":" + p + ":" + idem)).slice(0, 32),
    key = `${p}/${id}/${digest}`;
  await c.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  const result = await mutate(c, "media.register", p, {
    id,
    object_key: key,
    name: file.name.slice(0, 200),
    type: file.type || "application/octet-stream",
    size: file.size,
    digest,
  });
  if (
    !result.ok &&
    !(await one(c.env, "SELECT id FROM media WHERE object_key=?", key))
  )
    await c.env.MEDIA.delete(key);
  return result;
});
app.get("/api/v1/profiles/:profile/media/:id/content", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "media:read");
  return mediaResponse(
    c.env,
    await authorizedMedia(c.env, actor, p, c.req.param("id")),
    c.req.raw,
  );
});
app.put("/api/v1/profiles/:profile/media/uploads/:id/parts/:part", async (c) =>
  c.json(
    await uploadPart(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
      Number(c.req.param("part")),
      c.req.raw,
    ),
  ),
);
app.get("/api/v1/profiles/:profile/connections/:id/capabilities", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "conversations:read");
  const row = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND profile_id=?",
    c.req.param("id"),
    c.req.param("profile"),
  );
  requireValue(row, "Conexão não encontrada.");
  return c.json(capabilities(row));
});
app.get("/api/v1/profiles/:profile/calls", async (c) => {
  const actor = c.get("actor"),
    p = c.req.param("profile");
  access(actor, p, "calls:read");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30)),
    cursor = c.req.query("cursor") || "",
    cid = c.req.query("conversation_id") || "";
  let after = { created: Number.MAX_SAFE_INTEGER, id: "" };
  if (cursor) {
    try {
      after = JSON.parse(atob(cursor));
      if (!Number.isSafeInteger(after.created) || typeof after.id !== "string")
        throw Error();
    } catch {
      throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
    }
  }
  const rows = await all(
    c.env,
    "SELECT id,conversation_id,direction,actor,status,error,started,ended,duration,created,updated FROM calls WHERE profile_id=? AND (?=1 OR actor=? OR actor IS NULL) AND (?='' OR conversation_id=?) AND (created<? OR (created=? AND id<?)) ORDER BY created DESC,id DESC LIMIT ?",
    p,
    actor.kind !== "app" ? 1 : 0,
    actor.id,
    cid,
    cid,
    after.created,
    after.created,
    after.id,
    limit + 1,
  );
  return c.json({
    data: rows.slice(0, limit),
    next_cursor:
      rows.length > limit
        ? btoa(
            JSON.stringify({
              created: rows[limit - 1].created,
              id: rows[limit - 1].id,
            }),
          )
        : null,
  });
});
app.get("/api/v1/profiles/:profile/calls/:id", async (c) =>
  c.json(
    await callView(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
      c.req.query("session") === "1",
    ),
  ),
);
app.get(
  "/api/v1/profiles/:profile/conversations/:id/call-permission",
  async (c) => {
    const actor = c.get("actor"),
      p = c.req.param("profile");
    access(actor, p, "calls:read");
    const conv = await conversation(c.env, c.req.param("id"), p, actor),
      conn = await one(
        c.env,
        "SELECT * FROM connections WHERE id=?",
        conv.connection_id,
      );
    requireValue(
      conn?.kind === "meta" && conv.chat_type !== "group",
      "Ligações exigem conversa individual na Meta.",
    );
    return c.json(
      await callPermission(c.env, conn, conv.recipient_id || conv.external_id),
    );
  },
);
app.get("/api/v1/profiles/:profile/groups", async (c) => {
  const actor = c.get("actor"),
    p = c.req.param("profile");
  access(actor, p, "conversations:read");
  const cursor = c.req.query("cursor") || "";
  const rows = await all(
    c.env,
    "SELECT * FROM conversations WHERE profile_id=? AND chat_type='group' AND (?='' OR id<?) ORDER BY id DESC LIMIT 51",
    p,
    cursor,
    cursor,
  );
  return c.json({
    data: rows.slice(0, 50),
    next_cursor: rows.length > 50 ? rows[49].id : null,
  });
});
app.get("/api/v1/profiles/:profile/group-operations", async (c) => {
  const actor = c.get("actor"),
    p = c.req.param("profile");
  access(actor, p, "groups:manage");
  return c.json({
    data: await all(
      c.env,
      "SELECT id,connection_id,conversation_id,operation,status,result,error,created FROM group_operations WHERE profile_id=? AND (?=1 OR actor=?) ORDER BY created DESC LIMIT 30",
      p,
      actor.kind !== "app" ? 1 : 0,
      actor.id,
    ),
  });
});
async function ingest(env: Env, conn: any, data: any) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(conn.profile_id)).fetch(
    data.event
      ? "https://coordinator/channel-event"
      : "https://coordinator/inbound",
    {
      method: "POST",
      body: JSON.stringify({
        profile: conn.profile_id,
        data,
        namespace: `channel:${conn.id}`,
        connectionId: conn.id,
      }),
    },
  );
}
app.get("/webhooks/meta/:id", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind='meta'",
    c.req.param("id"),
  );
  const keys = conn ? await metaCredentials(c.env, conn) : {};
  if (
    c.req.query("hub.mode") !== "subscribe" ||
    !keys.verify_token ||
    !equal(keys.verify_token, c.req.query("hub.verify_token") || "")
  )
    throw new ApiError(403, "verification_failed", "Verificação recusada.");
  return c.text(c.req.query("hub.challenge") || "");
});
app.post("/webhooks/meta/:id", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind='meta'",
    c.req.param("id"),
  );
  requireValue(conn, "Canal não encontrado.");
  const keys = await metaCredentials(c.env, conn),
    raw = await c.req.text();
  if (
    !keys.app_secret ||
    !equal(
      c.req.header("X-Hub-Signature-256") || "",
      `sha256=${await hmac(keys.app_secret, raw)}`,
    )
  )
    throw new ApiError(403, "invalid_signature", "Assinatura inválida.");
  return metaInbound(c.env, conn, JSON.parse(raw), (data) =>
    ingest(c.env, conn, data),
  );
});
app.get("/webhooks/meta-accounts/:id", async (c) => {
  const account = await one(
    c.env,
    "SELECT id FROM meta_accounts WHERE id=?",
    c.req.param("id"),
  );
  const keys = account ? await secret(c.env, "meta-account:" + account.id) : {};
  if (
    c.req.query("hub.mode") !== "subscribe" ||
    !keys.verify_token ||
    !equal(keys.verify_token, c.req.query("hub.verify_token") || "")
  )
    throw new ApiError(403, "verification_failed", "Verificação recusada.");
  return c.text(c.req.query("hub.challenge") || "");
});
app.post("/webhooks/meta-accounts/:id", async (c) => {
  const account = await one(
    c.env,
    "SELECT * FROM meta_accounts WHERE id=?",
    c.req.param("id"),
  );
  requireValue(account, "Conta Meta não encontrada.");
  const keys = await secret(c.env, "meta-account:" + account.id),
    raw = await c.req.text();
  if (
    !keys.app_secret ||
    !equal(
      c.req.header("X-Hub-Signature-256") || "",
      `sha256=${await hmac(keys.app_secret, raw)}`,
    )
  )
    throw new ApiError(403, "invalid_signature", "Assinatura inválida.");
  const body = JSON.parse(raw);
  requireValue(
    body.object === "whatsapp_business_account" && Array.isArray(body.entry),
    "Webhook Meta inválido.",
  );
  const filtered = {
    ...body,
    entry: body.entry.filter((entry: any) => entry.id === account.waba_id),
  };
  const ids = new Set(
    filtered.entry.flatMap((entry: any) =>
      (entry.changes || []).map(
        (change: any) => change.value?.metadata?.phone_number_id,
      ),
    ),
  );
  const connections = await all(
    c.env,
    "SELECT c.* FROM connections c JOIN meta_numbers n ON n.connection_id=c.id WHERE n.account_id=? AND c.profile_id=?",
    account.id,
    account.profile_id,
  );
  for (const conn of connections) {
    if (!ids.has(json(conn.config).phone_id)) continue;
    const response = await metaInbound(c.env, conn, filtered, (data) =>
      ingest(c.env, conn, data),
    );
    if (!response.ok) return response;
  }
  return c.json({ received: true });
});
app.post("/webhooks/telegram/:id", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind='telegram'",
    c.req.param("id"),
  );
  requireValue(conn, "Canal não encontrado.");
  const keys = await secret(c.env, `connection:${conn.id}`);
  if (
    !keys.webhook_secret ||
    !equal(
      keys.webhook_secret,
      c.req.header("X-Telegram-Bot-Api-Secret-Token") || "",
    )
  )
    throw new ApiError(403, "invalid_signature", "Segredo inválido.");
  const update = await c.req.json(),
    m = update.message;
  if (
    !m ||
    String(m.chat.id) !== String(json(conn.config).group) ||
    m.from?.is_bot ||
    m.sender_chat
  )
    return c.json({ ignored: true });
  if (conn.status !== "active") return c.json({ paused: true });
  if (/^\/identificar(?:@\S+)?\s*$/.test(m.text || "")) {
    await telegram(c.env, conn.id, "sendMessage", {
      chat_id: m.chat.id,
      message_thread_id: m.message_thread_id,
      text: `Seu ID Telegram: ${m.from.id}. Solicite ao administrador o vínculo em Pessoas.`,
    });
    return c.json({ received: true });
  }
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE telegram_id=? AND disabled=0",
    String(m.from.id),
  );
  if (
    !user ||
    !(
      user.role === "admin" || json(user.profiles, []).includes(conn.profile_id)
    )
  )
    return c.json({ ignored: true });
  const actor: Actor = {
    id: user.id,
    kind: "user",
    name: user.name,
    role: user.role,
    profiles: json(user.profiles, []),
    scopes: [],
    bots: [],
    rate: 60,
    runLimit: 3,
  };
  const match = (m.text || m.caption || "").match(
      /^\/(\w+)(?:@\S+)?\s*([\s\S]*)$/,
    ),
    cmd = match?.[1],
    value = match?.[2] || m.text || m.caption || "";
  const conv = await one(
    c.env,
    "SELECT id,owner FROM conversations WHERE profile_id=? AND topic=?",
    conn.profile_id,
    String(m.message_thread_id),
  );
  let operation = "",
    data: any = {};
  if (cmd === "ajuda") {
    await telegram(c.env, conn.id, "sendMessage", {
      chat_id: m.chat.id,
      message_thread_id: m.message_thread_id,
      text: "/presente /ausente · No tópico: /assumir /responder texto /nota texto /transferir ID /encerrar /retomar. /identificar mostra seu ID.",
    });
    return c.json({ received: true });
  }
  if (cmd === "presente" || cmd === "ausente") {
    operation = "presence";
    data = { present: cmd === "presente" };
  } else if (conv) {
    const actions: Record<string, string> = {
      assumir: "claim",
      responder: "reply",
      nota: "note",
      encerrar: "resolve",
      retomar: "resume",
      transferir: "transfer",
    };
    const cfg = await settings(c.env, conn.profile_id);
    operation = "conversation.action";
    data = {
      id: conv.id,
      action:
        actions[cmd || ""] ||
        (cfg.reply_mode === "direct" &&
        conv.owner === actor.id &&
        !cmd &&
        (!m.reply_to_message ||
          (m.reply_to_message.from?.is_bot &&
            !m.reply_to_message.forum_topic_created))
          ? "reply"
          : "note"),
      text: value,
      target: value,
    };
    if (cmd === "transferir") {
      const target = await one(
        c.env,
        "SELECT id FROM users WHERE id=? OR telegram_id=?",
        value,
        value,
      );
      data.target = target?.id || value;
    }
    const file =
      m.document ||
      m.audio ||
      m.voice ||
      m.video ||
      m.sticker ||
      m.photo?.at(-1);
    if (file) {
      data.attachments = [
        await telegramFile(
          c.env,
          conn,
          file.file_id,
          file.file_name || "telegram-file",
          file.mime_type || "image/jpeg",
        ),
      ];
      data.content = {
        type: m.voice
          ? "voice"
          : m.video
            ? "video"
            : m.sticker
              ? "sticker"
              : m.audio
                ? "audio"
                : m.photo
                  ? "image"
                  : "document",
      };
      if (!data.text) data.text = "";
    }
  } else return c.json({ ignored: true });
  const result = await c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(conn.profile_id),
  ).fetch("https://coordinator/command", {
    method: "POST",
    body: JSON.stringify({
      profile: conn.profile_id,
      operation,
      data,
      actor,
      key: `telegram:${conn.id}:${update.update_id}`,
      requestId: c.get("requestId"),
    }),
  });
  if (result.status >= 500) return result;
  if (!result.headers.has("Idempotency-Replayed")) {
    const response = await result.clone().json<any>();
    await telegram(c.env, conn.id, "sendMessage", {
      chat_id: m.chat.id,
      message_thread_id: m.message_thread_id,
      text: result.ok
        ? operation === "presence"
          ? data.present
            ? "Presença registrada."
            : "Ausência registrada."
          : "Comando registrado."
        : response.error?.message || "Comando recusado.",
    }).catch(() => {});
  }
  return c.json({ received: true });
});
app.use("/internal/v1/connectors/:id/*", async (c, next) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind IN ('qr','hermes-whatsapp')",
    c.req.param("id"),
  );
  if (!conn) throw new ApiError(401, "unauthenticated", "Conector inválido.");
  const keys = await secret(c.env, `connection:${conn.id}`),
    token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  if (!keys.connector_hash || !equal(await sha(token), keys.connector_hash))
    throw new ApiError(401, "unauthenticated", "Token inválido.");
  await exec(
    c.env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    conn.id,
  );
  await next();
});
app.post("/internal/v1/connectors/:id/events", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return ingest(c.env, conn, await c.req.json());
});
async function transportCommand(c: any, operation: string, data: any = {}) {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(conn.profile_id),
  ).fetch("https://coordinator/transport", {
    method: "POST",
    body: JSON.stringify({
      profile: conn.profile_id,
      connectionId: conn.id,
      operation,
      data,
    }),
  });
}
app.get("/internal/v1/connectors/:id/commands", (c) =>
  transportCommand(c, "commands"),
);
app.post("/internal/v1/connectors/:id/commands/:command/check", (c) =>
  transportCommand(c, "check", { id: c.req.param("command") }),
);
app.post("/internal/v1/connectors/:id/receipts", async (c) =>
  transportCommand(c, "receipt", await c.req.json()),
);
app.get("/internal/v1/connectors/:id/media/:media", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  const m = await one(
    c.env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    c.req.param("media"),
    conn.profile_id,
  );
  requireValue(m, "Arquivo não encontrado.");
  const obj = await c.env.MEDIA.get(m.object_key);
  requireValue(obj, "Arquivo ausente.");
  return new Response(obj.body, {
    headers: {
      "Content-Type": m.type,
      "X-Filename": encodeURIComponent(m.name),
      "Content-Length": String(m.size),
    },
  });
});
app.post("/internal/v1/connectors/:id/media-content", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  const size = Number(c.req.header("Content-Length") || 0);
  requireValue(
    Number.isSafeInteger(size) && size > 0 && size <= 100 * 1024 * 1024,
    "Arquivo deve ter de 1 byte a 100 MB.",
  );
  const key = c.req.header("Idempotency-Key");
  requireValue(key && key.length <= 200, "Informe Idempotency-Key.");
  const id = (await sha(conn.id + ":" + key)).slice(0, 32);
  const existing = await one(
    c.env,
    "SELECT id,size FROM media WHERE id=? AND profile_id=?",
    id,
    conn.profile_id,
  );
  if (existing) {
    requireValue(
      existing.size === size,
      "A chave já foi usada para outro arquivo.",
    );
    return c.json({ id });
  }
  const name = decodeURIComponent(c.req.header("X-Filename") || "anexo").slice(
      0,
      200,
    ),
    type = c.req.header("Content-Type") || "application/octet-stream";
  await storeRemoteMedia(
    c.env,
    conn.profile_id,
    name,
    type,
    new Response(c.req.raw.body, {
      headers: { "Content-Length": String(size) },
    }),
    { id, actor: "transport:" + conn.id },
  );
  return c.json({ id });
});
app.post("/internal/v1/connectors/:id/media", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  const form = await c.req.formData(),
    file = form.get("file");
  requireValue(
    file instanceof File && file.size <= 20 * 1024 * 1024,
    "Arquivo inválido.",
  );
  const id = await storeRemoteMedia(
    c.env,
    conn.profile_id,
    file.name,
    file.type,
    new Response(file.stream(), {
      headers: { "Content-Length": String(file.size) },
    }),
  );
  return c.json({ id });
});
app.get("/internal/v1/connectors/:id/policy", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return c.json({
    notifications: (await settings(c.env, conn.profile_id)).notifications,
  });
});
app.post("/internal/v1/connectors/:id/status", async (c) => {
  const data = await c.req.json(),
    conn = await one(
      c.env,
      "SELECT * FROM connections WHERE id=?",
      c.req.param("id"),
    );
  await exec(
    c.env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({
      ...json(conn.config),
      qr: data.qr || null,
      protocol_version: Number(data.protocol_version) || 1,
      features: Array.isArray(data.features)
        ? data.features.filter((x: any) => typeof x === "string").slice(0, 30)
        : [],
      ...(data.approved_template
        ? {
            approved_template: data.approved_template,
            template_checked_at: now(),
          }
        : {}),
      ...(data.platform &&
      ["whatsapp", "whatsapp_cloud"].includes(data.platform)
        ? { platform: data.platform }
        : {}),
      transport_state: String(data.state || "unknown").slice(0, 40),
    }),
    conn.id,
  );
  return c.json({ ok: true });
});
export class FagooCommunication extends WorkerEntrypoint<Env> {
  async sendQueueNotice(input:any){try{return await sendQueueNotice(this.env,input);}catch(error){if(error instanceof ApiError)return {status:'failed',delivery_id:null,error:error.code};throw error;}}
  async queueNoticeStatus(input:any){return queueNoticeStatus(this.env,input);}
  async fetch(request:Request) {
    try {
      const grant=JSON.parse(request.headers.get('X-Fagoo-Delegation') || 'null');
      if(grant)grant.client=request.headers.get('X-Fagoo-Client')==='mobile'?'mobile':'web';
      const actor=await attachAliases(this.env,actorFromGrant(grant));
      const paused=(await one(this.env,'SELECT pause_outbound FROM fagoo_runtime WHERE id=1'))?.pause_outbound;
      if(paused && !['GET','HEAD'].includes(request.method) && !/\/devices(?:\/|$)/.test(new URL(request.url).pathname))throw new ApiError(503,'maintenance','O Fagoo está em manutenção. Tente novamente em instantes.');
      if(!paused)await syncGrant(this.env,grant);
      const url=new URL(request.url);
      if(url.pathname.startsWith(`/api/v1/profiles/${grant.profile_id}/devices`)) url.pathname=url.pathname.replace(`/api/v1/profiles/${grant.profile_id}`,'/api/v1');
      return await app.fetch(new Request(url,request),{...this.env,FAGOO_MANAGED:'true',FAGOO_ACTOR:actor,FAGOO_GRANT:grant},this.ctx);
    } catch(error) {return Response.json({error:{code:error instanceof ApiError?error.code:'invalid_delegation',message:error instanceof ApiError?error.message:'Contexto Fagoo indisponível.'}},{status:error instanceof ApiError?error.status:403});}
  }
}
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(wake(env, "_admin"));
    for (const profile of await all(env, "SELECT id FROM profiles"))
      ctx.waitUntil(wake(env, profile.id));
    ctx.waitUntil(
      exec(env, "DELETE FROM rate_limits WHERE expires<?", now() - 600000),
    );
    ctx.waitUntil(exec(env, "DELETE FROM sessions WHERE expires<?", now()));
    ctx.waitUntil(prunePush(env));
    ctx.waitUntil(prunePairings(env));
  },
};
