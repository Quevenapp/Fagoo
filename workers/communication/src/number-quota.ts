import { one, exec } from "./db";
import { ApiError, Env, now, json, requireValue } from "./types";
import { numberPolicy } from "./number-policy";

export function billingPeriod(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(timestamp);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}
// Pending, accepted and ambiguous sends remain reserved across month boundaries.
// A provider delivery timestamp moves confirmed usage to the correct billing month.
const localUnits = (
  reserved = "o.status IN ('pending','sending','unknown','sent')",
) => `(SELECT count(*) FROM outbox o LEFT JOIN meta_message_usage u ON u.connection_id=o.connection_id AND u.external_id=o.external_id
 WHERE o.connection_id=n.connection_id AND o.created>=n.monitored_at
 AND coalesce(nullif(u.category,'unknown'),o.quota_category)='service'
 AND ((u.delivered_at IS NOT NULL AND u.period=b.period) OR
      (u.delivered_at IS NULL AND coalesce(u.status,'')!='failed' AND (${reserved}))))`;
const externalUnits = `(SELECT count(*) FROM meta_message_usage u WHERE u.connection_id=n.connection_id AND u.delivered_at>=n.monitored_at AND u.period=b.period AND u.category IN ('service','unknown') AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.connection_id=u.connection_id AND o.external_id=u.external_id))`;
const usage = (reserved?: string) =>
  `(CASE WHEN n.baseline_period=b.period THEN n.baseline_used ELSE 0 END + ${localUnits(reserved)} + ${externalUnits})`;

export function quotaExhausted() {
  return new ApiError(
    409,
    "quota_exhausted",
    "A franquia configurada deste número foi consumida ou reservada. Este envio exige saldo de franquia gratuita. A conversa mantém o mesmo remetente.",
  );
}

export async function vinkiFreeOnly(env: Env, actor: string) {
  if(actor.startsWith('app:fagoo-queue:')) return true;
  return (
    actor.startsWith("app:") &&
    !!(await one(
      env,
      "SELECT id FROM pairing_requests WHERE app_id=? AND client='vinki' AND status='consumed' LIMIT 1",
      actor.slice(4),
    ))
  );
}

export async function numberUsage(env: Env, connection: string) {
  const n = await one(
    env,
    "SELECT n.*,a.timezone,c.config FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id JOIN connections c ON c.id=n.connection_id WHERE connection_id=?",
    connection,
  );
  if (!n) return null;
  const period = billingPeriod(now(), n.timezone);
  const count = await one(
    env,
    `WITH b(period) AS (VALUES (?)) SELECT ${usage()} used FROM meta_numbers n,b WHERE n.connection_id=?`,
    period,
    connection,
  );
  const confirmed = await one(
    env,
    `SELECT count(*) delivered,sum(CASE WHEN category='service' THEN 1 ELSE 0 END) service_delivered,sum(CASE WHEN category IN ('utility','marketing','authentication','authentication_international') THEN 1 ELSE 0 END) template_delivered,sum(CASE WHEN category='service' AND billable=0 THEN 1 ELSE 0 END) free_confirmed,sum(CASE WHEN billable=1 THEN 1 ELSE 0 END) billable_confirmed,sum(CASE WHEN category='unknown' OR billable IS NULL THEN 1 ELSE 0 END) pricing_unknown FROM meta_message_usage WHERE connection_id=? AND period=? AND delivered_at>=?`,
    connection,
    period,
    n.monitored_at,
  );
  const pending = await one(
    env,
    "SELECT count(*) n FROM outbox o LEFT JOIN meta_message_usage u ON u.connection_id=o.connection_id AND u.external_id=o.external_id WHERE o.connection_id=? AND o.created>=? AND o.quota_category='service' AND o.status IN ('pending','sending','unknown','sent') AND u.delivered_at IS NULL AND coalesce(u.status,'')!='failed'",
    connection,
    n.monitored_at,
  );
  return {
    period,
    timezone: n.timezone,
    limit: n.service_limit,
    baseline: n.baseline_period === period ? n.baseline_used : 0,
    used: count.used,
    remaining: Math.max(0, n.service_limit - count.used),
    // Pending sends count conservatively until Meta confirms. A saved policy
    // can opt into using this allowance as an admission cap.
    free_allowance: n.service_limit,
    free_remaining: Math.max(0, n.service_limit - count.used),
    paid_service_estimated: Math.max(0, count.used - n.service_limit),
    service_overage_allowed: numberPolicy(json(n.config)).service_overage,
    reserved: pending.n,
    delivered: confirmed.delivered,
    service_delivered: confirmed.service_delivered || 0,
    template_delivered: confirmed.template_delivered || 0,
    free_confirmed: confirmed.free_confirmed || 0,
    billable_confirmed: confirmed.billable_confirmed || 0,
    pricing_unknown: confirmed.pricing_unknown || 0,
    monitored_at: n.monitored_at,
  };
}
export async function queueWithNumberQuota(
  env: Env,
  values: any[],
  category: string,
) {
  const freeOnly =
    json(values[7]).free_only === true || (await vinkiFreeOnly(env, values[6]));
  requireValue(
    !freeOnly || category !== "template",
    "Somente franquia gratuita não permite modelos pagos.",
  );
  if (freeOnly) {
    values = [...values];
    values[7] = JSON.stringify({ ...json(values[7]), free_only: true });
  }
  const connection = values[3];
  const n =
    connection &&
    (await one(
      env,
      "SELECT a.timezone FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id WHERE n.connection_id=?",
      connection,
    ));
  requireValue(
    !freeOnly || category !== "service" || !!n,
    "Somente franquia gratuita exige uma linha WhatsApp com contador no roteador.",
  );
  const sql =
    "INSERT OR IGNORE INTO outbox(id,profile_id,conversation_id,connection_id,epoch,kind,actor,payload,dedupe,created,updated,quota_month,quota_category)";
  const period = n ? billingPeriod(now(), n.timezone) : null;
  // Admission and reservation are one statement: two concurrent sends cannot
  // both spend the last unit. Read the live policy in that same statement.
  await exec(
    env,
    `WITH b(period) AS (VALUES (?)) ${sql} SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?!='service' OR NOT EXISTS (
      SELECT 1 FROM meta_numbers n JOIN connections c ON c.id=n.connection_id,b
      WHERE n.connection_id=? AND (?=1 OR json_extract(c.config,'$.number_policy.service_overage')=0) AND ${usage()}>=n.service_limit
    )`,
    period,
    ...values,
    period,
    n ? category : null,
    category,
    connection || null,
    Number(freeOnly),
  );
  // A replay returns the original receipt even if the allowance is now full.
  if (!(await one(env, "SELECT id FROM outbox WHERE dedupe=?", values[8])))
    throw quotaExhausted();
}

