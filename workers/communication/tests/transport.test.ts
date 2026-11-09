import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { one, all, exec } from "../src/db";
import { now, uid, defaults, type Actor } from "../src/types";
import { inbound, conversation, enqueue, perform } from "../src/service";
import { transport } from "../src/transport";
import { approvedTemplate } from "../src/integrations";
const admin: Actor = {
  id: "admin",
  kind: "user",
  role: "admin",
  name: "Admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 10,
};
async function seed() {
  const p = uid(),
    conn = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    p,
    "Teste",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'qr','direct','active','{}',?)",
    conn,
    p,
    "QR",
    now(),
  );
  const result = await inbound(
    env,
    p,
    { external_id: "1", message_id: "1", text: "oi" },
    "channel:" + conn,
    conn,
  );
  return { p, conn, c: await conversation(env, result.conversation_id, p) };
}
it("conector só obtém uma entrega e não captura mensagens internas", async () => {
  const f = await seed();
  const a = await enqueue(
    env,
    f.c,
    "system",
    "text",
    { text: "primeira" },
    uid(),
  );
  await enqueue(env, f.c, "system", "text", { text: "segunda" }, uid());
  await enqueue(env, f.c, "system", "team", { text: "nota da equipe" }, uid());
  const r: any = await transport(env, f.conn, "commands", {});
  expect(r.commands).toHaveLength(1);
  expect(r.commands[0].id).toBe(a);
  expect(
    ((await transport(env, f.conn, "commands", {})) as any).commands,
  ).toHaveLength(0);
  await transport(env, f.conn, "receipt", {
    id: a,
    status: "sent",
    external_id: "provider1",
  });
  await transport(env, f.conn, "receipt", {
    id: a,
    status: "sent",
    external_id: "provider1",
  });
  expect(
    await all(env, "SELECT * FROM messages WHERE external_id='provider1'"),
  ).toHaveLength(1);
  expect(
    ((await transport(env, f.conn, "commands", {})) as any).commands,
  ).toHaveLength(1);
});
it("reanálise antes do envio impede bot obsoleto", async () => {
  const f = await seed();
  const a = await enqueue(
    env,
    f.c,
    "bot:attendant",
    "text",
    { text: "antiga" },
    uid(),
  );
  await transport(env, f.conn, "commands", {});
  await perform(
    env,
    admin,
    f.p,
    "conversation.action",
    { id: f.c.id, action: "claim" },
    uid(),
  );
  expect(
    ((await transport(env, f.conn, "check", { id: a })) as any).valid,
  ).toBe(false);
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", a)).status,
  ).toBe("cancelled");
});
it("múltiplos anexos possuem entregas separadas e deduplicadas", async () => {
  const f = await seed(),
    dedupe = uid();
  await enqueue(
    env,
    f.c,
    "admin",
    "text",
    { text: "Arquivos", attachments: ["a", "b"] },
    dedupe,
  );
  await enqueue(
    env,
    f.c,
    "admin",
    "text",
    { text: "Arquivos", attachments: ["a", "b"] },
    dedupe,
  );
  expect(
    await all(env, "SELECT * FROM outbox WHERE profile_id=?", f.p),
  ).toHaveLength(3);
});
it("exige formato de template validado", () => {
  const valid = {
    status: "APPROVED",
    category: "UTILITY",
    components: [{ type: "BODY", text: "Protocolo {{1}}: {{2}}" }],
  };
  expect(approvedTemplate(valid)).toBe(true);
  expect(approvedTemplate({ ...valid, status: "PENDING" })).toBe(false);
  expect(
    approvedTemplate({
      ...valid,
      components: [{ type: "BODY", text: "Oferta {{1}}" }],
    }),
  ).toBe(false);
});
