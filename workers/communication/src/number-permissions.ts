import { one } from "./db";
import { ApiError, type Env, json } from "./types";
import {
  numberPolicy,
  deniedNumberCapability,
  type NumberPolicyFlag,
} from "./number-policy";

export async function getNumberPolicy(env: Env, connection: string | null) {
  const row =
    connection &&
    (await one(env, "SELECT config FROM connections WHERE id=?", connection));
  const config = row ? json(row.config) : {};
  const policy = numberPolicy(config);
  if (config.service?.menu_mode === "off") policy.menu = false;
  return policy;
}
export function numberPolicyError(flag: NumberPolicyFlag) {
  const labels: Record<NumberPolicyFlag, string> = {
    service: "mensagens de atendimento dentro da janela de 24 horas",
    service_overage: "excedente de serviço após a franquia configurada",
    templates: "envio de templates",
    human: "envio por atendentes no painel ou Telegram",
    api: "envio por programas externos",
    menu: "menus e respostas automáticas",
    bots: "atendimento por bots",
    pool: "participação no roteamento por grupos",
  };
  return new ApiError(
    403,
    "number_policy_denied",
    `Este número não permite ${labels[flag]}. Confira as permissões no painel de linhas.`,
  );
}
export async function assertNumberDelivery(
  env: Env,
  connection: string | null,
  actor: string,
  kind: string,
  payload: any,
) {
  if (!connection || kind === "team") return;
  const denied = deniedNumberCapability(
    await getNumberPolicy(env, connection),
    actor,
    kind,
    payload,
  );
  if (denied) throw numberPolicyError(denied);
  if (
    actor.startsWith("bot:") &&
    actor !== "bot:attendant" &&
    payload.automation !== "menu"
  ) {
    const bot = await one(
      env,
      "SELECT b.line_ids FROM bots b JOIN connections c ON c.profile_id=b.profile_id WHERE b.id=? AND c.id=? AND b.enabled=1",
      actor.slice(4),
      connection,
    );
    if (
      !bot ||
      (bot.line_ids !== null && !json(bot.line_ids, []).includes(connection))
    )
      throw new ApiError(
        403,
        "bot_not_allowed",
        "Este bot não atende esta linha.",
      );
  }
}
