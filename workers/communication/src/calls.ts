import { all, one, exec } from "./db";
import { Actor, ApiError, Env, now, uid, json, requireValue } from "./types";
import { access, admin, seal, unseal, secret, rate } from "./security";
import { conversation, enqueue } from "./service";
import { event } from "./events";
import { needCapability } from "./whatsapp";
import { metaRequest } from "./meta";
import { managedAppAllowed } from "./number-router";

const finalStates = ["completed", "failed", "rejected", "missed"];
export async function callView(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
  session = false,
) {
  access(actor, profile, "calls:read");
  const row = await one(
    env,
    "SELECT * FROM calls WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!row || (actor.kind === "app" && row.actor && row.actor !== actor.id))
    throw new ApiError(404, "not_found", "Ligação não encontrada.");
  await conversation(env, row.conversation_id, profile, actor);
  const { local_session, remote_session, ...result } = row;
  if (session) {
    access(actor, profile, "calls:write");
    requireValue(
      row.actor === actor.id,
      "Assuma a ligação antes de obter o áudio.",
    );
    result.session = remote_session ? await unseal(env, remote_session) : null;
  }
  return result;
}
export async function callPermission(env: Env, conn: any, recipient: string) {
  const param = recipient.startsWith("US.") ? "recipient" : "user_wa_id";
  const data = await metaRequest(
    env,
    conn,
    `${json(conn.config).phone_id}/call_permissions?${param}=${encodeURIComponent(recipient)}`,
  );
  await exec(
    env,
    "INSERT INTO call_permissions(connection_id,recipient,payload,updated) VALUES(?,?,?,?) ON CONFLICT(connection_id,recipient) DO UPDATE SET payload=excluded.payload,updated=excluded.updated",
    conn.id,
    recipient,
    JSON.stringify(data),
    now(),
  );
  return data;
}
function session(value: any, type: string) {
  requireValue(
    value?.sdp_type === type &&
      typeof value.sdp === "string" &&
      value.sdp.length <= 60000 &&
      value.sdp.startsWith("v=0") &&
      /(?:^|\n)m=audio /.test(value.sdp) &&
      !/(?:^|\n)m=(video|application) /.test(value.sdp),
    "Sessão de voz WebRTC inválida. Vídeo e compartilhamento de tela não são suportados.",
  );
  return { sdp_type: type, sdp: value.sdp };
}
async function changed(env: Env, row: any, source?: string) {
  await event(
    env,
    row.profile_id,
    "call.updated",
    row.id,
    {
      conversation_id: row.conversation_id,
      call_id: row.id,
      status: row.status,
      direction: row.direction,
    },
    source,
  );
}
export async function callCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  key: string,
) {
  access(actor, profile, "calls:write");
  access(actor, profile, "calls:read");
  if (op === "call.configure") {
    admin(actor);
    const conn = await one(
      env,
      "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind='meta'",
      data.id,
      profile,
    );
    requireValue(conn, "Ligações exigem WhatsApp direto pela Meta.");
    requireValue(
      typeof data.enabled === "boolean",
      "Informe se deseja habilitar ligações.",
    );
    const settings = {
      status: data.enabled ? "ENABLED" : "DISABLED",
      call_icon_visibility: "DEFAULT",
      sip: { status: "DISABLED" },
    };
    await metaRequest(
      env,
      conn,
      `${json(conn.config).phone_id}/settings`,
      "POST",
      { calling: settings },
    );
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({ ...json(conn.config), calling_enabled: data.enabled }),
      conn.id,
    );
    return { enabled: data.enabled };
  }
  if (op === "call.permission" || op === "call.start") {
    const c = await conversation(env, data.conversation_id, profile, actor),
      conn = await one(
        env,
        "SELECT * FROM connections WHERE id=?",
        c.connection_id,
      );
    needCapability(conn, "calls", c.chat_type);
    if (
      await one(
        env,
        "SELECT connection_id FROM meta_numbers WHERE connection_id=?",
        conn.id,
      )
    )
      requireValue(
        await managedAppAllowed(env, actor.id, conn.id),
        "Aplicação sem autorização para este número do roteador.",
      );
    requireValue(conn.status === "active", "Ative a conexão antes de ligar.");
    requireValue(
      c.owner === actor.id && c.state === "human",
      "Assuma a conversa antes de ligar.",
    );
    await rate(env, `call:${actor.id}`, 10);
    const recipient = c.recipient_id || c.external_id;
    const permission = await callPermission(env, conn, recipient);
    const action =
      op === "call.permission" ? "send_call_permission_request" : "start_call";
    requireValue(
      permission.actions?.some(
        (x: any) => x.action_name === action && x.can_perform_action === true,
      ),
      "A Meta ainda não autoriza esta ação. Aguarde a permissão do cliente ou o fim do limite informado pela Meta.",
    );
    if (op === "call.permission") {
      requireValue(
        now() - c.last_customer < 86400000,
        "Peça uma nova mensagem do cliente para abrir a janela de atendimento antes de solicitar a ligação.",
      );
      const delivery = await enqueue(
        env,
        c,
        actor.id,
        "call_permission",
        {
          text: "Podemos ligar para ajudar neste atendimento?",
          content: { type: "call_permission" },
        },
        `permission:${actor.id}:${key}`,
      );
      return { delivery_id: delivery, status: "pending" };
    }
    const offer = session(data.session, "offer");
    const existing = await one(
      env,
      "SELECT id FROM calls WHERE (conversation_id=? OR actor=?) AND status NOT IN ('completed','failed','rejected','missed')",
      c.id,
      actor.id,
    );
    if (existing)
      throw new ApiError(
        409,
        "call_in_progress",
        "Encerre ou reconcilie a ligação anterior antes de iniciar outra.",
      );
    const id = uid();
    await exec(
      env,
      "INSERT INTO calls(id,profile_id,connection_id,conversation_id,direction,actor,status,local_session,created,updated,lease_until) VALUES(?,?,?,?,'outbound',?,'connecting',?,?,?,?)",
      id,
      profile,
      conn.id,
      c.id,
      actor.id,
      await seal(env, offer),
      now(),
      now(),
      now() + 90000,
    );
    try {
      const result = await metaRequest(
        env,
        conn,
        `${json(conn.config).phone_id}/calls`,
        "POST",
        {
          messaging_product: "whatsapp",
          ...(recipient.startsWith("US.") ? { recipient } : { to: recipient }),
          action: "connect",
          session: offer,
          biz_opaque_callback_data: id,
        },
      );
      requireValue(
        result.calls?.[0]?.id,
        "Meta não devolveu o identificador da ligação.",
      );
      await exec(
        env,
        "UPDATE calls SET external_id=?,status='dialing',updated=? WHERE id=?",
        result.calls[0].id,
        now(),
        id,
      );
    } catch (e) {
      const known = e instanceof ApiError && e.code === "meta_rejected";
      await exec(
        env,
        "UPDATE calls SET status=?,error=?,updated=? WHERE id=?",
        known ? "failed" : "unknown",
        known
          ? (e as Error).message
          : "Sem confirmação da Meta. Não inicie outra ligação; aguarde o webhook ou reconcilie.",
        now(),
        id,
      );
    }
    const row = await one(env, "SELECT * FROM calls WHERE id=?", id);
    await changed(env, row);
    return callView(env, actor, profile, id);
  }
  const row = await one(
    env,
    "SELECT * FROM calls WHERE id=? AND profile_id=?",
    data.id,
    profile,
  );
  requireValue(row, "Ligação não encontrada.");
  const c = await conversation(env, row.conversation_id, profile, actor);
  if (actor.kind === "app" && (row.actor || op !== "call.claim"))
    requireValue(
      row.actor === actor.id,
      "A ligação não pertence a esta aplicação.",
    );
  if (op === "call.claim") {
    access(actor, profile, "conversations:write");
    requireValue(
      row.direction === "inbound" && !finalStates.includes(row.status),
      "A ligação não está disponível.",
    );
    if (row.actor && row.actor !== actor.id)
      throw new ApiError(
        409,
        "call_claimed",
        "Outro atendente já assumiu esta ligação.",
      );
    requireValue(
      !c.owner || c.owner === actor.id,
      "A conversa pertence a outro atendente.",
    );
    const other = await one(
      env,
      "SELECT id FROM calls WHERE actor=? AND id<>? AND status NOT IN ('completed','failed','rejected','missed')",
      actor.id,
      row.id,
    );
    if (other)
      throw new ApiError(
        409,
        "call_in_progress",
        "Encerre a outra ligação antes de atender.",
      );
    await exec(
      env,
      "UPDATE conversations SET owner=?,state='human',epoch=epoch+1 WHERE id=?",
      actor.id,
      c.id,
    );
    await exec(
      env,
      "UPDATE calls SET actor=?,lease_until=? WHERE id=?",
      actor.id,
      now() + 90000,
      row.id,
    );
    return callView(env, actor, profile, row.id, true);
  }
  requireValue(
    row.actor === actor.id,
    "Somente o responsável pode controlar a ligação.",
  );
  if (op === "call.keepalive") {
    requireValue(!finalStates.includes(row.status), "A ligação já terminou.");
    await exec(
      env,
      "UPDATE calls SET lease_until=? WHERE id=?",
      now() + 90000,
      row.id,
    );
    return { ok: true };
  }
  if (op === "call.reconcile") {
    requireValue(
      row.status === "unknown" && data.confirmed_ended === true,
      "Confirme que a ligação terminou no WhatsApp antes de reconciliar.",
    );
    await exec(
      env,
      "UPDATE calls SET status='completed',ended=?,updated=?,remote_session=NULL,local_session=NULL WHERE id=?",
      now(),
      now(),
      row.id,
    );
    await changed(env, { ...row, status: "completed" });
    return { id: row.id, status: "completed" };
  }
  const action = op.slice(5);
  requireValue(
    ["pre_accept", "accept", "reject", "terminate"].includes(action),
    "Ação de ligação inválida.",
  );
  requireValue(
    !finalStates.includes(row.status) && row.external_id,
    "A ligação terminou ou está sem confirmação.",
  );
  if (["pre_accept", "accept", "reject"].includes(action))
    requireValue(
      row.direction === "inbound" &&
        ["ringing", "preaccepted", "unknown"].includes(row.status),
      "A ligação não está aguardando atendimento.",
    );
  const conn = await one(
    env,
    "SELECT * FROM connections WHERE id=?",
    row.connection_id,
  );
  const answer = ["pre_accept", "accept"].includes(action)
    ? session(
        data.session ||
          (row.local_session ? await unseal(env, row.local_session) : null),
        "answer",
      )
    : null;
  if (row.local_session && answer)
    requireValue(
      JSON.stringify(answer) ===
        JSON.stringify(await unseal(env, row.local_session)),
      "Use a mesma sessão na preparação e na aceitação da ligação.",
    );
  if (answer)
    await exec(
      env,
      "UPDATE calls SET local_session=? WHERE id=?",
      await seal(env, answer),
      row.id,
    );
  try {
    await metaRequest(
      env,
      conn,
      `${json(conn.config).phone_id}/calls`,
      "POST",
      {
        messaging_product: "whatsapp",
        call_id: row.external_id,
        action,
        ...(answer ? { session: answer } : {}),
        ...(action === "accept" ? { biz_opaque_callback_data: row.id } : {}),
      },
    );
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "meta_rejected"))
      await exec(
        env,
        "UPDATE calls SET status='unknown',error='Ação sem confirmação; aguarde o webhook.',updated=? WHERE id=?",
        now(),
        row.id,
      );
    throw e;
  }
  const status =
    action === "accept"
      ? "active"
      : action === "pre_accept"
        ? "preaccepted"
        : action === "reject"
          ? "rejected"
          : "completed";
  await exec(
    env,
    "UPDATE calls SET status=?,started=coalesce(started,?),ended=?,updated=?,lease_until=?,remote_session=CASE WHEN ?=1 THEN NULL ELSE remote_session END,local_session=CASE WHEN ?=1 THEN NULL ELSE local_session END WHERE id=?",
    status,
    status === "active" ? now() : null,
    finalStates.includes(status) ? now() : null,
    now(),
    now() + 90000,
    finalStates.includes(status) ? 1 : 0,
    finalStates.includes(status) ? 1 : 0,
    row.id,
  );
  await changed(env, { ...row, status });
  return { id: row.id, status };
}
export async function callWebhook(env: Env, conn: any, data: any) {
  const p = data.call,
    ts = (Number(p.timestamp) || Math.floor(now() / 1000)) * 1000;
  requireValue(p && typeof p.id === "string", "Evento de ligação inválido.");
  const key = `${conn.id}:${p.id}:${p.event || p.status}:${ts}`;
  if (
    await one(env, "SELECT event_key FROM call_events WHERE event_key=?", key)
  )
    return { duplicate: true };
  let row = await one(
    env,
    "SELECT * FROM calls WHERE connection_id=? AND external_id=?",
    conn.id,
    p.id,
  );
  if (!row && p.biz_opaque_callback_data) {
    row = await one(
      env,
      "SELECT * FROM calls WHERE id=? AND connection_id=? AND direction='outbound' AND external_id IS NULL",
      p.biz_opaque_callback_data,
      conn.id,
    );
    if (row)
      await exec(
        env,
        "UPDATE calls SET external_id=? WHERE id=?",
        p.id,
        row.id,
      );
  }
  if (!row && p.direction === "USER_INITIATED") {
    const recipient = p.from || p.from_user_id;
    requireValue(
      typeof recipient === "string" && recipient.length <= 200,
      "Origem da ligação inválida.",
    );
    let c = await one(
      env,
      "SELECT * FROM conversations WHERE connection_id=? AND coalesce(recipient_id,external_id)=?",
      conn.id,
      recipient,
    );
    if (!c) {
      const id = uid();
      await exec(
        env,
        "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,'waiting',?,0,?,?)",
        id,
        conn.profile_id,
        conn.id,
        "channel:" + conn.id,
        recipient,
        p.from || null,
        uid(),
        now(),
        now(),
      );
      c = await one(env, "SELECT * FROM conversations WHERE id=?", id);
    }
    const id = uid();
    await exec(
      env,
      "INSERT INTO calls(id,profile_id,connection_id,conversation_id,external_id,direction,status,created,updated,lease_until) VALUES(?,?,?,?,?,'inbound','ringing',?,?,?)",
      id,
      conn.profile_id,
      conn.id,
      c.id,
      p.id,
      now(),
      now(),
      now() + 90000,
    );
    row = await one(env, "SELECT * FROM calls WHERE id=?", id);
  }
  if (!row) return { ignored: true };
  let status = row.status;
  if (
    ts >= row.provider_at &&
    (!finalStates.includes(status) || p.event === "terminate")
  ) {
    if (p.event === "terminate" && !finalStates.includes(status))
      status =
        p.status === "FAILED" ? "failed" : p.duration ? "completed" : "missed";
    else if (!finalStates.includes(status) && p.status === "REJECTED")
      status = "rejected";
    else if (!finalStates.includes(status) && p.status === "ACCEPTED")
      status = "active";
    else if (
      !finalStates.includes(status) &&
      p.status === "RINGING" &&
      status !== "active"
    )
      status = "dialing";
    else if (
      p.event === "connect" &&
      row.direction === "outbound" &&
      status !== "active"
    )
      status = "connecting";
    const remote = p.session
      ? await seal(
          env,
          session(p.session, row.direction === "inbound" ? "offer" : "answer"),
        )
      : row.remote_session;
    await exec(
      env,
      "UPDATE calls SET status=?,remote_session=?,local_session=CASE WHEN ?=1 THEN NULL ELSE local_session END,provider_at=?,started=coalesce(started,?),ended=?,duration=?,updated=? WHERE id=?",
      status,
      finalStates.includes(status) ? null : remote,
      finalStates.includes(status) ? 1 : 0,
      ts,
      p.start_time ? Number(p.start_time) * 1000 : null,
      finalStates.includes(status) ? Number(p.end_time) * 1000 || ts : null,
      p.duration ?? row.duration,
      now(),
      row.id,
    );
  }
  await changed(env, { ...row, status }, key);
  // Keep SDP out of event history and application webhooks.
  await exec(
    env,
    "INSERT OR IGNORE INTO call_events(event_key,connection_id,external_id,payload,created) VALUES(?,?,?,?,?)",
    key,
    conn.id,
    p.id,
    JSON.stringify({
      event: p.event,
      status: p.status,
      timestamp: p.timestamp,
    }),
    now(),
  );
  return { received: true };
}
export async function expireCalls(env: Env, profile: string) {
  for (const row of await all(
    env,
    "SELECT * FROM calls WHERE profile_id=? AND status IN ('active','preaccepted','dialing','connecting','ringing') AND lease_until<? LIMIT 5",
    profile,
    now(),
  )) {
    // Record uncertainty before contacting the provider. Alarms must not repeat an ambiguous hang-up.
    await exec(
      env,
      "UPDATE calls SET status='unknown',error='Navegador desconectado; encerramento solicitado.',updated=? WHERE id=?",
      now(),
      row.id,
    );
    if (!row.external_id) continue;
    const conn = await one(
      env,
      "SELECT * FROM connections WHERE id=?",
      row.connection_id,
    );
    try {
      await metaRequest(
        env,
        conn,
        `${json(conn.config).phone_id}/calls`,
        "POST",
        {
          messaging_product: "whatsapp",
          call_id: row.external_id,
          action: row.status === "ringing" ? "reject" : "terminate",
        },
      );
      await exec(
        env,
        "UPDATE calls SET status='completed',ended=?,remote_session=NULL,local_session=NULL WHERE id=?",
        now(),
        row.id,
      );
      await changed(env, { ...row, status: "completed" });
    } catch {
      /* A provider webhook or explicit reconciliation settles this state. */
    }
  }
}
