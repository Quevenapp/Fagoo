import { managedAppAllowed } from "./number-router";
import { all, one, exec } from "./db";
import { Actor, ApiError, Env, now, uid, json, requireValue } from "./types";
import { access } from "./security";
import { conversation } from "./service";
import { needCapability, syncGroup } from "./whatsapp";
import { metaRequest } from "./meta";

export async function groupCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  key: string,
) {
  access(actor, profile, "groups:manage");
  if (op === "group.reconcile") {
    const job = await one(
      env,
      "SELECT * FROM group_operations WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(
      job && (job.actor === actor.id || actor.role === "admin"),
      "Operação não encontrada.",
    );
    requireValue(
      job.status === "unknown" && ["sent", "failed"].includes(data.status),
      "Reconcilie somente uma operação sem confirmação.",
    );
    requireValue(
      data.confirmed === true,
      "Confira o resultado no WhatsApp antes de reconciliar.",
    );
    await exec(
      env,
      "UPDATE group_operations SET status=?,error=NULL,updated=? WHERE id=?",
      data.status,
      now(),
      job.id,
    );
    return { id: job.id, status: data.status };
  }
  let c = data.id ? await conversation(env, data.id, profile, actor) : null;
  if (c)
    requireValue(c.chat_type === "group", "Selecione uma conversa de grupo.");
  if (op === "group.policy") {
    requireValue(
      c && ["off", "mentions", "all"].includes(data.bot_policy),
      "Escolha: desligado, menções ou todas as mensagens.",
    );
    await exec(
      env,
      "UPDATE conversations SET bot_policy=?,epoch=epoch+1,updated=? WHERE id=?",
      data.bot_policy,
      now(),
      c.id,
    );
    return { id: c.id, bot_policy: data.bot_policy };
  }
  const conn = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=? AND status='active'",
    c?.connection_id || data.connection_id,
    profile,
  );
  requireValue(conn, "Selecione uma conexão WhatsApp ativa.");
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
  needCapability(conn, "group_manage");
  const action = data.action;
  requireValue(
    [
      "sync",
      "create",
      "join",
      "refresh",
      "invite",
      "subject",
      "description",
      "participants",
      "leave",
      "announcement",
    ].includes(action),
    "Ação de grupo inválida.",
  );
  if (!["sync", "create", "join"].includes(action))
    requireValue(c, "Informe a conversa do grupo.");
  if (
    !["sync", "refresh", "invite"].includes(action) &&
    (await one(
      env,
      "SELECT id FROM group_operations WHERE connection_id=? AND status IN ('pending','sending','unknown') LIMIT 1",
      conn.id,
    ))
  )
    throw new ApiError(
      409,
      "group_in_progress",
      "Aguarde ou reconcilie a operação anterior em Grupos antes de alterar novamente.",
    );
  const payload: any = { action, destination: c?.external_id || null };
  if (["create", "subject"].includes(action)) {
    requireValue(
      typeof data.subject === "string" &&
        data.subject.trim() &&
        data.subject.length <= 128,
      "Nome do grupo deve ter até 128 caracteres.",
    );
    payload.subject = data.subject.trim();
  }
  if (action === "description") {
    requireValue(
      typeof data.description === "string" && data.description.length <= 2048,
      "Descrição deve ter até 2.048 caracteres.",
    );
    payload.description = data.description;
  }
  if (action === "join") {
    requireValue(
      conn.kind === "qr",
      "A Meta só permite grupos criados pela própria empresa. Use QR para entrar em um grupo por convite.",
    );
    const match =
      /^(?:https:\/\/chat\.whatsapp\.com\/)?([a-zA-Z0-9_-]{10,100})$/.exec(
        data.invite || "",
      );
    requireValue(match, "Link de convite inválido.");
    payload.invite = match[1];
  }
  if (action === "announcement") {
    requireValue(
      conn.kind === "qr" && typeof data.enabled === "boolean",
      "Esta opção exige QR.",
    );
    payload.enabled = data.enabled;
  }
  if (
    action === "participants" ||
    (action === "create" && conn.kind === "qr")
  ) {
    requireValue(
      Array.isArray(data.participants) &&
        data.participants.length > 0 &&
        data.participants.length <= 30,
      "Informe de 1 a 30 participantes.",
    );
    requireValue(
      data.participants.every(
        (p: any) =>
          typeof p === "string" &&
          /^(?:\+?\d{8,20}(?:@(?:s\.whatsapp\.net|lid))?|US\.[\w.]+)$/.test(p),
      ),
      "Participante inválido.",
    );
    payload.participants = data.participants;
    if (action === "participants") {
      requireValue(
        ["add", "remove", "promote", "demote"].includes(data.operation),
        "Operação inválida.",
      );
      payload.operation = data.operation;
    }
  }
  if (c && conn.kind === "qr" && !["refresh", "leave"].includes(action)) {
    const g = await one(
      env,
      "SELECT own_admin FROM whatsapp_groups WHERE conversation_id=?",
      c.id,
    );
    requireValue(
      g?.own_admin,
      "Este número precisa ser administrador do grupo. Atualize os dados do grupo.",
    );
  }
  if (conn.kind === "meta" && action === "participants")
    requireValue(
      payload.operation === "remove",
      "Na Meta, os participantes entram pelo link de convite.",
    );
  const id = uid();
  await exec(
    env,
    "INSERT INTO group_operations(id,profile_id,connection_id,conversation_id,actor,operation,payload,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    id,
    profile,
    conn.id,
    c?.id || null,
    actor.id,
    action,
    JSON.stringify(payload),
    now(),
    now(),
  );
  if (conn.kind === "qr") return { id, status: "pending" };
  await exec(
    env,
    "UPDATE group_operations SET status='sending',updated=? WHERE id=?",
    now(),
    id,
  );
  const cfg = json(conn.config),
    dest = encodeURIComponent(c?.external_id || "");
  try {
    let result: any;
    if (action === "sync") {
      result = await metaRequest(
        env,
        conn,
        `${cfg.phone_id}/groups?limit=100${data.cursor ? "&after=" + encodeURIComponent(data.cursor) : ""}`,
      );
      const groups =
        result.data?.groups || (Array.isArray(result.data) ? result.data : []);
      for (const g of groups)
        await syncGroup(env, conn, {
          external_id: g.id || g.group_id,
          subject: g.subject,
          own_admin: true,
        });
      result = {
        count: groups.length,
        cursor: result.paging?.next
          ? result.paging?.cursors?.after || null
          : null,
      };
    } else if (action === "create")
      result = await metaRequest(env, conn, `${cfg.phone_id}/groups`, "POST", {
        messaging_product: "whatsapp",
        subject: payload.subject,
        join_approval_mode: "auto_approve",
      });
    else if (action === "refresh") {
      result = await metaRequest(
        env,
        conn,
        `${dest}?fields=subject,description,participants`,
      );
      await syncGroup(env, conn, {
        external_id: c!.external_id,
        ...result,
        own_admin: true,
      });
    } else if (action === "invite") {
      result = await metaRequest(env, conn, `${dest}/invite_link`);
      await syncGroup(env, conn, {
        external_id: c!.external_id,
        invite_link: result.invite_link,
      });
    } else if (action === "subject" || action === "description")
      result = await metaRequest(env, conn, dest, "POST", {
        messaging_product: "whatsapp",
        [action]: payload[action],
      });
    else if (action === "participants")
      result = await metaRequest(env, conn, `${dest}/participants`, "DELETE", {
        messaging_product: "whatsapp",
        participants: payload.participants.map((p: string) =>
          p.startsWith("US.") ? { user_id: p } : { user: p },
        ),
      });
    else
      throw new ApiError(
        422,
        "unsupported_capability",
        "A Meta não permite sair de grupos como um usuário comum.",
      );
    const status = result.request_id ? "sending" : "sent";
    await exec(
      env,
      "UPDATE group_operations SET status=?,result=?,updated=? WHERE id=?",
      status,
      JSON.stringify(result),
      now(),
      id,
    );
    return { id, status, result };
  } catch (e) {
    await exec(
      env,
      "UPDATE group_operations SET status=?,error=?,updated=? WHERE id=?",
      e instanceof ApiError && e.code === "meta_rejected"
        ? "failed"
        : "unknown",
      e instanceof ApiError ? e.message : "Operação sem confirmação.",
      now(),
      id,
    );
    throw e;
  }
}
