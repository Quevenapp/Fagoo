import { all, one, exec, batch } from "./db";
import {
  type Actor,
  type Env,
  ApiError,
  json,
  now,
  uid,
  requireValue,
} from "./types";
import { access } from "./security";
import { event } from "./events";
import { createRun } from "./service";
import { hermesRequest } from "./integrations";
import { requireCapability, configured, actorIds, chatPeer, canonicalActor } from './managed';

function teamAccess(actor: Actor, profile: string) {
  requireCapability(actor,'team.chat');
  access(actor, profile, "presence:read");
  if (actor.kind !== "user" || actor.id.startsWith("bot:"))
    throw new ApiError(
      403,
      "people_only",
      "A conversa interna exige uma conta de pessoa.",
    );
}
export async function teamDirectory(env: Env, actor: Actor, profile: string) {
  teamAccess(actor, profile);
  const connections = await all(
    env,
    "SELECT c.*,b.remote_profile,p.checked_at,p.online FROM connections c JOIN bots b ON b.connection_id=c.id AND b.enabled=1 LEFT JOIN team_connection_presence p ON p.connection_id=c.id WHERE c.profile_id=? AND c.kind='hermes' AND c.status='active' GROUP BY c.id",
    profile,
  );
  await Promise.all(
    connections.map(async (connection) => {
      if (
        Math.max(connection.last_seen || 0, connection.checked_at || 0) >
        now() - 60000
      )
        return;
      const claimed = await exec(
        env,
        "INSERT INTO team_connection_presence(connection_id,checked_at,online) VALUES(?,?,0) ON CONFLICT(connection_id) DO UPDATE SET checked_at=excluded.checked_at WHERE team_connection_presence.checked_at<?",
        connection.id,
        now(),
        now() - 60000,
      );
      if (!claimed.meta.changes) return;
      let online = false;
      try {
        await hermesRequest(
          env,
          connection,
          "/v1/capabilities",
          undefined,
          connection.remote_profile,
        );
        online = true;
      } catch {}
      await exec(
        env,
        "UPDATE team_connection_presence SET online=?,checked_at=? WHERE connection_id=?",
        online ? 1 : 0,
        now(),
        connection.id,
      );
    }),
  );
  const users = await all(
    env,
    "SELECT u.id,u.name,coalesce(p.present,0) present FROM users u LEFT JOIN presence p ON p.actor=u.id AND p.profile_id=? WHERE u.disabled=0 AND (u.role='admin' OR EXISTS(SELECT 1 FROM json_each(u.profiles) WHERE value=?)) ORDER BY u.name,u.id",
    profile,
    profile,
  );
  const bots = await all(
    env,
    "SELECT b.id,b.name,b.enabled,b.line_ids,c.status,c.last_seen,p.checked_at,p.online FROM bots b JOIN connections c ON c.id=b.connection_id LEFT JOIN team_connection_presence p ON p.connection_id=c.id WHERE b.profile_id=? ORDER BY b.name,b.id",
    profile,
  );
  return {
    data: [
      ...users.filter(u=>!actor.fagoo || actor.fagoo.people.some(p=>p.id===u.id) || u.id===actor.id).map((u) => ({
        id: u.id,
        kind: "user",
        name: u.name,
        online: !!u.present,
      })),
      ...bots.filter(b=>!actor.fagoo || configured(actor) || actor.bots.includes(b.id)).map((b) => ({
        id: `bot:${b.id}`,
        kind: "bot",
        bot_id: b.id,
        name: b.name,
        online:
          !!b.enabled &&
          b.status === "active" &&
          (b.checked_at >= (b.last_seen || 0)
            ? !!b.online && now() - b.checked_at < 120000
            : !!b.last_seen && now() - b.last_seen < 120000),
        enabled: !!b.enabled,
        last_seen: b.last_seen,
        line_ids: b.line_ids === null ? null : json(b.line_ids, []),
      })),
    ],
  };
}
export async function internalChat(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  teamAccess(actor, profile);
  const chat = await one(
    env,
    "SELECT * FROM internal_chats WHERE id=? AND profile_id=? AND (member_a IN(SELECT value FROM json_each(?)) OR member_b IN(SELECT value FROM json_each(?)))",
    id,
    profile,
    JSON.stringify(actorIds(actor)),
    JSON.stringify(actorIds(actor)),
  );
  if (chat && actor.fagoo) {const peer=chatPeer(actor,chat);if(peer.startsWith("bot:") && !actor.bots.includes(peer.slice(4)))throw new ApiError(404,"not_found","Conversa interna não encontrada.");}
  if (!chat)
    throw new ApiError(404, "not_found", "Conversa interna não encontrada.");
  return chat;
}
async function withPeer(
  env: Env,
  actor: Actor,
  profile: string,
  chat: any,
  directory?: any[],
) {
  const peerId = chatPeer(actor,chat);
  const peer = (
    directory || (await teamDirectory(env, actor, profile)).data
  ).find((entry) => entry.id === peerId);
  return {
    ...chat,
    peer: peer || {
      id: peerId,
      kind: peerId.startsWith("bot:") ? "bot" : "user",
      name: "Contato indisponível",
      online: false,
    },
  };
}
export async function listInternalChats(
  env: Env,
  actor: Actor,
  profile: string,
) {
  teamAccess(actor, profile);
  const chats = await all(
    env,
    "SELECT * FROM internal_chats WHERE profile_id=? AND (member_a IN(SELECT value FROM json_each(?)) OR member_b IN(SELECT value FROM json_each(?))) ORDER BY updated DESC,id LIMIT 200",
    profile,
    JSON.stringify(actorIds(actor)),
    JSON.stringify(actorIds(actor)),
  );
  const directory = (await teamDirectory(env, actor, profile)).data;
  return {
    data: await Promise.all(
      chats.filter(chat=>{const peer=chatPeer(actor,chat);return !actor.fagoo || !peer.startsWith("bot:") || actor.bots.includes(peer.slice(4));}).map((chat) => withPeer(env, actor, profile, chat, directory)),
    ),
  };
}
export async function internalChatDetail(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  const chat = await internalChat(env, actor, profile, id);
  const messages = (
    await all(
      env,
      "SELECT m.id,m.author,m.text,m.created,coalesce(r.status,m.status) status,m.run_id FROM internal_messages m LEFT JOIN bot_runs r ON r.id=m.run_id WHERE m.chat_id=? ORDER BY m.created DESC,m.rowid DESC LIMIT 500",
      id,
    )
  ).reverse();
  return { ...(await withPeer(env, actor, profile, chat)), messages:messages.map(m=>actor.fagoo?{...m,source_author:m.author,author:canonicalActor(actor,m.author)}:m) };
}
export async function internalCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  requestId: string,
) {
  teamAccess(actor, profile);
  if (op === "internal.create") {
    const peer = (await teamDirectory(env, actor, profile)).data.find(
      (entry) => entry.id === data.peer_id,
    );
    requireValue(
      peer && peer.id !== actor.id,
      "Escolha outra pessoa ou bot deste perfil.",
    );
    const existing=await one(env,"SELECT * FROM internal_chats WHERE profile_id=? AND ((member_a IN(SELECT value FROM json_each(?)) AND member_b IN(SELECT value FROM json_each(?))) OR (member_b IN(SELECT value FROM json_each(?)) AND member_a IN(SELECT value FROM json_each(?)))) LIMIT 1",profile,JSON.stringify(actorIds(actor)),JSON.stringify(actorIds(actor,peer.id)),JSON.stringify(actorIds(actor)),JSON.stringify(actorIds(actor,peer.id)));
    if(existing)return withPeer(env,actor,profile,existing);
    const [a, b] = [actor.id, peer.id].sort();
    const id = uid();
    await exec(
      env,
      "INSERT OR IGNORE INTO internal_chats(id,profile_id,member_a,member_b,created,updated) VALUES(?,?,?,?,?,?)",
      id,
      profile,
      a,
      b,
      now(),
      now(),
    );
    const chat = await one(
      env,
      "SELECT * FROM internal_chats WHERE profile_id=? AND member_a=? AND member_b=?",
      profile,
      a,
      b,
    );
    return withPeer(env, actor, profile, chat);
  }
  const chat = await internalChat(env, actor, profile, data.id),
    peerId = chatPeer(actor,chat);
  const peer = (await teamDirectory(env, actor, profile)).data.find(
    (entry) => entry.id === peerId,
  );
  requireValue(peer, "Este contato não está mais disponível no perfil.");
  requireValue(
    typeof data.text === "string" &&
      data.text.trim().length &&
      data.text.length <= 60000,
    "Informe uma mensagem de até 60.000 caracteres.",
  );
  const source = `internal:${profile}:${actor.id}:${requestId}`;
  const old = await one(
    env,
    "SELECT * FROM internal_messages WHERE source_key=?",
    source,
  );
  if (old) return old;
  const id = uid(),
    text = data.text.trim();
  let runId: string | null = null;
  if (peer.kind === "bot") {
    const history = await all(
      env,
      "SELECT author,text FROM internal_messages WHERE chat_id=? ORDER BY created DESC,rowid DESC LIMIT 20",
      chat.id,
    );
    const run = await createRun(
      env,
      actor,
      profile,
      {
        bot_id: peerId.slice(4),
        input: JSON.stringify({ message: text, history: history.reverse() }),
      },
      {
        source_key: source,
        context: { internal_chat_id: chat.id, internal_message_id: id },
      },
    );
    runId = run.id;
  }
  await batch(env, [
    [
      "INSERT INTO internal_messages(id,chat_id,author,text,status,run_id,source_key,created) VALUES(?,?,?,?,?,?,?,?)",
      [
        id,
        chat.id,
        actor.id,
        text,
        runId ? "queued" : "sent",
        runId,
        source,
        now(),
      ],
    ],
    ["UPDATE internal_chats SET updated=? WHERE id=?", [now(), chat.id]],
  ]);
  await event(
    env,
    profile,
    "internal.message",
    id,
    { chat_id: chat.id },
    `internal:${id}`,
  );
  return {
    id,
    author: actor.id,
    text,
    created: now(),
    status: runId ? "queued" : "sent",
    run_id: runId,
  };
}
export async function finishInternalRun(env: Env, run: any, output: string) {
  const chatId = json(run.context).internal_chat_id;
  if (!chatId) return;
  const aliases=env.FAGOO_MANAGED==='true'?await all(env,'SELECT source_actor FROM fagoo_actor_aliases WHERE profile_id=? AND canonical_user_id=?',run.profile_id,run.actor):[];
  const identities=JSON.stringify([run.actor,...aliases.map(r=>r.source_actor)]);
  const chat = await one(
    env,
    "SELECT * FROM internal_chats WHERE id=? AND profile_id=? AND (member_a IN(SELECT value FROM json_each(?)) OR member_b IN(SELECT value FROM json_each(?)))",
    chatId,
    run.profile_id,
    identities,
    identities,
  );
  if (!chat || ![chat.member_a, chat.member_b].includes(`bot:${run.bot_id}`))
    return;
  const parsed = json(output, null),
    text = typeof parsed?.text === "string" ? parsed.text : output;
  const id = `bot-reply:${run.id}`;
  await batch(env, [
    [
      "INSERT OR IGNORE INTO internal_messages(id,chat_id,author,text,source_key,created) VALUES(?,?,?,?,?,?)",
      [
        id,
        chat.id,
        `bot:${run.bot_id}`,
        String(text).slice(0, 60000),
        id,
        now(),
      ],
    ],
    ["UPDATE internal_chats SET updated=? WHERE id=?", [now(), chat.id]],
  ]);
  await event(
    env,
    run.profile_id,
    "internal.message",
    id,
    { chat_id: chat.id },
    id,
  );
}
