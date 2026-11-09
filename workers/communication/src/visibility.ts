import { one } from "./db";
import { type Actor, type Env, json } from "./types";
import { managedVisible, configured,actorIds,chatPeer,canonicalActor } from './managed';
export function visibleConversation(actor: Actor, c: any) {
  if (actor.fagoo) return managedVisible(actor,c);
  return (
    actor.kind !== "app" ||
    !c.external_namespace.startsWith("app:") ||
    c.external_namespace === `app:${actor.id}`
  );
}
export async function visibleEvent(env: Env, actor: Actor, e: any) {
  if (e.kind.startsWith("internal.")) {
    if (actor.kind !== "user" || (actor.fagoo && !actor.fagoo.capabilities.includes("team.chat"))) return false;
    const chat = await one(
      env,
      "SELECT * FROM internal_chats WHERE id=? AND profile_id=? AND (member_a IN(SELECT value FROM json_each(?)) OR member_b IN(SELECT value FROM json_each(?)))",
      json(e.payload).chat_id || "",
      e.profile_id,
      JSON.stringify(actorIds(actor)),
      JSON.stringify(actorIds(actor)),
    );
    if(actor.fagoo && chat){const peer=chatPeer(actor,chat);if(peer.startsWith("bot:") && !actor.bots.includes(peer.slice(4)))return false;}
    return !!chat;
  }
  if (e.kind.startsWith("bot.")) {
    const run = await one(
      env,
      "SELECT actor,context FROM bot_runs WHERE id=?",
      e.resource_id,
    );
    if (json(run?.context).internal_chat_id && canonicalActor(actor,run?.actor) !== actor.id)
      return false;
  }
  if (actor.fagoo && !configured(actor)) {
    if (e.kind.startsWith('bot.')) return false;
    let id=json(e.payload).conversation_id;
    if(e.kind.startsWith('conversation.')) id=e.resource_id;
    if(e.kind.startsWith('ticket.')) id=(await one(env,'SELECT conversation_id FROM tickets WHERE id=? AND profile_id=?',e.resource_id,e.profile_id))?.conversation_id;
    const c=id ? await one(env,'SELECT * FROM conversations WHERE id=? AND profile_id=?',id,e.profile_id) : null;
    return !!c && managedVisible(actor,c);
  }
  if (actor.kind !== "app") return true;
  const scope = e.kind.startsWith("call.")
    ? "calls:read"
    : e.kind.startsWith("bot.")
      ? "bots:invoke"
      : e.kind.startsWith("ticket.")
        ? "tickets:read"
        : "conversations:read";
  if (!actor.scopes.includes(scope)) return false;
  if (e.kind.startsWith("call.")) {
    const call = await one(
      env,
      "SELECT actor FROM calls WHERE id=?",
      e.resource_id,
    );
    if (!call || (call.actor && call.actor !== actor.id)) return false;
  }
  if (e.kind.startsWith("bot.")) {
    const run = await one(
      env,
      "SELECT actor,bot_id FROM bot_runs WHERE id=?",
      e.resource_id,
    );
    return !!run && run.actor === actor.id && actor.bots.includes(run.bot_id);
  }
  const payload = json(e.payload);
  let id = payload.conversation_id;
  if (e.kind.startsWith("conversation.")) id = e.resource_id;
  if (e.kind.startsWith("ticket."))
    id = (
      await one(
        env,
        "SELECT conversation_id FROM tickets WHERE id=?",
        e.resource_id,
      )
    )?.conversation_id;
  const c = id
    ? await one(
        env,
        "SELECT external_namespace FROM conversations WHERE id=?",
        id,
      )
    : null;
  return !!c && visibleConversation(actor, c);
}
