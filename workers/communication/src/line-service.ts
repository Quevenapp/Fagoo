import { all, one, exec, batch } from "./db";
import {
  type Actor,
  type Env,
  type Conversation,
  ApiError,
  json,
  now,
  requireValue,
} from "./types";
import { access, admin } from "./security";
import { numberPolicy, numberPolicyFlags } from "./number-policy";
import { getNumberPolicy, numberPolicyError } from "./number-permissions";
import { settings, enqueue } from "./service";
import { sha } from "./security";
import { departmentFor } from "./departments";

export function lineService(config: any) {
  const value = config?.service || {};
  return {
    mode: ["inherit", "human", "bot"].includes(value.mode)
      ? value.mode
      : "inherit",
    bot_id:
      typeof value.bot_id === "string" && value.bot_id ? value.bot_id : null,
    menu_mode: ["automatic", "manual", "off"].includes(value.menu_mode)
      ? value.menu_mode
      : "automatic",
  };
}
export async function serviceForLine(env: Env, connection: string | null) {
  const row = connection
    ? await one(env, "SELECT config FROM connections WHERE id=?", connection)
    : null;
  return lineService(json(row?.config));
}
export async function botAllowsLine(
  env: Env,
  botId: string,
  profile: string,
  connection: string | null,
) {
  const bot = await one(
    env,
    "SELECT * FROM bots WHERE id=? AND profile_id=? AND enabled=1",
    botId,
    profile,
  );
  return (
    !!bot &&
    (!connection ||
      bot.line_ids === null ||
      json(bot.line_ids, []).includes(connection))
  );
}
export async function validateLineIds(
  env: Env,
  profile: string,
  ids: any,
  nullable = false,
) {
  if (nullable && ids === null) return;
  requireValue(
    Array.isArray(ids) &&
      ids.length <= 200 &&
      ids.every((id: any) => typeof id === "string") &&
      new Set(ids).size === ids.length,
    "Selecione linhas válidas, sem repetição.",
  );
  for (const id of ids)
    requireValue(
      await one(
        env,
        "SELECT id FROM connections WHERE id=? AND profile_id=? AND kind IN ('meta','qr','hermes-whatsapp')",
        id,
        profile,
      ),
      "A linha não pertence a este perfil.",
    );
}
export async function listLines(env: Env, actor: Actor, profile: string) {
  access(actor, profile, "conversations:read");
  requireValue(
    actor.kind === "user",
    "O painel de linhas exige uma conta de pessoa.",
  );
  const rows = await all(
    env,
    "SELECT id,name,kind,mode,status,config,last_seen FROM connections WHERE profile_id=? AND kind IN ('meta','qr','hermes-whatsapp') ORDER BY name,id",
    profile,
  );
  return {
    data: rows.map(({ config, ...row }) => ({
      ...row,
      number: json(config).number || json(config).phone || "",
      number_policy: numberPolicy(json(config)),
      service: lineService(json(config)),
    })),
  };
}
export async function saveLine(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
) {
  admin(actor);
  access(actor, profile, "conversations:write");
  const row = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind IN ('meta','qr','hermes-whatsapp')",
    data.id,
    profile,
  );
  requireValue(row, "Linha não encontrada.");
  const config = json(row.config),
    current = lineService(config),
    service = { ...current, ...data.service };
  requireValue(
    ["inherit", "human", "bot"].includes(service.mode) &&
      ["automatic", "manual", "off"].includes(service.menu_mode),
    "Modo de atendimento inválido.",
  );
  service.bot_id = service.bot_id || null;
  if (service.mode === "bot")
    requireValue(
      service.bot_id &&
        (await botAllowsLine(env, service.bot_id, profile, row.id)),
      "Selecione um bot habilitado e autorizado para esta linha.",
    );
  if (data.number_policy !== undefined) {
    requireValue(
      data.number_policy && typeof data.number_policy === "object",
      "Permissões inválidas.",
    );
    for (const key of numberPolicyFlags)
      if (data.number_policy[key] !== undefined)
        requireValue(
          typeof data.number_policy[key] === "boolean",
          "Permissão de linha inválida.",
        );
    config.number_policy = numberPolicy({
      number_policy: { ...numberPolicy(config), ...data.number_policy },
    });
  }
  config.service = service;
  const policy = numberPolicy(config);
  requireValue(
    service.mode !== "human" || (policy.human && policy.service),
    "Atendimento por pessoa exige mensagens de serviço e envio humano em Função e permissões.",
  );
  requireValue(
    service.mode !== "bot" || (policy.bots && policy.service),
    "Atendimento por bot exige mensagens de serviço e bots em Função e permissões.",
  );
  const updates: [string, any[]][] = [
    [
      "UPDATE connections SET config=? WHERE id=?",
      [JSON.stringify(config), row.id],
    ],
  ];
  if (current.mode !== service.mode || current.bot_id !== service.bot_id)
    updates.push([
      "UPDATE conversations SET state=CASE WHEN ?='human' THEN 'waiting' ELSE state END,epoch=epoch+1,menu_active=0,updated=? WHERE connection_id=? AND state='ai' AND assigned_bot_id IS NULL",
      [service.mode, now(), row.id],
    ]);
  await batch(env, updates);
  return (await listLines(env, actor, profile)).data.find(
    (line) => line.id === row.id,
  );
}

