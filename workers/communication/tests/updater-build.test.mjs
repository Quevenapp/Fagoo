import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { manualCommit, preserveDeployment } from "../wabotia-build.mjs";
const next = parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
test("recuperação manual exige SHA completo e opção explícita", () => {
  assert.equal(manualCommit([]), null);
  const commit = "a".repeat(40);
  assert.equal(manualCommit(["--commit", commit]), commit);
  for (const args of [
    ["main"],
    ["--commit", "main"],
    ["--commit", "a".repeat(7)],
    ["--commit", commit, "extra"],
  ])
    assert.throws(() => manualCommit(args));
});
function installed() {
  return {
    ...structuredClone(next),
    name: "wabotia-existing",
    account_id: "a".repeat(32),
    d1_databases: [
      {
        binding: "DB",
        database_id: "private-database",
        database_name: "existing-db",
      },
    ],
    r2_buckets: [{ binding: "MEDIA", bucket_name: "existing-bucket" }],
    routes: [{ pattern: "app.example.com", custom_domain: true }],
    vars: { APP_NAME: "Existing", CUSTOM: "kept" },
    env: { staging: { name: "test" } },
  };
}
test("preserva recursos, domínio, ambiente e variáveis da instalação", () => {
  const current = installed(),
    result = preserveDeployment(current, next);
  for (const field of [
    "name",
    "account_id",
    "d1_databases",
    "r2_buckets",
    "routes",
    "vars",
    "env",
    "durable_objects",
  ])
    assert.deepEqual(result[field], current[field]);
  assert.equal(result.main, next.main);
  assert.equal(
    preserveDeployment(
      {
        ...current,
        migrations: [{ new_sqlite_classes: ["Coordinator"], tag: "v1" }],
      },
      next,
    ).migrations.length,
    1,
  );
});
test("recusa recursos novos ou alterações incompatíveis antes de publicar", () => {
  for (const change of [
    { kv_namespaces: [{ binding: "NEW", id: "other" }] },
    {
      d1_databases: [
        ...next.d1_databases,
        { binding: "NEW", database_name: "new" },
      ],
    },
    {
      durable_objects: {
        bindings: [{ name: "COORDINATOR", class_name: "Other" }],
      },
    },
    { queues: { producers: [{ binding: "NEW", queue: "new" }] } },
    { migrations: [{ tag: "v1", deleted_classes: ["Coordinator"] }] },
  ])
    assert.throws(() =>
      preserveDeployment(installed(), { ...next, ...change }),
    );
  assert.throws(() =>
    preserveDeployment({ ...installed(), durable_objects: undefined }, next),
  );
});
