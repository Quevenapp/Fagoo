const BASE = "/v1/system/wabotia";
export const wabotiaRoute = (path) =>
  path === BASE || path.startsWith(BASE + "/");
export function wabotiaOrigin(value) {
  const u = new URL(String(value));
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    !u.hostname.includes(".") ||
    /^[\d.]+$/.test(u.hostname) ||
    u.hostname.includes(":") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)
  )
    throw new Error("invalid_origin");
  return u.origin;
}
async function cryptKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("fagoo/wabotia/v1/" + secret),
    ),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
async function seal(secret, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await cryptKey(secret),
      new TextEncoder().encode(JSON.stringify(value)),
    );
  return (
    btoa(String.fromCharCode(...iv)) +
    "." +
    btoa(String.fromCharCode(...new Uint8Array(cipher)))
  );
}
async function open(secret, value) {
  if (!value) return null;
  const [iv, cipher] = value.split(".");
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(atob(iv), (c) => c.charCodeAt(0)),
        },
        await cryptKey(secret),
        Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0)),
      ),
    ),
  );
}
const snapshot = (v) =>
  !v
    ? { status: "disconnected" }
    : v.token
      ? {
          status: "connected",
          url: v.url,
          name: v.name,
          profile_id: v.profile,
          application_id: v.app,
        }
      : {
          status: v.expires <= Date.now() ? "expired" : "authorization_pending",
          url: v.url,
          name: v.name,
          user_code: v.code,
          verification_uri: v.url + "/app?pair=1",
          expires: v.expires,
          interval: 5,
        };
