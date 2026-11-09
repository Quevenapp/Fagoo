import { all, one, exec, batch } from "./db";
import { type Env, ApiError, requireValue, now, json } from "./types";
import { conversation, message, settings } from "./service";
import { finishDelivery } from "./delivery";
import { event } from "./events";
import { approvedTemplate } from "./integrations";
import { syncGroup } from "./whatsapp";
import { assertNumberDelivery } from "./number-permissions";

export async function transport(
  env: Env,
  connectionId: string,
  operation: string,
  data: any,
) {
  const conn = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND kind IN ('qr','hermes-whatsapp')",
    connectionId,
  );
  requireValue(conn, "Conector não encontrado.");
  if (
    operation === "commands" &&
    conn.status === "active" &&
    Number(json(conn.config).protocol_version) >= 2
  ) {
    const job = await one(
      env,
      "SELECT * FROM group_operations WHERE connection_id=? AND status='pending' AND NOT EXISTS(SELECT 1 FROM group_operations WHERE connection_id=? AND status IN ('sending','unknown')) ORDER BY created LIMIT 1",
      conn.id,
      conn.id,
    );
    if (job) {
      await exec(
        env,
        "UPDATE group_operations SET status='sending',updated=? WHERE id=?",
        now(),
        job.id,
      );
      return {
        commands: [{ id: job.id, kind: "group", payload: json(job.payload) }],
      };
    }
  }
  if (operation !== "commands") {
    const job = await one(
      env,
      "SELECT * FROM group_operations WHERE id=? AND connection_id=?",
      data.id,
      conn.id,
    );
    if (job) {
      if (operation === "check")
        return { valid: conn.status === "active" && job.status === "sending" };
      requireValue(
        operation === "receipt" &&
          ["sent", "failed", "unknown"].includes(data.status),
        "Recibo inválido.",
      );
      if (job.status === "sent") return { ok: true, duplicate: true };
      requireValue(
        ["sending", "unknown"].includes(job.status),
        "Operação não aguardava confirmação.",
      );
      await exec(
        env,
        "UPDATE group_operations SET status=?,result=?,error=?,updated=? WHERE id=?",
        data.status,
        JSON.stringify(data.result || {}),
        String(data.error || "").slice(0, 200),
        now(),
        job.id,
      );
      return { ok: true };
    }
  }
  if (operation === "commands") {
    if (conn.status !== "active") return { commands: [] };
    await exec(
      env,
      "UPDATE outbox SET status='cancelled',updated=? WHERE connection_id=? AND kind!='team' AND status='pending' AND epoch!=(SELECT epoch FROM conversations WHERE id=outbox.conversation_id)",
      now(),
      conn.id,
    );
    const row = await one(
      env,
      "SELECT o.*,c.external_id destination,c.last_customer,c.chat_type FROM outbox o JOIN conversations c ON c.id=o.conversation_id WHERE o.connection_id=? AND o.kind!='team' AND o.status='pending' AND o.epoch=c.epoch AND NOT EXISTS(SELECT 1 FROM outbox p WHERE p.conversation_id=o.conversation_id AND p.kind!='team' AND (p.created<o.created OR p.created=o.created AND p.rowid<o.rowid) AND p.status IN ('pending','sending','unknown')) ORDER BY o.created,o.rowid LIMIT 1",
      conn.id,
    );
    if (!row) return { commands: [] };
    const cfg = json(conn.config),
      payload = { ...json(row.payload), chat_type: row.chat_type };
    try {
      await assertNumberDelivery(env, conn.id, row.actor, row.kind, payload);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await exec(
        env,
        "UPDATE outbox SET status='cancelled',error=?,updated=? WHERE id=?",
        error.message,
        now(),
        row.id,
      );
      return { commands: [] };
    }
    if (
      cfg.platform === "whatsapp_cloud" &&
      row.chat_type !== "group" &&
      now() - row.last_customer >= 86400000
    ) {
      const opts = (await settings(env, conn.profile_id)).notifications,
        consent = await one(
          env,
          "SELECT status FROM consents WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
          row.conversation_id,
        ),
        t = cfg.approved_template;
      if (
        row.kind !== "notification" ||
        consent?.status !== "granted" ||
        !opts?.enabled ||
        t?.name !== opts.template_name ||
        t?.language !== opts.language ||
        !approvedTemplate(t) ||
        now() - (cfg.template_checked_at || 0) > 86400000
      ) {
        await exec(
          env,
          "UPDATE outbox SET error='Aguardando janela Meta, consentimento ou template UTILITY aprovado.' WHERE id=?",
          row.id,
        );
        return { commands: [] };
      }
      payload.template = {
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
      };
    }
    await exec(
      env,
      "UPDATE outbox SET status='sending',updated=? WHERE id=? AND status='pending'",
      now(),
      row.id,
    );
    return {
      commands: [
        { id: row.id, destination: row.destination, epoch: row.epoch, payload },
      ],
    };
  }
  const row = await one(
    env,
    "SELECT * FROM outbox WHERE id=? AND connection_id=? AND kind!=?",
    data.id,
    conn.id,
    "team",
  );
  requireValue(row, "Entrega não encontrada.");
  const c = await conversation(env, row.conversation_id, conn.profile_id);
  if (operation === "check") {
    let valid =
      conn.status === "active" &&
      row.status === "sending" &&
      row.epoch === c.epoch;
    try {
      await assertNumberDelivery(
        env,
        conn.id,
        row.actor,
        row.kind,
        json(row.payload),
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      valid = false;
    }
    if (!valid && row.status === "sending")
      await exec(
        env,
        "UPDATE outbox SET status='cancelled',updated=? WHERE id=?",
        now(),
        row.id,
      );
    return { valid };
  }
  if (operation === "receipt") {
    requireValue(
      ["sent", "failed", "unknown"].includes(data.status),
      "Recibo inválido.",
    );
    if (row.status === "sent") return { ok: true, duplicate: true };
    if (data.status === "sent")
      requireValue(
        typeof data.external_id === "string" && data.external_id,
        "O envio exige confirmação do canal.",
      );
    requireValue(
      ["sending", "unknown"].includes(row.status),
      "Entrega não aguardava confirmação.",
    );
    const payload = json(row.payload);
    await batch(env, [
      [
        "INSERT INTO transport_receipts(id,connection_id,status,external_id,error,created) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,external_id=excluded.external_id,error=excluded.error",
        [
          row.id,
          conn.id,
          data.status,
          data.external_id || null,
          String(data.error || "").slice(0, 200),
          now(),
        ],
      ],
      [
        "UPDATE outbox SET status=?,external_id=?,error=?,updated=? WHERE id=?",
        [
          data.status,
          data.external_id || null,
          String(data.error || "").slice(0, 200),
          now(),
          row.id,
        ],
      ],
    ]);
    if (data.status === "sent") {
      await finishDelivery(env, row, data.external_id);
    }
    return { ok: true };
  }
  throw new ApiError(404, "not_found", "Operação inválida.");
}
