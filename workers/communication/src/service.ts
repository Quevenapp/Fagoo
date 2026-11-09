import { all, one, exec, batch } from "./db";
import {queueContactProjection} from './contact-projection';
import { managedVisible, requireCapability, configured, currentGrant, actorFromGrant, canonicalActor } from './managed';
import {
  ApiError,
  type Env,
  type Actor,
  type Conversation,
  uid,
  now,
  json,
  defaults,
  requireValue,
} from "./types";
import {
  access,
  admin,
  random,
  sha,
  setSecret,
  publicUrl,
  passwordHash,
} from "./security";
import { event, audit } from "./events";
import { visibleConversation } from "./visibility";
import { probe, discover, configureTelegram } from "./integrations";
import { secret } from "./security";
import { contactCommand } from "./contacts";
import { authorizedMedia, mediaKind, uploadCommand } from "./media";
import {
  outgoingContent,
  messageAction,
  channelEvent,
  applyChannelEvents,
  syncGroup,
  needCapability,
} from "./whatsapp";
import { callCommand } from "./calls";
import { groupCommand } from "./groups";
import { accountCommand } from "./meta-accounts";
import { routerCommand, managedAppAllowed } from "./number-router";
import { queueWithNumberQuota } from "./number-quota";
import {
  saveLine,
  validateLineIds,
  botAllowsLine,
  serviceForLine,
  sendMenu,
  availableMenus,
} from "./line-service";
import { internalCommand } from "./team";
import {
  validateDepartments,
  departmentFor,
  assertDepartmentAccess,
  presentInDepartment,
} from "./departments";
import { sendProtocolLookup } from "./protocol-lookup";
import {
  assertNumberDelivery,
  getNumberPolicy,
  numberPolicyError,
} from "./number-permissions";
export const scopes = [
  "routing:read",
  "routing:send",
  "routing:paid",
  "calls:read",
  "calls:write",
  "groups:manage",
  "conversations:read",
  "conversations:write",
  "contacts:read",
  "contacts:write",
  "notes:read",
  "tickets:read",
  "tickets:write",
  "knowledge:read",
  "knowledge:write",
  "media:read",
  "media:write",
  "reports:read",
  "presence:read",
  "presence:write",
  "bots:read",
  "bots:invoke",
  "events:read",
  "webhooks:manage",
];
export const eventTypes = [
  "conversation.created",
  "conversation.updated",
  "message.received",
  "message.sent",
  "message.updated",
  "call.updated",
  "ticket.created",
  "ticket.updated",
  "bot.run.completed",
  "bot.run.failed",
];
const text = (value: any, max = 3800) => {
  requireValue(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    `Informe um texto de até ${max} caracteres.`,
  );
  return value.trim();
};
export async function settings(env: Env, profile: string) {
  const row = await one(env, "SELECT * FROM profiles WHERE id=?", profile);
  if (!row) throw new ApiError(404, "not_found", "Perfil não encontrado.");
  return { ...defaults, ...json(row.settings) };
}
export async function conversation(
  env: Env,
  id: string,
  profile: string,
  actor?: Actor,
  claim = false,
) {
  const row = await one<Conversation>(
    env,
    "SELECT * FROM conversations WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!row || (actor && !(actor.fagoo && claim ? managedVisible(actor,row,true) : visibleConversation(actor, row))))
    throw new ApiError(404, "not_found", "Conversa não encontrada.");
  return actor?.fagoo ? {...row,owner:canonicalActor(actor,row.owner) ?? null} : row;
}
export async function mediaIds(env: Env, profile: string, ids: any) {
  requireValue(Array.isArray(ids) && ids.length <= 10, "Use até 10 anexos.");
  for (const id of ids)
    requireValue(
      await one(
        env,
        "SELECT id FROM media WHERE id=? AND profile_id=?",
        id,
        profile,
      ),
      "Anexo não encontrado neste perfil.",
    );
  return ids;
}
export async function enqueue(
  env: Env,
  c: Conversation,
  actor: string,
  kind: string,
  payload: any,
  dedupe: string,
) {
  await assertNumberDelivery(env, c.connection_id, actor, kind, payload);
  if (payload.attachments?.length) {
    const ids: string[] = [];
    const firstMedia = await one(
      env,
      "SELECT type FROM media WHERE id=?",
      payload.attachments[0],
    );
    const firstKind =
      payload.content?.type && payload.content.type !== "text"
        ? payload.content.type
        : mediaKind(firstMedia?.type || "application/octet-stream");
    const caption =
      !!payload.content && ["image", "video", "document"].includes(firstKind);
    if (payload.text && !caption)
      ids.push(
        await enqueue(
          env,
          c,
          actor,
          kind,
          {
            ...payload,
            attachments: [],
            content: payload.content
              ? { ...payload.content, type: "text" }
              : undefined,
          },
          dedupe + ":text",
        ),
      );
    for (const [index, attachment] of payload.attachments.entries())
      ids.push(
        await enqueue(
          env,
          c,
          actor,
          kind,
          {
            ...payload,
            text: caption && index === 0 ? payload.text : "",
            attachments: [],
            media_id: attachment,
            content: {
              ...payload.content,
              type:
                !payload.content?.type || payload.content.type === "text"
                  ? mediaKind(
                      (
                        await one(
                          env,
                          "SELECT type FROM media WHERE id=?",
                          attachment,
                        )
                      )?.type || "application/octet-stream",
                    )
                  : payload.content.type,
            },
          },
          dedupe + ":media:" + index,
        ),
      );
    return ids[0];
  }
  const id = uid();
  const managed =
    kind !== "team" &&
    c.connection_id &&
    (await one(
      env,
      "SELECT connection_id FROM meta_numbers WHERE connection_id=?",
      c.connection_id,
    ));
  if (
    managed &&
    !(await managedAppAllowed(
      env,
      actor,
      c.connection_id!,
      payload.router_source,
      !!payload.template_message,
    ))
  )
    throw new ApiError(
      403,
      "source_not_allowed",
      "Aplicação sem autorização para este número do roteador.",
    );
  if (managed && payload.template_message)
    requireValue(
      payload.paid_authorization?.actor === actor && payload.router_source,
      "Modelo pago exige autorização individual pelo roteador.",
    );
  const category =
    kind === "team" || payload.content?.type === "read"
      ? "action"
      : kind === "template" ||
          (!managed &&
            kind === "notification" &&
            now() - c.last_customer >= 86400000)
        ? "template"
        : "service";
  await queueWithNumberQuota(
    env,
    [
      id,
      c.profile_id,
      c.id,
      c.connection_id,
      c.epoch,
      kind,
      actor,
      JSON.stringify(payload),
      dedupe,
      now(),
      now(),
    ],
    category,
  );
  return (await one(env, "SELECT id FROM outbox WHERE dedupe=?", dedupe)).id;
}
export async function message(
  env: Env,
  c: Conversation,
  direction: string,
  actor: string,
  value: string,
  attachments: string[] = [],
  external: string | null = null,
) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created) VALUES(?,?,?,?,?,?,?,?,?)",
    id,
    c.profile_id,
    c.id,
    direction,
    actor,
    value,
    JSON.stringify(attachments),
    external,
    now(),
  );
  return id;
}
export async function openTicket(
  env: Env,
  c: Conversation,
  actor: string,
  title: string,
  dedupe = false,
) {
  if (dedupe) {
    const old = await one(
      env,
      "SELECT * FROM tickets WHERE conversation_id=? AND status!='closed'",
      c.id,
    );
    if (old) return old;
  }
  const config = await settings(env, c.profile_id);
  const id = uid(),
    number = `WA-${now().toString(36).toUpperCase()}-${id.slice(0, 4).toUpperCase()}`;
  await exec(
    env,
    "INSERT INTO tickets(id,number,profile_id,conversation_id,title,owner,response_due_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    id,
    number,
    c.profile_id,
    c.id,
    title,
    c.owner,
    config.protocol_response_hours
      ? now() + Number(config.protocol_response_hours) * 3600000
      : null,
    now(),
    now(),
  );
  await event(env, c.profile_id, "ticket.created", id, {
    id,
    number,
    conversation_id: c.id,
  });
  return await one(env, "SELECT * FROM tickets WHERE id=?", id);
}
export async function requestSurvey(
  env: Env,
  c: Conversation,
  key: string,
  actor = "system",
  question?: string,
) {
  requireValue(
    c.chat_type !== "group",
    "Peça uma avaliação em uma conversa individual.",
  );
  const pending = await one(
    env,
    "SELECT id FROM surveys WHERE conversation_id=? AND app_id IS NULL AND status='pending' AND created>? ORDER BY created DESC LIMIT 1",
    c.id,
    now() - 86400000,
  );
  const id = pending?.id || `survey:${key}`;
  const delivery = await enqueue(
    env,
    c,
    actor,
    "text",
    {
      text: `${question || "Como você avalia este atendimento?"}\nResponda de 1 a 5 e, se desejar, escreva um comentário. Para sair da avaliação, envie MENU.`,
    },
    key,
  );
  if (!pending)
    await exec(
      env,
      "INSERT OR IGNORE INTO surveys(id,profile_id,conversation_id,created) VALUES(?,?,?,?)",
      id,
      c.profile_id,
      c.id,
      now(),
    );
  return { survey_id: id, delivery_id: delivery, status: "pending" };
}
export async function handoff(
  env: Env,
  c: Conversation,
  reason: string,
  departmentId: string | null = null,
) {
  const department = await departmentFor(env, c.profile_id, departmentId);
  requireValue(
    !departmentId || department,
    "Setor de atendimento indisponível.",
  );
  const policy = await getNumberPolicy(env, c.connection_id);
  await batch(env, [
    [
      "UPDATE conversations SET state='waiting',owner=NULL,assigned_bot_id=NULL,department_id=?,menu_active=0,epoch=epoch+1,updated=? WHERE id=?",
      [departmentId, now(), c.id],
    ],
    [
      "UPDATE tickets SET owner=NULL WHERE conversation_id=? AND status!='closed'",
      [c.id],
    ],
  ]);
  c = await conversation(env, c.id, c.profile_id);
  const present = await presentInDepartment(env, c.profile_id, departmentId);
  const cfg = await settings(env, c.profile_id);
  let reply = department
    ? `Vou encaminhar sua solicitação para o setor ${department.name}.`
    : "Vou encaminhar sua solicitação para nossa equipe.";
  if (!present) {
    const ticket = await openTicket(env, c, "system", reason, true);
    reply = `${department ? `O setor ${department.name} está sem atendentes disponíveis.\n` : ""}${cfg.absence_instructions}\nProtocolo: ${ticket.number}. Para acompanhar, envie CONSULTAR PROTOCOLO ou o número completo.`;
  }
  if (policy.human && policy.service && (policy.menu || policy.bots))
    await enqueue(
      env,
      c,
      "system",
      "text",
      { text: reply },
      `handoff:${c.id}:${c.session}:${departmentId || "general"}`,
    );
  if (cfg.telegram_connection && cfg.telegram_group)
    await enqueue(
      env,
      c,
      "system",
      "team",
      {
        text: `Novo atendimento${department ? ` · Setor ${department.name}` : ""}\n${c.phone || c.external_id}\n${reason}`,
        group: cfg.telegram_group,
      },
      `topic:${c.id}:${c.session}:${departmentId || "general"}`,
    );
  await event(env, c.profile_id, "conversation.updated", c.id, {
    state: "waiting",
    department_id: departmentId,
    reason,
  });
}
export async function inbound(
  env: Env,
  profile: string,
  data: any,
  namespace: string,
  connectionId: string | null,
) {
  requireValue(
    typeof data.external_id === "string" && data.external_id.length <= 200,
    "Informe o identificador externo.",
  );
  requireValue(
    typeof data.message_id === "string" && data.message_id.length <= 250,
    "Informe message_id.",
  );
  requireValue(
    typeof data.text === "string" && data.text.length <= 20000,
    "Texto inválido.",
  );
  const attachments = await mediaIds(env, profile, data.attachments || []);
  if (namespace.startsWith("app:")) {
    const appId = namespace.slice(4);
    for (const id of attachments)
      requireValue(
        (await one(env, "SELECT actor FROM media WHERE id=?", id))?.actor ===
          appId,
        "Anexo não pertence a esta aplicação.",
      );
  }
  const content =
    data.content && typeof data.content === "object" ? data.content : {};
  const isGroup = data.chat_type === "group";
  if (isGroup) {
    requireValue(
      !!connectionId && namespace.startsWith("channel:"),
      "Grupos precisam de um canal autenticado.",
    );
    requireValue(
      typeof content.participant === "string" && content.participant.length > 0,
      "Informe o participante do grupo.",
    );
    const conn = await one(
      env,
      "SELECT * FROM connections WHERE id=?",
      connectionId,
    );
    await syncGroup(env, conn, {
      external_id: data.external_id,
      title: data.title,
    });
  }
  const key = `${profile}:${namespace}:${data.external_id}:${data.message_id}`;
  const customerAt =
    connectionId && Number.isFinite(data.customer_at) && data.customer_at > 0
      ? Math.min(now(), data.customer_at)
      : now();
  const old = await one(
    env,
    "SELECT conversation_id FROM inbox WHERE event_key=?",
    key,
  );
  if (old) return { conversation_id: old.conversation_id, duplicate: true };
  const routed =
    connectionId && !isGroup
      ? await one(
          env,
          "SELECT conversation_id FROM router_affinities WHERE connection_id=? AND recipient=?",
          connectionId,
          data.external_id,
        )
      : null;
  let c = routed
    ? await conversation(env, routed.conversation_id, profile)
    : await one<Conversation>(
        env,
        "SELECT * FROM conversations WHERE profile_id=? AND external_namespace=? AND external_id=?",
        profile,
        namespace,
        data.external_id,
      );
  requireValue(
    !c?.connection_id || !!connectionId,
    "Mensagens de cliente em um canal real devem chegar pelo webhook autenticado.",
  );
  if (!c) {
    const id = uid();
    await exec(
      env,
      "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      profile,
      connectionId,
      namespace,
      data.external_id,
      namespace.startsWith("channel:") ? data.phone || data.external_id : null,
      uid(),
      customerAt,
      now(),
      now(),
    );
    c = await conversation(env, id, profile);
    await event(env, profile, "conversation.created", id, {
      id,
      external_id: data.external_id,
    });
  }
  const ratingReply =
    /^[1-5](?:\s|$)/.test(data.text) &&
    (await one(
      env,
      "SELECT id FROM surveys WHERE conversation_id=? AND status='pending' AND created>?",
      c.id,
      now() - 86400000,
    ));
  if (c.state === "closed" && !ratingReply) {
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL,epoch=epoch+1,session=?,updated=? WHERE id=?",
      uid(),
      now(),
      c.id,
    );
    c = await conversation(env, c.id, profile);
  }
  const line = await serviceForLine(env, connectionId);
  if (line.mode === "human" && c.state === "ai" && !c.assigned_bot_id) {
    await exec(
      env,
      "UPDATE conversations SET state='waiting',owner=NULL,epoch=epoch+1,updated=? WHERE id=?",
      now(),
      c.id,
    );
    c = await conversation(env, c.id, profile);
    await event(env, profile, "conversation.updated", c.id, {
      action: "waiting",
      state: "waiting",
    });
  }
  if (
    c.state === "ai" &&
    (c.chat_type !== "group" ||
      c.bot_policy === "all" ||
      (c.bot_policy === "mentions" &&
        (content.mentioned || /^\/bot(?:\s|$)/i.test(data.text))))
  ) {
    await exec(env, "UPDATE conversations SET epoch=epoch+1 WHERE id=?", c.id);
    c = await conversation(env, c.id, profile);
  }
  const msgId = uid();
  await batch(env, [
    [
      "INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)",
      [
        uid(),
        profile,
        key,
        c.id,
        JSON.stringify({
          ...data,
          message_record_id: msgId,
          attachments,
          epoch: c.epoch,
          session: c.session,
        }),
        now(),
      ],
    ],
    [
      "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,content) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        msgId,
        profile,
        c.id,
        "customer",
        `customer:${namespace}:${content.participant || data.external_id}`,
        data.text,
        JSON.stringify(attachments),
        data.message_id,
        now(),
        JSON.stringify(content),
      ],
    ],
    [
      "UPDATE conversations SET last_customer=max(last_customer,?),updated=? WHERE id=?",
      [customerAt, now(), c.id],
    ],
  ]);
  await event(env, profile, "message.received", msgId, {
    conversation_id: c.id,
    message_id: msgId,
    text: data.text,
    attachments,
  });
  if (connectionId)
    await applyChannelEvents(env, connectionId, data.message_id);
  await queueContactProjection(env,c,msgId,data.text || '');
  return { conversation_id: c.id, message_id: msgId };
}
export async function createRun(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
  extra: any = {},
) {
  if (extra.conversation_id) {
    const c = await conversation(env, extra.conversation_id, profile, actor);
    if (!(await getNumberPolicy(env, c.connection_id)).bots)
      throw numberPolicyError("bots");
    requireValue(
      await botAllowsLine(env, data.bot_id, profile, c.connection_id),
      "Este bot não atende esta linha.",
    );
  }
  if (extra.source_key) {
    const old = await one(
      env,
      "SELECT id,status FROM bot_runs WHERE source_key=?",
      extra.source_key,
    );
    if (old) return old;
  }
  access(actor, profile, "bots:invoke");
  const bot = await one(
    env,
    "SELECT * FROM bots WHERE id=? AND profile_id=? AND enabled=1",
    data.bot_id,
    profile,
  );
  if (!bot || ((actor.kind === "app" || actor.fagoo) && !actor.bots.includes(bot.id)))
    throw new ApiError(403, "bot_not_allowed", "Bot não autorizado.");
  const input = text(data.input, 60000);
  const count = await one(
    env,
    "SELECT count(*) n FROM bot_runs WHERE actor=? AND status IN ('queued','starting','running','cancelling','unknown')",
    actor.id,
  );
  if (count.n >= actor.runLimit)
    throw new ApiError(
      429,
      "run_limit",
      "Limite de execuções simultâneas atingido.",
    );
  const id = uid();
  const inserted = await one(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,input,phase,context,created,updated,source_key) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM bot_runs WHERE actor=? AND status IN ('queued','starting','running','cancelling','unknown'))<? RETURNING id",
    id,
    profile,
    bot.id,
    actor.id,
    extra.conversation_id || null,
    extra.epoch ?? null,
    input,
    extra.phase || "external",
    JSON.stringify({...extra.context,...(actor.fagoo ? {fagoo_actor:actor.id,fagoo_unit:actor.fagoo.unitId,fagoo_capabilities:actor.fagoo.capabilities}: {})}),
    now(),
    now(),
    extra.source_key || null,
    actor.id,
    actor.runLimit,
  );
  if (!inserted)
    throw new ApiError(
      429,
      "run_limit",
      "Limite de execuções simultâneas atingido.",
    );
  return { id, status: "queued" };
}
export async function perform(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  requestId: string,
): Promise<any> {
  if(env.FAGOO_MANAGED==='true' && actor.kind==='user' && !actor.id.startsWith('bot:') && (await one(env,'SELECT pause_outbound FROM fagoo_runtime WHERE id=1'))?.pause_outbound) throw new ApiError(503,'maintenance','O Fagoo está em manutenção. Tente novamente em instantes.');
  if(actor.fagoo) {
    if(op.startsWith("contact.")) throw new ApiError(409,"canonical_contacts","Cadastre e edite contatos no Fagoo.");
    if(op.startsWith("application.")) data={...data,profiles:[actor.profiles[0]]};
    if(op.startsWith('internal.')) requireCapability(actor,'team.chat');
    else if(op==='conversation.action') requireCapability(actor,({claim:'communication.claim',transfer:'communication.transfer',resume:'communication.transfer'} as Record<string,string>)[data.action] || 'communication.reply');
    else if(!configured(actor) && !['presence','message.action','ticket.create','ticket.update','media.register'].includes(op) && !op.startsWith('upload.')) throw new ApiError(403,'missing_capability','Configuração exige permissão própria.');
    if(data.attachments) for(const id of data.attachments) await authorizedMedia(env,actor,profile,id);
  }
  if (op === "line.save") return saveLine(env, actor, profile, data);
  if (op.startsWith("internal."))
    return internalCommand(env, actor, profile, op, data, requestId);
  if (op.startsWith("meta-account.") || op.startsWith("meta-number."))
    return accountCommand(env, actor, profile, op, data);
  if (op.startsWith("router."))
    return routerCommand(env, actor, profile, op, data, requestId);
  if (op.startsWith("upload."))
    return uploadCommand(env, actor, profile, op, data);
  if (op.startsWith("call."))
    return callCommand(env, actor, profile, op, data, requestId);
  if (op.startsWith("group."))
    return groupCommand(env, actor, profile, op, data, requestId);
  if (op === "message.action")
    return messageAction(env, actor, profile, data, requestId);
  if (op.startsWith("contact."))
    return contactCommand(env, actor, profile, op, data);
  if (op.startsWith("system.")) {
    admin(actor);
    const maintenance = await import("./maintenance");
    return maintenance.maintenanceCommand(env, actor, op, data);
  }
  if (
    op.startsWith("connection.") &&
    [
      "connection.test",
      "connection.discover",
      "connection.telegram-webhook",
      "connection.connector-token",
    ].includes(op)
  ) {
    admin(actor);
    if (op === "connection.test")
      return probe(env, data.id, profile, data.origin);
    if (op === "connection.discover") return discover(env, data.id, profile);
    if (op === "connection.telegram-webhook")
      return configureTelegram(env, data.id, profile, data.origin);
    const conn = await one(
      env,
      "SELECT id FROM connections WHERE id=? AND profile_id=? AND kind IN ('qr','hermes-whatsapp')",
      data.id,
      profile,
    );
    requireValue(conn, "Conector não encontrado.");
    const token = random();
    await setSecret(env, `connection:${conn.id}`, {
      ...(await secret(env, `connection:${conn.id}`)),
      connector_hash: await sha(token),
    });
    return { token, connection_id: conn.id };
  }
  if (op === "jev") {
    admin(actor);
    requireValue(
      typeof data.key === "string" && data.key,
      "Informe a chave JEV.",
    );
    await setSecret(env, `jev:${profile}`, { key: data.key });
    return { saved: true };
  }
  if (op === "media.register") {
    access(actor, profile, "media:write");
    const id = data.id;
    requireValue(
      id && data.object_key.startsWith(profile + "/"),
      "Arquivo inválido.",
    );
    await exec(
      env,
      "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
      id,
      profile,
      data.name,
      data.type,
      data.size,
      data.object_key,
      actor.id,
      now(),
    );
    return { id, name: data.name, size: data.size };
  }
  if (op === "profile.create") {
    admin(actor);
    const id = uid();
    await exec(
      env,
      "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
      id,
      text(data.name, 100),
      JSON.stringify(defaults),
      now(),
    );
    return { id };
  }
  if (op === "user.create") {
    admin(actor);
    requireValue(["admin", "operator"].includes(data.role), "Papel inválido.");
    requireValue(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || ""),
      "E-mail inválido.",
    );
    const id = uid();
    await exec(
      env,
      "INSERT INTO users(id,email,name,password,role,profiles,telegram_id,created) VALUES(?,?,?,?,?,?,?,?)",
      id,
      text(data.email, 200).toLowerCase(),
      text(data.name, 100),
      passwordHash(data.password),
      data.role,
      JSON.stringify(data.profiles || []),
      data.telegram_id || null,
      now(),
    );
    return { id };
  }
  if (op === "user.update") {
    admin(actor);
    const u = await one(env, "SELECT * FROM users WHERE id=?", data.id);
    requireValue(u, "Usuário não encontrado.");
    requireValue(
      data.id !== actor.id || !data.disabled,
      "Você não pode desativar sua própria conta.",
    );
    await exec(
      env,
      "UPDATE users SET name=?,profiles=?,telegram_id=?,disabled=? WHERE id=?",
      data.name ? text(data.name, 100) : u.name,
      JSON.stringify(data.profiles ?? json(u.profiles, [])),
      data.telegram_id ?? u.telegram_id,
      data.disabled === undefined ? u.disabled : Number(!!data.disabled),
      data.id,
    );
    if (data.password)
      await exec(
        env,
        "UPDATE users SET password=? WHERE id=?",
        passwordHash(data.password),
        data.id,
      );
    await exec(env, "DELETE FROM sessions WHERE user_id=?", data.id);
    return { id: data.id };
  }
  if (op === "application.create") {
    admin(actor);
    requireValue(
      Array.isArray(data.scopes) &&
        data.scopes.every((s: string) => scopes.includes(s)),
      "Permissões inválidas.",
    );
    requireValue(
      Array.isArray(data.profiles) && data.profiles.length > 0,
      "Selecione perfis.",
    );
    const id = uid();
    await exec(
      env,
      "INSERT INTO applications(id,name,profiles,scopes,bots,rate,run_limit,created) VALUES(?,?,?,?,?,?,?,?)",
      id,
      text(data.name, 100),
      JSON.stringify(data.profiles),
      JSON.stringify(data.scopes),
      JSON.stringify(data.bots || []),
      Math.min(600, Math.max(1, Number(data.rate) || 60)),
      Math.min(10, Math.max(1, Number(data.run_limit) || 3)),
      now(),
    );
    return { id };
  }
  if (op === "application.update") {
    admin(actor);
    const old = await one(
      env,
      "SELECT * FROM applications WHERE id=?",
      data.id,
    );
    requireValue(old, "Aplicação não encontrada.");
    requireValue(
      !data.scopes ||
        (Array.isArray(data.scopes) &&
          data.scopes.every((s: string) => scopes.includes(s))),
      "Permissões inválidas.",
    );
    await exec(
      env,
      "UPDATE applications SET disabled=?,profiles=?,scopes=?,bots=? WHERE id=?",
      data.disabled === undefined ? old.disabled : Number(!!data.disabled),
      JSON.stringify(data.profiles ?? json(old.profiles, [])),
      JSON.stringify(data.scopes ?? json(old.scopes, [])),
      JSON.stringify(data.bots ?? json(old.bots, [])),
      data.id,
    );
    return { id: data.id };
  }
  if (op === "key.create") {
    admin(actor);
    requireValue(
      await one(env, "SELECT id FROM applications WHERE id=?", data.app_id),
      "Aplicação não encontrada.",
    );
    const token = `wab_${random()}`,
      id = uid(),
      expires =
        now() + Math.min(365, Math.max(1, Number(data.days) || 90)) * 86400000;
    await exec(
      env,
      "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
      id,
      data.app_id,
      await sha(token),
      token.slice(0, 12),
      expires,
      now(),
    );
    return { id, token, expires };
  }
  if (op === "key.revoke") {
    admin(actor);
    await exec(env, "UPDATE api_keys SET revoked=1 WHERE id=?", data.id);
    return { revoked: true };
  }
  if (op === "settings") {
    admin(actor);
    const old = await settings(env, profile);
    const next = { ...old, ...data };
    requireValue(
      typeof next.jev_enabled === "boolean" &&
        typeof next.surveys_enabled === "boolean",
      "JEV e avaliações devem estar ligados ou desligados.",
    );
    if (next.departments === undefined) next.departments = [];
    if (data.departments !== undefined)
      await validateDepartments(env, profile, next.departments);
    requireValue(
      JSON.stringify(next).length <= 150000,
      "Configuração muito grande.",
    );
    for (const [key, max] of [
      ["menus", 200],
      ["apps", 100],
      ["capabilities", 50],
    ] as const) {
      requireValue(
        Array.isArray(next[key]) && next[key].length <= max,
        `Lista ${key} inválida ou acima do limite.`,
      );
      const ids = next[key].map((item: any) => item?.id);
      requireValue(
        ids.every(
          (id: any) =>
            typeof id === "string" && id.length > 0 && id.length <= 100,
        ) && new Set(ids).size === ids.length,
        `Identificadores de ${key} inválidos ou repetidos.`,
      );
    }
    for (const item of next.apps) {
      text(item.name, 100);
      item.url = publicUrl(item.url);
      if (item.review_url) item.review_url = publicUrl(item.review_url);
    }
    for (const item of next.menus) {
      text(item.label, 100);
      if (item.line_ids !== undefined)
        await validateLineIds(env, profile, item.line_ids);
      if (item.trigger !== undefined)
        requireValue(
          ["automatic", "manual"].includes(item.trigger),
          "Modo de menu inválido.",
        );
      requireValue(
        [
          "human",
          "app",
          "submenu",
          "bot",
          "link",
          "content",
          "protocols",
          "survey",
        ].includes(item.type),
        "Destino de menu inválido.",
      );
      if (item.type === "human" && item.department_id)
        requireValue(
          next.departments.some((d: any) => d.id === item.department_id),
          "Setor do menu não encontrado.",
        );
      if (item.type === "link") {
        item.url = publicUrl(item.url);
        if (item.content) text(item.content, 3000);
      }
      if (item.type === "content") text(item.content, 3500);
      if (item.type === "survey" && item.question) text(item.question, 300);
      if (item.type === "app")
        requireValue(
          next.apps.some((a: any) => a.id === item.app_id),
          "Aplicativo do menu não encontrado.",
        );
      if (item.type === "bot")
        requireValue(
          await one(
            env,
            "SELECT id FROM bots WHERE id=? AND profile_id=?",
            item.bot_id,
            profile,
          ),
          "Bot do menu não pertence ao perfil.",
        );
      const visited = new Set([item.id]);
      let parent = item.parent_id;
      while (parent) {
        requireValue(!visited.has(parent), "O menu contém um ciclo.");
        visited.add(parent);
        const ancestor = next.menus.find((m: any) => m.id === parent);
        requireValue(
          ancestor?.type === "submenu",
          "Menu pai precisa ser um submenu.",
        );
        parent = ancestor.parent_id;
      }
    }
    requireValue(
      ["command", "direct"].includes(next.reply_mode),
      "Modo de resposta inválido.",
    );
    requireValue(
      next.protocol_response_hours === null ||
        (Number.isFinite(Number(next.protocol_response_hours)) &&
          Number(next.protocol_response_hours) > 0 &&
          Number(next.protocol_response_hours) <= 8760),
      "Prazo inválido.",
    );
    if (next.attendant_bot)
      requireValue(
        await one(
          env,
          "SELECT id FROM bots WHERE id=? AND profile_id=?",
          next.attendant_bot,
          profile,
        ),
        "Atendente não pertence ao perfil.",
      );
    for (const action of next.capabilities || [])
      requireValue(
        await one(
          env,
          "SELECT id FROM bots WHERE id=? AND profile_id=?",
          action.bot_id,
          profile,
        ),
        "Especialista não pertence ao perfil.",
      );
    await exec(
      env,
      "UPDATE profiles SET settings=? WHERE id=?",
      JSON.stringify(next),
      profile,
    );
    return next;
  }
  if (op === "activate" || op === "pause") {
    admin(actor);
    if (op === "activate") {
      const cfg = await settings(env, profile);
      const configuredLine = await one(
        env,
        "SELECT id FROM connections WHERE profile_id=? AND kind IN ('meta','qr','hermes-whatsapp') AND json_extract(config,'$.service.mode') IN ('human','bot') LIMIT 1",
        profile,
      );
      requireValue(
        cfg.attendant_bot || configuredLine,
        "Selecione o Bot Atendente do perfil ou configure o atendimento por linha.",
      );
    }
    await exec(
      env,
      "UPDATE profiles SET enabled=? WHERE id=?",
      op === "activate" ? 1 : 0,
      profile,
    );
    if (op === "pause")
      await exec(
        env,
        "UPDATE conversations SET epoch=epoch+1 WHERE profile_id=? AND state='ai'",
        profile,
      );
    return { enabled: op === "activate" };
  }
  if (op === "connection.save") {
    admin(actor);
    requireValue(
      ["hermes", "meta", "qr", "telegram", "hermes-whatsapp"].includes(
        data.kind,
      ),
      "Conector inválido.",
    );
    const id = data.id || uid();
    const old = await one(env, "SELECT * FROM connections WHERE id=?", id);
    requireValue(
      !old || old.profile_id === profile,
      "Conexão de outro perfil.",
    );
    if (old) {
      const pending = await one(
        env,
        "SELECT id FROM outbox WHERE connection_id=? AND status IN ('pending','sending','unknown') LIMIT 1",
        id,
      );
      requireValue(
        old.status === "paused" && !pending,
        "Pause e reconcilie as entregas antes de alterar a conexão.",
      );
    }
    const cfg = data.config || {};
    if (old) {
      const previous = json(old.config);
      // Credential editors omit line assignments. Those are edited through line.save.
      cfg.service = previous.service;
      cfg.number_policy = previous.number_policy;
    }
    const managed =
      old &&
      (await one(
        env,
        "SELECT connection_id FROM meta_numbers WHERE connection_id=?",
        id,
      ));
    if (managed) {
      const previous = json(old.config);
      requireValue(
        data.kind === "meta" &&
          cfg.phone_id === previous.phone_id &&
          cfg.number === previous.number,
        "O número do roteador não pode mudar de identidade ou de modo.",
      );
      cfg.meta_account_id = previous.meta_account_id;
      cfg.waba_id = previous.waba_id;
      // Editing connection credentials must not reset per-number restrictions.
      cfg.number_policy = previous.number_policy;
      requireValue(
        !data.secrets?.token &&
          !data.secrets?.app_secret &&
          !data.secrets?.verify_token,
        "Edite as credenciais na conta Meta do roteador.",
      );
    }
    if (cfg.url) cfg.url = publicUrl(cfg.url);
    if (cfg.api_url) cfg.api_url = publicUrl(cfg.api_url);
    if (["qr", "hermes-whatsapp", "meta"].includes(data.kind))
      requireValue(
        /^\d{8,16}$/.test(cfg.number || ""),
        "Informe o número completo com DDI, somente dígitos.",
      );
    if (data.kind === "meta") {
      requireValue(
        /^\d+$/.test(cfg.phone_id || ""),
        "Informe o Phone Number ID da Meta.",
      );
      const duplicate = await one(
        env,
        "SELECT id FROM connections WHERE kind='meta' AND json_extract(config,'$.phone_id')=? AND id!=?",
        cfg.phone_id,
        id,
      );
      requireValue(!duplicate, "Este número já está cadastrado.");
    }
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,config,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,kind=excluded.kind,mode=excluded.mode",
      id,
      profile,
      text(data.name, 100),
      data.kind,
      data.mode || "direct",
      JSON.stringify(cfg),
      now(),
    );
    if (data.secrets) {
      const previous = await secret(env, `connection:${id}`);
      await setSecret(env, `connection:${id}`, {
        ...previous,
        ...data.secrets,
        profile_keys: {
          ...previous.profile_keys,
          ...data.secrets.profile_keys,
        },
      });
    }
    return { id, status: "paused" };
  }
  if (op === "connection.state") {
    admin(actor);
    const row = await one(
      env,
      "SELECT * FROM connections WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(row, "Conexão não encontrada.");
    requireValue(
      ["active", "paused"].includes(data.status),
      "Estado inválido.",
    );
    if (data.status === "active") {
      requireValue(
        json(row.config).verified_at,
        "Teste a conexão antes de ativar.",
      );
      const number = json(row.config).number;
      if (number) {
        const other = await one(
          env,
          "SELECT id FROM connections WHERE id!=? AND json_extract(config,'$.number')=? AND (status='active' OR EXISTS(SELECT 1 FROM outbox o WHERE o.connection_id=connections.id AND o.status IN ('pending','sending','unknown')))",
          row.id,
          number,
        );
        requireValue(
          !other,
          "Pause o outro modo deste número e reconcilie todas as entregas antes de ativar.",
        );
      }
    }
    await exec(
      env,
      "UPDATE connections SET status=? WHERE id=?",
      data.status,
      row.id,
    );
    return { id: row.id, status: data.status };
  }
  if (op === "bot.update") {
    admin(actor);
    const bot = await one(
      env,
      "SELECT * FROM bots WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(bot, "Bot não encontrado.");
    if (data.line_ids !== undefined)
      await validateLineIds(env, profile, data.line_ids, true);
    const enabled = data.enabled === undefined ? !!bot.enabled : !!data.enabled;
    if (enabled && !bot.enabled) {
      const keys = await secret(env, `connection:${bot.connection_id}`);
      requireValue(
        keys.profile_keys?.[bot.remote_profile],
        "Cadastre a API_SERVER_KEY desse perfil Hermes antes de habilitar.",
      );
    }
    await exec(
      env,
      "UPDATE bots SET enabled=?,name=coalesce(?,name),line_ids=? WHERE id=?",
      enabled ? 1 : 0,
      data.name || null,
      data.line_ids === undefined
        ? bot.line_ids
        : data.line_ids === null
          ? null
          : JSON.stringify(data.line_ids),
      data.id,
    );
    return { id: data.id };
  }
  if (op === "inbound") {
    access(actor, profile, "conversations:write");
    return inbound(env, profile, data, `app:${actor.id}`, null);
  }
  if (op === "conversation.create") {
    access(actor, profile, "conversations:write");
    return inbound(
      env,
      profile,
      {
        ...data,
        text: data.text || "",
        message_id: data.message_id || requestId,
      },
      `app:${actor.id}`,
      null,
    );
  }
  if (op === "conversation.action") {
    access(actor, profile, "conversations:write");
    let c = await conversation(env, data.id, profile, actor, data.action === 'claim');
    const action = data.action;
    if (
      [
        "claim",
        "reply",
        "transfer",
        "resume",
        "resolve",
        "protocols",
        "survey",
      ].includes(action)
    )
      await assertDepartmentAccess(env, actor, c);
    let eventExtra: Record<string, any> = {};
    const policy = await getNumberPolicy(env, c.connection_id);
    if (action === "protocols" || action === "survey") {
      requireValue(
        c.owner === actor.id ||
          actor.role === "admin" ||
          (actor.id.startsWith("bot:") && c.state === "ai"),
        "Assuma a conversa antes desta ação.",
      );
      if (action === "protocols") {
        access(actor, profile, "tickets:read");
        return sendProtocolLookup(
          env,
          c,
          data.number || undefined,
          `protocols:${actor.id}:${requestId}`,
          actor.id,
        );
      }
      return requestSurvey(env, c, `survey:${actor.id}:${requestId}`, actor.id);
    }
    if (["claim", "reply"].includes(action)) {
      const capability = actor.kind === "app" ? "api" : "human";
      if (!policy[capability]) throw numberPolicyError(capability);
    }
    if (
      action === "transfer" &&
      !(String(data.target).startsWith("bot:") ? policy.bots : policy.human)
    )
      throw numberPolicyError(
        String(data.target).startsWith("bot:") ? "bots" : "human",
      );
    if (action === "resume" && !policy.bots) throw numberPolicyError("bots");
    if (action === "menu") {
      const botActor = actor.id.startsWith("bot:");
      requireValue(
        c.owner === actor.id ||
          actor.role === "admin" ||
          (botActor && c.state === "ai"),
        "Assuma a conversa antes de enviar um menu.",
      );
      return sendMenu(
        env,
        actor,
        c,
        data.menu_id || null,
        `manual-menu:${actor.id}:${requestId}`,
      );
    }
    if (action === "bind_topic") {
      admin(actor);
      requireValue(
        /^\d+$/.test(data.topic || ""),
        "Informe o ID numérico do tópico.",
      );
      await exec(
        env,
        "UPDATE conversations SET topic=? WHERE id=?",
        data.topic,
        c.id,
      );
      return { id: c.id, topic: data.topic };
    }
    if (action === "claim") {
      if (c.owner === actor.id && c.state === "human") return c;
      if (c.owner && c.owner !== actor.id)
        throw new ApiError(
          409,
          "already_claimed",
          "Outro atendente assumiu a conversa.",
        );
      await exec(
        env,
        "UPDATE conversations SET state='human',owner=?,assigned_bot_id=NULL,menu_active=0,epoch=epoch+1,updated=? WHERE id=?",
        actor.id,
        now(),
        c.id,
      );
      await exec(
        env,
        "UPDATE tickets SET owner=? WHERE conversation_id=? AND owner IS NULL AND status!='closed'",
        actor.id,
        c.id,
      );
    } else if (action === "note") {
      await message(env, c, "note", actor.id, text(data.text));
    } else if (action === "tags") {
      requireValue(
        Array.isArray(data.tags) && data.tags.length <= 20,
        "Etiquetas inválidas.",
      );
      await exec(
        env,
        "UPDATE conversations SET tags=?,updated=? WHERE id=?",
        JSON.stringify(data.tags.map((s: any) => text(s, 40))),
        now(),
        c.id,
      );
    } else {
      if (
        c.owner !== actor.id &&
        !(actor.role === "admin" && action === "transfer")
      )
        throw new ApiError(
          403,
          "not_owner",
          "Assuma a conversa antes desta ação.",
        );
      if (action === "reply") {
        requireValue(
          c.state === "human",
          "A conversa não está em atendimento humano.",
        );
        const content = await outgoingContent(env, actor, c, data);
        const value = String(data.text || "").trim(),
          attachments = await mediaIds(env, profile, data.attachments || []);
        if (c.chat_type === "group") {
          const group = await one(
            env,
            "SELECT * FROM whatsapp_groups WHERE conversation_id=?",
            c.id,
          );
          requireValue(
            !group?.announcement || group.own_admin,
            "Somente administradores podem enviar mensagens neste grupo.",
          );
        }
        const delivery = await enqueue(
          env,
          c,
          actor.id,
          "text",
          { text: value, attachments, content },
          `reply:${actor.id}:${requestId}`,
        );

        await exec(
          env,
          "UPDATE tickets SET first_response_at=coalesce(first_response_at,?),updated=? WHERE conversation_id=? AND status!='closed'",
          now(),
          now(),
          c.id,
        );
        return { delivery_id: delivery, status: "pending" };
      } else if (action === "transfer") {
        if (data.department_id) {
          requireValue(
            !data.target,
            "Escolha uma pessoa, bot ou setor por transferência.",
          );
          await handoff(env, c, "Encaminhado pela equipe.", data.department_id);
          return conversation(env, c.id, profile, actor);
        }
        const botId = String(data.target || "").startsWith("bot:")
          ? String(data.target).slice(4)
          : null;
        if (botId) {
          requireValue(!actor.fagoo || actor.bots.includes(botId),'Bot não autorizado para esta pessoa.');
          requireValue(
            await botAllowsLine(env, botId, profile, c.connection_id),
            "Bot não autorizado para esta linha.",
          );
          if (now() - c.last_customer < 86400000) {
            const history = await all(
              env,
              "SELECT direction,text FROM messages WHERE conversation_id=? AND direction!='note' ORDER BY created DESC,rowid DESC LIMIT 20",
              c.id,
            );
            const request =
              history.find((m) => m.direction === "customer")?.text ||
              "Atendimento encaminhado para você. Leia o histórico e pergunte como pode ajudar.";
            const words = Array.from(
              new Set(
                String(request)
                  .toLowerCase()
                  .match(/[\p{L}\p{N}]{3,}/gu) || [],
              ),
            ).slice(0, 24);
            const sources = words.length
              ? await all(
                  env,
                  "SELECT rowid id,document_id,text,url FROM chunks WHERE profile_id=? AND chunks MATCH ? ORDER BY rank LIMIT 5",
                  profile,
                  words
                    .map((w) => '"' + w.replaceAll('"', "") + '"')
                    .join(" OR "),
                )
              : [];
            const cfg = await settings(env, profile);
            const menus = (
              await availableMenus(env, profile, c.connection_id, null, true)
            ).map((m: any) => ({ id: m.id, label: m.label, type: m.type }));
            await createRun(
              env,
              actor,
              profile,
              {
                bot_id: botId,
                input: JSON.stringify({
                  request,
                  history: history.reverse(),
                  sources,
                  menus,
                  actions: (cfg.capabilities || []).filter(
                    (a: any) => a.enabled !== false,
                  ),
                }),
              },
              {
                conversation_id: c.id,
                epoch: c.epoch + 1,
                phase: "attendant",
                context: { request, sources, session: c.session },
                source_key: `transfer:${actor.id}:${requestId}`,
              },
            );
          }
          await exec(
            env,
            "UPDATE conversations SET owner=NULL,state='ai',assigned_bot_id=?,menu_active=0,epoch=epoch+1,updated=? WHERE id=?",
            botId,
            now(),
            c.id,
          );
          eventExtra = { assigned_bot_id: botId, actor: actor.id };
        } else {
          const target = await one(
            env,
            "SELECT * FROM users WHERE id=? AND disabled=0",
            data.target,
          );
          requireValue(
            target &&
              (target.role === "admin" ||
                json(target.profiles, []).includes(profile)),
            "Atendente não autorizado.",
          );
          const targetGrant=actor.fagoo ? await currentGrant(env,profile,target.id,"communication.read") : null;
          requireValue(!actor.fagoo || targetGrant,"Atendente não autorizado pelo Fagoo.");
          await assertDepartmentAccess(env,targetGrant ? actorFromGrant(targetGrant) : { ...actor,id:target.id,kind:"user",role:target.role },c);
          await exec(
            env,
            "UPDATE conversations SET owner=?,state='human',assigned_bot_id=NULL,menu_active=0,epoch=epoch+1,updated=? WHERE id=?",
            target.id,
            now(),
            c.id,
          );
          eventExtra = { owner: target.id, actor: actor.id };
        }
      } else if (action === "resolve" || action === "resume") {
        await exec(
          env,
          "UPDATE conversations SET state=?,owner=NULL,assigned_bot_id=NULL,menu_active=0,epoch=epoch+1,updated=? WHERE id=?",
          action === "resolve" ? "closed" : "ai",
          now(),
          c.id,
        );
        if (
          c.chat_type !== "group" &&
          action === "resolve" &&
          policy.service &&
          (policy.menu || policy.bots) &&
          (await settings(env, profile)).surveys_enabled
        ) {
          const id = uid();
          await exec(
            env,
            "INSERT INTO surveys(id,profile_id,conversation_id,created) VALUES(?,?,?,?)",
            id,
            profile,
            c.id,
            now(),
          );
          c = await conversation(env, c.id, profile);
          await enqueue(
            env,
            c,
            "system",
            "text",
            {
              text: "Como foi seu atendimento? Responda com uma nota de 1 a 5 e, se quiser, um comentário.",
            },
            `survey:${id}`,
          );
        }
      } else throw new ApiError(400, "unknown_action", "Ação inválida.");
    }
    await event(env, profile, "conversation.updated", c.id, {
      action,
      ...eventExtra,
    });
    return await conversation(env, c.id, profile);
  }
  if (op === "presence") {
    access(actor, profile, "presence:write");
    requireValue(
      actor.kind === "user",
      "A presença humana exige uma conta de atendente.",
    );
    requireValue(typeof data.present === "boolean", "Presença inválida.");
    await exec(
      env,
      "INSERT INTO presence(profile_id,actor,present,updated) VALUES(?,?,?,?) ON CONFLICT(profile_id,actor) DO UPDATE SET present=excluded.present,updated=excluded.updated",
      profile,
      actor.id,
      data.present ? 1 : 0,
      now(),
    );
    return { actor: actor.id, present: data.present };
  }
  if (op === "ticket.create") {
    access(actor, profile, "tickets:write");
    const c = await conversation(env, data.conversation_id, profile, actor);
    requireValue(
      c.owner === actor.id || actor.role === "admin",
      "Assuma a conversa antes de abrir o protocolo.",
    );
    return openTicket(env, c, actor.id, text(data.title, 300));
  }
  if (op === "ticket.update") {
    access(actor, profile, "tickets:write");
    const ticket = await one(
      env,
      "SELECT * FROM tickets WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(ticket, "Protocolo não encontrado.");
    const ticketConversation = await conversation(
      env,
      ticket.conversation_id,
      profile,
      actor,
    );
    await assertDepartmentAccess(env, actor, ticketConversation);
    requireValue(
      actor.role === "admin" || canonicalActor(actor,ticket.owner) === actor.id,
      "Somente o responsável pode alterar o protocolo.",
    );
    const status = data.status || ticket.status;
    requireValue(
      ["open", "in_progress", "closed"].includes(status),
      "Estado inválido.",
    );
    if (data.response_due_at !== undefined)
      requireValue(
        !ticket.first_response_at &&
          ticket.status !== "closed" &&
          (data.response_due_at === null ||
            Number.isFinite(data.response_due_at)),
        "Não é possível alterar este prazo.",
      );
    if (data.owner)
      requireValue(
        await one(
          env,
          "SELECT id FROM users WHERE id=? AND disabled=0 AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?))",
          data.owner,
          profile,
        ),
        "Responsável inválido.",
      );
    if (data.owner) {
      const owner = await one(
        env,
        "SELECT role FROM users WHERE id=?",
        data.owner,
      );
      await assertDepartmentAccess(
        env,
        { ...actor, id: data.owner, kind: "user", role: owner!.role },
        ticketConversation,
      );
    }
    const publicText = data.text ? text(data.text) : "";
    await exec(
      env,
      "UPDATE tickets SET status=?,owner=?,response_due_at=?,first_response_at=coalesce(first_response_at,?),updated=? WHERE id=?",
      status,
      data.owner ?? ticket.owner,
      data.response_due_at !== undefined
        ? data.response_due_at
        : ticket.response_due_at,
      publicText ? now() : null,
      now(),
      ticket.id,
    );
    if (publicText) {
      await exec(
        env,
        "INSERT INTO ticket_updates(id,ticket_id,actor,text,created) VALUES(?,?,?,?,?)",
        uid(),
        ticket.id,
        actor.id,
        publicText,
        now(),
      );
      const c = await conversation(env, ticket.conversation_id, profile);
      await enqueue(
        env,
        c,
        actor.id,
        "notification",
        {
          text: `Protocolo ${ticket.number}: ${publicText}`,
          ticket_id: ticket.id,
        },
        `ticket:${requestId}`,
      );
    }
    await event(env, profile, "ticket.updated", ticket.id, {
      status,
      previous_status: ticket.status,
      owner: data.owner ?? ticket.owner,
      previous_owner: ticket.owner,
      text_added: !!publicText,
      actor: actor.id,
      number: ticket.number,
    });
    return await one(env, "SELECT * FROM tickets WHERE id=?", ticket.id);
  }
  if (op === "consent.request") {
    access(actor, profile, "conversations:write");
    const c = await conversation(env, data.conversation_id, profile);
    requireValue(
      c.chat_type !== "group",
      "Consentimento individual não pode ser solicitado em grupo.",
    );
    requireValue(c.owner === actor.id, "Assuma a conversa.");
    const id = uid();
    await exec(
      env,
      "INSERT INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES(?,?,?,?,?,?)",
      id,
      profile,
      c.id,
      "pending",
      JSON.stringify({ actor: actor.id }),
      now(),
    );
    await enqueue(
      env,
      c,
      actor.id,
      "text",
      {
        text: "Você autoriza notificações sobre seu protocolo pelo WhatsApp? Responda AUTORIZO ou NÃO AUTORIZO. Para revogar depois, envie REVOGAR.",
      },
      `consent:${id}`,
    );
    return { id };
  }
  if (op === "run.create") return createRun(env, actor, profile, data);
  if (op === "run.cancel") {
    access(actor, profile, "bots:invoke");
    const run = await one(
      env,
      "SELECT * FROM bot_runs WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(
      run &&
        ((actor.kind !== "app" && !json(run.context).internal_chat_id) ||
          run.actor === actor.id),
      "Execução não encontrada.",
    );
    await exec(
      env,
      "UPDATE bot_runs SET status=CASE WHEN remote_id IS NULL THEN 'cancelled' ELSE 'cancelling' END,updated=? WHERE id=? AND status IN ('queued','running','starting')",
      now(),
      data.id,
    );
    return { id: data.id, status: "cancelling" };
  }
  if (op === "knowledge.create") {
    access(actor, profile, "knowledge:write");
    const id = uid();
    requireValue(
      ["text", "url", "file", "youtube"].includes(data.kind),
      "Tipo de fonte inválido.",
    );
    if (data.url) data.url = publicUrl(data.url);
    if (data.media_id)
      await authorizedMedia(env, actor, profile, data.media_id);
    await exec(
      env,
      "INSERT INTO documents(id,profile_id,title,kind,url,media_id,created) VALUES(?,?,?,?,?,?,?)",
      id,
      profile,
      text(data.title, 200),
      data.kind,
      data.url || null,
      data.media_id || null,
      now(),
    );
    if (data.kind === "text") {
      const value = text(data.text, 500000);
      const chunks: [string, any[]][] = [];
      for (let i = 0; i < value.length; i += 1300)
        chunks.push([
          "INSERT INTO chunks(profile_id,document_id,text,url) VALUES(?,?,?,?)",
          [profile, id, value.slice(i, i + 1600), ""],
        ]);
      await batch(env, chunks);
      await exec(env, "UPDATE documents SET status='ready' WHERE id=?", id);
    }
    return { id };
  }
  if (op === "knowledge.delete") {
    access(actor, profile, "knowledge:write");
    await batch(env, [
      [
        "DELETE FROM chunks WHERE document_id=? AND profile_id=?",
        [data.id, profile],
      ],
      ["DELETE FROM documents WHERE id=? AND profile_id=?", [data.id, profile]],
    ]);
    return { deleted: true };
  }
  if (op === "webhook.create") {
    access(actor, profile, "webhooks:manage");
    requireValue(actor.kind === "app" || data.app_id, "Selecione a aplicação.");
    const appId = actor.kind === "app" ? actor.id.slice(4) : data.app_id;
    const app = await one(
      env,
      "SELECT * FROM applications WHERE id=? AND disabled=0",
      appId,
    );
    requireValue(
      app && json(app.profiles, []).includes(profile),
      "Aplicação não autorizada neste perfil.",
    );
    requireValue(
      Array.isArray(data.events) &&
        data.events.length > 0 &&
        data.events.every((e: string) => eventTypes.includes(e)),
      "Eventos inválidos.",
    );
    const id = uid(),
      signingSecret = random();
    await exec(
      env,
      "INSERT INTO webhook_subscriptions(id,app_id,profile_id,url,events,created) VALUES(?,?,?,?,?,?)",
      id,
      appId,
      profile,
      publicUrl(data.url),
      JSON.stringify(data.events),
      now(),
    );
    await setSecret(env, `webhook:${id}`, { secret: signingSecret });
    return { id, signing_secret: signingSecret };
  }
  if (op === "webhook.disable") {
    access(actor, profile, "webhooks:manage");
    await exec(
      env,
      "UPDATE webhook_subscriptions SET enabled=0 WHERE id=? AND profile_id=? AND (?=1 OR app_id=?)",
      data.id,
      profile,
      actor.role === "admin" ? 1 : 0,
      actor.id.slice(4),
    );
    return { disabled: true };
  }
  if (op === "webhook.retry") {
    access(actor, profile, "webhooks:manage");
    const delivery = await one(
      env,
      "SELECT d.id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.id=? AND s.profile_id=? AND (?=1 OR s.app_id=?)",
      data.id,
      profile,
      actor.role === "admin" ? 1 : 0,
      actor.id.slice(4),
    );
    requireValue(delivery, "Entrega não encontrada.");
    await exec(
      env,
      "UPDATE webhook_deliveries SET status='pending',attempts=0,next_at=? WHERE id=?",
      now(),
      data.id,
    );
    return { queued: true };
  }
  if (op === "delivery.reconcile") {
    admin(actor);
    requireValue(
      ["sent", "pending", "cancelled"].includes(data.status),
      "Resultado inválido.",
    );
    if (data.status === "pending") {
      const old = await one(
        env,
        "SELECT * FROM outbox WHERE id=? AND profile_id=? AND status IN ('unknown','failed')",
        data.id,
        profile,
      );
      requireValue(old, "Entrega não encontrada ou já reconciliada.");
      requireValue(
        !json(old.payload).template_message || data.allow_paid === true,
        "Reenviar um modelo exige nova autorização explícita de cobrança (allow_paid: true).",
      );
      const c = await conversation(env, old.conversation_id, profile);
      const id = await enqueue(
        env,
        c,
        old.actor,
        old.kind,
        {
          ...json(old.payload),
          ...(json(old.payload).template_message
            ? { retry_authorization: { actor: actor.id, authorized_at: now() } }
            : {}),
        },
        "manual-retry:" + requestId,
      );
      await exec(
        env,
        "UPDATE outbox SET status='cancelled',updated=? WHERE id=?",
        now(),
        old.id,
      );
      return { id, status: "pending" };
    }
    await exec(
      env,
      "UPDATE outbox SET status=?,updated=? WHERE id=? AND profile_id=? AND status='unknown'",
      data.status,
      now(),
      data.id,
      profile,
    );
    return { status: data.status };
  }
  if (op === "run.reconcile") {
    admin(actor);
    const run = await one(
      env,
      "SELECT * FROM bot_runs WHERE id=? AND profile_id=? AND status='unknown'",
      data.id,
      profile,
    );
    requireValue(
      run && (!json(run.context).internal_chat_id || run.actor === actor.id),
      "Execução não encontrada.",
    );
    requireValue(
      typeof data.remote_id === "string" && /^run_[\w-]+$/.test(data.remote_id),
      "Informe run_id confirmado no Hermes.",
    );
    await exec(
      env,
      "UPDATE bot_runs SET remote_id=?,status='running',error=NULL,updated=? WHERE id=?",
      data.remote_id,
      now(),
      run.id,
    );
    return { id: run.id, status: "running" };
  }
  throw new ApiError(404, "not_found", "Operação não encontrada.");
}
