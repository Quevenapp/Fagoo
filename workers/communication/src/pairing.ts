import { all, one, exec, batch } from "./db";
import { admin, random, sha, seal, unseal, rate } from "./security";
import {
  ApiError,
  type Actor,
  type Env,
  uid,
  now,
  json,
  requireValue,
} from "./types";

// Device authorization semantics follow RFC 8628. The short code authorizes;
// only the initiating server holds the random device secret and receives a key.
export const pairingClients = {
  vinki: {
    name: "Vinki",
    scopes: [
      "routing:read",
      "routing:send",
      "conversations:read",
      "conversations:write",
      "events:read",
    ],
  },
  fagoo: {
    name: "Fagoo",
    scopes: [
      "routing:read",
      "routing:send",
      "conversations:read",
      "conversations:write",
      "tickets:read",
      "tickets:write",
      "bots:read",
      "bots:invoke",
      "events:read",
    ],
  },
} as const;
type Client = keyof typeof pairingClients;
const duration = 10 * 60_000;
const interval = 5;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const publicColumns =
  "id,client,instance_name,status,expires,profile_id,app_id,key_id,grants,approved_by,created,updated";
const badCode = () =>
  new ApiError(
    404,
    "pairing_not_found",
    "Código não encontrado ou expirado. Confira o código no sistema que deseja conectar.",
  );
function normalizeCode(value: unknown) {
  return typeof value === "string"
    ? value.toUpperCase().replace(/[\s-]/g, "")
    : "";
}
function expose(row: any) {
  return {
    ...row,
    status:
      ["pending", "approved"].includes(row.status) && row.expires <= now()
        ? "expired"
        : row.status,
    grants: json(row.grants, {}),
    allowed_scopes: pairingClients[row.client as Client].scopes,
  };
}
function ids(value: unknown, label: string) {
  requireValue(
    Array.isArray(value) &&
      value.length <= 200 &&
      value.every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 100,
      ),
    `Seleção inválida: ${label}.`,
  );
  return [...new Set(value)] as string[];
}

export async function pairingStart(
  env: Env,
  body: any,
  origin: string,
  ip: string,
) {
  await rate(env, "pair-start:" + (await sha(ip)), 10, 600_000);
  requireValue(
    body && Object.hasOwn(pairingClients, body.client),
    "Escolha Vinki ou Fagoo.",
  );
  requireValue(
    typeof body.instance_name === "string" &&
      body.instance_name.trim().length > 0 &&
      body.instance_name.length <= 80,
    "Informe o nome desta instalação (até 80 caracteres).",
  );
  const client = body.client as Client,
    device = random(),
    id = uid(),
    created = now();
  // 256 is divisible by this 32-symbol alphabet, so modulo has no bias.
  const letters = Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (v) => codeAlphabet[v % codeAlphabet.length],
  ).join("");
  await exec(
    env,
    "INSERT INTO pairing_requests(id,client,instance_name,device_hash,user_hash,expires,created,updated) VALUES(?,?,?,?,?,?,?,?)",
    id,
    client,
    body.instance_name.trim(),
    await sha(device),
    await sha(letters),
    created + duration,
    created,
    created,
  );
  return {
    device_code: device,
    user_code: letters.slice(0, 4) + "-" + letters.slice(4),
    verification_uri: new URL("/app?pair=1", origin).href,
    expires_in: duration / 1000,
    interval,
    client,
  };
}

export async function pairingLookup(env: Env, actor: Actor, code: unknown) {
  admin(actor);
  await rate(env, "pair-lookup:" + actor.id, 12);
  const normalized = normalizeCode(code);
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(normalized)) throw badCode();
  const row = await one(
    env,
    `SELECT ${publicColumns} FROM pairing_requests WHERE user_hash=? AND expires>? AND status='pending'`,
    await sha(normalized),
    now(),
  );
  if (!row) throw badCode();
  return expose(row);
}

export async function pairingList(env: Env, actor: Actor) {
  admin(actor);
  // Unapproved requests from the Internet never appear as trusted installations.
  return {
    data: (
      await all(
        env,
        `SELECT ${publicColumns} FROM pairing_requests WHERE app_id IS NOT NULL ORDER BY created DESC LIMIT 100`,
      )
    ).map(expose),
    clients: pairingClients,
  };
}