// Child menus inherit all ancestor line restrictions. A manually exposed menu
// stays selectable until a terminal choice; an unrelated human reply is not a menu.
export function menuAllowed(
  item: any,
  items: any[],
  connection: string | null,
  includeManual = false,
) {
  let current = item;
  const visited = new Set<string>();
  while (current) {
    if (
      visited.has(current.id) ||
      current.enabled === false ||
      (!includeManual && current.trigger === "manual")
    )
      return false;
    visited.add(current.id);
    if (
      Array.isArray(current.line_ids) &&
      current.line_ids.length &&
      !current.line_ids.includes(connection)
    )
      return false;
    if (!current.parent_id) return true;
    current = items.find((m) => m.id === current.parent_id);
    if (!current) return false;
  }
  return false;
}
export async function availableMenus(
  env: Env,
  profile: string,
  connection: string | null,
  parent: string | null = null,
  includeManual = false,
  chatType = "direct",
) {
  const cfg = await settings(env, profile),
    policy = await getNumberPolicy(env, connection),
    service = await serviceForLine(env, connection);
  if (!policy.menu || service.menu_mode === "off") return [];
  const result = [];
  for (const item of cfg.menus || []) {
    if (
      (item.parent_id || null) !== parent ||
      !menuAllowed(item, cfg.menus, connection, includeManual)
    )
      continue;
    if (item.type === "human" && !policy.human) continue;
    if (
      item.type === "human" &&
      item.department_id &&
      !(await departmentFor(env, profile, item.department_id))
    )
      continue;
    if (["protocols", "survey"].includes(item.type) && !policy.service)
      continue;
    if (chatType === "group" && ["protocols", "survey"].includes(item.type))
      continue;
    if (
      item.type === "bot" &&
      (!policy.bots ||
        !(await botAllowsLine(env, item.bot_id, profile, connection)))
    )
      continue;
    result.push(item);
  }
  return result;
}
export function menuPayload(
  items: any[],
  title: string,
  token: string,
  interactive: boolean,
  submenu = false,
) {
  const text = `${title}\n${items.map((item, index) => `${index + 1}. ${item.label}`).join("\n")}${submenu ? "\nEnvie MENU para voltar." : ""}`;
  if (!interactive || items.length > 10 || !items.length)
    return { text, automation: "menu" };
  const buttons =
    items.length <= 3 &&
    items.every((item) => Array.from(item.label).length <= 20);
  const body = {
    text:
      title +
      (submenu ? "\nEnvie MENU para voltar." : "\nEscolha uma opção abaixo."),
  };
  return {
    text,
    automation: "menu",
    content: {
      type: "interactive",
      interactive: buttons
        ? {
            type: "button",
            body,
            action: {
              buttons: items.map((item) => ({
                type: "reply",
                reply: { id: `wmenu:${token}:${item.id}`, title: item.label },
              })),
            },
          }
        : {
            type: "list",
            body,
            action: {
              button: "Escolher opção",
              sections: [
                {
                  title: "Atendimento",
                  rows: items.map((item, index) => ({
                    id: `wmenu:${token}:${item.id}`,
                    title: Array.from(`${index + 1}. ${item.label}`)
                      .slice(0, 24)
                      .join(""),
                    description: Array.from(item.label).slice(0, 72).join(""),
                  })),
                },
              ],
            },
          },
    },
  };
}

