// Shared by the Worker updater and the standalone installer. No customer credentials
// are sent to the release origin; only Cloudflare receives the API token.
import { Buffer } from "node:buffer";

export const RELEASE_ORIGIN = "https://wabotia.queven.app";
export const MAX_PACKAGE = 20 * 1024 * 1024;
export interface ReleaseIndex {
  format: 1;
  version: string;
  commit: string;
  package_sha256: string;
  package_size: number;
}
export interface ReleaseFile {
  name: string;
  type: string;
  data: string;
  sha256: string;
}
export interface ReleasePackage {
  format: 1;
  version: string;
  commit: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  assets_config: Record<string, unknown>;
  durable_migrations: { tag: string; new_sqlite_classes?: string[] }[];
  modules: ReleaseFile[];
  assets: ReleaseFile[];
  migrations: { name: string; statements: string[] }[];
}
export function assertRelease(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export async function digest(value: Uint8Array | string) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  ).toString("hex");
}
export function validateIndex(value: any): ReleaseIndex {
  assertRelease(
    value?.format === 1 &&
      /^\d+\.\d+\.\d+$/.test(value.version) &&
      /^[a-f0-9]{40}$/.test(value.commit) &&
      /^[a-f0-9]{64}$/.test(value.package_sha256) &&
      Number.isSafeInteger(value.package_size) &&
      value.package_size > 0 &&
      value.package_size <= MAX_PACKAGE,
    "A versão oficial não contém um pacote de publicação válido.",
  );
  return {
    format: 1,
    version: value.version,
    commit: value.commit,
    package_sha256: value.package_sha256,
    package_size: value.package_size,
  };
}
export async function limitedBody(response: Response, limit: number) {
  assertRelease(
    response.ok && response.body,
    `Não foi possível baixar a versão oficial (HTTP ${response.status}).`,
  );
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assertRelease(
        size <= limit,
        "O pacote oficial excedeu o tamanho permitido.",
      );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export async function latestRelease(): Promise<ReleaseIndex> {
  const r = await fetch(`${RELEASE_ORIGIN}/releases/latest.json`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  return validateIndex(
    JSON.parse((await limitedBody(r, 8192)).toString("utf8")),
  );
}
export async function fetchPackage(index: ReleaseIndex) {
  validateIndex(index);
  const r = await fetch(
    `${RELEASE_ORIGIN}/releases/${index.version}/package.json`,
    { redirect: "manual", signal: AbortSignal.timeout(20000) },
  );
  const bytes = await limitedBody(r, MAX_PACKAGE);
  const pkg = await parsePackage(index, bytes);
  return { pkg, bytes };
}
export async function parsePackage(
  index: ReleaseIndex,
  bytes: Uint8Array,
): Promise<ReleasePackage> {
  assertRelease(
    bytes.length === index.package_size &&
      (await digest(bytes)) === index.package_sha256,
    "A integridade do pacote oficial não confere. Nenhuma publicação foi feita.",
  );
  const p = JSON.parse(Buffer.from(bytes).toString("utf8"));
  assertRelease(
    p.format === 1 && p.version === index.version && p.commit === index.commit,
    "O pacote não corresponde à versão escolhida.",
  );
  assertRelease(
    /^\d{4}-\d{2}-\d{2}$/.test(p.compatibility_date) &&
      Array.isArray(p.compatibility_flags) &&
      p.compatibility_flags.every((v: unknown) => typeof v === "string") &&
      Array.isArray(p.modules) &&
      p.modules.length > 0 &&
      p.modules.length < 64 &&
      Array.isArray(p.assets) &&
      p.assets.length > 0 &&
      p.assets.length <= 100 &&
      Array.isArray(p.migrations) &&
      p.migrations.length <= 100,
    "Estrutura do pacote oficial inválida.",
  );
  const seen = new Set<string>();
  for (const [group, files] of [
    ["module", p.modules],
    ["asset", p.assets],
  ] as const) {
    for (const f of files) {
      assertRelease(
        typeof f.name === "string" &&
          (group === "asset"
            ? /^\/[a-zA-Z0-9_./-]+$/
            : /^[a-zA-Z0-9_./-]+$/
          ).test(f.name) &&
          !f.name.split("/").includes("..") &&
          !seen.has(group + f.name) &&
          typeof f.data === "string" &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(f.data) &&
          typeof f.type === "string" &&
          f.type.length < 120,
        "Arquivo inválido no pacote oficial.",
      );
      seen.add(group + f.name);
      const raw = Buffer.from(f.data, "base64");
      assertRelease(
        raw.toString("base64") === f.data && (await digest(raw)) === f.sha256,
        "Arquivo corrompido no pacote oficial.",
      );
    }
  }
  assertRelease(
    p.modules.some(
      (f: ReleaseFile) =>
        f.name === p.main_module && f.type === "application/javascript+module",
    ),
    "Módulo principal inválido.",
  );
  assertRelease(
    JSON.stringify(p.durable_migrations) ===
      JSON.stringify([{ tag: "v1", new_sqlite_classes: ["Coordinator"] }]),
    "Esta versão altera Durable Objects e exige atualização manual.",
  );
  for (const m of p.migrations) {
    assertRelease(
      /^\d{4}_[a-z0-9_]+\.sql$/.test(m.name) &&
        !seen.has(m.name) &&
        Array.isArray(m.statements) &&
        m.statements.length > 0 &&
        m.statements.length <= 100 &&
        m.statements.every(
          (s: unknown) => typeof s === "string" && s.length < 100000,
        ),
      "Migração inválida no pacote oficial.",
    );
    seen.add(m.name);
  }
  assertRelease(
    p.assets_config?.not_found_handling === "single-page-application" &&
      JSON.stringify(p.assets_config?.run_worker_first) ===
        JSON.stringify(["/api/*", "/webhooks/*", "/internal/*"]),
    "Configuração de arquivos incompatível.",
  );
  return p;
}

export class CloudflareCallError extends Error {
  constructor(
    message: string,
    public ambiguous: boolean,
  ) {
    super(message);
  }
}
export async function releaseCloudflare(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  assertRelease(
    /^\/accounts\/[a-f0-9]{32}\/workers\//.test(path),
    "Destino Cloudflare inválido.",
  );
  const multipart = body instanceof FormData;
  let r: Response;
  try {
    r = await fetch("https://api.cloudflare.com/client/v4" + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(!multipart && body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body:
        body === undefined
          ? undefined
          : multipart
            ? (body as FormData)
            : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new CloudflareCallError(
      "A Cloudflare não confirmou a operação. Confira o andamento antes de repetir.",
      method !== "GET",
    );
  }
  let data: any;
  try {
    data = await r.json();
  } catch {
    throw new CloudflareCallError(
      "Resposta inesperada da Cloudflare. Confira o andamento antes de repetir.",
      method !== "GET",
    );
  }
  if (!r.ok || data.success !== true)
    throw new CloudflareCallError(
      `Cloudflare HTTP ${r.status}. Confira a conta e a permissão Workers Scripts: Edit do token.`,
      method !== "GET" && !(r.status >= 400 && r.status < 500),
    );
  return data.result;
}
export function scriptPath(account: string, worker: string) {
  assertRelease(
    /^[a-f0-9]{32}$/.test(account) && /^[a-z][a-z0-9-]{2,45}$/.test(worker),
    "Identificação da instalação inválida.",
  );
  return `/accounts/${account}/workers/scripts/${worker}`;
}
export async function installedSettings(token: string, base: string) {
  const [settings, service] = await Promise.all([
    releaseCloudflare(token, base + "/settings"),
    releaseCloudflare(
      token,
      base.replace("/workers/scripts/", "/workers/services/"),
    ),
  ]);
  // /settings omits the migration tag. Wrangler reads it from service metadata.
  return {
    ...settings,
    migration_tag: service?.default_environment?.script?.migration_tag,
  };
}
export function validateInstalledSettings(
  settings: any,
  installationId: string,
) {
  const bindings = settings?.bindings;
  assertRelease(
    Array.isArray(bindings) &&
      installationId &&
      bindings.some(
        (b: any) =>
          b.name === "WABOTIA_INSTALLATION_ID" &&
          b.type === "plain_text" &&
          b.text === installationId,
      ),
    "O Worker indicado não corresponde a esta instalação.",
  );
  for (const [name, type] of [
    ["DB", "d1"],
    ["MEDIA", "r2_bucket"],
    ["COORDINATOR", "durable_object_namespace"],
    ["ASSETS", "assets"],
    ["MASTER_KEY", "secret_text"],
  ])
    assertRelease(
      bindings.some((b: any) => b.name === name && b.type === type),
      `A ligação ${name} não está configurada corretamente.`,
    );
  const coordinator = bindings.find((b: any) => b.name === "COORDINATOR");
  assertRelease(
    coordinator.class_name === "Coordinator" && !coordinator.script_name,
    "Durable Object externo exige atualização manual.",
  );
  assertRelease(
    settings.migration_tag === "v1",
    "A migração Durable Object exige revisão manual.",
  );
  return settings;
}
export function assetManifest(pkg: ReleasePackage) {
  return Object.fromEntries(
    pkg.assets.map((f) => [
      f.name,
      {
        hash: f.sha256.slice(0, 32),
        size: Buffer.from(f.data, "base64").length,
      },
    ]),
  );
}
export function assetUpload(pkg: ReleasePackage, hashes: string[]) {
  const body = new FormData();
  assertRelease(
    Array.isArray(hashes) && hashes.length <= 100,
    "Lote de arquivos inválido.",
  );
  for (const hash of hashes) {
    const f = pkg.assets.find((file) => file.sha256.slice(0, 32) === hash);
    assertRelease(
      f,
      "A Cloudflare solicitou um arquivo fora da versão escolhida.",
    );
    body.set(hash, new Blob([f.data], { type: f.type }), hash);
  }
  return body;
}
export function workerUpload(
  pkg: ReleasePackage,
  settings: any,
  completionToken: string,
) {
  const metadata: Record<string, unknown> = {
    main_module: pkg.main_module,
    compatibility_date: pkg.compatibility_date,
    compatibility_flags: pkg.compatibility_flags,
    bindings: [{ type: "assets", name: "ASSETS" }],
    keep_bindings: [
      ...new Set(
        settings.bindings
          .map((b: any) => b.type)
          .filter((t: string) => t !== "assets"),
      ),
    ],
    assets: { jwt: completionToken, config: pkg.assets_config },
    annotations: {
      "workers/message": `Wabotia ${pkg.version} · ${pkg.commit.slice(0, 12)}`,
    },
  };
  for (const key of [
    "observability",
    "limits",
    "logpush",
    "placement",
    "tail_consumers",
    "streaming_tail_consumers",
    "tags",
  ])
    if (settings[key] !== undefined) metadata[key] = settings[key];
  const body = new FormData();
  body.set(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  for (const f of pkg.modules)
    body.set(
      f.name,
      new Blob([Buffer.from(f.data, "base64")], { type: f.type }),
      f.name,
    );
  return body;
}
