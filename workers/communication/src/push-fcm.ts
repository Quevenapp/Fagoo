// Firebase Cloud Messaging (HTTP v1) client shared by the server and the push
// gateway Worker. Keep this module free of project imports (./types, ./db).
export interface PushMessage {
  token: string;
  platform: "android" | "ios";
  title: string;
  body: string;
  data: Record<string, string>;
  priority: "high" | "normal";
  collapse_key?: string;
  channel?: string;
  category?: string;
  time_sensitive?: boolean;
  data_only?: boolean;
}
export interface PushResult {
  token: string;
  status: "ok" | "unregistered" | "error";
  error?: string;
}
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri: string;
}
const enc = new TextEncoder();
const b64url = (input: ArrayBuffer | Uint8Array | string) => {
  const bytes =
    typeof input === "string" ? enc.encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export function fcmMessage(m: PushMessage) {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.data || {}))
    if (v !== undefined && v !== null) data[k] = String(v);
  if (m.platform === "android") {
    // Android recebe mensagem só de dados: o serviço do app monta a notificação (canal, tela cheia
    // para ligações, ações Atender/Recusar) mesmo em segundo plano. Toda mensagem gera um aviso
    // visível, por isso a prioridade alta é permitida pela política do FCM.
    return {
      message: {
        token: m.token,
        data: { title: m.title, body: m.body, ...data },
        android: {
          priority: "high",
          ...(m.collapse_key ? { collapse_key: m.collapse_key } : {}),
        },
      },
    };
  }
  if (m.data_only) return {
    message: {
      token:m.token, data:{title:m.title,body:m.body,...data},
      apns: {
        headers:{'apns-priority':'5','apns-push-type':'background',...(m.collapse_key?{'apns-collapse-id':m.collapse_key}:{})},
        payload:{aps:{'content-available':1}},
      },
    },
  };
  const android: any = {
    priority: m.priority === "high" ? "high" : "normal",
    notification: { sound: "default" },
  };
  if (m.channel) android.notification.channel_id = m.channel;
  if (m.collapse_key) android.notification.tag = m.collapse_key;
  const headers: Record<string, string> = {
    "apns-priority": m.priority === "high" ? "10" : "5",
    "apns-push-type": "alert",
  };
  if (m.collapse_key) headers["apns-collapse-id"] = m.collapse_key;
  const aps: any = {
    sound: "default",
    "interruption-level": m.time_sensitive ? "time-sensitive" : "active",
    "mutable-content": 1,
  };
  if (m.category) aps.category = m.category;
  if (m.collapse_key) aps["thread-id"] = m.collapse_key;
  return {
    message: {
      token: m.token,
      notification: { title: m.title, body: m.body },
      data,
      android,
      apns: { headers, payload: { aps } },
    },
  };
}
function pemToDer(pem: string) {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const tokenCache = new Map<string, { token: string; expires: number }>();
export async function fcmAccessToken(
  sa: ServiceAccount,
  fetchImpl: typeof fetch = fetch,
) {
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expires > Date.now()) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    claims = b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: sa.token_uri,
        iat,
        exp: iat + 3600,
      }),
    );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(`${header}.${claims}`),
  );
  const assertion = `${header}.${claims}.${b64url(signature)}`;
  const response = await fetchImpl(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`FCM OAuth HTTP ${response.status}`);
  const body: any = await response.json();
  if (typeof body?.access_token !== "string")
    throw new Error("FCM OAuth sem access_token");
  const ttl = Number(body.expires_in) || 3600;
  tokenCache.set(sa.client_email, {
    token: body.access_token,
    expires: Date.now() + Math.max(0, ttl - 300) * 1000,
  });
  return body.access_token as string;
}
async function sendOne(
  sa: ServiceAccount,
  accessToken: string,
  m: PushMessage,
  fetchImpl: typeof fetch,
): Promise<PushResult> {
  try {
    const response = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fcmMessage(m)),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (response.ok) return { token: m.token, status: "ok" };
    // A bare 404 also comes back for a wrong project_id or a project without
    // the FCM API enabled, so only the body's errorCode marks a dead token.
    let body: any = null;
    try {
      body = await response.json();
    } catch {}
    const err = body?.error || {};
    const codes: string[] = (err.details || [])
      .map((d: any) => d?.errorCode)
      .filter(Boolean);
    const message = String(err.message || "").toLowerCase();
    if (
      codes.includes("UNREGISTERED") ||
      ((codes.includes("INVALID_ARGUMENT") || err.status === "INVALID_ARGUMENT") &&
        message.includes("registration token"))
    )
      return {
        token: m.token,
        status: "unregistered",
        error: codes[0] || err.status || "INVALID_ARGUMENT",
      };
    return {
      token: m.token,
      status: "error",
      error: `HTTP ${response.status}${err.status ? " " + err.status : ""}`.slice(
        0,
        120,
      ),
    };
  } catch (error) {
    return {
      token: m.token,
      status: "error",
      error: (error instanceof Error ? error.message : "Falha de rede").slice(
        0,
        120,
      ),
    };
  }
}
export async function sendFcm(
  sa: ServiceAccount,
  messages: PushMessage[],
  fetchImpl: typeof fetch = fetch,
  beforeSend?: (message: PushMessage) => Promise<boolean>,
): Promise<PushResult[]> {
  if (!messages.length) return [];
  let accessToken: string;
  try {
    accessToken = await fcmAccessToken(sa, fetchImpl);
  } catch (error) {
    const msg = (
      error instanceof Error ? error.message : "Falha ao autenticar no FCM"
    ).slice(0, 120);
    return messages.map((m) => ({ token: m.token, status: "error", error: msg }));
  }
  const results: PushResult[] = new Array(messages.length);
  let next = 0;
  const worker = async () => {
    while (next < messages.length) {
      const index = next++;
      if (beforeSend) {
        let allowed = false;
        try { allowed = await beforeSend(messages[index]); } catch {}
        if (!allowed) {
          results[index] = {token: messages[index].token, status: "error", error: "push_not_authorized"};
          continue;
        }
      }
      results[index] = await sendOne(sa, accessToken, messages[index], fetchImpl);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(5, messages.length) }, () => worker()),
  );
  return results;
}