export function selectedMenu(
  c: Conversation,
  items: any[],
  text: string,
  replyId?: string,
) {
  const snapshot = json(c.menu_items, []) as string[];
  const active =
    !!c.menu_active &&
    !!c.menu_token?.startsWith(c.session + ".") &&
    (c.menu_expires_at || 0) > now();
  if (replyId) {
    if (!active) return null;
    const prefix = `wmenu:${c.menu_token}:`;
    if (!replyId.startsWith(prefix)) return null;
    const id = replyId.slice(prefix.length);
    return snapshot.includes(id)
      ? items.find((item) => item.id === id) || null
      : null;
  }
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
  if (/^\d+$/.test(text) && c.menu_token) {
    if (!active) return null;
    return items.find((item) => item.id === snapshot[Number(text) - 1]) || null;
  }
  return (
    items.find(
      (item, index) =>
        (!c.menu_token && String(index + 1) === text) ||
        item.label
          .toLowerCase()
          .normalize("NFD")
          .replace(/\p{Diacritic}/gu, "") === normalized,
    ) || null
  );
}
export async function listMenus(
  env: Env,
  actor: Actor,
  profile: string,
  connection?: string,
) {
  access(actor, profile, "conversations:read");
  const cfg = await settings(env, profile);
  if (connection)
    requireValue(
      await one(
        env,
        "SELECT id FROM connections WHERE id=? AND profile_id=?",
        connection,
        profile,
      ),
      "Linha não encontrada.",
    );
  return {
    data: (cfg.menus || []).filter(
      (m: any) => !connection || menuAllowed(m, cfg.menus, connection, true),
    ),
  };
}
export async function sendMenu(
  env: Env,
  actor: Actor,
  c: Conversation,
  menuId: string | null,
  key: string,
  manual = true,
) {
  const policy = await getNumberPolicy(env, c.connection_id);
  if (!policy.menu) throw numberPolicyError("menu");
  const service = await serviceForLine(env, c.connection_id);
  requireValue(service.menu_mode !== "off", "Menus desativados nesta linha.");
  if (c.connection_id) {
    const line = await one(
      env,
      "SELECT kind FROM connections WHERE id=?",
      c.connection_id,
    );
    requireValue(
      line?.kind !== "meta" || now() - c.last_customer < 86400000,
      "O cliente precisa enviar mensagem para este mesmo número nas últimas 24 horas.",
    );
  }
  const cfg = await settings(env, c.profile_id);
  const parent = menuId
    ? (cfg.menus || []).find((m: any) => m.id === menuId)
    : null;
  requireValue(
    !menuId ||
      (parent?.type === "submenu" &&
        menuAllowed(parent, cfg.menus, c.connection_id, manual)),
    "Menu indisponível para esta linha.",
  );
  const items = await availableMenus(
    env,
    c.profile_id,
    c.connection_id,
    menuId,
    manual,
    c.chat_type,
  );
  requireValue(
    items.length,
    "Nenhuma opção de menu disponível para esta linha.",
  );
  const token =
    c.session + "." + (await sha(`${c.id}:${c.session}:${key}`)).slice(0, 24);
  const connection = c.connection_id
    ? await one(env, "SELECT kind FROM connections WHERE id=?", c.connection_id)
    : null;
  const payload = menuPayload(
    items,
    parent?.label || "Como podemos ajudar?",
    token,
    connection?.kind === "meta" && c.chat_type !== "group",
    !!menuId,
  );
  // Use the person's own authorization for a manual send. Bot menus retain the
  // automation capability check; no ownership or channel authorization is bypassed.
  const parts = payload.content
    ? [payload.text]
    : payload.text.match(/[\s\S]{1,3800}/g) || [payload.text];
  const deliveries = [];
  for (const [index, part] of parts.entries())
    deliveries.push(
      await enqueue(
        env,
        c,
        actor.id,
        "text",
        { ...payload, text: part },
        index === 0 ? key : `${key}:${index}`,
      ),
    );
  await batch(env, [
    [
      "UPDATE surveys SET status='cancelled' WHERE conversation_id=? AND status='pending'",
      [c.id],
    ],
    [
      "UPDATE conversations SET menu_parent=?,menu_active=1,menu_manual=?,menu_token=?,menu_expires_at=?,menu_items=? WHERE id=?",
      [
        menuId,
        manual ? 1 : 0,
        token,
        now() + 86400000,
        JSON.stringify(items.map((item: any) => item.id)),
        c.id,
      ],
    ],
  ]);
  return { delivery_id: deliveries[0], status: "pending", menu_id: menuId };
}
