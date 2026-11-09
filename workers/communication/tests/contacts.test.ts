import { env, SELF } from "cloudflare:test";
import { it, expect } from "vitest";
import { exec, one, all } from "../src/db";
import { uid, now, defaults, type Actor } from "../src/types";
import { sha } from "../src/security";
import { inbound } from "../src/service";
import { contactCommand, listContacts } from "../src/contacts";
import { parseContactCsv } from "../src/contact-csv";

async function fixture(
  profile = uid(),
  scopes = [
    "contacts:read",
    "contacts:write",
    "conversations:read",
    "conversations:write",
  ],
) {
  const id = uid(),
    token = "wab_" + uid();
  await exec(
    env,
    "INSERT OR IGNORE INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Agenda teste",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
    id,
    "Agenda",
    JSON.stringify([profile]),
    JSON.stringify(scopes),
    "[]",
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    id,
    await sha(token),
    token.slice(0, 12),
    now() + 600000,
    now(),
  );
  const actor: Actor = {
    id: "app:" + id,
    kind: "app",
    name: "Agenda",
    role: "service",
    profiles: [profile],
    scopes,
    bots: [],
    rate: 300,
    runLimit: 3,
  };
  return { p: profile, token, actor };
}
async function request(
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
  body?: any,
  method = body === undefined ? "GET" : "POST",
  key = uid(),
) {
  return SELF.fetch(`https://test/api/v1/profiles/${f.p}${path}`, {
    method,
    headers: {
      Authorization: "Bearer " + f.token,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const csv =
  'nome;telefone;email;empresa;observacoes\n"João; Silva";"+55 (11) 99999-0000";JOAO@EXAMPLE.COM;Acme;"primeira linha\nsegunda ""linha"""';
it("lê CSV UTF-8, separadores, aspas, campos multilinha e informa a linha com erro", () => {
  const parsed = parseContactCsv(
    "\ufeffsep=;\r\n" + csv + "\r\nMaria;123;email inválido;;",
  );
  expect(parsed.rows[0]).toEqual({
    line: 3,
    values: {
      name: "João; Silva",
      phone: "5511999990000",
      email: "joao@example.com",
      company: "Acme",
      notes: 'primeira linha\nsegunda "linha"',
    },
  });
  expect(parsed.errors[0].line).toBe(5);
  expect(
    parseContactCsv('name,email,other\r\n"Ana, Maria",ana@example.com,x')
      .ignored_columns,
  ).toEqual(["other"]);
  expect(() => parseContactCsv("nome,nome\nAna,Maria")).toThrow("repetidas");
  expect(() => parseContactCsv('nome\n"Ana')).toThrow("aspas");
  expect(() => parseContactCsv("nome\nJo\ufffdo")).toThrow("UTF-8");
  expect(() => parseContactCsv("nome\n" + "x".repeat(1024 * 1024))).toThrow(
    "1 MB",
  );
  expect(() => parseContactCsv("nome\n" + "Ana\n".repeat(501))).toThrow("500");
});
it("prévia não salva; CSV inválido não importa parcialmente", async () => {
  const f = await fixture(),
    data = { csv: "nome;email\nAna;ana@example.com\nBia;inválido" };
  const preview = await request(
    f,
    "/contacts/import/preview",
    data,
    "POST",
    "",
  );
  expect(preview.status).toBe(200);
  expect((await preview.json<any>()).errors).toHaveLength(1);
  expect((await request(f, "/contacts/import", data)).status).toBe(400);
  expect(
    (await one(env, "SELECT count(*) n FROM contacts WHERE profile_id=?", f.p))
      .n,
  ).toBe(0);
});
it("importa até 500 contatos atomicamente e ignora linhas idênticas sem sobrescrever edições", async () => {
  const f = await fixture(),
    content =
      "nome;telefone\n" +
      Array.from({ length: 500 }, (_, i) => `Pessoa ${i};5511999990000`).join(
        "\n",
      );
  expect(
    await (await request(f, "/contacts/import", { csv: content })).json(),
  ).toEqual({ imported: 500, skipped: 0, total: 500 });
  const contact = await one(
    env,
    "SELECT * FROM contacts WHERE profile_id=? LIMIT 1",
    f.p,
  );
  expect(
    (
      await request(
        f,
        "/contacts/" + contact.id,
        { expected_version: 1, name: "Nome corrigido" },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  expect(
    await (await request(f, "/contacts/import", { csv: content })).json(),
  ).toEqual({ imported: 0, skipped: 500, total: 500 });
  expect(
    (await one(env, "SELECT name FROM contacts WHERE id=?", contact.id)).name,
  ).toBe("Nome corrigido");
  const repeat =
    "nome;telefone\nPessoa nova;5511888880000\nPessoa nova;+55 (11) 88888-0000";
  expect(
    await (await request(f, "/contacts/import", { csv: repeat })).json(),
  ).toEqual({ imported: 1, skipped: 1, total: 2 });
});
it("exige idempotência, repete o resultado e rejeita conteúdo ou versão em conflito", async () => {
  const f = await fixture(),
    key = uid(),
    body = { name: "Ana", namespace: "team", created_by: "admin" };
  expect((await request(f, "/contacts", body, "POST", "")).status).toBe(400);
  const response = await request(f, "/contacts", body, "POST", key),
    value = await response.json<any>();
  expect(response.status).toBe(200);
  expect(value.namespace).toBe("app:" + f.actor.id);
  expect(value.created_by).toBe(f.actor.id);
  const replay = await request(f, "/contacts", body, "POST", key);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual(value);
  expect(
    (await request(f, "/contacts", { name: "Outra" }, "POST", key)).status,
  ).toBe(409);
  expect(
    (
      await request(
        f,
        "/contacts/" + value.id,
        { name: "Ana nova", expected_version: 1 },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        f,
        "/contacts/" + value.id,
        { name: "Ana antiga", expected_version: 1 },
        "PATCH",
      )
    ).status,
  ).toBe(409);
});
it("isola contatos entre aplicações, perfis e permissões", async () => {
  const f = await fixture(),
    other = await fixture(f.p),
    anotherProfile = await fixture();
  const contact = await (
    await request(f, "/contacts", { name: "Privado" })
  ).json<any>();
  expect((await request(other, "/contacts/" + contact.id)).status).toBe(404);
  expect(
    (
      await (
        await request(other, "/contacts?namespace=" + contact.namespace)
      ).json<any>()
    ).data,
  ).toEqual([]);
  expect(
    (await request(anotherProfile, "/contacts/" + contact.id)).status,
  ).toBe(404);
  const readOnly = await fixture(f.p, ["contacts:read"]);
  expect(
    (await request(readOnly, "/contacts", { name: "Sem permissão" })).status,
  ).toBe(403);
  expect(
    (await request(readOnly, "/contacts/import/preview", { csv })).status,
  ).toBe(403);
  const noRead = await fixture(f.p, ["conversations:read"]);
  expect((await request(noRead, "/contacts")).status).toBe(403);
  const operator: Actor = {
    ...f.actor,
    kind: "user",
    role: "operator",
    profiles: [f.p],
  };
  expect((await listContacts(env, operator, f.p, {})).data).toHaveLength(1);
  await expect(
    listContacts(env, operator, anotherProfile.p, {}),
  ).rejects.toMatchObject({ status: 404 });
});
it("busca sem acentos, trata curingas como texto e pagina sem repetir", async () => {
  const f = await fixture();
  for (const name of ["João", "Joana", "Cliente 100%_!"])
    await request(f, "/contacts", { name });
  expect(
    (await (await request(f, "/contacts?q=joao")).json<any>()).data[0].name,
  ).toBe("João");
  expect(
    (
      await (
        await request(f, "/contacts?q=" + encodeURIComponent("%_!"))
      ).json<any>()
    ).data,
  ).toHaveLength(1);
  const a = await (await request(f, "/contacts?limit=2")).json<any>();
  const b = await (
    await request(
      f,
      "/contacts?limit=2&cursor=" + encodeURIComponent(a.next_cursor),
    )
  ).json<any>();
  expect(new Set([...a.data, ...b.data].map((c) => c.id)).size).toBe(3);
  expect(b.next_cursor).toBeNull();
  expect((await request(f, "/contacts?cursor=inválido")).status).toBe(400);
});
it("salva contato de conversa, evita duplicação e desvincula sem apagar dados", async () => {
  const f = await fixture();
  const c = await inbound(
    env,
    f.p,
    { external_id: "cliente", message_id: uid(), text: "Olá" },
    "app:" + f.actor.id,
    null,
  );
  const path = `/conversations/${c.conversation_id}/contact`;
  const contact = await (
    await request(f, path, { name: "Ana", phone: "5511999990000" }, "PUT")
  ).json<any>();
  expect(contact.source).toBe("conversation");
  expect((await request(f, path, { name: "Duplicado" }, "PUT")).status).toBe(
    409,
  );
  expect(
    (await request(f, path, { contact_id: contact.id }, "PUT")).status,
  ).toBe(200);
  const detail = await (
    await request(f, "/conversations/" + c.conversation_id)
  ).json<any>();
  expect(detail.contact.id).toBe(contact.id);
  expect(
    (await (await request(f, "/conversations?q=Ana")).json<any>()).data[0]
      .contact_name,
  ).toBe("Ana");
  expect(
    (await (await request(f, "/contacts/" + contact.id)).json<any>())
      .conversations[0].id,
  ).toBe(c.conversation_id);
  expect(
    (await request(f, path, { expected_contact_id: "stale" }, "DELETE")).status,
  ).toBe(409);
  expect(
    (await request(f, path, { expected_contact_id: contact.id }, "DELETE"))
      .status,
  ).toBe(200);
  expect(
    (
      await (
        await request(f, "/conversations/" + c.conversation_id)
      ).json<any>()
    ).contact,
  ).toBeNull();
  expect((await request(f, "/contacts/" + contact.id)).status).toBe(200);
  expect(
    (await request(f, path, { contact_id: contact.id }, "PUT")).status,
  ).toBe(200);
  await exec(
    env,
    "UPDATE applications SET scopes=? WHERE id=?",
    JSON.stringify(["conversations:read"]),
    f.actor.id.slice(4),
  );
  expect(
    (await (await request(f, "/conversations")).json<any>()).data[0]
      .contact_name,
  ).toBeNull();
  expect(
    (
      await (
        await request(f, "/conversations/" + c.conversation_id)
      ).json<any>()
    ).contact,
  ).toBeNull();
});
it("vincula explicitamente, nunca une pelo telefone nem cruza equipe e aplicações", async () => {
  const f = await fixture(),
    other = await fixture(f.p);
  const user: Actor = {
    ...f.actor,
    id: "operator",
    kind: "user",
    role: "operator",
  };
  const a = await contactCommand(env, user, f.p, "contact.create", {
    name: "Pessoa A",
    phone: "5511999990000",
  });
  const b = await contactCommand(env, user, f.p, "contact.create", {
    name: "Pessoa B",
    phone: "5511999990000",
  });
  expect(a.id).not.toBe(b.id);
  const channel = await inbound(
    env,
    f.p,
    { external_id: "5511999990000", message_id: uid(), text: "Olá" },
    "meta:test",
    null,
  );
  expect(
    await one(
      env,
      "SELECT * FROM conversation_contacts WHERE conversation_id=?",
      channel.conversation_id,
    ),
  ).toBeNull();
  expect(
    (
      await request(
        f,
        `/conversations/${channel.conversation_id}/contact`,
        { contact_id: a.id },
        "PUT",
      )
    ).status,
  ).toBe(404);
  await contactCommand(env, user, f.p, "contact.from-conversation", {
    id: channel.conversation_id,
    contact_id: a.id,
  });
  const external = await inbound(
    env,
    f.p,
    { external_id: "cliente", message_id: uid(), text: "Olá" },
    "app:" + f.actor.id,
    null,
  );
  await expect(
    contactCommand(env, user, f.p, "contact.from-conversation", {
      id: external.conversation_id,
      contact_id: a.id,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await request(
        other,
        `/conversations/${external.conversation_id}/contact`,
        { name: "Outro" },
        "PUT",
      )
    ).status,
  ).toBe(404);
  expect(
    (await all(env, "SELECT * FROM outbox WHERE profile_id=?", f.p)).length,
  ).toBe(0);
});
