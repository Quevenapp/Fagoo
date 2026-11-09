import { admin, secret, setSecret } from "./security";
import {
  ApiError,
  type Actor,
  type Env,
  now,
  requireValue,
  uid,
} from "./types";
import { buildInfo } from "./build-info.generated";
import { all, exec } from "./db";
import * as legacy from "./legacy-updates";
import {
  assetManifest,
  assetUpload,
  CloudflareCallError,
  fetchPackage,
  installedSettings,
  latestRelease,
  parsePackage,
  releaseCloudflare,
  scriptPath,
  validateInstalledSettings,
  workerUpload,
} from "./release";

const configId = "system:release-config",
  stateId = "system:release-state",
  latestId = "system:release-latest";
const automaticConfigId = "system:release-automatic-config",
  automaticStateId = "system:release-automatic-state";
const activeStatuses = ["pending", "sending", "requested", "unknown"];
const automaticDefaults = {
  enabled: false,
  hour: 3,
  window_hours: 2,
  timezone: "America/Sao_Paulo",
};

async function updateLock<T>(
  env: Env,
  work: () => Promise<T>,
  skipBusy = false,
): Promise<T | null> {
  const owner = uid(),
    at = now();
  const result = await exec(
    env,
    "INSERT INTO system_update_locks(name,owner,expires) VALUES('release',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE system_update_locks.expires<=?",
    owner,
    at + 180000,
    at,
  );
  if (!result.meta.changes) {
    if (skipBusy) return null;
    throw new ApiError(
      409,
      "update_busy",
      "Outra etapa de atualização está em andamento. Tente novamente em instantes.",
    );
  }
  try {
    return await work();
  } finally {
    await exec(
      env,
      "DELETE FROM system_update_locks WHERE name='release' AND owner=?",
      owner,
    );
  }
}

function localParts(at: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}

export function automaticWindow(at: number, hour: number, windowHours: number) {
  const local = localParts(at),
    distance = (local.hour - hour + 24) % 24;
  return {
    open: distance < windowHours,
    key: localParts(at - distance * 3600000).date,
  };
}

function newerVersion(candidate: string, installed: string) {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(installed))
    return false;
  const a = candidate.split(".").map(Number),
    b = installed.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export async function automaticUpdateStatus(env: Env) {
  const config = {
    ...automaticDefaults,
    ...(await secret(env, automaticConfigId)),
  };
  const state = await secret(env, automaticStateId);
  return {
    ...config,
    ...state,
    enabled: config.enabled,
    status: config.enabled ? state.status || "scheduled" : "off",
    max_attempts: 3,
  };
}

export async function configureAutomaticUpdates(
  env: Env,
  actor: Actor,
  data: any,
) {
  admin(actor);
  requireValue(
    typeof data.enabled === "boolean",
    "Informe se a atualização automática está ligada.",
  );
  requireValue(
    Number.isInteger(data.hour) && data.hour >= 0 && data.hour <= 23,
    "Escolha uma hora entre 0 e 23.",
  );
  requireValue(
    Number.isInteger(data.window_hours) &&
      data.window_hours >= 1 &&
      data.window_hours <= 6,
    "Escolha uma janela de 1 a 6 horas.",
  );
  if (data.enabled)
    requireValue(
      isDirect(env) && !!(await tokenFor(env)),
      "Configure a atualização direta desta instalação antes de ligar a atualização automática.",
    );
  return updateLock(env, async () => {
    const old = await secret(env, automaticConfigId);
    await setSecret(env, automaticConfigId, {
      ...automaticDefaults,
      enabled: data.enabled,
      hour: data.hour,
      window_hours: data.window_hours,
      updated_at: now(),
      updated_by: actor.id,
    });
    if (!data.enabled) {
      const job = await secret(env, stateId);
      if (
        job.source === "automatic" &&
        job.status === "pending" &&
        !job.started_at
      ) {
        await setSecret(env, stateId, {
          ...job,
          status: "cancelled",
          updated: now(),
        });
      }
    }
    if (!old.enabled && data.enabled)
      await setSecret(env, automaticStateId, { status: "scheduled" });
    return automaticUpdateStatus(env);
  });
}
export const deployHookUrl = legacy.deployHookUrl;
export const updatePlan = legacy.updatePlan;
const isDirect = (env: Env) =>
  !!(
    env.WABOTIA_INSTALLATION_ID &&
    env.WABOTIA_ACCOUNT_ID &&
    env.WABOTIA_WORKER_NAME
  );
