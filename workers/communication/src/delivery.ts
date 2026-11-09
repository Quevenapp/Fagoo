import { batch, exec, one } from "./db";
import { applyChannelEvents, channelEvent } from "./whatsapp";
import { conversation } from "./service";
import { event } from "./events";
import { type Env, now, json } from "./types";
export async function finishDelivery(env: Env, row: any, external: string) {
  const payload = json(row.payload),
    attachments = payload.media_id
      ? [payload.media_id]
      : payload.template_media_ids || payload.attachments || [];
  const writes: [string, any[]][] = [
    [
      "UPDATE outbox SET status='sent',external_id=?,error=NULL,updated=? WHERE id=?",
      [external, now(), row.id],
    ],
  ];
  if (row.kind !== "team" && row.kind !== "action")
    writes.push([
      "INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,source_key,content,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "delivery:" + row.id,
        row.profile_id,
        row.conversation_id,
        "outbound",
        row.actor,
        payload.text || "",
        JSON.stringify(attachments),
        external,
        now(),
        "delivery:" + row.id,
        JSON.stringify(payload.content || {}),
        "sent",
      ],
    ]);
  await batch(env, writes);
  if (row.kind !== "team" && row.kind !== "action")
    await event(env, row.profile_id, "message.sent", row.id, {
      conversation_id: row.conversation_id,
      text: payload.text || "",
      attachments,
    });
  if (row.kind === "action" && payload.content?.type !== "read") {
    const conn = await one(
      env,
      "SELECT * FROM connections WHERE id=?",
      row.connection_id,
    );
    const c = await conversation(env, row.conversation_id, row.profile_id),
      content = payload.content;
    await channelEvent(env, conn, {
      event: content.type,
      external_id: c.recipient_id || c.external_id,
      message_id: content.target_external_id,
      event_id: row.id,
      participant: row.actor,
      emoji: content.emoji,
      text: content.text,
      timestamp: row.created,
    });
  }
  if (row.connection_id)
    await applyChannelEvents(env, row.connection_id, external);
  await exec(env, "UPDATE outbox SET completion_handled=1 WHERE id=?", row.id);
}
