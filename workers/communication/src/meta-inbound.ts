import { Env, json, requireValue, now } from "./types";
import { one, exec } from "./db";
import { sha, secret } from "./security";
import { metaRequest } from "./meta";
import { storeRemoteMedia } from "./integrations";
import { metaCredentials } from "./meta-accounts";

export async function metaInbound(
  env: Env,
  conn: any,
  body: any,
  dispatch: (data: any) => Promise<Response>,
) {
  for (const entry of body.entry || [])
    for (const change of entry.changes || []) {
      const v = change.value;
      if (v?.metadata?.phone_number_id !== json(conn.config).phone_id) continue;
      for (const call of v.calls || []) {
        if (!["connect", "terminate"].includes(call.event)) continue;
        const r = await dispatch({ event: "call", call });
        if (!r.ok) return r;
      }
      for (const status of v.statuses || []) {
        const r = await dispatch(
          status.type === "call"
            ? { event: "call", call: status }
            : {
                event: "status",
                external_id:
                  status.recipient_id || status.recipient_user_id || "",
                message_id: status.id,
                status: status.status,
                pricing: status.pricing,
                participant:
                  status.recipient_participant_id ||
                  status.recipient_participant_user_id ||
                  null,
                timestamp: Number(status.timestamp) * 1000,
              },
        );
        if (!r.ok) return r;
      }
      for (const g of v.groups || []) {
        if (!g.group_id && !g.request_id) continue;
        const detail =
          g.type === "group_delete" || g.errors?.length || !g.group_id
            ? {}
            : await metaRequest(
                env,
                conn,
                `${encodeURIComponent(g.group_id)}?fields=subject,description,participants`,
              );
        const r = await dispatch({
          event: "group",
          external_id: g.group_id || "",
          message_id: g.request_id || g.group_id,
          subject: g.subject,
          invite_link: g.invite_link,
          own_admin: true,
          provider_request_id: g.request_id,
          provider_errors: g.errors || [],
          deleted: g.type === "group_delete",
          ...detail,
        });
        if (!r.ok) return r;
      }
      for (const m of v.messages || []) {
        const from = m.from || m.from_user_id;
        if (!from) continue;
        const destination = m.group_id || from;
        if (m.interactive?.call_permission_reply) {
          await exec(
            env,
            "INSERT INTO call_permissions(connection_id,recipient,payload,updated) VALUES(?,?,?,?) ON CONFLICT(connection_id,recipient) DO UPDATE SET payload=excluded.payload,updated=excluded.updated WHERE excluded.updated>=call_permissions.updated",
            conn.id,
            from,
            JSON.stringify({ reply: m.interactive.call_permission_reply }),
            Number(m.timestamp) * 1000 || now(),
          );
          continue;
        }
        if (m.reaction) {
          const r = await dispatch({
            event: "reaction",
            external_id: destination,
            message_id: m.reaction.message_id,
            event_id: m.id,
            participant: from,
            emoji: m.reaction.emoji,
            timestamp: Number(m.timestamp) * 1000,
          });
          if (!r.ok) return r;
          continue;
        }
        // Inbound retries must not repeatedly download the same private attachment.
        const known = await one(
          env,
          "SELECT id FROM inbox WHERE event_key=?",
          `${conn.profile_id}:channel:${conn.id}:${destination}:${m.id}`,
        );
        if (known) continue;
        const content: any = {
          type: m.type || "text",
          participant: from,
          participant_name:
            v.contacts?.find((x: any) => (x.wa_id || x.user_id) === from)
              ?.profile?.name || from,
        };
        if (m.context?.id) content.reply_external_id = m.context.id;
        const interactiveReply =
          m.interactive?.button_reply?.id || m.interactive?.list_reply?.id;
        if (typeof interactiveReply === "string")
          content.interactive_reply_id = interactiveReply;
        if (m.location) content.location = m.location;
        if (m.contacts)
          content.contacts = m.contacts.map((x: any) => ({
            name: x.name?.formatted_name || "",
            phone: x.phones?.[0]?.phone || "",
          }));
        const attachments: string[] = [];
        let value =
          m.text?.body ||
          m.interactive?.button_reply?.title ||
          m.interactive?.list_reply?.title ||
          m.button?.text ||
          "";
        const media = m.image || m.audio || m.document || m.video || m.sticker;
        if (media) {
          value = media.caption || value;
          if (m.audio?.voice) content.type = "voice";
          const id = (await sha(`${conn.id}:${m.id}:${media.id}`)).slice(0, 32);
          const existing = await one(
            env,
            "SELECT id FROM media WHERE id=? AND profile_id=?",
            id,
            conn.profile_id,
          );
          if (existing) attachments.push(id);
          else
            try {
              const info = await metaRequest(
                env,
                conn,
                encodeURIComponent(media.id),
              );
              const url = new URL(info.url);
              requireValue(
                url.protocol === "https:" &&
                  (url.hostname === "lookaside.fbsbx.com" ||
                    url.hostname.endsWith(".fbcdn.net") ||
                    url.hostname.endsWith(".fbsbx.com")),
                "Endereço de mídia Meta inválido.",
              );
              const keys = await metaCredentials(env, conn);
              const resource = await fetch(url, {
                headers: { Authorization: `Bearer ${keys.token}` },
                // storeRemoteMedia rejects non-2xx responses. Never follow a
                // redirect carrying the private Meta credential.
                redirect: "manual",
                signal: AbortSignal.timeout(60000),
              });
              attachments.push(
                await storeRemoteMedia(
                  env,
                  conn.profile_id,
                  media.filename || `${m.type}-${m.id.slice(-10)}`,
                  info.mime_type || "application/octet-stream",
                  resource,
                  { id, actor: "transport:" + conn.id },
                ),
              );
            } catch {
              value +=
                "\n[Anexo indisponível. Solicite o reenvio ou verifique o tamanho e a conexão.]";
              content.media_error = true;
            }
        }
        if (m.type === "unsupported")
          value = "[Tipo de mensagem não suportado pelo canal.]";
        const r = await dispatch({
          external_id: destination,
          phone: m.group_id ? null : m.from || null,
          message_id: m.id,
          customer_at: Number(m.timestamp) * 1000,
          text: value,
          attachments,
          content,
          chat_type: m.group_id ? "group" : "direct",
        });
        if (!r.ok) return r;
      }
    }
  return Response.json({ received: true });
}
