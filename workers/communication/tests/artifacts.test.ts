import { env } from "cloudflare:test";
import { it, expect, vi, afterEach } from "vitest";
import { hermesArtifact } from "../src/integrations";
import { setSecret } from "../src/security";
import { exec, one } from "../src/db";
import { uid, now } from "../src/types";
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const connection = {
    id: uid(),
    profile_id: uid(),
    config: JSON.stringify({ api_url: "https://hermes.example.com" }),
  };
  await setSecret(env, `connection:${connection.id}`, {
    profile_keys: { default: "test-only-key" },
  });
  return connection;
}
it("guarda o artefato privado e repete sem consumir outro download", async () => {
  const c = await fixture(),
    fetcher = vi.fn(
      async () =>
        new Response("documento", {
          headers: { "Content-Type": "text/plain" },
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const id = await hermesArtifact(
    env,
    c,
    "default",
    "artifact-12345",
    "resultado.txt",
    "app:a",
  );
  expect(
    await hermesArtifact(
      env,
      c,
      "default",
      "artifact-12345",
      "resultado.txt",
      "app:a",
    ),
  ).toBe(id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await one(env, "SELECT actor FROM media WHERE id=?", id)).actor).toBe(
    "app:a",
  );
  await expect(
    hermesArtifact(
      env,
      c,
      "default",
      "artifact-12345",
      "resultado.txt",
      "app:b",
    ),
  ).rejects.toThrow("outra identidade");
});
it("recupera a escrita R2 interrompida antes do registro D1", async () => {
  const c = await fixture(),
    id = uid(),
    fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await exec(
    env,
    "INSERT INTO artifact_imports(connection_id,remote_profile,artifact_id,media_id,actor,name,created) VALUES(?,?,?,?,?,?,?)",
    c.id,
    "default",
    "artifact-56789",
    id,
    "app:a",
    "resultado.txt",
    now(),
  );
  await env.MEDIA.put(`${c.profile_id}/${id}`, "arquivo", {
    httpMetadata: { contentType: "text/plain" },
  });
  expect(
    await hermesArtifact(
      env,
      c,
      "default",
      "artifact-56789",
      "resultado.txt",
      "app:a",
    ),
  ).toBe(id);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await one(env, "SELECT size FROM media WHERE id=?", id)).size).toBe(
    7,
  );
});
it("download ambíguo não é repetido automaticamente", async () => {
  const c = await fixture(),
    fetcher = vi.fn(async () => {
      throw Error("interrompido");
    });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    hermesArtifact(
      env,
      c,
      "default",
      "artifact-98765",
      "resultado.txt",
      "app:a",
    ),
  ).rejects.toThrow();
  await expect(
    hermesArtifact(
      env,
      c,
      "default",
      "artifact-98765",
      "resultado.txt",
      "app:a",
    ),
  ).rejects.toThrow("uso único");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