async function tokenFor(env: Env) {
  return (await secret(env, configId)).token || env.WABOTIA_UPDATE_TOKEN || "";
}
async function legacyMode(env: Env) {
  return !isDirect(env) && !!(await secret(env, "system:update-config")).hook;
}
function failure(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(
    502,
    "update_check_failed",
    error instanceof Error
      ? error.message
      : "Não foi possível consultar a publicação oficial.",
  );
}
export async function checkUpdate(env: Env, force = false) {
  if (await legacyMode(env)) return legacy.checkUpdate(env, force);
  const cached = await secret(env, latestId);
  if (!force && cached.checked_at > now() - 300000) return cached;
  try {
    const index = await latestRelease();
    const latest = {
      ...index,
      checked_at: now(),
      url: `https://github.com/Quevenapp/Wabotia/commit/${index.commit}`,
    };
    await setSecret(env, latestId, latest);
    return latest;
  } catch (e) {
    failure(e);
  }
}
function publicState(state: any) {
  if (!state.id) return null;
  return Object.fromEntries(
    [
      "id",
      "target",
      "version",
      "previous",
      "status",
      "phase",
      "created",
      "updated",
      "completed_at",
      "error",
      "source",
      "attempt",
      "started_at",
      "retryable",
      "retry_at",
    ].map((key) => [key, state[key]]),
  );
}
export async function updateStatus(env: Env) {
  if (await legacyMode(env))
    return {
      ...(await legacy.updateStatus(env)),
      method: "legacy",
      installation_ready: false,
      automatic: await automaticUpdateStatus(env),
    };
  const state = await secret(env, stateId),
    latest = await secret(env, latestId);
  if (state.target === buildInfo.commit && state.status !== "completed") {
    state.status = "completed";
    state.completed_at = now();
    await setSecret(env, stateId, state);
    if (state.package_key) await env.MEDIA.delete(state.package_key);
  }
  return {
    installed: buildInfo,
    method: "direct",
    installation_ready: isDirect(env),
    account_id: env.WABOTIA_ACCOUNT_ID || "",
    worker_name: env.WABOTIA_WORKER_NAME || "",
    configured: isDirect(env) && !!(await tokenFor(env)),
    latest: latest.commit ? latest : null,
    available: !!latest.commit && latest.commit !== buildInfo.commit,
    state: publicState(state),
    review_required:
      ["requested", "unknown", "sending"].includes(state.status) &&
      state.created < now() - 900000,
    automatic: await automaticUpdateStatus(env),
  };
}
export async function configureUpdates(env: Env, actor: Actor, data: any) {
  admin(actor);
  if (!isDirect(env) && data.hook_url)
    return legacy.configureUpdates(env, actor, data);
  requireValue(
    isDirect(env),
    "Esta instalação usa o fluxo antigo. Siga o guia de reinstalação sem repositório.",
  );
  requireValue(
    typeof data.token === "string" &&
      data.token.length >= 20 &&
      data.token.length <= 1024 &&
      !/\s/.test(data.token),
    "Informe um token Cloudflare com Workers Scripts: Edit.",
  );
  return updateLock(env, async () => {
    requireValue(
      !activeStatuses.includes((await secret(env, stateId)).status),
      "Aguarde a atualização atual antes de trocar o token.",
    );
    try {
      const settings = await installedSettings(
        data.token,
        scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!),
      );
      validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
      await setSecret(env, configId, {
        token: data.token,
        configured_at: now(),
      });
      return { configured: true };
    } catch (e) {
      failure(e);
    }
  });
}
export async function startUpdate(env: Env, actor: Actor, data: any) {
  admin(actor);
  if (await legacyMode(env)) return legacy.startUpdate(env, actor, data);
  return updateLock(env, () => startDirectUpdate(env, data));
}
async function startDirectUpdate(env: Env, data: any, source = "manual") {
  requireValue(
    isDirect(env) && (await tokenFor(env)),
    "Configure a autorização Cloudflare para atualizar esta instalação.",
  );
  const old = await secret(env, stateId);
  if (activeStatuses.includes(old.status)) return publicState(old);
  const index = await checkUpdate(env);
  requireValue(
    data.commit === index.commit && index.commit !== buildInfo.commit,
    "Confira novamente a versão disponível antes de atualizar.",
  );
  const state = {
    id: uid(),
    index,
    target: index.commit,
    version: index.version,
    previous: buildInfo.commit,
    status: "pending",
    phase: "download",
    created: now(),
    updated: now(),
    source,
    attempt: 1,
  };
  await setSecret(env, stateId, state);
  return publicState(state);
}
export async function updatePending(env: Env) {
  return (await secret(env, stateId)).status === "pending";
}