export async function pairingApprove(
  env: Env,
  actor: Actor,
  id: string,
  body: any,
) {
  admin(actor);
  const request = await one(
    env,
    "SELECT * FROM pairing_requests WHERE id=? AND status='pending' AND expires>?",
    id,
    now(),
  );
  if (!request) throw badCode();
  const profile = body?.profile_id;
  requireValue(
    typeof profile === "string" &&
      (await one(env, "SELECT id FROM profiles WHERE id=?", profile)),
    "Escolha um perfil existente.",
  );
  const scopes = ids(body.scopes, "permissões"),
    numbers = ids(body.number_ids || [], "números"),
    pools = ids(body.pool_ids || [], "grupos"),
    bots = ids(body.bot_ids || [], "bots");
  const allowed: readonly string[] =
    pairingClients[request.client as Client].scopes;
  requireValue(
    scopes.length > 0 && scopes.every((scope) => allowed.includes(scope)),
    "A permissão pedida não faz parte deste pareamento.",
  );
  requireValue(
    !scopes.includes("routing:send") || numbers.length + pools.length > 0,
    "Escolha ao menos um número ou grupo para enviar mensagens.",
  );
  requireValue(
    !scopes.includes("routing:send") ||
      (scopes.includes("conversations:write") &&
        scopes.includes("routing:read")),
    "Para enviar pelas linhas, autorize também a consulta das linhas e o envio nas conversas.",
  );
  requireValue(
    !scopes.includes("bots:invoke") || bots.length > 0,
    "Escolha os bots que o sistema pode consultar.",
  );
  for (const number of numbers)
    requireValue(
      await one(
        env,
        "SELECT c.id FROM connections c JOIN meta_numbers n ON n.connection_id=c.id WHERE c.id=? AND c.profile_id=?",
        number,
        profile,
      ),
      "Número não pertence ao perfil selecionado.",
    );
  for (const pool of pools)
    requireValue(
      await one(
        env,
        "SELECT id FROM number_pools WHERE id=? AND profile_id=?",
        pool,
        profile,
      ),
      "Grupo não pertence ao perfil selecionado.",
    );
  for (const bot of bots)
    requireValue(
      await one(
        env,
        "SELECT id FROM bots WHERE id=? AND profile_id=? AND enabled=1",
        bot,
        profile,
      ),
      "Bot não está habilitado neste perfil.",
    );
  const appId = uid(),
    keyId = uid(),
    token = "wab_" + random(),
    created = now(),
    expires = created + 365 * 86400_000;
  const grants = {
    scopes,
    number_ids: numbers,
    pool_ids: pools,
    bot_ids: bots,
    key_expires: expires,
  };
  const credential = await seal(env, {
    access_token: token,
    token_type: "Bearer",
    expires_in: 365 * 86400,
    profile_id: profile,
    application_id: appId,
    ...grants,
  });
  const commands: [string, any[]][] = [
    [
      "INSERT INTO applications(id,name,profiles,scopes,bots,rate,run_limit,created) SELECT ?,?,?,?, ?,60,3,? WHERE EXISTS(SELECT 1 FROM pairing_requests WHERE id=? AND status='pending' AND expires>?)",
      [
        appId,
        `${pairingClients[request.client as Client].name} · ${request.instance_name}`,
        JSON.stringify([profile]),
        JSON.stringify(scopes),
        JSON.stringify(bots),
        created,
        id,
        created,
      ],
    ],
    [
      "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM applications WHERE id=?)",
      [
        keyId,
        appId,
        await sha(token),
        token.slice(0, 12),
        expires,
        created,
        appId,
      ],
    ],
    ...numbers.map((number): [string, any[]] => [
      "INSERT INTO number_router_grants(app_id,profile_id,source_type,source_id,allow_paid) SELECT ?,?,'number',?,0 WHERE EXISTS(SELECT 1 FROM applications WHERE id=?)",
      [appId, profile, number, appId],
    ]),
    ...pools.map((pool): [string, any[]] => [
      "INSERT INTO number_router_grants(app_id,profile_id,source_type,source_id,allow_paid) SELECT ?,?,'pool',?,0 WHERE EXISTS(SELECT 1 FROM applications WHERE id=?)",
      [appId, profile, pool, appId],
    ]),
    [
      "UPDATE pairing_requests SET status='approved',profile_id=?,app_id=?,key_id=?,credential=?,grants=?,approved_by=?,updated=? WHERE id=? AND status='pending' AND expires>?",
      [
        profile,
        appId,
        keyId,
        credential,
        JSON.stringify(grants),
        actor.id,
        created,
        id,
        created,
      ],
    ],
  ];
  const result = await batch(env, commands);
  if (!result.at(-1)?.meta.changes)
    throw new ApiError(
      409,
      "pairing_changed",
      "Este pareamento já foi processado. Confira o estado antes de repetir.",
    );
  return expose(
    await one(
      env,
      `SELECT ${publicColumns} FROM pairing_requests WHERE id=?`,
      id,
    ),
  );
}