export async function assertNumberQuotaAvailable(
  env: Env,
  connection: string,
  freeOnly = false,
) {
  const usage = await numberUsage(env, connection);
  if (
    usage &&
    (freeOnly || !usage.service_overage_allowed) &&
    usage.free_remaining <= 0
  )
    throw quotaExhausted();
}

export async function assertNumberQuotaDelivery(env: Env, row: any) {
  if (!row.connection_id || row.quota_category !== "service") return;
  const number = await one(
    env,
    "SELECT a.timezone FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id WHERE n.connection_id=?",
    row.connection_id,
  );
  if (!number && json(row.payload).free_only === true)
    throw new ApiError(
      409,
      "quota_exhausted",
      "O envio exige franquia gratuita, mas o contador desta linha não está disponível. A conversa mantém o mesmo remetente.",
    );
  if (!number) return;
  // Already sent/ambiguous messages always hold capacity. Among pending
  // messages only reservations up to this one have priority, so tightening a
  // policy or lowering the allowance cancels the excess, not the entire queue.
  const reserved =
    "o.status IN ('sending','unknown','sent') OR (o.status='pending' AND (o.created<r.created OR (o.created=r.created AND o.rowid<=r.row_order)))";
  const blocked = await one(
    env,
    `WITH b(period) AS (VALUES (?)),r AS (SELECT rowid row_order,* FROM outbox WHERE id=?) SELECT n.connection_id FROM meta_numbers n JOIN connections c ON c.id=n.connection_id,b,r WHERE n.connection_id=? AND (json_extract(r.payload,'$.free_only')=1 OR json_extract(c.config,'$.number_policy.service_overage')=0) AND ${usage(reserved)}>n.service_limit`,
    billingPeriod(now(), number.timezone),
    row.id,
    row.connection_id,
  );
  if (blocked) throw quotaExhausted();
}
export async function observeMetaUsage(env: Env, conn: any, data: any) {
  if (
    conn.kind !== "meta" ||
    !["sent", "delivered", "read", "failed"].includes(data.status)
  )
    return;
  const n = await one(
    env,
    "SELECT a.timezone FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id WHERE connection_id=?",
    conn.id,
  );
  if (!n) return;
  const stamp = Number(data.timestamp);
  if (!Number.isFinite(stamp) || stamp <= 0 || stamp > now() + 300000) return;
  const delivered = ["delivered", "read"].includes(data.status);
  const category = [
    "service",
    "utility",
    "marketing",
    "authentication",
    "authentication_international",
  ].includes(data.pricing?.category)
    ? data.pricing.category
    : "unknown";
  const billable =
    typeof data.pricing?.billable === "boolean"
      ? Number(data.pricing.billable)
      : null;
  await exec(
    env,
    `INSERT INTO meta_message_usage(connection_id,external_id,status,category,billable,pricing_type,delivered_at,period,updated) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET
    status=CASE WHEN meta_message_usage.delivered_at IS NOT NULL THEN meta_message_usage.status WHEN excluded.delivered_at IS NOT NULL OR excluded.updated>=meta_message_usage.updated THEN excluded.status ELSE meta_message_usage.status END,
    category=CASE WHEN excluded.category!='unknown' THEN excluded.category ELSE meta_message_usage.category END,
    billable=coalesce(excluded.billable,meta_message_usage.billable),pricing_type=coalesce(excluded.pricing_type,meta_message_usage.pricing_type),
    period=CASE WHEN excluded.delivered_at IS NOT NULL AND (meta_message_usage.delivered_at IS NULL OR excluded.delivered_at<meta_message_usage.delivered_at) THEN excluded.period ELSE meta_message_usage.period END,
    delivered_at=CASE WHEN meta_message_usage.delivered_at IS NULL THEN excluded.delivered_at WHEN excluded.delivered_at IS NULL THEN meta_message_usage.delivered_at ELSE min(meta_message_usage.delivered_at,excluded.delivered_at) END,
    updated=max(meta_message_usage.updated,excluded.updated)`,
    conn.id,
    data.message_id,
    data.status,
    category,
    billable,
    typeof data.pricing?.type === "string"
      ? data.pricing.type.slice(0, 100)
      : null,
    delivered ? stamp : null,
    delivered ? billingPeriod(stamp, n.timezone) : null,
    stamp,
  );
}
