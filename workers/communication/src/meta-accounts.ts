import { all, one, exec, batch } from "./db";
import { Env, Actor, ApiError, json, requireValue, uid, now } from "./types";
import { access, admin, secret, setSecret } from "./security";
import { metaRequest } from "./meta";
import { billingPeriod, numberUsage } from "./number-quota";

export async function metaCredentials(env: Env, conn: any) {
  const account = json(conn.config).meta_account_id;
  if (!account) return secret(env, `connection:${conn.id}`);
  const row = await one(
    env,
    "SELECT id FROM meta_accounts WHERE id=? AND profile_id=?",
    account,
    conn.profile_id,
  );
  requireValue(row, "Conta Meta não pertence a este perfil.");
  return secret(env, `meta-account:${account}`);
}
export async function accountList(env: Env, actor: Actor, profile: string) {
  access(actor, profile, "routing:read");
  admin(actor);
  return all(
    env,
    "SELECT * FROM meta_accounts WHERE profile_id=? ORDER BY created,id LIMIT 50",
    profile,
  );
}
export async function accountCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
) {
  access(actor, profile, "routing:read");
  admin(actor);
  if (op === "meta-account.save") {
    const id = data.id || uid();
    const old = await one(env, "SELECT * FROM meta_accounts WHERE id=?", id);
    requireValue(!old || old.profile_id === profile, "Conta de outro perfil.");
    const name = String(data.name || "").trim();
    requireValue(
      name.length > 0 && name.length <= 100,
      "Informe o nome da conta.",
    );
    const waba = String(data.waba_id || old?.waba_id || "");
    requireValue(/^\d{3,40}$/.test(waba), "Informe o WABA ID numérico.");
    requireValue(
      !old || waba === old.waba_id,
      "O WABA ID da conta não pode ser trocado.",
    );
    const duplicate = await one(
      env,
      "SELECT id FROM meta_accounts WHERE waba_id=? AND id!=?",
      waba,
      id,
    );
    requireValue(!duplicate, "Esta conta Meta já está cadastrada.");
    const timezone = String(
      data.timezone || old?.timezone || "America/Sao_Paulo",
    );
    try {
      billingPeriod(now(), timezone);
    } catch {
      throw new ApiError(
        400,
        "invalid_timezone",
        "Informe um fuso IANA, igual ao da conta Meta.",
      );
    }
    requireValue(
      !old ||
        old.timezone === timezone ||
        !(await one(
          env,
          "SELECT connection_id FROM meta_numbers WHERE account_id=? LIMIT 1",
          id,
        )),
      "Defina o fuso antes de cadastrar números.",
    );
    const previous = await secret(env, `meta-account:${id}`);
    const keys = { ...previous };
    for (const key of ["token", "app_secret", "verify_token"]) {
      if (data.secrets?.[key]) {
        requireValue(
          typeof data.secrets[key] === "string" &&
            data.secrets[key].length <= 4096,
          "Credencial inválida.",
        );
        keys[key] = data.secrets[key];
      }
      requireValue(
        keys[key],
        "Preencha token Meta, App Secret e Verify Token.",
      );
    }
    await exec(
      env,
      "INSERT INTO meta_accounts(id,profile_id,name,waba_id,timezone,created) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,timezone=excluded.timezone,discovered_at=0",
      id,
      profile,
      name,
      waba,
      timezone,
      now(),
    );
    await setSecret(env, `meta-account:${id}`, keys);
    return { id, webhook_path: `/webhooks/meta-accounts/${id}` };
  }
  const account = await one(
    env,
    "SELECT * FROM meta_accounts WHERE id=? AND profile_id=?",
    data.account_id || data.id,
    profile,
  );
  requireValue(account, "Conta Meta não encontrada.");
  if (op === "meta-account.discover") {
    const conn = {
      profile_id: profile,
      config: JSON.stringify({ meta_account_id: account.id }),
    };
    const found: any[] = [];
    const cursors = new Set<string>();
    let after = "";
    while (true) {
      const result = await metaRequest(
        env,
        conn,
        `${account.waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=100${after ? "&after=" + encodeURIComponent(after) : ""}`,
      );
      requireValue(
        Array.isArray(result.data),
        "A Meta não retornou os números da conta.",
      );
      for (const item of result.data) {
        if (!/^\d+$/.test(item.id || "")) continue;
        found.push({
          phone_id: item.id,
          number: String(item.display_phone_number || "").replace(/\D/g, ""),
          name: String(item.verified_name || "").slice(0, 100),
          quality: item.quality_rating || "UNKNOWN",
        });
      }
      if (!result.paging?.next) break;
      const next = result.paging?.cursors?.after;
      requireValue(
        typeof next === "string" && next && !cursors.has(next),
        "Paginação Meta inválida.",
      );
      cursors.add(next);
      after = next;
    }
    await exec(
      env,
      "UPDATE meta_accounts SET discovered=?,discovered_at=? WHERE id=?",
      JSON.stringify(found),
      now(),
      account.id,
    );
    return { data: found };
  }
  if (op === "meta-number.save") {
    requireValue(
      now() - account.discovered_at < 3600000,
      "Clique em Buscar números para validar a conta antes de cadastrar.",
    );
    const discovered = json(account.discovered, []).find(
      (n: any) => n.phone_id === data.phone_id,
    );
    requireValue(
      discovered && /^\d{8,16}$/.test(discovered.number),
      "Número não encontrado nesta conta Meta.",
    );
    const old = await one(
      env,
      "SELECT * FROM meta_numbers WHERE phone_id=?",
      data.phone_id,
    );
    requireValue(!old, "Este número já está no roteador.");
    const existing = await one(
      env,
      "SELECT * FROM connections WHERE kind='meta' AND json_extract(config,'$.phone_id')=?",
      data.phone_id,
    );
    requireValue(
      !existing || existing.profile_id === profile,
      "Número cadastrado em outro perfil.",
    );
    if (existing) {
      requireValue(
        existing.status === "paused",
        "Pause a conexão antes de adicioná-la ao roteador.",
      );
      requireValue(
        !(await one(
          env,
          "SELECT id FROM outbox WHERE connection_id=? AND status IN ('pending','sending','unknown') LIMIT 1",
          existing.id,
        )),
        "Reconcilie as entregas pendentes antes de cadastrar.",
      );
      requireValue(
        !(await one(
          env,
          "SELECT o.id FROM outbox o WHERE o.connection_id=? AND o.kind!='team' AND o.status='sent' AND coalesce(json_extract(o.payload,'$.content.type'),'')!='read' AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=o.conversation_id AND m.external_id=o.external_id AND m.delivery_status IN ('delivered','read','played','failed')) LIMIT 1",
          existing.id,
        )),
        "Aguarde os comprovantes de entrega dos envios anteriores antes de cadastrar este número.",
      );
    }
    requireValue(
      data.baseline_confirmed === true,
      "Confira na Meta o uso deste mês e confirme o contador inicial.",
    );
    const baseline = Number(data.baseline_used),
      limit = Number(data.service_limit ?? 1000);
    requireValue(
      Number.isSafeInteger(baseline) && baseline >= 0 && baseline <= 100000000,
      "Uso inicial inválido.",
    );
    requireValue(
      Number.isSafeInteger(limit) && limit >= 0 && limit <= 1000,
      "A franquia gratuita deve estar entre 0 e 1.000 mensagens. O excedente continua com cobrança.",
    );
    const id = existing?.id || uid(),
      created = now();
    const config = {
      ...json(existing?.config),
      phone_id: discovered.phone_id,
      number: discovered.number,
      waba_id: account.waba_id,
      meta_account_id: account.id,
      verified_at: created,
    };
    await batch(env, [
      [
        "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'meta','direct','paused',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config",
        [
          id,
          profile,
          String(data.name || discovered.name || discovered.number).slice(
            0,
            100,
          ),
          JSON.stringify(config),
          created,
        ],
      ],
      [
        "INSERT INTO meta_numbers(connection_id,account_id,phone_id,service_limit,baseline_period,baseline_used,monitored_at) VALUES(?,?,?,?,?,?,?)",
        [
          id,
          account.id,
          discovered.phone_id,
          limit,
          billingPeriod(created, account.timezone),
          baseline,
          created,
        ],
      ],
    ]);
    return { id, status: "paused", usage: await numberUsage(env, id) };
  }
  throw new ApiError(400, "unknown_action", "Operação Meta inválida.");
}
