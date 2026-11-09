import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "wabotia-router-examples-")),
  requests = [];
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer fictitious-example-key");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST") {
    assert.equal(req.url, "/api/v1/profiles/example/router/messages");
    assert.equal(req.headers["idempotency-key"], "example-intent");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(202);
    res.end(
      JSON.stringify({ delivery_id: "delivery-example", status: "pending" }),
    );
  } else {
    assert.equal(
      req.url,
      "/api/v1/profiles/example/router/messages/delivery-example",
    );
    res.end(
      JSON.stringify({
        id: "delivery-example",
        status: "sent",
        provider_status: "delivered",
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  WABOTIA_URL: `http://127.0.0.1:${server.address().port}`,
  WABOTIA_KEY: "fictitious-example-key",
  WABOTIA_PROFILE: "example",
  WABOTIA_REQUEST_ID: "example-intent",
};
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
try {
  const service = {
    pool_id: "pool-example",
    to: "5511999991111",
    external_id: "cliente-123",
    text: "Olá",
  };
  const paid = {
    ...service,
    text: undefined,
    allow_paid: true,
    consent: {
      granted: true,
      category: "utility",
      reference: "Teste fictício",
    },
    template: { name: "pedido_atualizado", language: "pt_BR" },
  };
  await writeFile(join(dir, "service.json"), JSON.stringify(service));
  await writeFile(join(dir, "paid.json"), JSON.stringify(paid));
  for (const [command, script] of [
    [process.execPath, "examples/router-message.mjs"],
    ["python3", "examples/router-message.py"],
  ]) {
    const a = await run(command, [script, join(dir, "service.json")]);
    assert.equal(a.code, 0, a.output);
    assert.match(a.output, /delivered/);
    const blocked = await run(command, [script, join(dir, "paid.json")]);
    assert.notEqual(blocked.code, 0);
    const b = await run(command, [
      script,
      join(dir, "paid.json"),
      "--allow-paid",
    ]);
    assert.equal(b.code, 0, b.output);
  }
  const curl = await run("curl", [
    "--fail-with-body",
    "-sS",
    env.WABOTIA_URL + "/api/v1/profiles/example/router/messages",
    "-H",
    "Authorization: Bearer " + env.WABOTIA_KEY,
    "-H",
    "Content-Type: application/json",
    "-H",
    "Idempotency-Key: " + env.WABOTIA_REQUEST_ID,
    "--data-binary",
    "@" + join(dir, "service.json"),
  ]);
  assert.equal(curl.code, 0, curl.output);
  assert.deepEqual(requests, [
    service,
    JSON.parse(JSON.stringify(paid)),
    service,
    JSON.parse(JSON.stringify(paid)),
    service,
  ]);
  console.log(
    "Exemplos cURL, JavaScript e Python: aprovados contra servidor fictício local; nenhum envio real.",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
