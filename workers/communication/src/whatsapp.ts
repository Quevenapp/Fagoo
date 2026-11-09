import { observeMetaUsage } from "./number-quota";
import { all, one, exec, batch } from "./db";
import {
  Actor,
  ApiError,
  Conversation,
  Env,
  json,
  now,
  requireValue,
  uid,
} from "./types";
import { access } from "./security";
import { event } from "./events";
import { mediaKind, authorizedMedia } from "./media";
import { conversation, enqueue } from "./service";

export function capabilities(conn: any, chatType = "direct") {
  const cfg = json(conn?.config),
    direct = conn?.kind === "meta",
    qr = conn?.kind === "qr",
    modern = Number(cfg.protocol_version) >= 2;
  const advertised = cfg.features || [];
  const has = (f: string) => direct || (qr && modern) || advertised.includes(f);
  const group = chatType === "group";
  return {
    text: true,
    document: has("document"),
    image: has("image"),
    video: has("video"),
    audio: has("audio"),
    voice: has("voice"),
    sticker: has("sticker"),
    reply: has("reply"),
    reaction: (!group && has("reaction")) || (qr && modern),
    location: (!group && has("location")) || (qr && modern),
    contacts: (!group && has("contacts")) || (qr && modern),
    edit: !direct && has("edit"),
    delete: !direct && has("delete"),
    read: has("read"),
    mentions: qr && modern,
    groups:
      (qr && modern) ||
      (direct && cfg.groups_enabled === true) ||
      advertised.includes("groups"),
    group_manage: (qr && modern) || (direct && cfg.groups_enabled === true),
    calls: direct && !group && cfg.calling_enabled === true,
    video_calls: false,
    upgrade_required: !direct && !modern,
  };
}
export function needCapability(
  conn: any,
  feature: string,
  chatType = "direct",
) {
  if (!(capabilities(conn, chatType) as any)[feature])
    throw new ApiError(
      422,
      "unsupported_capability",
      `O canal não oferece ${feature} nesta conversa. Confira os recursos da conexão e a versão do conector.`,
    );
}
const str = (v: any, max = 200) => typeof v === "string" && v.length <= max;
export async function outgoingContent(
  env: Env,
  actor: Actor,
  c: Conversation,
  data: any,
) {
  const conn = c.connection_id
    ? await one(env, "SELECT * FROM connections WHERE id=?", c.connection_id)
    : null;
  const input = data.content || {},
    out: any = { type: input.type || "text" };
  const ids = data.attachments || [];
  requireValue(Array.isArray(ids) && ids.length <= 10, "Use até 10 anexos.");
  requireValue(
    [
      "text",
      "image",
      "video",
      "audio",
      "voice",
      "document",
      "sticker",
      "location",
      "contacts",
    ].includes(out.type),
    "Tipo de mensagem inválido.",
  );
  requireValue(
    str(data.text ?? "", 3800),
    "Texto inválido ou maior que 3.800 caracteres.",
  );
  if (ids.length) {
    for (const id of ids) {
      const m = await authorizedMedia(env, actor, c.profile_id, id);
      const kind = out.type === "text" ? mediaKind(m.type) : out.type;
      requireValue(
        ["image", "video", "audio", "voice", "document", "sticker"].includes(
          kind,
        ),
        "Tipo incompatível com o anexo.",
      );
      if (conn) {
        needCapability(conn, kind, c.chat_type);
        validateMedia(m, kind, conn);
        if (kind === "sticker") await validateSticker(env, m, conn);
      }
    }
  } else
    requireValue(
      !["image", "video", "audio", "voice", "document", "sticker"].includes(
        out.type,
      ),
      "Este tipo exige anexo.",
    );
  if (out.type === "location") {
    if (conn) needCapability(conn, "location", c.chat_type);
    const l = input.location || {};
    requireValue(
      typeof l.latitude === "number" &&
        Number.isFinite(l.latitude) &&
        Math.abs(l.latitude) <= 90 &&
        typeof l.longitude === "number" &&
        Number.isFinite(l.longitude) &&
        Math.abs(l.longitude) <= 180,
      "Coordenadas inválidas.",
    );
    requireValue(
      str(l.name || "", 200) && str(l.address || "", 500),
      "Nome ou endereço muito longo.",
    );
    out.location = {
      latitude: l.latitude,
      longitude: l.longitude,
      name: l.name || "",
      address: l.address || "",
    };
  }
  if (out.type === "contacts") {
    if (conn) needCapability(conn, "contacts", c.chat_type);
    requireValue(
      Array.isArray(input.contacts) &&
        input.contacts.length > 0 &&
        input.contacts.length <= 10,
      "Envie de 1 a 10 contatos.",
    );
    out.contacts = input.contacts.map((x: any) => {
      requireValue(
        str(x.name, 100) && x.name.trim() && /^\+?\d{8,16}$/.test(x.phone),
        "Informe nome e telefone completo para compartilhar um contato.",
      );
      return { name: x.name.trim(), phone: x.phone };
    });
  }
  if (input.reply_to) {
    if (conn) needCapability(conn, "reply", c.chat_type);
    const m = await one(
      env,
      "SELECT * FROM messages WHERE id=? AND conversation_id=? AND external_id IS NOT NULL AND direction!='note'",
      input.reply_to,
      c.id,
    );
    requireValue(
      m,
      "Mensagem citada não pertence a esta conversa ou ainda não foi enviada.",
    );
    out.reply_to = m.id;
    out.reply_external_id = m.external_id;
    out.reply_participant = json(m.content).participant || null;
    out.reply_from_me = m.direction === "outbound";
    out.reply_text = m.text.slice(0, 500);
  }
  if (input.mentions?.length) {
    if (conn) needCapability(conn, "mentions", c.chat_type);
    requireValue(
      c.chat_type === "group" &&
        Array.isArray(input.mentions) &&
        input.mentions.length <= 30,
      "Menções só podem ser feitas em grupos.",
    );
    const g = await one(
        env,
        "SELECT participants FROM whatsapp_groups WHERE conversation_id=?",
        c.id,
      ),
      members = json(g?.participants, []);
    requireValue(
      input.mentions.every(
        (id: any) => str(id) && members.some((p: any) => p.id === id),
      ),
      "Selecione participantes atuais do grupo.",
    );
    out.mentions = input.mentions;
  }
  requireValue(
    (data.text || "").trim() ||
      ids.length ||
      ["location", "contacts"].includes(out.type),
    "Escreva uma mensagem ou escolha um conteúdo.",
  );
  return out;
}
export function validateMedia(m: any, kind: string, conn: any) {
  const mime = m.type.split(";")[0].toLowerCase(),
    meta =
      conn.kind === "meta" || json(conn.config).platform === "whatsapp_cloud";
  const limits: any = meta
    ? { image: 5, video: 16, audio: 16, voice: 16, document: 100, sticker: 0.5 }
    : {
        image: 20,
        video: 100,
        audio: 100,
        voice: 16,
        document: 100,
        sticker: 1,
      };
  requireValue(
    m.size <= (limits[kind] || 100) * 1024 * 1024,
    `O limite deste canal para ${kind} é ${limits[kind]} MB.`,
  );
  if (kind === "voice")
    requireValue(
      mime === "audio/ogg",
      "Mensagem de voz exige OGG/Opus. Use o gravador do painel.",
    );
  if (kind === "sticker")
    requireValue(mime === "image/webp", "Figurinha exige imagem WebP.");
  if (["image", "audio", "video"].includes(kind))
    requireValue(
      mime.startsWith(kind + "/"),
      "O tipo do arquivo não corresponde à mensagem.",
    );
  if (meta) {
    const formats: any = {
      image: ["image/jpeg", "image/png"],
      video: ["video/mp4", "video/3gpp"],
      audio: ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"],
      voice: ["audio/ogg"],
      sticker: ["image/webp"],
      document: [
        "text/plain",
        "application/pdf",
        "application/msword",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
    };
    if (formats[kind])
      requireValue(
        formats[kind].includes(mime),
        "Formato não aceito pela Meta. Use JPG/PNG, MP4 (H.264/AAC), áudio MP3/M4A/OGG, documento PDF/TXT/Office ou figurinha WebP.",
      );
  }
}
export async function validateSticker(env: Env, media: any, conn: any) {
  const object = await env.MEDIA.get(media.object_key, {
    range: { offset: 0, length: 32 },
  });
  requireValue(object, "Figurinha indisponível.");
  const bytes = new Uint8Array(await object.arrayBuffer()),
    view = new DataView(bytes.buffer),
    text = new TextDecoder();
  requireValue(
    bytes.length >= 30 &&
      text.decode(bytes.slice(0, 4)) === "RIFF" &&
      text.decode(bytes.slice(8, 12)) === "WEBP",
    "Arquivo WebP inválido.",
  );
  const kind = text.decode(bytes.slice(12, 16));
  let width = 0,
    height = 0,
    animated = false;
  if (kind === "VP8X") {
    animated = !!(bytes[20] & 2);
    width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
  } else if (kind === "VP8L" && bytes[20] === 0x2f) {
    const dims = view.getUint32(21, true);
    width = 1 + (dims & 0x3fff);
    height = 1 + ((dims >>> 14) & 0x3fff);
  } else if (
    kind === "VP8 " &&
    bytes[23] === 0x9d &&
    bytes[24] === 1 &&
    bytes[25] === 0x2a
  ) {
    width = view.getUint16(26, true) & 0x3fff;
    height = view.getUint16(28, true) & 0x3fff;
  }
  requireValue(
    width === 512 && height === 512,
    "A figurinha deve ser WebP com 512 × 512 pixels.",
  );
  if (conn.kind === "meta" || json(conn.config).platform === "whatsapp_cloud")
    requireValue(
      media.size <= (animated ? 500 : 100) * 1024,
      "Na Meta, figurinha estática pode ter até 100 KB e animada até 500 KB.",
    );
}
export async function messageAction(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
  key: string,
) {
  access(actor, profile, "conversations:write");
  const c = await conversation(env, data.id, profile, actor);
  requireValue(
    c.owner === actor.id && c.state === "human",
    "Assuma a conversa antes desta ação.",
  );
  const conn = await one(
    env,
    "SELECT * FROM connections WHERE id=?",
    c.connection_id,
  );
  requireValue(conn, "Conversa sem canal WhatsApp.");
  const type = data.action;
  requireValue(
    ["reaction", "edit", "delete", "read"].includes(type),
    "Ação de mensagem inválida.",
  );
  needCapability(conn, type, c.chat_type);
  const m = await one(
    env,
    "SELECT * FROM messages WHERE id=? AND conversation_id=? AND direction!='note'",
    data.message_id,
    c.id,
  );
  requireValue(
    m?.external_id,
    "Mensagem não encontrada ou envio ainda pendente.",
  );
  if (type === "edit" || type === "delete")
    requireValue(
      m.direction === "outbound",
      "Só é possível alterar mensagens enviadas por este canal.",
    );
  if (type === "edit")
    requireValue(
      now() - m.created <= 15 * 60 * 1000 &&
        str(data.text, 3800) &&
        data.text.trim(),
      "Edite um texto enviado nos últimos 15 minutos.",
    );
  if (type === "reaction")
    requireValue(
      str(data.emoji ?? "", 16) &&
        (!data.emoji ||
          [
            ...new Intl.Segmenter("pt", { granularity: "grapheme" }).segment(
              data.emoji,
            ),
          ].length === 1),
      "Informe um emoji ou vazio para remover a reação.",
    );
  const content = {
    type,
    target_id: m.id,
    target_external_id: m.external_id,
    participant: json(m.content).participant || null,
    from_me: m.direction === "outbound",
    emoji: data.emoji || "",
    text: type === "edit" ? data.text : "",
  };
  const delivery = await enqueue(
    env,
    c,
    actor.id,
    "action",
    { text: "", content },
    `action:${actor.id}:${key}`,
  );
  return { delivery_id: delivery, status: "pending" };
}
export async function channelEvent(env: Env, conn: any, data: any) {
  requireValue(
    ["status", "reaction", "edit", "delete", "group"].includes(data.event),
    "Evento de canal inválido.",
  );
  requireValue(
    str(data.message_id, 250) && data.message_id && str(data.external_id, 200),
    "Identificador de evento inválido.",
  );
  if (data.event === "status") await observeMetaUsage(env, conn, data);
  if (data.event === "group") {
    if (data.provider_request_id)
      await exec(
        env,
        "UPDATE group_operations SET status=?,error=?,updated=? WHERE connection_id=? AND json_extract(result,'$.request_id')=?",
        data.provider_errors?.length ? "failed" : "sent",
        data.provider_errors?.length
          ? "Meta informou falha na operação do grupo. Confira as permissões e os participantes."
          : null,
        now(),
        conn.id,
        data.provider_request_id,
      );
    if (data.provider_errors?.length || !data.external_id)
      return { received: true };
    if (data.deleted) {
      await exec(
        env,
        "UPDATE conversations SET state='closed',bot_policy='off',epoch=epoch+1 WHERE connection_id=? AND external_id=? AND chat_type='group' AND (state!='closed' OR bot_policy!='off')",
        conn.id,
        data.external_id,
      );
      await exec(
        env,
        "UPDATE whatsapp_groups SET own_admin=0 WHERE conversation_id IN (SELECT id FROM conversations WHERE connection_id=? AND external_id=?)",
        conn.id,
        data.external_id,
      );
      return { received: true };
    }
    return syncGroup(env, conn, data);
  }
  const payload = { ...data, timestamp: Number(data.timestamp) || now() };
  const eventKey = `${conn.id}:${data.external_id}:${data.message_id}:${data.event}:${data.participant || ""}:${data.event_id || `${payload.timestamp}:${data.status || data.emoji || ""}`}`;
  await exec(
    env,
    "INSERT OR IGNORE INTO channel_events(event_key,connection_id,chat,external_id,kind,payload,created) VALUES(?,?,?,?,?,?,?)",
    eventKey,
    conn.id,
    data.external_id,
    data.message_id,
    data.event,
    JSON.stringify(payload),
    now(),
  );
  await applyChannelEvents(env, conn.id, data.message_id);
  return { received: true };
}
export async function applyChannelEvents(
  env: Env,
  connectionId: string,
  externalId: string,
) {
  const events = await all(
    env,
    "SELECT * FROM channel_events WHERE connection_id=? AND external_id=? AND applied=0 ORDER BY created,event_key",
    connectionId,
    externalId,
  );
  for (const e of events) {
    const m = await one(
      env,
      "SELECT m.*,c.chat_type FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.connection_id=? AND m.external_id=? AND (?='' OR coalesce(c.recipient_id,c.external_id)=?)",
      connectionId,
      externalId,
      e.chat,
      e.chat,
    );
    if (!m) continue;
    const p = json(e.payload),
      content = json(m.content);
    if (e.kind === "status") {
      const ranks: any = { sent: 1, delivered: 2, read: 3, played: 4 };
      if (!ranks[p.status] && p.status !== "failed") continue;
      if (m.chat_type === "group" && p.participant) {
        content.receipts ||= {};
        const old = content.receipts[p.participant];
        if (!old || ranks[p.status] >= (ranks[old.status] || 0))
          content.receipts[p.participant] = {
            status: p.status,
            timestamp: p.timestamp,
          };
        await exec(
          env,
          "UPDATE messages SET content=? WHERE id=?",
          JSON.stringify(content),
          m.id,
        );
      } else if (
        (ranks[p.status] || 0) > (ranks[m.delivery_status] || 0) ||
        (p.status === "failed" && !ranks[m.delivery_status])
      ) {
        await exec(
          env,
          "UPDATE messages SET delivery_status=?,status_at=? WHERE id=?",
          p.status,
          p.timestamp,
          m.id,
        );
      }
    } else if (e.kind === "reaction") {
      content.reactions ||= {};
      const author = String(p.participant || "customer");
      const old = content.reactions[author];
      if (!old || p.timestamp >= old.timestamp)
        content.reactions[author] = {
          emoji: String(p.emoji || "").slice(0, 16),
          timestamp: p.timestamp,
        };
      await exec(
        env,
        "UPDATE messages SET content=? WHERE id=?",
        JSON.stringify(content),
        m.id,
      );
    } else {
      if (p.timestamp >= (content.changed_at || 0)) {
        content.changed_at = p.timestamp;
        if (e.kind === "delete") content.deleted = true;
        else content.edited = true;
        await batch(env, [
          [
            "UPDATE messages SET text=?,content=? WHERE id=?",
            [
              e.kind === "delete"
                ? "Mensagem apagada"
                : String(p.text || "").slice(0, 20000),
              JSON.stringify(content),
              m.id,
            ],
          ],
          [
            "UPDATE conversations SET epoch=epoch+1 WHERE id=?",
            [m.conversation_id],
          ],
        ]);
      }
    }
    await event(
      env,
      m.profile_id,
      "message.updated",
      m.id,
      {
        conversation_id: m.conversation_id,
        message_id: m.id,
        action: e.kind,
        status: p.status || null,
      },
      e.event_key,
    );
    await exec(
      env,
      "UPDATE channel_events SET applied=1 WHERE event_key=?",
      e.event_key,
    );
  }
}
export async function syncGroup(env: Env, conn: any, data: any) {
  requireValue(
    str(data.external_id, 200) && data.external_id,
    "Grupo inválido.",
  );
  let c = await one(
    env,
    "SELECT * FROM conversations WHERE connection_id=? AND external_id=?",
    conn.id,
    data.external_id,
  );
  const title = String(data.subject || data.title || c?.title || "Grupo").slice(
    0,
    128,
  );
  if (!c) {
    const id = uid();
    await exec(
      env,
      "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated,chat_type,title) VALUES(?,?,?,?,?,?,?,?,?,'group',?)",
      id,
      conn.profile_id,
      conn.id,
      "channel:" + conn.id,
      data.external_id,
      uid(),
      0,
      now(),
      now(),
      title,
    );
    c = await one(env, "SELECT * FROM conversations WHERE id=?", id);
  }
  requireValue(
    c.chat_type === "group",
    "Identificador já utilizado por conversa individual.",
  );
  const old = await one(
    env,
    "SELECT * FROM whatsapp_groups WHERE conversation_id=?",
    c.id,
  );
  const members = Array.isArray(data.participants)
    ? data.participants.slice(0, 2048).map((x: any) => ({
        id: String(x.id || x.wa_id || x.user_id || "").slice(0, 200),
        name: String(x.name || "").slice(0, 100),
        admin: !!x.admin,
      }))
    : json(old?.participants, []);
  await batch(env, [
    [
      "UPDATE conversations SET title=?,updated=? WHERE id=?",
      [title, now(), c.id],
    ],
    [
      "INSERT INTO whatsapp_groups(conversation_id,subject,description,participants,own_admin,announcement,invite_link,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET subject=excluded.subject,description=excluded.description,participants=excluded.participants,own_admin=excluded.own_admin,announcement=excluded.announcement,invite_link=excluded.invite_link,updated=excluded.updated",
      [
        c.id,
        title,
        String(data.description ?? old?.description ?? "").slice(0, 2048),
        JSON.stringify(members),
        data.own_admin === undefined
          ? old?.own_admin || 0
          : data.own_admin
            ? 1
            : 0,
        data.announcement === undefined
          ? old?.announcement || 0
          : data.announcement
            ? 1
            : 0,
        data.invite_link ?? old?.invite_link ?? null,
        now(),
      ],
    ],
  ]);
  return { conversation_id: c.id };
}