async function read(response, max = 32768) {
  if (Number(response.headers.get("content-length")) > max || !response.body)
    throw new Error("invalid_response");
  const reader = response.body.getReader();
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error("invalid_response");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
  }
}
async function remote(fetchImpl, url, path, body, token, extraHeaders = {}) {
  const response = await fetchImpl(url + path, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(12000),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error("redirect_rejected");
  return { response, value: await read(response) };
}
export async function handleWabotia({
  request,
  settings,
  authenticate,
  fetchImpl = fetch,
}) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  const respond = (status, value) =>
    new Response(status === 204 ? null : JSON.stringify(value), {
      status,
      headers,
    });
  let lock;
  const rpc = async (action, cipher) => {
    const { response, value } = await remote(
      fetchImpl,
      settings.baseUrl,
      "/rest/v1/rpc/erp_wabotia_state",
      { p_action: action, p_lock: lock ?? null, p_cipher: cipher ?? null },
      settings.key,
      { apikey: settings.key },
    );
    if (!response.ok) throw new Error("storage_unavailable");
    return value;
  };
  try {
    const u = new URL(request.url),
      origin = request.headers.get("Origin"),
      action =
        u.pathname === BASE ? "status" : u.pathname.slice(BASE.length + 1);
    if (
      !["status", "start", "poll", "disconnect", "forget"].includes(action) ||
      u.search
    )
      return respond(404, { error: { code: "ERP_NOT_FOUND" } });
    const method = action === "status" ? "GET" : "POST";
    if (origin) {
      if (!settings.origins.includes(origin))
        return respond(403, { error: { code: "ERP_ORIGIN_NOT_ALLOWED" } });
      headers.set("Access-Control-Allow-Origin", origin);
    }
    if (request.method === "OPTIONS") {
      if (
        !origin ||
        request.headers.get("Access-Control-Request-Method") !== method ||
        (request.headers.get("Access-Control-Request-Headers") || "")
          .toLowerCase()
          .split(",")
          .filter(Boolean)
          .some((v) => !["authorization", "content-type"].includes(v.trim()))
      )
        return respond(403, { error: { code: "ERP_PREFLIGHT_DENIED" } });
      headers.set("Access-Control-Allow-Methods", method);
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      return respond(204, null);
    }
    if (request.method !== method)
      return respond(405, { error: { code: "ERP_METHOD_NOT_ALLOWED" } });
    const token = /^Bearer ([^\s]+)$/i.exec(
      request.headers.get("Authorization") || "",
    )?.[1];
    if (!token || token.length > 8192)
      return respond(401, { error: { code: "ERP_UNAUTHENTICATED" } });
    await authenticate(token); // Existing user session, membership and admin checks.
    if (action === "status") {
      const cipher = (await rpc("read")).cipher;
      try {
        return respond(200, snapshot(await open(settings.key, cipher)));
      } catch {
        return respond(200, { status: "recovery_required" });
      }
    }
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      return respond(400, { error: { code: "ERP_INVALID_INPUT" } });
    const body = await read(request, 2048);
    lock = crypto.randomUUID();
    const reserved = await rpc("reserve");
    if (!reserved.acquired)
      return respond(409, { error: { code: "ERP_WABOTIA_BUSY" } });
    if (action === "forget") {
      if (body.confirmed !== true)
        return respond(400, {
          error: { code: "ERP_WABOTIA_CONFIRMATION_REQUIRED" },
        });
      await rpc("save", "");
      return respond(200, {
        status: "disconnected",
        remote_revocation_required: true,
      });
    }
    let state = await open(settings.key, reserved.cipher);
    if (action === "start") {
      if (state?.token || (state?.device && state.expires > Date.now()))
        return respond(409, { error: { code: "ERP_WABOTIA_ALREADY_STARTED" } });
      const url = wabotiaOrigin(body.url),
        name = String(body.name ?? "").trim();
      if (!name || name.length > 80) throw new Error("invalid_name");
      const { response, value } = await remote(
        fetchImpl,
        url,
        "/api/pairing/start",
        { client: "fagoo", instance_name: name },
      );
      if (
        !response.ok ||
        !/^[a-f0-9]{64}$/.test(value.device_code) ||
        !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value.user_code)
      )
        throw new Error("start_failed");
      state = {
        url,
        name,
        device: value.device_code,
        code: value.user_code,
        expires:
          Date.now() + Math.min(600, Number(value.expires_in) || 600) * 1000,
        next: Date.now() + 5000,
      };
    } else if (action === "poll") {
      if (!state?.device || state.expires <= Date.now())
        return respond(409, { error: { code: "ERP_WABOTIA_EXPIRED" } });
      if (state.next > Date.now())
        return respond(429, { error: { code: "ERP_WABOTIA_WAIT" } });
      state.next = Date.now() + 5000;
      await rpc("save", await seal(settings.key, state));
      const { response, value } = await remote(
        fetchImpl,
        state.url,
        "/api/pairing/token",
        { client: "fagoo", device_code: state.device },
      );
      if (!response.ok) {
        if ([400, 403].includes(response.status)) state.expires = 0;
        else throw new Error("poll_failed");
      } else if (value.status === "connected") {
        if (
          typeof value.access_token !== "string" ||
          !value.access_token.startsWith("wab_") ||
          typeof value.profile_id !== "string" ||
          !Array.isArray(value.scopes)
        )
          throw new Error("invalid_credential");
        state = {
          url: state.url,
          name: state.name,
          token: value.access_token,
          profile: value.profile_id,
          app: value.application_id,
          scopes: value.scopes,
          numbers: value.number_ids,
          pools: value.pool_ids,
          bots: value.bot_ids,
        };
      }
    } else {
      if (state?.token) {
        const { response } = await remote(
          fetchImpl,
          state.url,
          "/api/v1/pairings/disconnect",
          {},
          state.token,
        );
        if (!response.ok && response.status !== 401)
          throw new Error("disconnect_failed");
      }
      state = null;
    }
    await rpc("save", state ? await seal(settings.key, state) : "");
    return respond(200, snapshot(state));
  } catch (error) {
    const status =
      error?.status === 401 ? 401 : error?.status === 403 ? 403 : 503;
    return respond(status, {
      error: {
        code:
          status === 403
            ? "ERP_FORBIDDEN"
            : status === 401
              ? "ERP_UNAUTHENTICATED"
              : "ERP_WABOTIA_UNAVAILABLE",
      },
    });
  } finally {
    if (lock) await rpc("release").catch(() => {});
  }
}
