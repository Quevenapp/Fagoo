import { scryptSync, timingSafeEqual } from "node:crypto";
import { one, exec } from "./db";
import { ApiError, type Env, type Actor, uid, now, json } from "./types";
const enc = new TextEncoder();
export const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function sha(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}
export function passwordHash(password: string, salt = random()) {
  if (typeof password !== "string")
    throw new ApiError(400, "weak_password", "Informe uma senha.");
  if (password.length < 12 || password.length > 256)
    throw new ApiError(
      400,
      "weak_password",
      "Use uma senha entre 12 e 256 caracteres.",
    );
  return `${salt}:${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
}
export function passwordVerify(password: string, stored: string) {
  try {
    const [salt, hash] = stored.split(":");
    if (password.length > 256) return false;
    const actual = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(actual, Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}
// Fixed scrypt hash of an unknown password: logins for e-mails that do not
// exist run the same key derivation as real accounts, so response time does
// not reveal which e-mails are registered.
const DUMMY_PASSWORD_HASH =
  "67c91b3aa4dd3fe9c74836224e16f8a143c88887bc0525bb173392966dc94ec4:c035d6c1ac69cfec4881e94f578eeb46a439fc47cf16df672dbd1347d22e192e";
export function passwordMatches(
  password: string,
  stored: string | null | undefined,
) {
  const verified = passwordVerify(password, stored || DUMMY_PASSWORD_HASH);
  return !!stored && verified;
}
async function key(env: Env) {
  if (!env.MASTER_KEY || env.MASTER_KEY.length < 32)
    throw new ApiError(
      503,
      "setup_required",
      "Configure MASTER_KEY nos secrets do Worker.",
    );
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", enc.encode(env.MASTER_KEY)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(env: Env, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(env),
    enc.encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(data)),
  });
}
export async function unseal(env: Env, value: string) {
  const row = JSON.parse(value);
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(row.iv) },
        await key(env),
        new Uint8Array(row.data),
      ),
    ),
  );
}
export async function setSecret(env: Env, id: string, value: unknown) {
  await exec(
    env,
    "INSERT INTO secrets(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    id,
    await seal(env, value),
  );
}
export async function secret(env: Env, id: string) {
  const row = await one(env, "SELECT value FROM secrets WHERE id=?", id);
  return row ? unseal(env, row.value) : {};
}
export async function hmac(secret: string, body: string) {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(body)));
}
export function equal(a: string, b: string) {
  const aa = enc.encode(a),
    bb = enc.encode(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export async function rate(
  env: Env,
  key: string,
  limit: number,
  period = 60000,
) {
  const bucket = Math.floor(now() / period);
  const result = await one(
    env,
    "INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
    `${key}:${bucket}`,
    now() + period,
  );
  if (result.count > limit)
    throw new ApiError(
      429,
      "rate_limited",
      "Limite de requisições atingido. Aguarde antes de repetir.",
    );
}
export function canProfile(actor: Actor, id: string) {
  if (actor.fagoo) return actor.profiles.includes(id);
  return actor.role === "admin" || actor.profiles.includes(id);
}
export function access(actor: Actor, profile: string, scope: string) {
  if (!canProfile(actor, profile))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  if ((actor.kind === "app" || actor.fagoo) && !actor.scopes.includes(scope) && !(actor.fagoo && actor.scopes.includes('*')))
    throw new ApiError(403, "missing_scope", `Permissão necessária: ${scope}`);
}
export function admin(actor: Actor) {
  if (actor.kind !== "user" || actor.role !== "admin")
    throw new ApiError(403, "admin_required", "Somente administradores.");
}
function userActor(row: any): Actor {
  return {
    id: row.id,
    kind: "user",
    name: row.name,
    role: row.role,
    profiles: json(row.profiles, []),
    scopes: [],
    bots: [],
    rate: 300,
    runLimit: 10,
  };
}
export const MOBILE_TOKEN_PREFIX = "wabu_";
export async function authenticate(env: Env, request: Request): Promise<Actor> {
  if (env.FAGOO_MANAGED === 'true') {
    if (env.FAGOO_ACTOR) return env.FAGOO_ACTOR;
  }
  const bearer = request.headers
    .get("Authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && bearer.startsWith(MOBILE_TOKEN_PREFIX)) {
    if(env.FAGOO_MANAGED === 'true') throw new ApiError(401,'fagoo_login_required','Entre pelo Fagoo.');
    // Mobile user session: identifies a person, no Origin check (native app).
    const hash = await sha(bearer);
    const row = await one(
      env,
      "SELECT u.*,s.last_used session_last_used FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.kind='bearer' AND s.expires>? AND u.disabled=0",
      hash,
      now(),
    );
    if (!row)
      throw new ApiError(
        401,
        "invalid_token",
        "Sessão inválida ou expirada. Entre novamente.",
      );
    if (!row.session_last_used || row.session_last_used < now() - 3600000)
      await exec(
        env,
        "UPDATE sessions SET last_used=? WHERE hash=?",
        now(),
        hash,
      );
    return userActor(row);
  }
  if (bearer) {
    const row = await one(
      env,
      "SELECT k.id key_id,a.* FROM api_keys k JOIN applications a ON a.id=k.app_id WHERE k.hash=? AND k.revoked=0 AND k.expires>? AND a.disabled=0",
      await sha(bearer),
      now(),
    );
    if (!row)
      throw new ApiError(401, "invalid_token", "Chave inválida ou expirada.");
    await rate(env, `app:${row.id}`, row.rate);
    return {
      id: `app:${row.id}`,
      kind: "app",
      name: row.name,
      role: "service",
      profiles: json(row.profiles, []),
      scopes: json(row.scopes, []),
      bots: json(row.bots, []),
      keyId: row.key_id,
      rate: row.rate,
      runLimit: row.run_limit,
    };
  }
  if(env.FAGOO_MANAGED === 'true') throw new ApiError(401,'fagoo_login_required','Entre pelo Fagoo.');
  const token = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)wabotia=([^;]+)/)?.[1];
  const row = token
    ? await one(
        env,
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.kind='cookie' AND s.expires>? AND u.disabled=0",
        await sha(token),
        now(),
      )
    : null;
  if (!row) throw new ApiError(401, "unauthenticated", "Entre na sua conta.");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin !== new URL(request.url).origin)
      throw new ApiError(
        403,
        "invalid_origin",
        "Origem da requisição inválida.",
      );
  }
  return userActor(row);
}
export function publicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "invalid_url", "Informe uma URL HTTPS válida.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && !["443"].includes(url.port)) ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":")
  )
    throw new ApiError(
      400,
      "invalid_url",
      "Use um domínio HTTPS público, sem credenciais ou endereço IP.",
    );
  return url.toString().replace(/\/$/, "");
}
export async function safeFetch(url: string, options: RequestInit = {}) {
  const response = await fetch(publicUrl(url), {
    ...options,
    redirect: "manual",
    signal: options.signal ?? AbortSignal.timeout(15000),
  });
  if (response.status >= 300 && response.status < 400)
    throw new ApiError(
      502,
      "redirect_refused",
      "O serviço redirecionou a requisição. Configure a URL final.",
    );
  return response;
}

export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
