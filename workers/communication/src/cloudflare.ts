import { all, exec, one } from "./db";
import { admin, secret, setSecret } from "./security";
import {
  ApiError,
  type Actor,
  type Env,
  json,
  now,
  requireValue,
  uid,
} from "./types";

export const cloudflareSteps = [
  "Conferir domínio e conflitos",
  "Criar credencial Access",
  "Criar política Service Auth",
  "Proteger descoberta de perfis",
  "Proteger API do bot",
  "Validar proteção Access",
  "Criar túnel exclusivo",
  "Obter credencial do conector",
  "Configurar rotas restritas",
  "Criar DNS administrativo",
  "Criar DNS da API",
  "Cadastrar conexão no Wabotia",
];
const id32 = /^[a-f0-9]{32}$/;
const resourceId =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const hostname =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const configKey = "cloudflare:config";
const jobKey = (id: string) => `cloudflare:job:${id}`;

export class CloudflareError extends ApiError {
  constructor(
    public ambiguous: boolean,
    status: number,
    message: string,
  ) {
    super(
      status,
      ambiguous ? "cloudflare_unknown" : "cloudflare_failed",
      message,
    );
  }
}
function createdResource(value: any) {
  if (!resourceId.test(value?.id || ""))
    throw new CloudflareError(
      true,
      502,
      "A Cloudflare recebeu a criação, mas não devolveu um identificador válido. Confira o dashboard; a etapa não será repetida automaticamente.",
    );
  return value.id as string;
}
export async function cloudflareRequest(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  // All paths are constructed here from validated IDs; credentials never reach arbitrary URLs.
  requireValue(
    /^\/(accounts|zones)\/[a-f0-9]{32}(?:\/|$)/.test(path),
    "Recurso Cloudflare inválido.",
  );
  let response: Response;
  try {
    response = await fetch("https://api.cloudflare.com/client/v4" + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new CloudflareError(
      method !== "GET",
      502,
      "A Cloudflare não confirmou a resposta. Confira o recurso no dashboard antes de repetir a etapa.",
    );
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new CloudflareError(
      method !== "GET",
      502,
      "A Cloudflare retornou uma resposta inesperada. Confira o dashboard.",
    );
  }
  if (!response.ok || data?.success !== true) {
    const codes = (Array.isArray(data?.errors) ? data.errors : [])
      .map((e: any) => String(e.code).replace(/[^\d]/g, ""))
      .filter(Boolean)
      .join(", ");
    throw new CloudflareError(
      method !== "GET" && !(response.status >= 400 && response.status < 500),
      502,
      `Cloudflare HTTP ${response.status}${codes ? ` (código ${codes})` : ""}. Confira a conta, o domínio, o plano Zero Trust e as permissões do token de API.`,
    );
  }
  return data;
}
export async function cloudflareSettings(env: Env) {
  const config = await secret(env, configKey);
  return {
    configured: !!config.token,
    account_id: config.account_id || "",
    zone_id: config.zone_id || "",
    domain: config.domain || "",
  };
}
export async function saveCloudflareSettings(
  env: Env,
  actor: Actor,
  data: any,
) {
  admin(actor);
  requireValue(
    id32.test(data.account_id) && id32.test(data.zone_id),
    "Informe Account ID e Zone ID com 32 caracteres.",
  );
  const old = await secret(env, configKey);
  const token =
    data.token ||
    (old.account_id === data.account_id && old.zone_id === data.zone_id
      ? old.token
      : "");
  requireValue(
    typeof token === "string" &&
      token.length >= 20 &&
      token.length <= 1024 &&
      !/\s/.test(token),
    "Informe um token de API Cloudflare válido.",
  );
  const { result: zone } = await cloudflareRequest(
    token,
    `/zones/${data.zone_id}`,
  );
  requireValue(
    zone.account?.id === data.account_id && zone.status === "active",
    "O domínio deve estar ativo e pertencer à conta informada.",
  );
  await cloudflareRequest(
    token,
    `/accounts/${data.account_id}/access/apps?per_page=1`,
  );
  await cloudflareRequest(
    token,
    `/accounts/${data.account_id}/cfd_tunnel?is_deleted=false&per_page=1`,
  );
  await setSecret(env, configKey, {
    token,
    account_id: data.account_id,
    zone_id: data.zone_id,
    domain: zone.name,
  });
  return cloudflareSettings(env);
}
export async function createCloudflareJob(env: Env, actor: Actor, data: any) {
  admin(actor);
  const config = await secret(env, configKey);
  requireValue(
    config.token,
    "Configure a autorização Cloudflare em Sistema e atualizações.",
  );
  requireValue(
    data.prerequisites_confirmed === true,
    "Confirme que as APIs Hermes estão ligadas e que o Zero Trust já foi ativado.",
  );
  requireValue(
    await one(env, "SELECT id FROM profiles WHERE id=?", data.profile_id),
    "Escolha um perfil de atendimento existente.",
  );
  const names = [data.admin_hostname, data.api_hostname];
  requireValue(
    names.every(
      (n) =>
        typeof n === "string" &&
        hostname.test(n) &&
        n.endsWith("." + config.domain) &&
        n.slice(0, -config.domain.length - 1).indexOf(".") === -1,
    ) && names[0] !== names[1],
    "Use dois subdomínios diferentes, de um único nível, no domínio autorizado.",
  );
  requireValue(
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(data.remote_profile || ""),
    "Nome de perfil Hermes inválido.",
  );
  const adminPort = Number(data.admin_port || 9119),
    apiPort = Number(data.api_port || 8642);
  requireValue(
    [adminPort, apiPort].every(
      (p) => Number.isInteger(p) && p > 0 && p <= 65535,
    ) && adminPort !== apiPort,
    "Informe portas locais diferentes entre 1 e 65535.",
  );
  for (const value of [data.dashboard_token, data.profile_key])
    requireValue(
      typeof value === "string" &&
        value.length >= 16 &&
        value.length <= 4096 &&
        !/[\r\n]/.test(value),
      "Informe as duas chaves existentes do Hermes.",
    );
  requireValue(
    !(await one(
      env,
      "SELECT id FROM cloudflare_jobs WHERE admin_hostname IN (?,?) OR api_hostname IN (?,?)",
      ...names,
      ...names,
    )),
    "Já existe uma preparação para um desses endereços. Consulte o andamento abaixo.",
  );
  const id = uid(),
    connectionId = uid();
  const spec = {
    account_id: config.account_id,
    zone_id: config.zone_id,
    domain: config.domain,
    admin_hostname: names[0],
    api_hostname: names[1],
    remote_profile: data.remote_profile,
    admin_port: adminPort,
    api_port: apiPort,
    tunnel_name: `wabotia-${data.remote_profile}-${id.slice(0, 8)}`,
    connection_id: connectionId,
  };
  await setSecret(env, jobKey(id), {
    token: config.token,
    dashboard_token: data.dashboard_token,
    profile_key: data.profile_key,
  });
  await exec(
    env,
    "INSERT INTO cloudflare_jobs(id,profile_id,actor,admin_hostname,api_hostname,spec,created,updated) VALUES(?,?,?,?,?,?,?,?)",
    id,
    data.profile_id,
    actor.id,
    names[0],
    names[1],
    JSON.stringify(spec),
    now(),
    now(),
  );
  return { id, status: "pending" };
}
export async function cloudflareJobs(env: Env) {
  return (
    await all(
      env,
      "SELECT * FROM cloudflare_jobs ORDER BY created DESC LIMIT 50",
    )
  ).map((row) => ({
    id: row.id,
    profile_id: row.profile_id,
    admin_hostname: row.admin_hostname,
    api_hostname: row.api_hostname,
    status: row.status,
    step: row.step,
    label: cloudflareSteps[row.step] || "Configuração pronta",
    total: cloudflareSteps.length,
    error: row.error,
    resources: json(row.resources),
    connection_id: json(row.spec).connection_id,
    tunnel_name: json(row.spec).tunnel_name,
    remote_profile: json(row.spec).remote_profile,
    created: row.created,
  }));
}
async function preflight(spec: any, token: string) {
  const base = `/accounts/${spec.account_id}`;
  const { result: zone } = await cloudflareRequest(
    token,
    `/zones/${spec.zone_id}`,
  );
  requireValue(
    zone.account?.id === spec.account_id &&
      zone.status === "active" &&
      zone.name === spec.domain,
    "O domínio mudou de conta ou deixou de estar ativo.",
  );
  for (const host of [spec.admin_hostname, spec.api_hostname]) {
    const records = await cloudflareRequest(
      token,
      `/zones/${spec.zone_id}/dns_records?name=${encodeURIComponent(host)}`,
    );
    requireValue(
      records.result.length === 0,
      `Já existe DNS para ${host}. A configuração existente foi preservada; escolha um endereço novo.`,
    );
  }
  let page = 1;
  while (page <= 20) {
    const apps = await cloudflareRequest(
      token,
      `${base}/access/apps?per_page=100&page=${page}`,
    );
    for (const app of apps.result) {
      const domains = [
        app.domain,
        ...(app.destinations || []).map((d: any) => d.uri),
      ]
        .filter(Boolean)
        .map((d: string) => d.split("/")[0]);
      for (const host of [spec.admin_hostname, spec.api_hostname])
        requireValue(
          !domains.some(
            (d: string) =>
              d === host || (d.startsWith("*.") && host.endsWith(d.slice(1))),
          ),
          `Já existe proteção Access para ${host}. Use um endereço novo para preservar essa aplicação.`,
        );
    }
    if (page >= (apps.result_info?.total_pages || 1)) return;
    page++;
  }
  throw new ApiError(
    400,
    "too_many_apps",
    "Muitas aplicações Access. Configure esta conexão manualmente.",
  );
}
async function verifyAccess(spec: any, resources: any, token: string) {
  for (const [id, host] of [
    [resources.admin_app, spec.admin_hostname],
    [resources.api_app, spec.api_hostname],
  ]) {
    const base = `/accounts/${spec.account_id}/access/apps/${id}`;
    const { result: app } = await cloudflareRequest(token, base);
    const { result: policies } = await cloudflareRequest(
      token,
      base + "/policies",
    );
    requireValue(
      app.domain === host &&
        app.type === "self_hosted" &&
        policies.length === 1 &&
        policies[0].decision === "non_identity" &&
        policies[0].include?.length === 1 &&
        policies[0].include[0].service_token?.token_id ===
          resources.service_token,
      "A política Access não corresponde à proteção exclusiva esperada. Nenhum DNS será publicado.",
    );
  }
}
export async function processCloudflareJob(env: Env) {
  // An interrupted mutation is never replayed automatically: the provider may have committed it.
  await exec(
    env,
    "UPDATE cloudflare_jobs SET status='unknown',error='A etapa foi interrompida sem confirmação. Confira os recursos no Cloudflare antes de continuar.',updated=? WHERE status='running' AND updated<?",
    now(),
    now() - 60000,
  );
  const job = await one(
    env,
    "SELECT * FROM cloudflare_jobs WHERE status='pending' ORDER BY created LIMIT 1",
  );
  if (!job) return;
  const claimed = await one(
    env,
    "UPDATE cloudflare_jobs SET status='running',updated=? WHERE id=? AND status='pending' RETURNING id",
    now(),
    job.id,
  );
  if (!claimed) return;
  const spec = json(job.spec),
    resources = json(job.resources),
    keys = await secret(env, jobKey(job.id));
  const base = `/accounts/${spec.account_id}`;
  const call = async (path: string, method = "GET", body?: unknown) =>
    (await cloudflareRequest(keys.token, path, method, body)).result;
  try {
    switch (job.step) {
      case 0:
        await preflight(spec, keys.token);
        break;
      case 1: {
        const value = await call(base + "/access/service_tokens", "POST", {
          name: spec.tunnel_name,
          duration: "8760h",
        });
        resources.service_token = createdResource(value);
        if (
          typeof value.client_id !== "string" ||
          typeof value.client_secret !== "string" ||
          !value.client_id ||
          !value.client_secret
        )
          throw new CloudflareError(
            true,
            502,
            "A Cloudflare não devolveu a credencial Access completa. Confira o recurso no dashboard; a etapa não será repetida.",
          );
        keys.access_client_id = value.client_id;
        keys.access_client_secret = value.client_secret;
        keys.access_expires_at = new Date(now() + 365 * 86400000).toISOString();
        await setSecret(env, jobKey(job.id), keys);
        break;
      }
      case 2:
        resources.policy = createdResource(
          await call(base + "/access/policies", "POST", {
            name: spec.tunnel_name,
            decision: "non_identity",
            include: [{ service_token: { token_id: resources.service_token } }],
            exclude: [],
            require: [],
          }),
        );
        break;
      case 3:
      case 4: {
        const isAdmin = job.step === 3;
        const value = await call(base + "/access/apps", "POST", {
          type: "self_hosted",
          name: `${spec.tunnel_name} ${isAdmin ? "descoberta" : "API"}`,
          domain: isAdmin ? spec.admin_hostname : spec.api_hostname,
          session_duration: "24h",
          app_launcher_visible: false,
          policies: [{ id: resources.policy, precedence: 1 }],
        });
        resources[isAdmin ? "admin_app" : "api_app"] = createdResource(value);
        break;
      }
      case 5:
        await verifyAccess(spec, resources, keys.token);
        break;
      case 6:
        resources.tunnel = createdResource(
          await call(base + "/cfd_tunnel", "POST", {
            name: spec.tunnel_name,
            config_src: "cloudflare",
          }),
        );
        break;
      case 7: {
        const token = await call(
          base + `/cfd_tunnel/${resources.tunnel}/token`,
        );
        requireValue(
          typeof token === "string" &&
            /^[A-Za-z0-9_+/=-]{40,2048}$/.test(token),
          "Credencial do túnel inválida.",
        );
        keys.tunnel_token = token;
        await setSecret(env, jobKey(job.id), keys);
        break;
      }
      case 8:
        await call(
          base + `/cfd_tunnel/${resources.tunnel}/configurations`,
          "PUT",
          {
            config: {
              ingress: [
                {
                  hostname: spec.admin_hostname,
                  path: "^/api/profiles$",
                  service: `http://127.0.0.1:${spec.admin_port}`,
                  originRequest: {
                    httpHostHeader: `127.0.0.1:${spec.admin_port}`,
                  },
                },
                {
                  hostname: spec.api_hostname,
                  path: `^${spec.remote_profile === "default" ? "" : `/p/${spec.remote_profile}`}/v1/.*$`,
                  service: `http://127.0.0.1:${spec.api_port}`,
                },
                { service: "http_status:404" },
              ],
            },
          },
        );
        break;
      case 9:
      case 10: {
        await verifyAccess(spec, resources, keys.token);
        const host = job.step === 9 ? spec.admin_hostname : spec.api_hostname;
        const existing = await call(
          `/zones/${spec.zone_id}/dns_records?name=${encodeURIComponent(host)}`,
        );
        requireValue(
          existing.length === 0,
          `DNS ${host} já existe. Não será substituído.`,
        );
        resources[job.step === 9 ? "admin_dns" : "api_dns"] = createdResource(
          await call(`/zones/${spec.zone_id}/dns_records`, "POST", {
            type: "CNAME",
            name: host,
            content: `${resources.tunnel}.cfargotunnel.com`,
            proxied: true,
            ttl: 1,
            comment: `Wabotia ${job.id}`,
          }),
        );
        break;
      }
      case 11:
        await setSecret(env, `connection:${spec.connection_id}`, {
          dashboard_token: keys.dashboard_token,
          profile_keys: { [spec.remote_profile]: keys.profile_key },
          access_client_id: keys.access_client_id,
          access_client_secret: keys.access_client_secret,
        });
        await exec(
          env,
          "INSERT OR IGNORE INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'hermes','direct','paused',?,?)",
          spec.connection_id,
          job.profile_id,
          `Hermes · ${spec.remote_profile}`,
          JSON.stringify({
            url: `https://${spec.admin_hostname}`,
            api_url: `https://${spec.api_hostname}`,
            cloudflare_job: job.id,
            access_expires_at: keys.access_expires_at,
          }),
          now(),
        );
        break;
    }
    await exec(
      env,
      "UPDATE cloudflare_jobs SET resources=?,step=step+1,status=?,error=NULL,updated=? WHERE id=?",
      JSON.stringify(resources),
      job.step + 1 === cloudflareSteps.length ? "ready" : "pending",
      now(),
      job.id,
    );
  } catch (error) {
    const ambiguous =
      error instanceof CloudflareError
        ? error.ambiguous
        : !(error instanceof ApiError);
    await exec(
      env,
      "UPDATE cloudflare_jobs SET status=?,error=?,resources=?,updated=? WHERE id=?",
      ambiguous ? "unknown" : "failed",
      error instanceof ApiError
        ? error.message
        : "A etapa não foi confirmada. Confira os recursos já criados no dashboard Cloudflare.",
      JSON.stringify(resources),
      now(),
      job.id,
    );
  }
}
export async function retryCloudflareJob(env: Env, actor: Actor, id: string) {
  admin(actor);
  const job = await one(
    env,
    "SELECT status,spec FROM cloudflare_jobs WHERE id=?",
    id,
  );
  requireValue(
    job?.status === "failed",
    "Somente falhas confirmadas podem ser retomadas. Operações sem confirmação exigem reconciliação manual.",
  );
  const config = await secret(env, configKey),
    spec = json(job.spec);
  requireValue(
    config.account_id === spec.account_id && config.zone_id === spec.zone_id,
    "Restaure a autorização da conta e domínio usados neste deploy antes de retomá-lo.",
  );
  const keys = await secret(env, jobKey(id));
  keys.token = config.token;
  await setSecret(env, jobKey(id), keys);
  await exec(
    env,
    "UPDATE cloudflare_jobs SET status='pending',error=NULL,updated=? WHERE id=?",
    now(),
    id,
  );
  return { id, status: "pending" };
}
export async function connectorDownload(env: Env, actor: Actor, id: string) {
  admin(actor);
  const job = await one(
    env,
    "SELECT * FROM cloudflare_jobs WHERE id=? AND status='ready'",
    id,
  );
  requireValue(
    job,
    "Conclua a configuração Cloudflare antes de obter o conector.",
  );
  const keys = await secret(env, jobKey(id)),
    spec = json(job.spec);
  return {
    token: keys.tunnel_token,
    tunnel_name: spec.tunnel_name,
    tunnel_id: json(job.resources).tunnel,
    expires_at: keys.access_expires_at,
  };
}
