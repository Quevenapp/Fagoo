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
const source = "https://api.github.com/repos/Quevenapp/Wabotia";
const sha = /^[a-f0-9]{40}$/;
const configId = "system:update-config",
  stateId = "system:update-state",
  latestId = "system:update-latest";
export function deployHookUrl(value: unknown) {
  requireValue(
    typeof value === "string" &&
      /^https:\/\/api\.cloudflare\.com\/client\/v4\/workers\/builds\/deploy_hooks\/[a-zA-Z0-9_-]{16,200}$/.test(
        value,
      ),
    "Cole a URL do Deploy Hook do seu Worker, criada em Cloudflare > Settings > Builds > Deploy Hooks.",
  );
  return value;
}
async function github(path: string) {
  const r = await fetch(source + path, {
    headers: {
      "User-Agent": "Wabotia-Updater",
      Accept: "application/vnd.github+json",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok)
    throw new ApiError(
      502,
      "update_check_failed",
      `Não foi possível consultar o repositório oficial (HTTP ${r.status}). Tente mais tarde.`,
    );
  return r.json<any>();
}
export async function checkUpdate(env: Env, force = false) {
  const cached = await secret(env, latestId);
  if (!force && cached.checked_at && cached.checked_at > now() - 300000)
    return cached;
  const head = await github("/commits/main");
  requireValue(
    sha.test(head.sha),
    "O repositório não retornou uma versão válida.",
  );
  const packageFile = await github(`/contents/package.json?ref=${head.sha}`);
  const pkg = JSON.parse(atob(packageFile.content.replace(/\s/g, "")));
  requireValue(
    /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version),
    "Versão publicada inválida.",
  );
  const latest = {
    commit: head.sha,
    version: pkg.version,
    checked_at: now(),
    url: `https://github.com/Quevenapp/Wabotia/commit/${head.sha}`,
  };
  await setSecret(env, latestId, latest);
  return latest;
}
export async function updateStatus(env: Env) {
  const config = await secret(env, configId),
    state = await secret(env, stateId),
    latest = await secret(env, latestId);
  if (
    state.target &&
    state.target === buildInfo.commit &&
    state.status !== "completed"
  ) {
    state.status = "completed";
    state.completed_at = now();
    await setSecret(env, stateId, state);
  }
  return {
    installed: buildInfo,
    configured: !!config.hook,
    latest: latest.commit ? latest : null,
    available: !!latest.commit && latest.commit !== buildInfo.commit,
    state: state.id ? state : null,
    review_required:
      ["requested", "unknown", "sending"].includes(state.status) &&
      state.created < now() - 900000,
  };
}
export async function updatePlan(env: Env) {
  const state = await secret(env, stateId);
  const commit = ["sending", "requested", "unknown"].includes(state.status)
    ? state.target
    : buildInfo.commit;
  return {
    repository: "Quevenapp/Wabotia",
    commit: sha.test(commit || "") ? commit : null,
  };
}
export async function configureUpdates(env: Env, actor: Actor, data: any) {
  admin(actor);
  requireValue(
    data.build_configured === true,
    "Confirme que o comando de build e WABOTIA_UPDATE_ORIGIN foram configurados conforme o guia.",
  );
  await setSecret(env, configId, {
    hook: deployHookUrl(data.hook_url),
    configured_at: now(),
  });
  return { configured: true };
}
export async function startUpdate(env: Env, actor: Actor, data: any) {
  admin(actor);
  const current = await updateStatus(env);
  if (
    current.state &&
    ["sending", "requested", "unknown"].includes(current.state.status)
  )
    return current.state;
  const config = await secret(env, configId);
  requireValue(
    config.hook,
    "Configure primeiro o Deploy Hook desta instalação.",
  );
  const latest = await checkUpdate(env);
  requireValue(
    data.commit === latest.commit && data.commit !== buildInfo.commit,
    "Confira novamente a versão disponível antes de atualizar.",
  );
  const state: any = {
    id: uid(),
    target: latest.commit,
    version: latest.version,
    previous: buildInfo.commit,
    status: "sending",
    created: now(),
  };
  // Persist the pinned source before triggering the build. Never retry a timeout automatically.
  await setSecret(env, stateId, state);
  try {
    const r = await fetch(deployHookUrl(config.hook), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const result: any = await r.json();
    if (!r.ok || result.success !== true || !result.result?.build_uuid) {
      state.status = r.status >= 400 && r.status < 500 ? "failed" : "unknown";
      state.error = `A Cloudflare não confirmou a atualização (HTTP ${r.status}). Confira a aba Builds antes de tentar novamente.`;
    } else {
      state.status = "requested";
      state.build_id = result.result.build_uuid;
    }
  } catch {
    state.status = "unknown";
    state.error =
      "O pedido ficou sem confirmação. Confira a aba Builds na Cloudflare antes de liberar outra tentativa.";
  }
  await setSecret(env, stateId, state);
  return state;
}
export async function resetUpdate(env: Env, actor: Actor, data: any) {
  admin(actor);
  const { state } = await updateStatus(env);
  requireValue(
    state &&
      state.status !== "completed" &&
      data.confirmed_build_stopped === true,
    "Confirme no Cloudflare que não há um build em execução ou na fila.",
  );
  requireValue(
    state.status === "failed" || state.created < now() - 900000,
    "Aguarde o build. Uma nova tentativa não será iniciada enquanto a atualização pode estar em andamento.",
  );
  state.status = "cancelled";
  await setSecret(env, stateId, state);
  return state;
}
