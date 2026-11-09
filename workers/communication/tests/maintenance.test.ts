import { env, SELF } from "cloudflare:test";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { secret, setSecret, sha } from "../src/security";
import { now, uid, type Actor } from "../src/types";
import {
  cloudflareJobs,
  cloudflareRequest,
  cloudflareSettings,
  connectorDownload,
  createCloudflareJob,
  processCloudflareJob,
  retryCloudflareJob,
  saveCloudflareSettings,
} from "../src/cloudflare";
import {
  checkUpdate,
  configureUpdates,
  deployHookUrl,
  resetUpdate,
  startUpdate,
  updatePlan,
  updateStatus,
} from "../src/updates";
import { buildInfo } from "../src/build-info.generated";

const account = "a".repeat(32),
  zone = "b".repeat(32),
  target = "c".repeat(40);
const token = "private-cloudflare-api-token-test";
const hook =
  "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/0123456789abcdef0123456789abcdef";
const admin: Actor = {
  id: "test-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 100,
  runLimit: 10,
};
let calls: { path: string; method: string; body: any; auth: string }[],
  apps: any[],
  policies: any[],
  dns: any[],
  fault: string,
  special: string;
const ok = (result: any, extra = {}) =>
  Response.json({ success: true, result, ...extra });
beforeEach(async () => {
  calls = [];
  apps = [];
  policies = [];
  dns = [];
  fault = "";
  special = "";
  await exec(env, "DELETE FROM cloudflare_jobs");
  await exec(
    env,
    "DELETE FROM secrets WHERE id LIKE 'cloudflare:%' OR id LIKE 'system:update-%'",
  );
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    // Validate request options in workerd even when the provider response is simulated.
    new Request(input, init);
    const url = new URL(
      typeof input === "string" ? input : input.url || String(input),
    );
    const path = url.pathname.replace("/client/v4", ""),
      method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({
      path,
      method,
      body,
      auth: new Headers(init.headers).get("Authorization") || "",
    });
    if (fault === path) throw new Error("network interrupted");
    if (special === path && method === "POST") return ok({ id: uid() });
    if (url.origin === "https://api.github.com") {
      if (path.endsWith("/commits/main")) return Response.json({ sha: target });
      if (
        path.endsWith("/contents/package.json") &&
        url.search === `?ref=${target}`
      )
        return Response.json({
          content: btoa(JSON.stringify({ version: "0.2.1" })),
        });
    }
    if (url.origin !== "https://api.cloudflare.com")
      throw Error("Unexpected destination");
    if (url.href === hook) return ok({ build_uuid: uid() });
    if (path === `/zones/${zone}`)
      return ok({
        name: "example.com",
        account: { id: account },
        status: "active",
      });
    if (path === `/zones/${zone}/dns_records`) {
      if (method === "GET")
        return ok(
          dns.filter((record) => record.name === url.searchParams.get("name")),
        );
      const record = { ...body, id: "d".repeat(32) };
      dns.push(record);
      return ok(record);
    }
    const base = `/accounts/${account}`;
    if (path === base + "/access/apps") {
      if (method === "GET")
        return ok(apps, { result_info: { total_pages: 1 } });
      const app = { ...body, id: uid() };
      apps.push(app);
      return ok(app);
    }
    if (path === base + "/access/service_tokens")
      return ok({
        id: uid(),
        client_id: "access-client",
        client_secret: "access-secret-private",
      });
    if (path === base + "/access/policies") {
      const policy = { ...body, id: uid() };
      policies.push(policy);
      return ok(policy);
    }
    if (path.startsWith(base + "/access/apps/")) {
      const app = apps.find((app) => path.includes(app.id));
      if (!app) throw Error("App not found");
      return ok(path.endsWith("/policies") ? policies : app);
    }
    if (path === base + "/cfd_tunnel")
      return ok(method === "GET" ? [] : { id: uid() });
    if (path.endsWith("/token")) return ok("T".repeat(100));
    if (path.endsWith("/configurations")) return ok(body);
    throw Error("Unexpected request " + path);
  });
});
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const profile = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,?,?)",
    profile,
    "Test",
    now(),
  );
  await saveCloudflareSettings(env, admin, {
    account_id: account,
    zone_id: zone,
    token,
  });
  const spec = {
    profile_id: profile,
    admin_hostname: "hermes.example.com",
    api_hostname: "api-hermes.example.com",
    remote_profile: "wabotia",
    dashboard_token: "dashboard-secret-private",
    profile_key: "profile-secret-private",
    prerequisites_confirmed: true,
  };
  return { profile, spec };
}
async function job() {
  const f = await setup();
  return { ...f, ...(await createCloudflareJob(env, admin, f.spec)) };
}
async function session(role = "admin") {
  const user = uid(),
    cookie = uid();
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)",
    user,
    user + "@example.com",
    "Test",
    "unused",
    role,
    now(),
  );
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)",
    await sha(cookie),
    user,
    now() + 60000,
  );
  return cookie;
}
async function request(
  cookie: string,
  path: string,
  body?: any,
  key = uid(),
  origin = "https://test",
) {
  return SELF.fetch("https://test/api/v1/system" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Cookie: `wabotia=${cookie}`,
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
it("restringe manutenção a administradores e recusa origem cruzada", async () => {
  const op = await session("operator"),
    user = await session();
  expect((await request(op, "")).status).toBe(403);
  expect((await request(op, "/cloudflare/x/connector")).status).toBe(403);
  expect(
    (
      await request(op, "/updates/configure", {
        hook_url: hook,
        build_configured: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        user,
        "/updates/configure",
        { hook_url: hook, build_configured: true },
        uid(),
        "https://attacker.example",
      )
    ).status,
  ).toBe(403);
  await expect(
    saveCloudflareSettings(env, { ...admin, kind: "app" }, {}),
  ).rejects.toMatchObject({ status: 403 });
});
it("mantém idempotência, conflito e sigilo pela API", async () => {
  const user = await session(),
    key = uid(),
    body = { hook_url: hook, build_configured: true };
  expect((await request(user, "/updates/configure", body, key)).status).toBe(
    200,
  );
  const replay = await request(user, "/updates/configure", body, key);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    (
      await request(
        user,
        "/updates/configure",
        { ...body, hook_url: hook + "x" },
        key,
      )
    ).status,
  ).toBe(409);
  const visible = await request(user, "");
  expect(visible.headers.get("Cache-Control")).toBe("no-store");
  expect(await visible.text()).not.toContain(hook);
  expect(
    (
      await one(
        env,
        "SELECT value FROM secrets WHERE id='system:update-config'",
      )
    ).value,
  ).not.toContain("deploy_hooks");
});
it("cifra autorização e chaves, publica só metadados", async () => {
  const f = await job();
  const visible = JSON.stringify([
    await cloudflareSettings(env),
    await cloudflareJobs(env),
  ]);
  for (const value of [token, f.spec.dashboard_token, f.spec.profile_key]) {
    expect(visible).not.toContain(value);
    expect(
      JSON.stringify(await all(env, "SELECT value FROM secrets")),
    ).not.toContain(value);
  }
  await expect(connectorDownload(env, admin, f.id)).rejects.toMatchObject({
    status: 400,
  });
});
it("valida domínio, perfil, portas e não cria dois jobs no mesmo endereço", async () => {
  const { spec } = await setup();
  for (const change of [
    { admin_hostname: "hermes.attacker.com" },
    { api_hostname: "foo.bar.example.com" },
    { remote_profile: "../default" },
    { api_port: 9119 },
    { prerequisites_confirmed: false },
    { profile_id: "missing" },
  ])
    await expect(
      createCloudflareJob(env, admin, { ...spec, ...change }),
    ).rejects.toMatchObject({ status: 400 });
  await createCloudflareJob(env, admin, spec);
  await expect(createCloudflareJob(env, admin, spec)).rejects.toMatchObject({
    status: 400,
  });
});
it.each(["dns", "access"])(
  "preserva %s existente e impede criação remota",
  async (kind) => {
    const f = await job();
    if (kind === "dns")
      dns.push({
        name: f.spec.admin_hostname,
        content: "existing.example.com",
      });
    else apps.push({ id: uid(), domain: "*.example.com" });
    await processCloudflareJob(env);
    expect(
      (await one(env, "SELECT status FROM cloudflare_jobs WHERE id=?", f.id))
        .status,
    ).toBe("failed");
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  },
);
it("conclui Access antes de DNS, restringe rotas e cadastra conexão pausada", async () => {
  const f = await job();
  for (let i = 0; i < 12; i++) await processCloudflareJob(env);
  const [done] = await cloudflareJobs(env);
  expect(done.status).toBe("ready");
  expect(done.step).toBe(12);
  const firstDns = calls.findIndex(
    (call) => call.path.endsWith("dns_records") && call.method === "POST",
  );
  expect(
    calls
      .slice(0, firstDns)
      .filter(
        (call) =>
          call.path.includes("/access/apps/") &&
          call.path.endsWith("/policies"),
      ),
  ).toHaveLength(4);
  const ingress = calls.find((call) => call.path.endsWith("/configurations"))!
    .body.config.ingress;
  expect(ingress).toEqual([
    {
      hostname: f.spec.admin_hostname,
      path: "^/api/profiles$",
      service: "http://127.0.0.1:9119",
      originRequest: { httpHostHeader: "127.0.0.1:9119" },
    },
    {
      hostname: f.spec.api_hostname,
      path: "^/p/wabotia/v1/.*$",
      service: "http://127.0.0.1:8642",
    },
    { service: "http_status:404" },
  ]);
  expect(policies[0]).toMatchObject({
    decision: "non_identity",
    include: [{ service_token: { token_id: done.resources.service_token } }],
  });
  const connection = await one(
    env,
    "SELECT * FROM connections WHERE id=?",
    done.connection_id,
  );
  expect(connection.status).toBe("paused");
  expect(await secret(env, `connection:${connection.id}`)).toMatchObject({
    profile_keys: { wabotia: f.spec.profile_key },
    access_client_secret: "access-secret-private",
  });
  expect((await connectorDownload(env, admin, f.id)).token).toBe(
    "T".repeat(100),
  );
  const count = calls.length;
  await processCloudflareJob(env);
  expect(calls).toHaveLength(count);
});
it("impede DNS se a política Access foi ampliada durante o deploy", async () => {
  const f = await job();
  for (let i = 0; i < 5; i++) await processCloudflareJob(env);
  policies.push({ id: uid(), decision: "bypass", include: [{ everyone: {} }] });
  await processCloudflareJob(env);
  expect(
    (await one(env, "SELECT status FROM cloudflare_jobs WHERE id=?", f.id))
      .status,
  ).toBe("failed");
  expect(dns).toHaveLength(0);
});
it.each(["timeout", "incomplete"])(
  "não repete criação com resposta %s",
  async (scenario) => {
    const f = await job();
    await processCloudflareJob(env);
    if (scenario === "timeout")
      fault = `/accounts/${account}/access/service_tokens`;
    else special = `/accounts/${account}/access/service_tokens`;
    await processCloudflareJob(env);
    expect(
      (await one(env, "SELECT status FROM cloudflare_jobs WHERE id=?", f.id))
        .status,
    ).toBe("unknown");
    await expect(retryCloudflareJob(env, admin, f.id)).rejects.toMatchObject({
      status: 400,
    });
    const count = calls.length;
    await processCloudflareJob(env);
    expect(calls).toHaveLength(count);
  },
);
it("reconhece interrupção persistida e retoma só falha confirmada com token atual", async () => {
  const f = await job();
  await exec(
    env,
    "UPDATE cloudflare_jobs SET status='running',updated=? WHERE id=?",
    now() - 70000,
    f.id,
  );
  await processCloudflareJob(env);
  expect(
    (await one(env, "SELECT status FROM cloudflare_jobs WHERE id=?", f.id))
      .status,
  ).toBe("unknown");
  await exec(
    env,
    "UPDATE cloudflare_jobs SET status='failed' WHERE id=?",
    f.id,
  );
  await setSecret(env, "cloudflare:config", {
    account_id: account,
    zone_id: zone,
    token: "renewed-token-private",
    domain: "example.com",
  });
  await retryCloudflareJob(env, admin, f.id);
  await processCloudflareJob(env);
  expect(calls.at(-1)?.auth).toBe("Bearer renewed-token-private");
});
it.each([302, 500, 200])(
  "trata resposta de mutação HTTP %s não confirmada como ambígua",
  async (status) => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { success: false, errors: [{ code: 123, message: token }] },
        { status },
      ),
    );
    await expect(
      cloudflareRequest(token, `/accounts/${account}/access/apps`, "POST", {}),
    ).rejects.toMatchObject({ ambiguous: true });
  },
);
it("recusa URLs arbitrárias para hooks e requisições Cloudflare", async () => {
  for (const value of [
    "https://evil.example/hook",
    hook + "?redirect=evil",
    hook.replace("https:", "http:"),
    "https://user:secret@api.cloudflare.com/client/v4/workers/builds/deploy_hooks/01234567890123456789",
  ])
    expect(() => deployHookUrl(value)).toThrow();
  await expect(
    cloudflareRequest(token, "https://evil.example"),
  ).rejects.toMatchObject({ status: 400 });
  expect(calls).toHaveLength(0);
});
it("fixa commit oficial antes do hook, deduplica e só confirma o código instalado", async () => {
  await configureUpdates(env, admin, {
    hook_url: hook,
    build_configured: true,
  });
  await checkUpdate(env);
  const first = await startUpdate(env, admin, { commit: target });
  expect(first.status).toBe("requested");
  expect((await updatePlan(env)).commit).toBe(target);
  expect((await startUpdate(env, admin, { commit: target })).id).toBe(first.id);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect((await updateStatus(env)).state.status).toBe("requested");
  await setSecret(env, "system:update-state", {
    ...first,
    target: buildInfo.commit,
  });
  expect((await updateStatus(env)).state.status).toBe("completed");
});
it("recusa redirecionamento do repositório sem registrar uma versão", async () => {
  const redirectedFetch = vi.fn(async (input: any, init: any) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe("manual");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://other.example/repository" },
    });
  });
  vi.stubGlobal("fetch", redirectedFetch);
  await expect(checkUpdate(env)).rejects.toMatchObject({
    status: 502,
    code: "update_check_failed",
  });
  expect(redirectedFetch).toHaveBeenCalledTimes(1);
  expect((await updateStatus(env)).latest).toBeNull();
});
it("não repete hook ambíguo e exige revisão antes de liberar outra tentativa", async () => {
  await configureUpdates(env, admin, {
    hook_url: hook,
    build_configured: true,
  });
  fault = new URL(hook).pathname.replace("/client/v4", "");
  const first = await startUpdate(env, admin, { commit: target });
  expect(first.status).toBe("unknown");
  await startUpdate(env, admin, { commit: target });
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  await expect(
    resetUpdate(env, admin, { confirmed_build_stopped: true }),
  ).rejects.toMatchObject({ status: 400 });
  await setSecret(env, "system:update-state", {
    ...first,
    created: now() - 1000000,
  });
  await expect(resetUpdate(env, admin, {})).rejects.toMatchObject({
    status: 400,
  });
  expect(
    (await resetUpdate(env, admin, { confirmed_build_stopped: true })).status,
  ).toBe("cancelled");
  expect((await updatePlan(env)).commit).toBe(buildInfo.commit);
});
