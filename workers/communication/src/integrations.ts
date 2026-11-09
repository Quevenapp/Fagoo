import { all, one, exec } from "./db";
import {
  ApiError,
  type Env,
  type Run,
  uid,
  now,
  json,
  requireValue,
} from "./types";
import { mediaKind, putStream, multipartStream } from "./media";
import { validateMedia } from "./whatsapp";
import { metaRequest } from "./meta";
import { metaCredentials } from "./meta-accounts";
import { secret, setSecret, safeFetch, random, sha } from "./security";
export async function hermesRequest(
  env: Env,
  connection: any,
  path: string,
  body?: any,
  profile?: string,
  idem?: string,
) {
  const cfg = json(connection.config),
    keys = await secret(env, `connection:${connection.id}`);
  const api = path.startsWith("/v1/");
  const base = api ? cfg.api_url || cfg.url : cfg.url;
  const token = api
    ? keys.profile_keys?.[profile || "default"]
    : keys.dashboard_token;
  requireValue(
    token,
    `Configure a chave ${api ? "API_SERVER_KEY do perfil " + profile : "do backend administrativo"} do Hermes.`,
  );
  const prefix =
    api && profile && profile !== "default"
      ? `/p/${encodeURIComponent(profile)}`
      : "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (keys.access_client_id) {
    headers["CF-Access-Client-Id"] = keys.access_client_id;
    headers["CF-Access-Client-Secret"] = keys.access_client_secret;
  }
  if (idem) headers["Idempotency-Key"] = idem;
  const r = await safeFetch(`${base}${prefix}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok)
    throw new ApiError(
      502,
      "hermes_error",
      `Hermes respondeu HTTP ${r.status}.`,
    );
  const result = await r.json<any>();
  await exec(
    env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    connection.id,
  );
  return result;
}

export async function hermesArtifact(
  env: Env,
  connection: any,
  profile: string,
  artifactId: string,
  name: string,
  actor: string,
) {
  requireValue(
    /^[A-Za-z0-9_-]{8,200}$/.test(artifactId),
    "Referência de arquivo inválida.",
  );
  const cfg = json(connection.config),
    keys = await secret(env, `connection:${connection.id}`);
  requireValue(
    keys.profile_keys?.[profile],
    "Configure a API_SERVER_KEY do perfil Hermes.",
  );
  const prior = await one(
    env,
    "SELECT * FROM artifact_imports WHERE connection_id=? AND remote_profile=? AND artifact_id=?",
    connection.id,
    profile,
    artifactId,
  );
  if (prior) {
    requireValue(
      prior.actor === actor,
      "Artefato pertence a outra identidade.",
    );
    const existing = await one(
      env,
      "SELECT id FROM media WHERE id=? AND actor=?",
      prior.media_id,
      actor,
    );
    if (existing) return existing.id;
    // A completed R2 write can be recovered even if the following D1 write was interrupted.
    const key = `${connection.profile_id}/${prior.media_id}`,
      obj = await env.MEDIA.head(key);
    if (obj) {
      await exec(
        env,
        "INSERT OR IGNORE INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
        prior.media_id,
        connection.profile_id,
        prior.name,
        obj.httpMetadata?.contentType || "application/octet-stream",
        obj.size,
        key,
        actor,
        now(),
      );
      await exec(
        env,
        "UPDATE artifact_imports SET state='complete' WHERE media_id=?",
        prior.media_id,
      );
      return prior.media_id;
    }
    throw new ApiError(
      409,
      "artifact_unknown",
      "Download de uso único interrompido. Exporte um novo artefato no Hermes; o download anterior não será repetido automaticamente.",
    );
  }
  const id = uid();
  await exec(
    env,
    "INSERT INTO artifact_imports(connection_id,remote_profile,artifact_id,media_id,actor,name,created) VALUES(?,?,?,?,?,?,?)",
    connection.id,
    profile,
    artifactId,
    id,
    actor,
    name.slice(0, 200),
    now(),
  );
  const headers: Record<string, string> = {
    Authorization: "Bearer " + keys.profile_keys[profile],
  };
  if (keys.access_client_id) {
    headers["CF-Access-Client-Id"] = keys.access_client_id;
    headers["CF-Access-Client-Secret"] = keys.access_client_secret;
  }
  const prefix =
    profile === "default" ? "" : `/p/${encodeURIComponent(profile)}`;
  const response = await safeFetch(
    `${cfg.api_url || cfg.url}${prefix}/v1/artifacts/download/${encodeURIComponent(artifactId)}`,
    { headers },
  );
  await storeRemoteMedia(
    env,
    connection.profile_id,
    name.slice(0, 200),
    response.headers.get("Content-Type") || "application/octet-stream",
    response,
    { id, actor },
  );
  await exec(
    env,
    "UPDATE artifact_imports SET state='complete' WHERE media_id=?",
    id,
  );
  return id;
}
export async function discover(env: Env, id: string, profile: string) {
  const c = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind='hermes'",
    id,
    profile,
  );
  requireValue(c, "Conexão Hermes não encontrada.");
  const data = await hermesRequest(env, c, "/api/profiles");
  for (const p of data.profiles || []) {
    if (typeof p.name !== "string") continue;
    await exec(
      env,
      "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,remote_profile) DO UPDATE SET name=excluded.name",
      uid(),
      profile,
      c.id,
      p.name,
      p.display_name || p.name,
    );
  }
  const keys = await secret(env, `connection:${id}`);
  const checks: Record<string, any> = {};
  const remoteProfiles = Object.keys(keys.profile_keys || {});
  requireValue(
    remoteProfiles.length <= 20,
    "Use no máximo 20 perfis por conexão Hermes.",
  );
  await Promise.all(
    remoteProfiles.map(async (remote) => {
      const cap = await hermesRequest(
        env,
        c,
        "/v1/capabilities",
        undefined,
        remote,
      );
      requireValue(
        cap.features?.runs_idempotency?.supported &&
          cap.features?.runs_idempotency?.durable,
        "Atualize o Hermes: é necessária a API /v1/runs com idempotência durável.",
      );
      checks[remote] = cap.features?.runs_idempotency;
    }),
  );
  requireValue(
    Object.keys(checks).length,
    "Configure pelo menos uma API_SERVER_KEY de perfil.",
  );
  await exec(
    env,
    "UPDATE connections SET config=?,last_seen=? WHERE id=?",
    JSON.stringify({
      ...json(c.config),
      verified_at: now(),
      capabilities: checks,
    }),
    now(),
    id,
  );
  return all(env, "SELECT * FROM bots WHERE connection_id=?", id);
}
export async function probe(
  env: Env,
  id: string,
  profile: string,
  origin: string,
) {
  const c = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  requireValue(c, "Conexão não encontrada.");
  const cfg = json(c.config),
    keys =
      c.kind === "meta"
        ? await metaCredentials(env, c)
        : await secret(env, `connection:${id}`);
  let details: any = {};
  if (c.kind === "hermes")
    return { ok: true, bots: await discover(env, id, profile) };
  if (c.kind === "telegram") {
    const me = await telegram(env, id, "getMe", {});
    requireValue(me.result?.id, "Token Telegram inválido.");
    const chat = await telegram(env, id, "getChat", { chat_id: cfg.group });
    requireValue(
      chat.result?.is_forum && !chat.result?.username,
      "Use um grupo privado com tópicos.",
    );
    const member = await telegram(env, id, "getChatMember", {
      chat_id: cfg.group,
      user_id: me.result.id,
    });
    requireValue(
      member.result?.status === "administrator" &&
        member.result?.can_manage_topics,
      "O bot deve administrar o grupo e gerenciar tópicos.",
    );
    details = { username: me.result.username, group: cfg.group };
  }
  if (c.kind === "meta") {
    requireValue(
      keys.token && keys.app_secret && keys.verify_token,
      "Preencha token, App Secret e Verify Token.",
    );
    const response = await safeFetch(
      `https://graph.facebook.com/v23.0/${cfg.phone_id}?fields=id,display_phone_number`,
      { headers: { Authorization: `Bearer ${keys.token}` } },
    );
    requireValue(response.ok, "A Meta não validou as credenciais.");
    details = await response.json();
  }
  if (["qr", "hermes-whatsapp"].includes(c.kind)) {
    requireValue(
      c.last_seen && now() - c.last_seen < 60000,
      "O conector está offline. Inicie-o antes de testar.",
    );
    details = { online: true };
  }
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({ ...cfg, verified_at: now() }),
    id,
  );
  return { ok: true, ...details };
}
export async function configureTelegram(
  env: Env,
  id: string,
  profile: string,
  origin: string,
) {
  const c = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind='telegram'",
    id,
    profile,
  );
  requireValue(c, "Conexão não encontrada.");
  const keys = await secret(env, `connection:${id}`);
  keys.webhook_secret ||= random();
  await setSecret(env, `connection:${id}`, keys);
  await telegram(env, id, "setWebhook", {
    url: `${origin}/webhooks/telegram/${id}`,
    secret_token: keys.webhook_secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  return { configured: true };
}
export async function telegram(
  env: Env,
  id: string,
  method: string,
  body: any,
) {
  const keys = await secret(env, `connection:${id}`);
  requireValue(keys.token, "Token Telegram não configurado.");
  const r = await fetch(`https://api.telegram.org/bot${keys.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = await r.json<any>();
  if (!result.ok)
    throw new ApiError(
      r.status >= 400 ? r.status : 502,
      "telegram_error",
      `Telegram: ${result.description || "requisição recusada"}`,
    );
  return result;
}
export async function storeRemoteMedia(
  env: Env,
  profile: string,
  name: string,
  type: string,
  response: Response,
  identity?: { id: string; actor: string },
) {
  requireValue(
    response.ok && response.body,
    "Não foi possível obter o arquivo.",
  );
  const id = identity?.id || uid(),
    objectKey = `${profile}/${id}`;
  const size = await putStream(env, objectKey, type, response);
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    profile,
    name,
    type,
    size,
    objectKey,
    identity?.actor || "transport",
    now(),
  );
  return id;
}
export async function telegramFile(
  env: Env,
  connection: any,
  fileId: string,
  name: string,
  type: string,
) {
  const info = await telegram(env, connection.id, "getFile", {
    file_id: fileId,
  });
  requireValue(
    (info.result.file_size || 0) <= 20 * 1024 * 1024,
    "Arquivo Telegram excede 20 MB.",
  );
  const keys = await secret(env, `connection:${connection.id}`);
  return storeRemoteMedia(
    env,
    connection.profile_id,
    name,
    type,
    await fetch(
      `https://api.telegram.org/file/bot${keys.token}/${info.result.file_path}`,
    ),
  );
}
export async function telegramMedia(
  env: Env,
  connection: string,
  chat: string,
  thread: string | null,
  mediaId: string,
  payload: any = {},
) {
  const m = await one(env, "SELECT * FROM media WHERE id=?", mediaId);
  requireValue(m, "Anexo não encontrado.");
  requireValue(
    m.size <= 50 * 1024 * 1024,
    "O espelhamento Telegram aceita arquivos de até 50 MB.",
  );
  const obj = await env.MEDIA.get(m.object_key);
  requireValue(obj, "Arquivo ausente.");
  const type = payload.content?.type || mediaKind(m.type);
  const native: any = {
    image: ["photo", "sendPhoto"],
    video: ["video", "sendVideo"],
    audio: ["audio", "sendAudio"],
    voice: ["voice", "sendVoice"],
    sticker: ["sticker", "sendSticker"],
  };
  const [field, method] = native[type] || ["document", "sendDocument"];
  const fields: any = {
    chat_id: chat,
    ...(thread ? { message_thread_id: thread } : {}),
    ...(payload.text && type !== "sticker"
      ? { caption: payload.text.slice(0, 1024) }
      : {}),
  };
  const body = multipartStream(fields, field, m.name, m.type, obj.body, m.size),
    keys = await secret(env, `connection:${connection}`);
  const r = await fetch(`https://api.telegram.org/bot${keys.token}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": body.type,
      "Content-Length": String(body.length),
    },
    body: body.stream,
    signal: AbortSignal.timeout(60000),
  });
  const data = await r.json<any>();
  if (!data.ok)
    throw new ApiError(
      r.status >= 500 ? 502 : 400,
      "telegram_error",
      "Telegram recusou o anexo.",
    );
  return String(data.result.message_id);
}
export async function metaSend(
  env: Env,
  c: any,
  to: string,
  payload: any,
  template = false,
  expiresAt?: number,
) {
  const keys = await metaCredentials(env, c),
    cfg = json(c.config);
  const body: any = { messaging_product: "whatsapp", to, ...payload };
  if (typeof expiresAt === "number" && expiresAt <= now())
    throw new ApiError(
      410,
      "message_expired",
      "Validade da mensagem encerrada antes do envio.",
    );
  const r = await safeFetch(
    `https://graph.facebook.com/v23.0/${cfg.phone_id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok)
    throw new ApiError(
      r.status >= 500 ? 502 : 400,
      "meta_error",
      `Meta recusou o envio (HTTP ${r.status}).`,
    );
  const data = await r.json<any>();
  return data.messages?.[0]?.id;
}
export async function metaUpload(
  env: Env,
  c: any,
  mediaId: string,
  kind: string,
) {
  const m = await one(
    env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    mediaId,
    c.profile_id,
  );
  requireValue(m, "Anexo não encontrado.");
  validateMedia(m, kind, c);
  const obj = await env.MEDIA.get(m.object_key);
  requireValue(obj, "Arquivo ausente.");
  const keys = await metaCredentials(env, c),
    cfg = json(c.config);
  const body = multipartStream(
    { messaging_product: "whatsapp" },
    "file",
    m.name,
    m.type,
    obj.body,
    m.size,
  );
  const r = await fetch(
    `https://graph.facebook.com/v23.0/${cfg.phone_id}/media`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys.token}`,
        "Content-Type": body.type,
        "Content-Length": String(body.length),
      },
      body: body.stream,
      signal: AbortSignal.timeout(60000),
    },
  );
  const data = await r.json<any>();
  if (!r.ok || !data.id)
    throw new ApiError(
      400,
      "meta_media_error",
      "Meta recusou o arquivo. Confira tamanho, formato e codecs.",
    );
  return { id: String(data.id), name: m.name };
}
export async function metaMedia(
  env: Env,
  c: any,
  to: string,
  mediaId: string,
  payload: any = {},
  group = false,
) {
  const m = await one(
    env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    mediaId,
    c.profile_id,
  );
  requireValue(m, "Anexo não encontrado.");
  const kind =
    payload.content?.type && payload.content.type !== "text"
      ? payload.content.type
      : mediaKind(m.type);
  const data = await metaUpload(env, c, mediaId, kind);
  const type = kind === "voice" ? "audio" : kind;
  const details: any = { id: data.id };
  if (type === "document") details.filename = m.name;
  if (["document", "image", "video"].includes(type) && payload.text)
    details.caption = payload.text;
  if (kind === "voice") details.voice = true;
  return metaSend(
    env,
    c,
    to,
    {
      type,
      [type]: details,
      ...(group ? { recipient_type: "group" } : {}),
      ...(payload.content?.reply_external_id
        ? { context: { message_id: payload.content.reply_external_id } }
        : {}),
    },
    false,
    payload.expires_at,
  );
}
export async function metaContent(
  env: Env,
  c: any,
  to: string,
  payload: any,
  group = false,
) {
  const content = payload.content || {},
    kind = content.type || "text";
  let body: any = { type: "text", text: { body: payload.text } };
  if (kind === "reaction")
    body = {
      type: "reaction",
      reaction: {
        message_id: content.target_external_id,
        emoji: content.emoji,
      },
    };
  if (kind === "location")
    body = { type: "location", location: content.location };
  if (kind === "contacts")
    body = {
      type: "contacts",
      contacts: content.contacts.map((x: any) => ({
        name: { formatted_name: x.name, first_name: x.name },
        phones: [{ phone: x.phone, type: "CELL" }],
      })),
    };
  if (kind === "call_permission")
    body = {
      type: "interactive",
      interactive: {
        type: "call_permission_request",
        action: { name: "call_permission_request" },
        body: { text: payload.text },
      },
    };
  if (kind === "interactive" && !group) {
    requireValue(
      content.interactive &&
        ["button", "list"].includes(content.interactive.type),
      "Menu interativo inválido.",
    );
    body = { type: "interactive", interactive: content.interactive };
  }
  if (kind === "read") {
    await metaRequest(env, c, `${json(c.config).phone_id}/messages`, "POST", {
      messaging_product: "whatsapp",
      status: "read",
      message_id: content.target_external_id,
    });
    return content.target_external_id;
  }
  if (content.reply_external_id)
    body.context = { message_id: content.reply_external_id };
  if (group) body.recipient_type = "group";
  return metaSend(env, c, to, body, false, payload.expires_at);
}
export async function templatePayload(
  env: Env,
  c: any,
  conversation: any,
  payload: any,
  cfg: any,
) {
  const consent = await one(
    env,
    "SELECT status FROM consents WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
    conversation.id,
  );
  if (consent?.status !== "granted" || !cfg.notifications?.enabled)
    throw new ApiError(
      409,
      "notification_waiting",
      "Aguardando consentimento e template.",
    );
  const keys = await metaCredentials(env, c);
  const config = json(c.config);
  requireValue(config.waba_id, "Configure WABA ID para verificar templates.");
  const response = await safeFetch(
    `https://graph.facebook.com/v23.0/${config.waba_id}/message_templates?name=${encodeURIComponent(cfg.notifications.template_name)}`,
    { headers: { Authorization: `Bearer ${keys.token}` } },
  );
  if (!response.ok)
    throw new ApiError(
      409,
      "template_unverified",
      "Não foi possível verificar o template.",
    );
  const templates = await response.json<any>();
  const t = templates.data?.find(
    (t: any) =>
      t.name === cfg.notifications.template_name &&
      t.language === cfg.notifications.language &&
      t.status === "APPROVED" &&
      t.category === "UTILITY",
  );
  requireValue(t, "Template UTILITY ainda não aprovado pela Meta.");
  requireValue(
    approvedTemplate(t),
    "Use um template UTILITY com corpo contendo {{1}} e {{2}}, cabeçalho textual estático e sem botões dinâmicos.",
  );
  return {
    type: "template",
    template: {
      name: t.name,
      language: { code: t.language },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: payload.ticket_id || "Atendimento" },
            { type: "text", text: payload.text.slice(0, 1000) },
          ],
        },
      ],
    },
  };
}
export function approvedTemplate(t: any) {
  if (t?.status !== "APPROVED" || t?.category !== "UTILITY") return false;
  const body = t.components?.find((c: any) => c.type === "BODY");
  const slots = Array.from(
    new Set((body?.text || "").match(/\{\{\s*\d+\s*\}\}/g) || []),
  )
    .sort()
    .join(",")
    .replaceAll(" ", "");
  return (
    slots === "{{1}},{{2}}" &&
    t.components.every(
      (c: any) =>
        c.type === "BODY" ||
        (c.type === "FOOTER" && !/\{\{/.test(c.text || "")) ||
        (c.type === "HEADER" &&
          c.format === "TEXT" &&
          !/\{\{/.test(c.text || "")),
    )
  );
}
