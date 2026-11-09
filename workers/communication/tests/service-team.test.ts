import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, one, exec, batch } from "../src/db";
import { uid, now, defaults, json, type Actor } from "../src/types";
import { sha, setSecret } from "../src/security";
import { inbound, perform, conversation, enqueue } from "../src/service";
import { processInbox, processRun } from "../src/engine";
import { listLines, saveLine, availableMenus } from "../src/line-service";
import {
  teamDirectory,
  internalCommand,
  internalChatDetail,
  listInternalChats,
  finishInternalRun,
} from "../src/team";
import { visibleEvent } from "../src/visibility";
import { transport } from "../src/transport";

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const p = uid(),
    line = uid(),
    second = uid(),
    hermes = uid(),
    bot = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    p,
    "Equipe",
    JSON.stringify(defaults),
    now(),
  );
  for (const id of [line, second])
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'meta','direct','active',?,?)",
      id,
      p,
      id,
      JSON.stringify({
        number: "5511999999999",
        secret_marker: "preservar",
        service: { mode: "inherit", menu_mode: "manual" },
      }),
      now(),
    );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,last_seen,created) VALUES(?,?,?,'hermes','direct','active','{}',?,?)",
    hermes,
    p,
    "Hermes",
    now(),
    now(),
  );
  await exec(
    env,
    "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,?,?,1)",
    bot,
    p,
    hermes,
    "support",
    "Bot suporte",
  );
  const users: Actor[] = [];
  for (const role of ["admin", "operator", "operator"] as const) {
    const id = uid();
    await exec(
      env,
      "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      id,
      `${id}@example.test`,
      id,
      "test",
      role,
      JSON.stringify([p]),
      now(),
    );
    users.push({
      id,
      kind: "user",
      name: id,
      role,
      profiles: [p],
      scopes: [],
      bots: [],
      rate: 300,
      runLimit: 20,
    });
  }
  return {
    p,
    line,
    second,
    hermes,
    bot,
    admin: users[0],
    a: users[1],
    b: users[2],
  };
}
async function receive(
  f: any,
  line: string,
  text: string,
  recipient = "5511888888888",
) {
  return inbound(
    env,
    f.p,
    { external_id: recipient, message_id: uid(), text },
    `channel:${line}`,
    line,
  );
}
async function token(actor: Actor) {
  const t = "wabu_" + uid();
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created) VALUES(?,?,?,'bearer',?)",
    await sha(t),
    actor.id,
    now() + 86400000,
    now(),
  );
  return t;
}
describe("linhas, menus e equipe interna", () => {
  it("configura linhas fora do roteador e preserva configurações e habilitação do bot", async () => {
    const f = await fixture();
    const saved = await saveLine(env, f.admin, f.p, {
      id: f.line,
      service: { mode: "bot", bot_id: f.bot, menu_mode: "manual" },
      number_policy: { pool: false },
    });
    expect(saved.service.bot_id).toBe(f.bot);
    expect(saved.number_policy.pool).toBe(false);
    expect(
      json(
        (await one(env, "SELECT config FROM connections WHERE id=?", f.line))
          .config,
      ).secret_marker,
    ).toBe("preservar");
    expect((await listLines(env, f.admin, f.p)).data).toHaveLength(2);
    await perform(
      env,
      f.admin,
      f.p,
      "bot.update",
      { id: f.bot, line_ids: [f.line] },
      uid(),
    );
    expect(
      await one(env, "SELECT enabled,line_ids FROM bots WHERE id=?", f.bot),
    ).toMatchObject({ enabled: 1, line_ids: JSON.stringify([f.line]) });
    await expect(
      saveLine(env, f.admin, f.p, {
        id: f.second,
        service: { mode: "bot", bot_id: f.bot },
      }),
    ).rejects.toThrow("autorizado");
    await expect(
      saveLine(env, f.a, f.p, { id: f.line, service: { mode: "human" } }),
    ).rejects.toThrow("administradores");
    await expect(
      saveLine(env, f.admin, f.p, {
        id: f.line,
        service: { mode: "human" },
        number_policy: { human: false },
      }),
    ).rejects.toThrow("permissões");
  });
  it("filtra menus por linha, ancestral e acionamento manual", async () => {
    const f = await fixture();
    await perform(
      env,
      f.admin,
      f.p,
      "settings",
      {
        menus: [
          {
            id: "root",
            label: "Unidade A",
            type: "submenu",
            line_ids: [f.line],
            trigger: "manual",
          },
          { id: "child", label: "Pessoa", type: "human", parent_id: "root" },
          { id: "auto", label: "Geral", type: "human" },
        ],
      },
      uid(),
    );
    expect(
      (await availableMenus(env, f.p, f.line, null, false)).map((x) => x.id),
    ).toEqual(["auto"]);
    expect(
      (await availableMenus(env, f.p, f.line, null, true)).map((x) => x.id),
    ).toEqual(["root", "auto"]);
    expect(await availableMenus(env, f.p, f.second, "root", true)).toEqual([]);
    const { conversation_id } = await receive(f, f.line, "Olá");
    await perform(
      env,
      f.admin,
      f.p,
      "conversation.action",
      { id: conversation_id, action: "claim" },
      uid(),
    );
    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 86400001,
      conversation_id,
    );
    await expect(
      perform(
        env,
        f.admin,
        f.p,
        "conversation.action",
        { id: conversation_id, action: "menu", menu_id: "root" },
        uid(),
      ),
    ).rejects.toThrow("24 horas");
    expect(
      (
        await one(
          env,
          "SELECT count(*) n FROM outbox WHERE conversation_id=?",
          conversation_id,
        )
      ).n,
    ).toBe(0);
  });
  it("permite seleção de submenu durante atendimento humano sem perder o responsável", async () => {
    const f = await fixture();
    await perform(
      env,
      f.admin,
      f.p,
      "settings",
      {
        menus: [
          {
            id: "root",
            label: "Serviços",
            type: "submenu",
            trigger: "manual",
            line_ids: [f.line],
          },
          {
            id: "child",
            label: "Consultar",
            type: "app",
            app_id: "site",
            parent_id: "root",
          },
        ],
        apps: [
          { id: "site", name: "Consulta", url: "https://example.com/consulta" },
        ],
      },
      uid(),
    );
    const { conversation_id } = await receive(f, f.line, "Quero consultar");
    await exec(
      env,
      "UPDATE inbox SET status='done' WHERE conversation_id=?",
      conversation_id,
    );
    await perform(
      env,
      f.a,
      f.p,
      "conversation.action",
      { id: conversation_id, action: "claim" },
      uid(),
    );
    await perform(
      env,
      f.a,
      f.p,
      "conversation.action",
      { id: conversation_id, action: "menu", menu_id: "root" },
      uid(),
    );
    await receive(f, f.line, "1");
    await processInbox(env, f.p);
    const c = await conversation(env, conversation_id, f.p);
    expect(c).toMatchObject({ state: "human", owner: f.a.id, menu_active: 0 });
    const sent = await all(
      env,
      "SELECT payload FROM outbox WHERE conversation_id=?",
      c.id,
    );
    expect(
      sent.some((row) =>
        json(row.payload).text.includes("https://example.com/consulta"),
      ),
    ).toBe(true);
  });
  it("encaminha para bot autorizado imediatamente e usa esse bot na próxima entrada", async () => {
    const f = await fixture();
    const { conversation_id } = await receive(
      f,
      f.line,
      "Como acompanho o pedido?",
    );
    await exec(
      env,
      "UPDATE inbox SET status='done' WHERE conversation_id=?",
      conversation_id,
    );
    await perform(
      env,
      f.admin,
      f.p,
      "conversation.action",
      { id: conversation_id, action: "claim" },
      uid(),
    );
    await perform(
      env,
      f.admin,
      f.p,
      "conversation.action",
      { id: conversation_id, action: "transfer", target: `bot:${f.bot}` },
      uid(),
    );
    let runs = await all(
      env,
      "SELECT * FROM bot_runs WHERE conversation_id=?",
      conversation_id,
    );
    expect(runs).toHaveLength(1);
    expect(json(runs[0].input).request).toBe("Como acompanho o pedido?");
    expect(await conversation(env, conversation_id, f.p)).toMatchObject({
      state: "ai",
      owner: null,
      assigned_bot_id: f.bot,
      epoch: runs[0].epoch,
    });
    await receive(f, f.line, "Pedido 123");
    await processInbox(env, f.p);
    runs = await all(
      env,
      "SELECT * FROM bot_runs WHERE conversation_id=?",
      conversation_id,
    );
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.bot_id === f.bot)).toBe(true);
    await exec(env, "UPDATE bots SET line_ids='[]' WHERE id=?", f.bot);
    await processRun(env, runs[1]);
    expect(
      (await one(env, "SELECT status FROM bot_runs WHERE id=?", runs[1].id))
        .status,
    ).toBe("cancelled");
  });
  it("fornece fontes ao bot transferido e entrega a resposta fundamentada", async () => {
    const f = await fixture();
    await exec(
      env,
      "INSERT INTO chunks(profile_id,document_id,text,url) VALUES(?,?,?,?)",
      f.p,
      uid(),
      "O pedido pode ser acompanhado pelo protocolo informado no balcão.",
      "",
    );
    const { conversation_id } = await receive(
      f,
      f.line,
      "Como acompanho o pedido?",
    );
    await exec(
      env,
      "UPDATE inbox SET status='done' WHERE conversation_id=?",
      conversation_id,
    );
    await perform(
      env,
      f.a,
      f.p,
      "conversation.action",
      { id: conversation_id, action: "claim" },
      uid(),
    );
    await perform(
      env,
      f.a,
      f.p,
      "conversation.action",
      { id: conversation_id, action: "transfer", target: `bot:${f.bot}` },
      uid(),
    );
    let run = await one(
      env,
      "SELECT * FROM bot_runs WHERE conversation_id=?",
      conversation_id,
    );
    const context = json(run.context);
    expect(context.sources).toHaveLength(1);
    await exec(
      env,
      "UPDATE bot_runs SET status='completed',result=? WHERE id=?",
      JSON.stringify({
        action: "answer",
        text: "Use o protocolo informado no balcão.",
        citations: [context.sources[0].id],
      }),
      run.id,
    );
    run = await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id);
    await processRun(env, run);
    const delivery = await one(
      env,
      "SELECT * FROM outbox WHERE conversation_id=?",
      conversation_id,
    );
    expect(delivery.actor).toBe(`bot:${f.bot}`);
    expect(json(delivery.payload).text).toContain("Use o protocolo");
    await saveLine(env, f.admin, f.p, {
      id: f.line,
      service: { mode: "human" },
    });
    // A specifically transferred conversation keeps its explicit bot; the line
    // default is for unassigned conversations, never a silent transfer.
    expect(
      (await conversation(env, conversation_id, f.p)).assigned_bot_id,
    ).toBe(f.bot);
  });
  it("renova presença de Hermes ocioso com consulta em cache", async () => {
    const f = await fixture();
    await exec(
      env,
      "UPDATE connections SET last_seen=?,config=? WHERE id=?",
      now() - 600000,
      JSON.stringify({
        url: "https://hermes.example.com",
        api_url: "https://hermes.example.com",
      }),
      f.hermes,
    );
    await setSecret(env, `connection:${f.hermes}`, {
      profile_keys: { support: "test-key" },
    });
    const request = vi.fn(async () =>
      Response.json({
        features: { runs_idempotency: { supported: true, durable: true } },
      }),
    );
    vi.stubGlobal("fetch", request);
    expect(
      (await teamDirectory(env, f.a, f.p)).data.find(
        (x) => x.id === `bot:${f.bot}`,
      ).online,
    ).toBe(true);
    expect(
      (await teamDirectory(env, f.a, f.p)).data.find(
        (x) => x.id === `bot:${f.bot}`,
      ).online,
    ).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      (await one(env, "SELECT last_seen FROM connections WHERE id=?", f.hermes))
        .last_seen,
    ).toBeGreaterThan(now() - 5000);
  });
  it("ativa perfil por linha e preserva atribuições ao editar credenciais", async () => {
    const f = await fixture();
    await saveLine(env, f.admin, f.p, {
      id: f.line,
      service: { mode: "human", menu_mode: "manual" },
      number_policy: { pool: false },
    });
    expect(await perform(env, f.admin, f.p, "activate", {}, uid())).toEqual({
      enabled: true,
    });
    await exec(
      env,
      "UPDATE connections SET status='paused' WHERE id=?",
      f.line,
    );
    await perform(
      env,
      f.admin,
      f.p,
      "connection.save",
      {
        id: f.line,
        name: "Nova descrição",
        kind: "meta",
        config: { number: "5511999999999", phone_id: "111222" },
      },
      uid(),
    );
    const config = json(
      (await one(env, "SELECT config FROM connections WHERE id=?", f.line))
        .config,
    );
    expect(config.service).toMatchObject({
      mode: "human",
      menu_mode: "manual",
    });
    expect(config.number_policy.pool).toBe(false);
  });
  it("coloca linha humana na fila sem executar bot", async () => {
    const f = await fixture();
    await saveLine(env, f.admin, f.p, {
      id: f.line,
      service: { mode: "human", menu_mode: "off" },
      number_policy: { bots: false, menu: false, pool: false },
    });
    const { conversation_id } = await receive(
      f,
      f.line,
      "Preciso de ajuda com a compra",
    );
    await processInbox(env, f.p);
    expect((await conversation(env, conversation_id, f.p)).state).toBe(
      "waiting",
    );
    expect(
      (
        await one(
          env,
          "SELECT count(*) n FROM bot_runs WHERE conversation_id=?",
          conversation_id,
        )
      ).n,
    ).toBe(0);
  });
  it("mantém mensagens internas privadas e nunca enfileira WhatsApp", async () => {
    const f = await fixture();
    const chat = await internalCommand(
      env,
      f.a,
      f.p,
      "internal.create",
      { peer_id: f.b.id },
      uid(),
    );
    const key = uid();
    await internalCommand(
      env,
      f.a,
      f.p,
      "internal.send",
      { id: chat.id, text: "Mensagem privada" },
      key,
    );
    await internalCommand(
      env,
      f.a,
      f.p,
      "internal.send",
      { id: chat.id, text: "Mensagem privada" },
      key,
    );
    expect(
      (await internalChatDetail(env, f.b, f.p, chat.id)).messages,
    ).toHaveLength(1);
    expect((await listInternalChats(env, f.admin, f.p)).data).toHaveLength(0);
    await expect(
      internalChatDetail(env, f.admin, f.p, chat.id),
    ).rejects.toThrow("não encontrada");
    const ev = await one(
      env,
      "SELECT * FROM events WHERE profile_id=? AND kind='internal.message'",
      f.p,
    );
    expect(await visibleEvent(env, f.a, ev)).toBe(true);
    expect(await visibleEvent(env, f.admin, ev)).toBe(false);
    expect(
      (await one(env, "SELECT count(*) n FROM outbox WHERE profile_id=?", f.p))
        .n,
    ).toBe(0);
    await exec(env, "UPDATE users SET disabled=1 WHERE id=?", f.b.id);
    expect((await internalChatDetail(env, f.a, f.p, chat.id)).peer.name).toBe(
      "Contato indisponível",
    );
    await expect(
      internalCommand(
        env,
        f.a,
        f.p,
        "internal.send",
        { id: chat.id, text: "Não enviar" },
        uid(),
      ),
    ).rejects.toThrow("não está mais disponível");
  });
  it("conversa com bot internamente sem expor execução em API, eventos ou relatórios", async () => {
    const f = await fixture();
    const chat = await internalCommand(
      env,
      f.a,
      f.p,
      "internal.create",
      { peer_id: `bot:${f.bot}` },
      uid(),
    );
    const sent = await internalCommand(
      env,
      f.a,
      f.p,
      "internal.send",
      { id: chat.id, text: "Preciso de uma informação privada" },
      uid(),
    );
    const run = await one(
      env,
      "SELECT * FROM bot_runs WHERE id=?",
      sent.run_id,
    );
    expect(run.conversation_id).toBeNull();
    await exec(
      env,
      "UPDATE bot_runs SET status='completed',result=? WHERE id=?",
      JSON.stringify({ text: "Resposta privada" }),
      run.id,
    );
    await finishInternalRun(
      env,
      run,
      JSON.stringify({ text: "Resposta privada" }),
    );
    await finishInternalRun(
      env,
      run,
      JSON.stringify({ text: "Resposta privada" }),
    );
    expect(
      (await internalChatDetail(env, f.a, f.p, chat.id)).messages.map(
        (m: any) => m.text,
      ),
    ).toEqual(["Preciso de uma informação privada", "Resposta privada"]);
    await expect(
      perform(env, f.admin, f.p, "run.cancel", { id: run.id }, uid()),
    ).rejects.toThrow("não encontrada");
    const t = await token(f.admin),
      headers = { Authorization: `Bearer ${t}` };
    expect(
      (await SELF.fetch(`https://test/api/v1/bot-runs/${run.id}`, { headers }))
        .status,
    ).toBe(404);
    const list = await (
      await SELF.fetch(`https://test/api/v1/profiles/${f.p}/bot-runs`, {
        headers,
      })
    ).json<any>();
    expect(list.data.some((r: any) => r.id === run.id)).toBe(false);
    const report = await (
      await SELF.fetch(
        `https://test/api/v1/profiles/${f.p}/reports?section=runs`,
        { headers },
      )
    ).json<any>();
    expect(report.data.some((r: any) => r.id === run.id)).toBe(false);
    expect(
      (await one(env, "SELECT count(*) n FROM outbox WHERE profile_id=?", f.p))
        .n,
    ).toBe(0);
  });
  it("retorna as mensagens recentes após 500 mensagens", async () => {
    const f = await fixture();
    const chat = await internalCommand(
      env,
      f.a,
      f.p,
      "internal.create",
      { peer_id: f.b.id },
      uid(),
    );
    const stamp = now();
    await batch(
      env,
      Array.from(
        { length: 501 },
        (_, i) =>
          [
            "INSERT INTO internal_messages(id,chat_id,author,text,source_key,created) VALUES(?,?,?,?,?,?)",
            [uid(), chat.id, f.a.id, `Mensagem ${i}`, uid(), stamp + i],
          ] as [string, any[]],
      ),
    );
    const detail = await internalChatDetail(env, f.a, f.p, chat.id);
    expect(detail.messages).toHaveLength(500);
    expect(detail.messages[0].text).toBe("Mensagem 1");
    expect(detail.messages.at(-1).text).toBe("Mensagem 500");
  });
  it("mostra presença real e bloqueia alterações de permissão em entregas QR pendentes", async () => {
    const f = await fixture();
    await perform(env, f.a, f.p, "presence", { present: true }, uid());
    const team = (await teamDirectory(env, f.a, f.p)).data;
    expect(team.find((x) => x.id === f.a.id).online).toBe(true);
    expect(team.find((x) => x.id === `bot:${f.bot}`).online).toBe(true);
    await exec(
      env,
      "UPDATE connections SET kind='qr',config='{}' WHERE id=?",
      f.line,
    );
    const { conversation_id } = await receive(f, f.line, "Oi");
    const c = await conversation(env, conversation_id, f.p);
    const delivery = await enqueue(
      env,
      c,
      `bot:${f.bot}`,
      "text",
      { text: "Resposta" },
      uid(),
    );
    await exec(env, "UPDATE bots SET line_ids='[]' WHERE id=?", f.bot);
    expect((await transport(env, f.line, "commands", {})).commands).toEqual([]);
    expect(
      (await one(env, "SELECT status FROM outbox WHERE id=?", delivery)).status,
    ).toBe("cancelled");
  });
});