// The existing five-minute cron wakes the installation's _admin coordinator.
// A durable lease also prevents a simultaneous manual command from starting or
// processing the same publication twice after a retry or Worker restart.
export async function automaticUpdateTick(env: Env) {
  if (!(await secret(env, automaticConfigId)).enabled) return;
  return updateLock(
    env,
    async () => {
      const config = {
        ...automaticDefaults,
        ...(await secret(env, automaticConfigId)),
      };
      if (!config.enabled) return;
      const at = now(),
        window = automaticWindow(at, config.hour, config.window_hours);
      const automatic = await secret(env, automaticStateId);
      const save = (patch: Record<string, unknown>) =>
        setSecret(env, automaticStateId, {
          ...automatic,
          ...patch,
          updated_at: at,
        });
      if (!isDirect(env) || !(await tokenFor(env))) {
        await save({
          status: "blocked",
          error:
            "A instalação direta precisa de autorização Cloudflare válida para atualizar.",
        });
        return;
      }
      await updateStatus(env); // Reconcile only against the code actually running.
      const job = await secret(env, stateId);
      if (activeStatuses.includes(job.status)) {
        await save({
          status: ["sending", "requested", "unknown"].includes(job.status)
            ? "awaiting_confirmation"
            : "running",
          job_id: job.id,
          attempt: job.attempt || 1,
          error: job.error || null,
        });
        return;
      }
      if (job.status === "failed") {
        if (
          job.source !== "automatic" ||
          !job.retryable ||
          (job.attempt || 1) >= 3
        ) {
          await save({
            status: "blocked",
            job_id: job.id,
            attempt: job.attempt || 1,
            error:
              job.error ||
              "A atualização exige revisão antes de uma nova tentativa.",
            retry_at: null,
          });
          return;
        }
        await save({
          status: "retry_wait",
          job_id: job.id,
          attempt: job.attempt || 1,
          error: job.error,
          retry_at: job.retry_at,
        });
        if (!window.open || at < job.retry_at) return;
        const retry = {
          ...job,
          status: "pending",
          phase: "download",
          attempt: (job.attempt || 1) + 1,
          error: null,
          retry_at: null,
          retryable: false,
          updated: at,
        };
        await setSecret(env, stateId, retry);
        await save({
          status: "queued",
          job_id: job.id,
          attempt: retry.attempt,
          error: null,
          retry_at: null,
        });
        return;
      }
      if (!window.open) {
        if (automatic.status !== "scheduled")
          await save({ status: "scheduled", retry_at: null });
        return;
      }
      const sameWindow = automatic.last_window === window.key;
      if (
        sameWindow &&
        (!automatic.check_retry_at ||
          at < automatic.check_retry_at ||
          automatic.check_attempt >= 3)
      )
        return;
      const checkAttempt = sameWindow ? (automatic.check_attempt || 0) + 1 : 1;
      const checkState = {
        last_window: window.key,
        last_checked_at: at,
        check_attempt: checkAttempt,
        check_retry_at: null,
      };
      await save({ ...checkState, status: "checking", error: null });
      try {
        const index = await checkUpdate(env, true);
        if (index.commit === buildInfo.commit) {
          await save({
            ...checkState,
            status: "up_to_date",
            error: null,
            target: index.commit,
          });
        } else if (!newerVersion(index.version, buildInfo.version)) {
          await save({
            ...checkState,
            status: "release_requires_review",
            error:
              "A publicação tem versão igual ou anterior à instalada. A atualização automática não faz downgrade nem troca o código de uma versão já publicada.",
            target: index.commit,
          });
        } else {
          const queued = await startDirectUpdate(
            env,
            { commit: index.commit },
            "automatic",
          );
          await save({
            ...checkState,
            status: "queued",
            error: null,
            job_id: queued?.id,
            target: index.commit,
            attempt: 1,
            retry_at: null,
          });
        }
      } catch (error) {
        await save({
          ...checkState,
          status: "check_failed",
          error:
            error instanceof Error
              ? error.message
              : "Não foi possível consultar a versão oficial.",
          check_retry_at:
            checkAttempt < 3 ? at + 300000 * 2 ** (checkAttempt - 1) : null,
        });
      }
    },
    true,
  );
}
export async function processUpdate(env: Env) {
  return updateLock(env, () => processDirectUpdate(env), true);
}
async function processDirectUpdate(env: Env) {
  const state = await secret(env, stateId);
  if (state.status !== "pending") return;
  if (
    state.source === "automatic" &&
    !state.started_at &&
    !(await secret(env, automaticConfigId)).enabled
  ) {
    await setSecret(env, stateId, {
      ...state,
      status: "cancelled",
      updated: now(),
    });
    return;
  }
  state.started_at ||= now();
  try {
    const token = await tokenFor(env),
      base = scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!);
    if (state.phase === "download") {
      const { bytes } = await fetchPackage(state.index);
      state.package_key = `system/releases/${state.id}.json`;
      await env.MEDIA.put(state.package_key, bytes, {
        httpMetadata: { contentType: "application/json" },
      });
      state.phase = "prepare";
    } else {
      const stored = await env.MEDIA.get(state.package_key);
      requireValue(
        stored,
        "O pacote temporário não está disponível. Libere uma nova tentativa.",
      );
      const pkg = await parsePackage(
        state.index,
        new Uint8Array(await stored!.arrayBuffer()),
      );
      if (state.phase === "prepare") {
        const settings = await installedSettings(token, base);
        validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
        const upload = await releaseCloudflare(
          token,
          base + "/assets-upload-session",
          "POST",
          { manifest: assetManifest(pkg) },
        );
        requireValue(
          typeof upload?.jwt === "string" && Array.isArray(upload.buckets),
          "Sessão de arquivos inválida.",
        );
        state.upload = upload;
        state.bucket = 0;
        state.phase = upload.buckets.length ? "assets" : "migrate";
      } else if (state.phase === "assets") {
        const result = await releaseCloudflare(
          state.upload.jwt,
          `/accounts/${env.WABOTIA_ACCOUNT_ID}/workers/assets/upload?base64=true`,
          "POST",
          assetUpload(pkg, state.upload.buckets[state.bucket]),
        );
        state.bucket++;
        if (state.bucket === state.upload.buckets.length) {
          requireValue(
            typeof result?.jwt === "string",
            "A Cloudflare não confirmou todos os arquivos. Libere uma nova tentativa.",
          );
          state.upload.jwt = result.jwt;
          state.phase = "migrate";
        }
      } else if (state.phase === "migrate") {
        await env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
        ).run();
        const applied = await all(env, "SELECT name FROM d1_migrations");
        const migration = pkg.migrations.find(
          (m) => !applied.some((row) => row.name === m.name),
        );
        if (migration) {
          await env.DB.batch([
            ...migration.statements.map((sql) => env.DB.prepare(sql)),
            env.DB.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(
              migration.name,
            ),
          ]);
        } else state.phase = "publish";
      } else if (state.phase === "publish") {
        const settings = await installedSettings(token, base);
        validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
        state.status = "sending";
        state.updated = now();
        await setSecret(env, stateId, state);
        const result = await releaseCloudflare(
          token,
          base,
          "PUT",
          workerUpload(pkg, settings, state.upload.jwt),
        );
        requireValue(
          result?.id || result?.etag,
          "A Cloudflare não confirmou a publicação. Confira a versão antes de repetir.",
        );
        state.status = "requested";
      } else throw new Error("Etapa de atualização desconhecida.");
    }
    state.updated = now();
    if ((await secret(env, stateId)).status !== "completed")
      await setSecret(env, stateId, state);
  } catch (e) {
    state.error =
      e instanceof Error ? e.message : "A atualização não foi concluída.";
    state.status =
      state.status === "sending" &&
      (!(e instanceof CloudflareCallError) || e.ambiguous)
        ? "unknown"
        : "failed";
    state.updated = now();
    state.retryable =
      state.source === "automatic" &&
      ["download", "prepare", "assets"].includes(state.phase) &&
      (e instanceof TypeError ||
        (e instanceof Error &&
          ["AbortError", "TimeoutError"].includes(e.name)) ||
        (e instanceof CloudflareCallError &&
          !/HTTP (?!429\b)4\d\d\b/.test(state.error)) ||
        /HTTP (429|5\d\d)\b/.test(state.error));
    state.retry_at = state.retryable
      ? now() + 300000 * 2 ** ((state.attempt || 1) - 1)
      : null;
    if ((await secret(env, stateId)).status !== "completed")
      await setSecret(env, stateId, state);
  }
}
export async function resetUpdate(env: Env, actor: Actor, data: any) {
  admin(actor);
  if (await legacyMode(env)) return legacy.resetUpdate(env, actor, data);
  return updateLock(env, () => resetDirectUpdate(env, data));
}
async function resetDirectUpdate(env: Env, data: any) {
  const state = await secret(env, stateId);
  requireValue(
    data.confirmed_build_stopped === true &&
      state.id &&
      state.status !== "completed" &&
      state.status !== "pending",
    "Confira a versão e confirme que a publicação anterior terminou.",
  );
  requireValue(
    state.status === "failed" || state.created < now() - 900000,
    "Aguarde a publicação. Não é possível repetir uma operação ainda em andamento.",
  );
  state.status = "cancelled";
  await setSecret(env, stateId, state);
  if (state.package_key) await env.MEDIA.delete(state.package_key);
  return publicState(state);
}