export async function pairingToken(env: Env, body: any, ip: string) {
  await rate(env, "pair-poll-ip:" + (await sha(ip)), 90);
  requireValue(
    body &&
      Object.hasOwn(pairingClients, body.client) &&
      typeof body.device_code === "string" &&
      /^[0-9a-f]{64}$/.test(body.device_code),
    "Solicitação de pareamento inválida.",
  );
  const hash = await sha(body.device_code),
    time = now();
  const row = await one(
    env,
    "SELECT * FROM pairing_requests WHERE device_hash=? AND client=?",
    hash,
    body.client,
  );
  if (!row)
    throw new ApiError(
      400,
      "invalid_grant",
      "Solicitação de pareamento inválida.",
    );
  if (row.status === "denied" || row.status === "revoked")
    throw new ApiError(
      403,
      "access_denied",
      "O pareamento foi recusado ou revogado.",
    );
  if (row.status === "consumed")
    throw new ApiError(
      400,
      "invalid_grant",
      "Este pareamento já foi concluído. Inicie outro para reconectar.",
    );
  if (row.expires <= time) {
    await batch(env, [
      ["UPDATE api_keys SET revoked=1 WHERE id=?", [row.key_id]],
      ["UPDATE pairing_requests SET credential=NULL WHERE id=?", [row.id]],
    ]);
    throw new ApiError(
      400,
      "expired_token",
      "O código expirou. Inicie outro pareamento.",
    );
  }
  const polled = await one(
    env,
    "UPDATE pairing_requests SET next_poll_at=? WHERE id=? AND next_poll_at<=? RETURNING id",
    time + interval * 1000,
    row.id,
    time,
  );
  if (!polled)
    throw new ApiError(
      429,
      "slow_down",
      "Aguarde pelo menos 5 segundos antes de consultar novamente.",
    );
  if (row.status === "pending")
    return { status: "authorization_pending", interval };
  const claimed = await one(
    env,
    "UPDATE pairing_requests SET status='consumed',updated=? WHERE id=? AND status='approved' AND expires>? AND EXISTS(SELECT 1 FROM api_keys k JOIN applications a ON a.id=k.app_id WHERE k.id=pairing_requests.key_id AND k.revoked=0 AND a.disabled=0) RETURNING credential",
    time,
    row.id,
    time,
  );
  if (!claimed?.credential)
    throw new ApiError(
      400,
      "invalid_grant",
      "Pareamento já concluído ou revogado.",
    );
  const credential = await unseal(env, claimed.credential);
  await exec(
    env,
    "UPDATE pairing_requests SET credential=NULL WHERE id=?",
    row.id,
  );
  return { status: "connected", ...credential };
}

export async function pairingDeny(env: Env, actor: Actor, id: string) {
  admin(actor);
  await exec(
    env,
    "UPDATE pairing_requests SET status='denied',credential=NULL,updated=? WHERE id=? AND status='pending'",
    now(),
    id,
  );
  return { denied: true };
}
export async function pairingRevoke(env: Env, actor: Actor, id: string) {
  admin(actor);
  const row = await one(
    env,
    "SELECT app_id FROM pairing_requests WHERE id=?",
    id,
  );
  if (!row) throw badCode();
  await batch(env, [
    ["UPDATE applications SET disabled=1 WHERE id=?", [row.app_id]],
    ["UPDATE api_keys SET revoked=1 WHERE app_id=?", [row.app_id]],
    [
      "UPDATE pairing_requests SET status='revoked',credential=NULL,updated=? WHERE id=?",
      [now(), id],
    ],
  ]);
  return { revoked: true };
}

export async function pairingDisconnect(env: Env, actor: Actor) {
  if (actor.kind !== "app" || !actor.keyId)
    throw new ApiError(
      403,
      "forbidden",
      "Somente o aplicativo pode desconectar seu próprio vínculo.",
    );
  const row = await one(
    env,
    "SELECT p.id,p.app_id FROM pairing_requests p JOIN api_keys k ON k.app_id=p.app_id WHERE k.id=? AND 'app:'||p.app_id=? AND p.status='consumed'",
    actor.keyId,
    actor.id,
  );
  if (!row) throw badCode();
  await batch(env, [
    ["UPDATE applications SET disabled=1 WHERE id=?", [row.app_id]],
    ["UPDATE api_keys SET revoked=1 WHERE app_id=?", [row.app_id]],
    [
      "UPDATE pairing_requests SET status='revoked',credential=NULL,updated=? WHERE id=?",
      [now(), row.id],
    ],
  ]);
  return { revoked: true };
}

export async function prunePairings(env: Env) {
  const time = now();
  await batch(env, [
    [
      "UPDATE api_keys SET revoked=1 WHERE id IN (SELECT key_id FROM pairing_requests WHERE status IN ('pending','approved') AND expires<=?)",
      [time],
    ],
    [
      "UPDATE applications SET disabled=1 WHERE id IN (SELECT app_id FROM pairing_requests WHERE status IN ('pending','approved') AND expires<=?)",
      [time],
    ],
    [
      "UPDATE pairing_requests SET credential=NULL WHERE expires<=? OR status IN ('consumed','revoked','denied')",
      [time],
    ],
    [
      "DELETE FROM pairing_requests WHERE app_id IS NULL AND expires<?",
      [time - 30 * 86400_000],
    ],
  ]);
}
