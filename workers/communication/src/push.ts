import { currentGrant, managedPushAllowed } from './managed';
import { all, one, exec } from "./db";
import {
  type Env,
  type Actor,
  ApiError,
  uid,
  now,
  json,
  requireValue,
} from "./types";
import { admin, secret, setSecret, publicUrl } from "./security";
import {
  sendFcm,
  type PushMessage,
  type PushResult,
  type ServiceAccount,
} from "./push-fcm";
export interface PushConfig {
  mode: "off" | "gateway" | "fcm";
  gateway_url: string;
  gateway_secret?: string;
  service_account?: ServiceAccount;
  preview: "preview" | "minimal";
  ticket_alert_minutes: number;
  updated?: number;
}
const CONFIG_ID = "push:config";
export const pushDefaults: PushConfig = {
  mode: "gateway",
  gateway_url: "https://push.wabotia.queven.app",
  preview: "preview",
  ticket_alert_minutes: 60,
};
export async function pushConfig(env: Env): Promise<PushConfig> {
  const stored = await secret(env, CONFIG_ID);
  return { ...pushDefaults, ...stored };
}
export function publicPushConfig(cfg: PushConfig) {
  return {
    mode: cfg.mode,
    gateway_url: cfg.gateway_url,
    gateway_secret_configured: !!cfg.gateway_secret,
    preview: cfg.preview,
    ticket_alert_minutes: cfg.ticket_alert_minutes,
    fcm_configured: !!cfg.service_account?.private_key,
    fcm_project_id: cfg.service_account?.project_id || "",
    updated: cfg.updated || 0,
  };
}
function parseServiceAccount(value: any): ServiceAccount {
  let sa: any = value;
  if (typeof sa === "string") {
    try {
      sa = JSON.parse(sa);
    } catch {
      throw new ApiError(
        400,
        "invalid_request",
        "A conta de serviço precisa ser um JSON válido.",
      );
    }
  }
  requireValue(
    sa &&
      typeof sa === "object" &&
      typeof sa.client_email === "string" &&
      sa.client_email.includes("@") &&
      typeof sa.private_key === "string" &&
      sa.private_key.includes("-----BEGIN") &&
      typeof sa.project_id === "string" &&
      sa.project_id.length > 0 &&
      typeof sa.token_uri === "string",
    "A conta de serviço precisa conter client_email, private_key, project_id e token_uri.",
  );
  return {
    client_email: sa.client_email,
    private_key: sa.private_key,
    project_id: sa.project_id,
    token_uri: publicUrl(sa.token_uri),
  };
}
export async function configurePush(env: Env, actor: Actor, data: any) {
  admin(actor);
  const old = await pushConfig(env);
  const next: PushConfig = { ...old };
  if (data.mode !== undefined) {
    requireValue(
      ["off", "gateway", "fcm"].includes(data.mode),
      "Modo de envio inválido (off, gateway ou fcm).",
    );
    next.mode = data.mode;
  }
  if (data.gateway_url !== undefined) {
    requireValue(
      typeof data.gateway_url === "string" && data.gateway_url.length <= 500,
      "URL do gateway inválida.",
    );
    next.gateway_url = data.gateway_url.trim()
      ? publicUrl(data.gateway_url.trim())
      : pushDefaults.gateway_url;
  }
  if (data.gateway_secret !== undefined) {
    requireValue(
      data.gateway_secret === null ||
        (typeof data.gateway_secret === "string" &&
          data.gateway_secret.length <= 200),
      "Segredo do gateway inválido.",
    );
    if (data.gateway_secret) next.gateway_secret = data.gateway_secret;
    else delete next.gateway_secret;
  }
  if (data.service_account !== undefined && data.service_account !== null) {
    if (data.service_account === "") delete next.service_account;
    else next.service_account = parseServiceAccount(data.service_account);
  }
  if (data.preview !== undefined) {
    requireValue(
      ["preview", "minimal"].includes(data.preview),
      "Conteúdo inválido (preview ou minimal).",
    );
    next.preview = data.preview;
  }
  if (data.ticket_alert_minutes !== undefined) {
    const minutes = Number(data.ticket_alert_minutes);
    requireValue(
      Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440,
      "Alerta de protocolo deve ser um inteiro entre 0 e 1440 minutos.",
    );
    next.ticket_alert_minutes = minutes;
  }
  requireValue(
    next.mode !== "fcm" || !!next.service_account,
    "Informe a conta de serviço FCM para usar o modo fcm.",
  );
  next.updated = now();
  await setSecret(env, CONFIG_ID, next);
  return publicPushConfig(next);
}
export async function sendPush(
  env: Env,
  messages: PushMessage[],
  cfg?: PushConfig,
  beforeSend?: (message: PushMessage) => Promise<boolean>,
): Promise<PushResult[]> {
  if (!messages.length) return [];
  let config = cfg || (await pushConfig(env));
  if(env.FAGOO_MANAGED==='true') {
    const account=(env as any).FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON || (env as any).FCM_CONTA_SERVICO;
    if(account) config={...config,mode:'fcm',service_account:parseServiceAccount(account)};
    // An old external gateway may ignore data_only and display a delayed private alert in panel mode.
    if(config.mode==='gateway') throw new ApiError(503,'push_not_configured','Configure o FCM do Fagoo para notificações privadas.');
  }
  if (config.mode === "off") return [];
  if (config.mode === "fcm") {
    if (!config.service_account)
      throw new ApiError(
        400,
        "push_not_configured",
        "Conta de serviço FCM não configurada.",
      );
    return sendFcm(config.service_account, messages, fetch, beforeSend);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.gateway_secret)
    headers.Authorization = `Bearer ${config.gateway_secret}`;
  const response = await fetch(
    config.gateway_url.replace(/\/$/, "") + "/v1/push",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
  const body: any = await response.json();
  if (!Array.isArray(body?.results))
    throw new Error("Resposta inválida do gateway.");
  return body.results.map((r: any) => ({
    token: String(r?.token || ""),
    status: ["ok", "unregistered", "error"].includes(r?.status)
      ? r.status
      : "error",
    error: r?.error ? String(r.error).slice(0, 200) : undefined,
  }));
}
interface Device {
  id: string;
  user_id: string;
  platform: "android" | "ios";
  provider: string;
  token: string;
  profiles: string;
  origin: string;
  enabled: number;
}
interface Pending {
  logId: string;
  device: Device;
  kind: string;
  resource_id: string | null;
  message: PushMessage;
}
// A notification computed from an event or a ticket deadline, before any
// push_log row exists. Rows are claimed right before sending (see deliver).
interface Notification {
  targets: string[] | "all";
  exclude: string | null;
  kind: string;
  resource: string | null;
  dedupeKey: string;
  message: Omit<PushMessage, "token" | "platform">;
  alert?: { ticketId: string; kind: string };
}
/** Events older than this are skipped (cursor still advances): a stalled
 * cursor or a reset must never replay history as notifications. */
export const MAX_EVENT_AGE_MS = 10 * 60000;
/** Sending budget per processPush run; the rest waits for the next alarm. */
export const SEND_BUDGET_MS = 20000;
/** push_log retention; ticket_alerts of tickets closed longer ago are dropped. */
export const PUSH_LOG_RETENTION_MS = 7 * 86400000;
const ticketStates: Record<string, string> = {
  open: "Aberto",
  in_progress: "Em andamento",
  closed: "Concluído",
};
// Event that keeps failing inside processPush, per profile (isolate memory).
const stuck = new Map<string, { id: number; attempts: number }>();
const truncate = (value: string, max: number) =>
  value.length > max ? value.slice(0, max - 1).trimEnd() + "…" : value;
export function testMessage(device: Device, fagoo?: {userId:string;unitId:string;server:string}): PushMessage {
  return {
    token: device.token,
    platform: device.platform,
    title: fagoo ? "Fagoo" : "Wabotia",
    body: "Notificação de teste recebida com sucesso.",
    data: { type: "test", server: fagoo?.server ?? device.origin ?? "",
      ...(fagoo ? {user_id:fagoo.userId,unit_id:fagoo.unitId,profile_id:fagoo.unitId} : {}) },
    ...(fagoo ? {data_only:true} : {}),
    priority: "normal",
    channel: "messages",
    category: "MESSAGE",
    time_sensitive: false,
  };
}
export async function applyResults(
  env: Env,
  items: { logId?: string; device: Device }[],
  results: PushResult[],
) {
  for (const [index, item] of items.entries()) {
    const result =
      results[index]?.token === item.device.token
        ? results[index]
        : results.find((r) => r.token === item.device.token) || {
            token: item.device.token,
            status: "error" as const,
            error: "Sem resultado do provedor.",
          };
    if (result.status === "unregistered")
      await exec(
        env,
        "UPDATE devices SET enabled=0,last_error=?,updated=? WHERE id=?",
        result.error || "unregistered",
        now(),
        item.device.id,
      );
    else if (result.status === "error")
      await exec(
        env,
        "UPDATE devices SET last_error=?,updated=? WHERE id=?",
        result.error || "error",
        now(),
        item.device.id,
      );
    else
      await exec(
        env,
        "UPDATE devices SET last_error=NULL,updated=? WHERE id=?",
        now(),
        item.device.id,
      );
    if (item.logId)
      await exec(
        env,
        "UPDATE push_log SET status=?,error=? WHERE id=?",
        result.status,
        result.error || null,
        item.logId,
      );
  }
}
export async function sendTest(env: Env, devices: Device[], server?: string) {
  if (!devices.length) return [];
  let identity: {userId:string;unitId:string;server:string}|undefined;
  let beforeSend: ((message:PushMessage)=>Promise<boolean>)|undefined;
  if (env.FAGOO_MANAGED === 'true') {
    const actor=env.FAGOO_ACTOR, grant=env.FAGOO_GRANT;
    if (!actor?.fagoo || actor.kind!=='user' || !grant || actor.id!==grant.user_id || actor.fagoo.unitId!==grant.unit_id ||
        actor.profiles.length!==1 || actor.profiles[0]!==grant.profile_id || !server ||
        !/^https:\/\/[^/]+$/.test(server))
      throw new ApiError(403,'push_not_authorized','Teste de notificação não autorizado.');
    identity={userId:actor.id,unitId:grant.unit_id,server};
    const capability=grant.capabilities.includes('communication.read')?'communication.read':'team.chat';
    const allowed=async(device:Device)=>{
      const current=await currentGrant(env,grant.profile_id,actor.id,capability);
      if (!current || current.unit_id!==grant.unit_id) return false;
      const registered=await one(env,'SELECT * FROM devices WHERE id=? AND user_id=? AND enabled=1',device.id,actor.id);
      const profiles=json(registered?.profiles,[]);
      return !!registered && registered.provider==='fcm' && registered.token===device.token &&
        registered.platform===device.platform && registered.origin===server &&
        Array.isArray(profiles) && profiles.includes(grant.profile_id);
    };
    for (const device of devices) if (!await allowed(device))
      throw new ApiError(403,'push_not_authorized','Teste de notificação não autorizado.');
    // OAuth may take time: recheck the current grant and registration just before FCM dispatch.
    beforeSend=async message=>{
      const device=devices.find(d=>d.token===message.token && d.platform===message.platform);
      return !!device && await allowed(device);
    };
  }
  const results = await sendPush(
    env,
    devices.map((d) => testMessage(d,identity)),
    undefined,
    beforeSend,
  );
  await applyResults(
    env,
    devices.map((device) => ({ device })),
    results,
  );
  return results;
}
/** Removes old push_log rows and alerts of tickets closed long ago. */
export async function prunePush(env: Env) {
  const cutoff = now() - PUSH_LOG_RETENTION_MS;
  await exec(env, "DELETE FROM push_log WHERE created<?", cutoff);
  await exec(
    env,
    "DELETE FROM ticket_alerts WHERE ticket_id IN (SELECT id FROM tickets WHERE status='closed' AND updated<?) OR ticket_id NOT IN (SELECT id FROM tickets)",
    cutoff,
  );
}
/** Marks every ticket already overdue as alerted, so a fresh cursor does not
 * fire "atrasado" for months-old protocols at once. */
async function seedTicketAlerts(env: Env, profile: string) {
  for (const kind of ["due_soon", "overdue"])
    await exec(
      env,
      "INSERT OR IGNORE INTO ticket_alerts(ticket_id,kind,created) SELECT id,?,? FROM tickets WHERE profile_id=? AND status!='closed' AND first_response_at IS NULL AND response_due_at IS NOT NULL AND response_due_at<=?",
      kind,
      now(),
      profile,
      now(),
    );
}
/**
 * Phase 2: claims a push_log row (and the ticket alert) for each device right
 * before sending, in chunks of 100, until the deadline. Returns false when it
 * stopped early: the caller then keeps the cursor so the next run rebuilds
 * the same notifications and the claimed ones are skipped by the dedupe key.
 */
async function deliver(
  env: Env,
  profile: string,
  cfg: PushConfig,
  users: { id: string }[],
  devices: Device[],
  items: Notification[],
  deadline: number,
) {
  const userIds = new Set(users.map((u) => u.id));
  let chunk: Pending[] = [];
  const send = async () => {
    if (!chunk.length) return;
    const batch = chunk;
    chunk = [];
    try {
      const results = await sendPush(
        env,
        batch.map((p) => p.message),
        cfg,
      );
      await applyResults(env, batch, results);
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : "Falha de envio"
      ).slice(0, 200);
      for (const p of batch)
        await exec(
          env,
          "UPDATE push_log SET status='error',error=? WHERE id=?",
          message,
          p.logId,
        );
      console.error(
        JSON.stringify({ component: "push", profile, error: message }),
      );
    }
  };
  let complete = true;
  try {
    for (const item of items) {
      if (now() > deadline) {
        complete = false;
        break;
      }
      // The alert is consumed even without recipients, so tickets that fell
      // due while nobody had the app do not fire later all at once.
      if (item.alert) {
        const claimed = await one(
          env,
          "INSERT OR IGNORE INTO ticket_alerts(ticket_id,kind,created) VALUES(?,?,?) RETURNING ticket_id",
          item.alert.ticketId,
          item.alert.kind,
          now(),
        );
        if (!claimed) continue;
      }
      const ids =
        item.targets === "all"
          ? users.map((u) => u.id)
          : item.targets.filter((id) => userIds.has(id));
      const recipients = devices.filter(
        (d) =>
          ids.includes(d.user_id) &&
          !(item.exclude && d.user_id === item.exclude),
      );
      for (const device of recipients) {
        if(!await managedPushAllowed(env,profile,device.user_id,item.kind,item.resource || '')) continue;
        const fagooUnit = env.FAGOO_MANAGED==='true' ? await one(env,'SELECT unit_id FROM fagoo_profiles WHERE profile_id=?',profile) : null;
        const logId = uid();
        const inserted = await one(
          env,
          "INSERT OR IGNORE INTO push_log(id,profile_id,user_id,device_id,kind,resource_id,dedupe,status,created) VALUES(?,?,?,?,?,?,?,'pending',?) RETURNING id",
          logId,
          profile,
          device.user_id,
          device.id,
          item.kind,
          item.resource,
          `${device.id}:${item.dedupeKey}`,
          now(),
        );
        if (!inserted) continue;
        chunk.push({
          logId,
          device,
          kind: item.kind,
          resource_id: item.resource,
          message: {
            ...item.message,
            ...(fagooUnit?{data_only:true,title:'Fagoo',body:'Novo aviso de atendimento'}:{}),
            ...(env.FAGOO_MANAGED==='true' && item.kind==='queue'?{title:'Fagoo',body:'Novo atendimento disponível'}:{}),
            token: device.token,
            platform: device.platform,
            data: Object.fromEntries(
              Object.entries({
                ...item.message.data,
                ...(fagooUnit?{profile_id:fagooUnit.unit_id,unit_id:fagooUnit.unit_id,user_id:device.user_id}:{}),
                server: device.origin || "",
              })
                .filter(([, v]) => v !== undefined && v !== null && v !== "")
                .map(([k, v]) => [k, String(v)]),
            ),
          },
        });
        if (chunk.length >= 100) await send();
      }
    }
  } finally {
    // Whatever was claimed is sent, even when a claim failed midway.
    await send();
  }
  return complete;
}
export async function processPush(env: Env, profile: string) {
  let cursor = 0,
    last = 0;
  try {
    const row = await one(
      env,
      "SELECT last_event_id FROM push_cursors WHERE profile_id=?",
      profile,
    );
    if (!row) {
      // First run for this profile (installation updated before the cursor
      // existed): start at the end of the history and notify nothing old.
      const top = await one(
        env,
        "SELECT coalesce(max(id),0) m FROM events WHERE profile_id=?",
        profile,
      );
      await exec(
        env,
        "INSERT INTO push_cursors(profile_id,last_event_id,updated) VALUES(?,?,?) ON CONFLICT(profile_id) DO NOTHING",
        profile,
        top?.m || 0,
        now(),
      );
      await seedTicketAlerts(env, profile);
      return;
    }
    cursor = row.last_event_id || 0;
    last = cursor;
    const events = await all(
      env,
      "SELECT * FROM events WHERE profile_id=? AND id>? ORDER BY id LIMIT 100",
      profile,
      cursor,
    );
    const cfg = await pushConfig(env);
    if (cfg.mode === "off") {
      last = events.at(-1)?.id || cursor;
      return;
    }
    const started = now();
    const users = await all(
      env,
      "SELECT id,name,role FROM users WHERE disabled=0 AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?))",
      profile,
    );
    const userIds = new Set(users.map((u) => u.id));
    const devices = (
      await all<Device>(
        env,
        "SELECT * FROM devices WHERE enabled=1 AND (profiles='[]' OR EXISTS(SELECT 1 FROM json_each(devices.profiles) WHERE value=?)) AND user_id IN (SELECT id FROM users WHERE disabled=0 AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?)))",
        profile,
        profile,
      )
    ).filter((d) => userIds.has(d.user_id));
    const minimal = cfg.preview === "minimal";
    const items: Notification[] = [];
    const convCache = new Map<string, any>();
    const conv = async (id: string | null | undefined) => {
      if (!id) return null;
      if (!convCache.has(id))
        convCache.set(
          id,
          await one(
            env,
            "SELECT c.id,c.phone,c.external_id,c.title,c.state,c.owner,ct.name contact_name FROM conversations c LEFT JOIN conversation_contacts l ON l.conversation_id=c.id AND l.profile_id=c.profile_id LEFT JOIN contacts ct ON ct.id=l.contact_id AND ct.profile_id=c.profile_id WHERE c.id=? AND c.profile_id=?",
            id,
            profile,
          ),
        );
      return convCache.get(id);
    };
    const label = (c: any) =>
      c?.contact_name || c?.title || c?.phone || c?.external_id || "Contato";
    const queue = (
      targets: string[] | "all",
      exclude: string | null,
      kind: string,
      resource: string | null,
      dedupeKey: string,
      message: Omit<PushMessage, "token" | "platform">,
      alert?: Notification["alert"],
    ) => {
      items.push({ targets, exclude, kind, resource, dedupeKey, message, alert });
    };
    // Phase 1: compute notifications without writing anything.
    const handle = async (ev: any) => {
      if (ev.created < now() - MAX_EVENT_AGE_MS) return;
      const payload = json(ev.payload);
      const actor: string | null =
        typeof payload.actor === "string" ? payload.actor : null;
      if(ev.kind === 'internal.message') {
        const chat=await one(env,'SELECT * FROM internal_chats WHERE id=? AND profile_id=?',payload.chat_id,profile);
        const msg=await one(env,'SELECT author FROM internal_messages WHERE id=? AND chat_id=?',ev.resource_id,chat?.id || '');
        if(chat && msg) queue([chat.member_a,chat.member_b].filter(id=>!id.startsWith('bot:')),msg.author,'internal',chat.id,String(ev.id),{title:'Fagoo',body:'Nova mensagem interna',data:{type:'internal',profile_id:profile,chat_id:chat.id},priority:'high',collapse_key:'internal-'+chat.id,channel:'messages',category:'MESSAGE',time_sensitive:false});
      } else if (ev.kind === "message.received") {
        const c = await conv(payload.conversation_id);
        if (!c) return;
        let targets: string[] | "all";
        if (c.state === "human" && c.owner) targets = [c.owner];
        else if (c.state === "waiting") targets = "all";
        else return;
        const text = String(payload.text || "").trim();
        const body = text
          ? truncate(text, 120)
          : (payload.attachments || []).length
            ? "Anexo"
            : "Nova mensagem";
        queue(targets, actor, "message", c.id, String(ev.id), {
          title: minimal ? "Wabotia" : label(c),
          body: minimal ? "Nova mensagem" : body,
          data: {
            type: "message",
            profile_id: profile,
            conversation_id: c.id,
          },
          priority: "high",
          collapse_key: "conversa-" + c.id,
          channel: "messages",
          category: "MESSAGE",
          time_sensitive: false,
        });
      } else if (ev.kind === "conversation.updated") {
        const c = await conv(ev.resource_id);
        if (!c) return;
        if (payload.state === "waiting") {
          queue("all", actor, "queue", c.id, String(ev.id), {
            title: minimal ? "Wabotia" : label(c),
            body: minimal ? "Novo atendimento" : "Novo atendimento na fila",
            data: { type: "queue", profile_id: profile, conversation_id: c.id },
            priority: "high",
            collapse_key: "fila-" + c.id,
            channel: "queue",
            category: "MESSAGE",
            time_sensitive: false,
          });
        } else if (
          payload.action === "transfer" &&
          typeof payload.owner === "string" &&
          payload.owner
        )
          queue([payload.owner], actor, "transfer", c.id, String(ev.id), {
            title: minimal ? "Wabotia" : label(c),
            body: "Atendimento transferido para você",
            data: {
              type: "transfer",
              profile_id: profile,
              conversation_id: c.id,
            },
            priority: "high",
            collapse_key: "conversa-" + c.id,
            channel: "messages",
            category: "MESSAGE",
            time_sensitive: false,
          });
      } else if (ev.kind === "ticket.created" || ev.kind === "ticket.updated") {
        const ticket = await one(
          env,
          "SELECT * FROM tickets WHERE id=? AND profile_id=?",
          ev.resource_id,
          profile,
        );
        if (!ticket) return;
        const number = ticket.number || payload.number || "";
        const data = {
          type: "ticket",
          profile_id: profile,
          ticket_id: ticket.id,
          conversation_id: ticket.conversation_id,
        };
        if (ev.kind === "ticket.created") {
          if (ticket.status === "closed") return;
          queue(
            ticket.owner ? [ticket.owner] : "all",
            actor,
            "ticket",
            ticket.id,
            String(ev.id),
            {
              title: minimal ? "Wabotia" : `Protocolo ${number} aberto`,
              body: minimal ? "Novo protocolo" : truncate(ticket.title, 120),
              data,
              priority: "normal",
              collapse_key: "protocolo-" + ticket.id,
              channel: "tickets",
              category: "TICKET",
              time_sensitive: false,
            },
          );
          return;
        }
        if (!ticket.owner) return;
        // Body reflects what changed: state, assignment and/or public update.
        const status = String(payload.status || ticket.status);
        const stateChanged =
          payload.previous_status === undefined ||
          payload.previous_status !== status;
        const assigned =
          typeof payload.previous_owner !== "undefined" &&
          payload.previous_owner !== ticket.owner;
        const parts: string[] = [];
        if (assigned) parts.push("Protocolo atribuído a você");
        if (stateChanged)
          parts.push(`Novo estado: ${ticketStates[status] || status}`);
        if (payload.text_added) parts.push("Novo andamento registrado");
        if (!parts.length) return;
        queue([ticket.owner], actor, "ticket", ticket.id, String(ev.id), {
          title: minimal ? "Wabotia" : `Protocolo ${number}`,
          body: minimal ? "Protocolo atualizado" : parts.join(" · "),
          data,
          priority: "normal",
          collapse_key: "protocolo-" + ticket.id,
          channel: "tickets",
          category: "TICKET",
          time_sensitive: false,
        });
      } else if (
        ev.kind === "call.updated" &&
        payload.status === "ringing" &&
        payload.direction === "inbound"
      ) {
        const callId = String(payload.call_id || ev.resource_id || "");
        const c = await conv(payload.conversation_id);
        queue("all", actor, "call", callId, String(ev.id), {
          title: minimal ? "Wabotia" : "Ligação recebida",
          body: minimal ? "Ligação recebida" : label(c),
          data: {
            type: "call",
            profile_id: profile,
            conversation_id: c?.id || payload.conversation_id || "",
            call_id: callId,
          },
          priority: "high",
          collapse_key: "call-" + callId,
          channel: "calls",
          category: "CALL",
          time_sensitive: true,
        });
      }
    };
    // Cursor only moves past events whose notifications were computed; a
    // failing event is retried on the next alarm and skipped after 3 tries.
    let processed = cursor,
      interrupted = false;
    for (const ev of events) {
      try {
        await handle(ev);
        if (stuck.get(profile)?.id === ev.id) stuck.delete(profile);
      } catch (error) {
        const previous = stuck.get(profile);
        const attempts =
          previous && previous.id === ev.id ? previous.attempts + 1 : 1;
        stuck.set(profile, { id: ev.id, attempts });
        console.error(
          JSON.stringify({
            component: "push",
            profile,
            event: ev.id,
            attempts,
            error: error instanceof Error ? error.message : "event_error",
          }),
        );
        if (attempts < 3) {
          interrupted = true;
          break;
        }
        stuck.delete(profile);
      }
      processed = ev.id;
    }
    if (!interrupted && cfg.ticket_alert_minutes > 0) {
      const horizon = now() + cfg.ticket_alert_minutes * 60000;
      // Tickets already alerted for the applicable kind are excluded here, so
      // a backlog of old overdue tickets never hides newer ones (LIMIT 100).
      const tickets = await all(
        env,
        "SELECT * FROM tickets t WHERE t.profile_id=? AND t.status!='closed' AND t.first_response_at IS NULL AND t.response_due_at IS NOT NULL AND t.response_due_at<=? AND NOT EXISTS(SELECT 1 FROM ticket_alerts a WHERE a.ticket_id=t.id AND a.kind=CASE WHEN t.response_due_at<=? THEN 'overdue' ELSE 'due_soon' END) ORDER BY t.response_due_at LIMIT 100",
        profile,
        horizon,
        now(),
      );
      for (const ticket of tickets) {
        const overdue = ticket.response_due_at <= now();
        const kind = overdue ? "overdue" : "due_soon";
        const minutes = Math.max(
          1,
          Math.ceil((ticket.response_due_at - now()) / 60000),
        );
        queue(
          ticket.owner ? [ticket.owner] : "all",
          null,
          "ticket_due",
          ticket.id,
          `ticket:${ticket.id}:${kind}`,
          {
            title: minimal
              ? "Wabotia"
              : overdue
                ? `Protocolo ${ticket.number} atrasado`
                : `Protocolo ${ticket.number} vence em ${minutes} min`,
            body: minimal
              ? overdue
                ? "Protocolo atrasado"
                : "Protocolo vencendo"
              : truncate(ticket.title, 120),
            data: {
              type: "ticket_due",
              profile_id: profile,
              ticket_id: ticket.id,
              conversation_id: ticket.conversation_id,
            },
            priority: overdue ? "high" : "normal",
            collapse_key: "protocolo-" + ticket.id,
            channel: "tickets",
            category: "TICKET",
            time_sensitive: false,
          },
          { ticketId: ticket.id, kind },
        );
      }
    }
    // Phase 2: claim and send. If the budget ran out, keep the cursor so the
    // next alarm resumes; claimed rows are skipped by the dedupe key.
    const complete = await deliver(
      env,
      profile,
      cfg,
      users,
      devices,
      items,
      started + SEND_BUDGET_MS,
    );
    if (complete) last = processed;
  } catch (error) {
    console.error(
      JSON.stringify({
        component: "push",
        profile,
        error:
          error instanceof ApiError
            ? error.code
            : error instanceof Error
              ? error.message
              : "push_error",
      }),
    );
  } finally {
    if (last > cursor)
      try {
        await exec(
          env,
          "INSERT INTO push_cursors(profile_id,last_event_id,updated) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET last_event_id=max(push_cursors.last_event_id,excluded.last_event_id),updated=excluded.updated",
          profile,
          last,
          now(),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            component: "push",
            profile,
            error: error instanceof Error ? error.message : "cursor_error",
          }),
        );
      }
  }
}
