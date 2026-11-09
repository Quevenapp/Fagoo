import { env, SELF } from "cloudflare:test";
import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { exec, one, all } from "../src/db";
import { uid, now, defaults, type Actor } from "../src/types";
import { inbound, conversation, perform, enqueue } from "../src/service";
import {
  capabilities,
  channelEvent,
  outgoingContent,
  syncGroup,
  validateMedia,
} from "../src/whatsapp";
import {
  uploadCommand,
  uploadPart,
  authorizedMedia,
  mediaResponse,
  PART_SIZE,
  expireUploads,
} from "../src/media";
import { finishDelivery } from "../src/delivery";
import { metaMedia, metaContent } from "../src/integrations";
import { metaInbound } from "../src/meta-inbound";
import { processInbox, deliverWebhook } from "../src/engine";
import { callCommand, callWebhook, callView, expireCalls } from "../src/calls";
import { setSecret, sha, hmac } from "../src/security";
import { visibleEvent } from "../src/visibility";
import { transport } from "../src/transport";
const admin: Actor = {
  id: "test-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 10,
};
const sdp = {
  sdp_type: "offer",
  sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n",
};
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  admin.id = "test-admin:" + uid();
});
async function seed(kind = "qr") {
  const p = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    p,
    "Teste WhatsApp",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?,'direct','active',?,?)",
    id,
    p,
    "Canal de teste",
    kind,
    JSON.stringify({
      number: "5511999990000",
      phone_id: "1234",
      protocol_version: 2,
      groups_enabled: true,
      calling_enabled: true,
    }),
    now(),
  );
  const conn = await one(env, "SELECT * FROM connections WHERE id=?", id);
  await setSecret(env, "connection:" + id, { token: "fake-token" });
  const r = await inbound(
    env,
    p,
    { external_id: "5511999991111", message_id: uid(), text: "Olá" },
    "channel:" + id,
    id,
  );
  await perform(
    env,
    admin,
    p,
    "conversation.action",
    { id: r.conversation_id, action: "claim" },
    uid(),
  );
  return { p, conn, c: await conversation(env, r.conversation_id, p) };
}
async function media(p: string, type = "image/jpeg", actor = admin.id) {
  const id = uid();
  await env.MEDIA.put(p + "/" + id, "sample");
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    p,
    "arquivo." + type.split("/")[1],
    type,
    6,
    p + "/" + id,
    actor,
    now(),
  );
  return id;
}
it("envia imagem sem texto, mantém legenda e não duplica bolhas de mensagem", async () => {
  const f = await seed(),
    id = await media(f.p);
  const r = await perform(
    env,
    admin,
    f.p,
    "conversation.action",
    { id: f.c.id, action: "reply", text: "Foto do produto", attachments: [id] },
    uid(),
  );
  const row = await one(env, "SELECT * FROM outbox WHERE id=?", r.delivery_id),
    payload = JSON.parse(row.payload);
  expect(payload.content.type).toBe("image");
  expect(payload.text).toBe("Foto do produto");
  await finishDelivery(env, row, "provider-photo");
  await finishDelivery(env, row, "provider-photo");
  expect(
    await all(env, "SELECT * FROM messages WHERE external_id='provider-photo'"),
  ).toHaveLength(1);
  expect(
    await all(
      env,
      "SELECT * FROM messages WHERE direction='operator' AND conversation_id=?",
      f.c.id,
    ),
  ).toHaveLength(0);
  expect(
    (
      await perform(
        env,
        admin,
        f.p,
        "conversation.action",
        { id: f.c.id, action: "reply", text: "", attachments: [id] },
        uid(),
      )
    ).status,
  ).toBe("pending");
});
it("áudio com texto mantém mensagem de texto separada e voz nativa", async () => {
  const f = await seed(),
    id = await media(f.p, "audio/ogg");
  await perform(
    env,
    admin,
    f.p,
    "conversation.action",
    {
      id: f.c.id,
      action: "reply",
      text: "Ouça este áudio",
      attachments: [id],
      content: { type: "voice" },
    },
    uid(),
  );
  const rows = await all(
    env,
    "SELECT * FROM outbox WHERE conversation_id=? ORDER BY created,rowid",
    f.c.id,
  );
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[0].payload).content.type).toBe("text");
  expect(JSON.parse(rows[1].payload).content.type).toBe("voice");
});
it("recebe recibo antes da confirmação e nunca retrocede de lida para entregue", async () => {
  const f = await seed(),
    id = await enqueue(env, f.c, admin.id, "text", { text: "Teste" }, uid());
  await channelEvent(env, f.conn, {
    event: "status",
    message_id: "early",
    external_id: f.c.external_id,
    status: "read",
    timestamp: 1000,
  });
  await finishDelivery(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", id),
    "early",
  );
  await channelEvent(env, f.conn, {
    event: "status",
    message_id: "early",
    external_id: f.c.external_id,
    status: "delivered",
    timestamp: 2000,
  });
  expect(
    (await one(env, "SELECT * FROM messages WHERE external_id='early'"))
      .delivery_status,
  ).toBe("read");
});
it("reação e edição repetidas não criam mensagens ou eventos duplicados", async () => {
  const f = await seed(),
    m = await one(
      env,
      "SELECT * FROM messages WHERE conversation_id=?",
      f.c.id,
    );
  const e = {
    event: "reaction",
    message_id: m.external_id,
    external_id: f.c.external_id,
    participant: "cliente",
    emoji: "👍",
    event_id: "react-1",
    timestamp: 5000,
  };
  await channelEvent(env, f.conn, e);
  await channelEvent(env, f.conn, e);
  expect(
    JSON.parse(
      (await one(env, "SELECT content FROM messages WHERE id=?", m.id)).content,
    ).reactions.cliente.emoji,
  ).toBe("👍");
  expect(
    await all(
      env,
      "SELECT * FROM events WHERE kind='message.updated' AND profile_id=?",
      f.p,
    ),
  ).toHaveLength(1);
  await channelEvent(env, f.conn, {
    ...e,
    event: "edit",
    event_id: "edit-1",
    text: "Novo texto",
    timestamp: 6000,
  });
  expect(
    (await one(env, "SELECT text FROM messages WHERE id=?", m.id)).text,
  ).toBe("Novo texto");
});
it("impede citar ou reagir a mensagem de outra conversa", async () => {
  const a = await seed(),
    b = await seed(),
    message = await one(
      env,
      "SELECT id FROM messages WHERE conversation_id=?",
      b.c.id,
    );
  await expect(
    outgoingContent(env, admin, a.c, {
      text: "Teste",
      content: { reply_to: message.id },
    }),
  ).rejects.toThrow("não pertence");
  await expect(
    perform(
      env,
      admin,
      a.p,
      "message.action",
      { id: a.c.id, action: "reaction", message_id: message.id, emoji: "👍" },
      uid(),
    ),
  ).rejects.toThrow("não encontrada");
});
it("grupos preservam participante e não disparam bots sem menção", async () => {
  const f = await seed();
  const r = await inbound(
    env,
    f.p,
    {
      external_id: "test@g.us",
      chat_type: "group",
      message_id: "one",
      text: "Bom dia",
      content: { participant: "person1", participant_name: "Pessoa 1" },
    },
    "channel:" + f.conn.id,
    f.conn.id,
  );
  const c = await conversation(env, r.conversation_id, f.p);
  expect(c.phone).toBeNull();
  expect(c.chat_type).toBe("group");
  expect(
    (await one(env, "SELECT author FROM messages WHERE id=?", r.message_id))
      .author,
  ).toContain("person1");
  // Drain the direct fixture inbox before processing the group.
  await exec(
    env,
    "UPDATE inbox SET status='done' WHERE conversation_id=?",
    f.c.id,
  );
  await processInbox(env, f.p);
  expect(
    await all(env, "SELECT * FROM bot_runs WHERE conversation_id=?", c.id),
  ).toHaveLength(0);
  expect(
    await all(env, "SELECT * FROM outbox WHERE conversation_id=?", c.id),
  ).toHaveLength(0);
});
it("grupo exclusivo de administradores impede envio por membro e respeita política", async () => {
  const f = await seed();
  const r = await syncGroup(env, f.conn, {
    external_id: "locked@g.us",
    subject: "Equipe",
    announcement: true,
    own_admin: false,
    participants: [{ id: "a" }],
  });
  await perform(
    env,
    admin,
    f.p,
    "conversation.action",
    { id: r.conversation_id, action: "claim" },
    uid(),
  );
  await expect(
    perform(
      env,
      admin,
      f.p,
      "conversation.action",
      { id: r.conversation_id, action: "reply", text: "Teste" },
      uid(),
    ),
  ).rejects.toThrow("administradores");
  await perform(
    env,
    admin,
    f.p,
    "group.policy",
    { id: r.conversation_id, bot_policy: "off" },
    uid(),
  );
  expect((await conversation(env, r.conversation_id, f.p)).bot_policy).toBe(
    "off",
  );
});
it("nega chamadas QR e formatos/tamanhos incompatíveis antes de enviar", async () => {
  const qr = await seed();
  expect(capabilities(qr.conn).calls).toBe(false);
  expect(capabilities({ ...qr.conn, config: "{}" }).upgrade_required).toBe(
    true,
  );
  await expect(
    callCommand(
      env,
      admin,
      qr.p,
      "call.start",
      { conversation_id: qr.c.id, session: sdp },
      uid(),
    ),
  ).rejects.toThrow("não oferece");
  expect(() =>
    validateMedia({ type: "video/mp4", size: 17 * 1024 * 1024 }, "video", {
      kind: "meta",
    }),
  ).toThrow("16 MB");
  expect(() =>
    validateMedia({ type: "audio/webm", size: 100 }, "audio", { kind: "meta" }),
  ).toThrow("Formato");
});
it("upload em partes repete com o mesmo conteúdo, recusa conflito e conclui no R2", async () => {
  const f = await seed(),
    data = new Uint8Array(30).fill(7);
  const upload = await uploadCommand(env, admin, f.p, "upload.create", {
    name: "teste.pdf",
    type: "application/pdf",
    size: data.length,
  });
  const req = () =>
    new Request("https://test", {
      method: "PUT",
      headers: { "Idempotency-Key": "part" },
      body: data,
    });
  await uploadPart(env, admin, f.p, upload.id, 1, req());
  await uploadPart(env, admin, f.p, upload.id, 1, req());
  await expect(
    uploadPart(
      env,
      admin,
      f.p,
      upload.id,
      1,
      new Request("https://test", {
        method: "PUT",
        headers: { "Idempotency-Key": "part" },
        body: new Uint8Array(30).fill(8),
      }),
    ),
  ).rejects.toThrow("outro conteúdo");
  const done = await uploadCommand(env, admin, f.p, "upload.complete", {
    id: upload.id,
  });
  expect(done.id).toBe(upload.id);
  expect(
    new Uint8Array(
      await (await env.MEDIA.get(f.p + "/" + done.id))!.arrayBuffer(),
    ),
  ).toEqual(data);
  expect(
    (await uploadCommand(env, admin, f.p, "upload.complete", { id: upload.id }))
      .id,
  ).toBe(done.id);
});
it("nega mídia privada de outra aplicação e permite anexo recebido em conversa autorizada", async () => {
  const f = await seed(),
    app: Actor = {
      ...admin,
      id: "app:" + uid(),
      kind: "app",
      role: "service",
      profiles: [f.p],
      scopes: ["media:read", "media:write", "conversations:read"],
    };
  const privateId = await media(f.p, "application/pdf", "app:other");
  await expect(authorizedMedia(env, app, f.p, privateId)).rejects.toThrow(
    "permissão",
  );
  const incoming = await media(f.p, "image/png", "transport");
  await inbound(
    env,
    f.p,
    {
      external_id: f.c.external_id,
      message_id: uid(),
      text: "",
      attachments: [incoming],
    },
    "channel:" + f.conn.id,
    f.conn.id,
  );
  expect((await authorizedMedia(env, app, f.p, incoming)).id).toBe(incoming);
});
it("reprodução privada suporta ranges válidos e bloqueia HTML inline", async () => {
  const f = await seed(),
    id = await media(f.p, "video/mp4"),
    m = await one(env, "SELECT * FROM media WHERE id=?", id);
  const r = await mediaResponse(
    env,
    m,
    new Request("https://test?inline=1", { headers: { Range: "bytes=1-3" } }),
  );
  expect(r.status).toBe(206);
  expect(r.headers.get("Content-Range")).toBe("bytes 1-3/6");
  expect(new TextDecoder().decode(await r.arrayBuffer())).toBe("amp");
  expect(
    (
      await mediaResponse(
        env,
        m,
        new Request("https://test", { headers: { Range: "bytes=99-100" } }),
      )
    ).status,
  ).toBe(416);
  const html = await mediaResponse(
    env,
    { ...m, type: "text/html" },
    new Request("https://test?inline=1"),
  );
  expect(html.headers.get("Content-Disposition")).toContain("attachment");
});
it("Meta envia mídia como vídeo nativo por streaming, com citação e legenda", async () => {
  const f = await seed("meta"),
    id = await media(f.p, "video/mp4");
  const sent: any[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_input: any, init: any) => {
      sent.push(init);
      if (sent.length === 1) {
        expect(init.body).toBeInstanceOf(ReadableStream);
        await new Response(init.body).arrayBuffer();
        return Response.json({ id: "asset" });
      }
      return Response.json({ messages: [{ id: "native-video" }] });
    },
  );
  expect(
    await metaMedia(env, f.conn, f.c.external_id, id, {
      text: "Vídeo",
      content: { type: "video", reply_external_id: "quoted" },
    }),
  ).toBe("native-video");
  expect(JSON.parse(sent[1].body)).toMatchObject({
    type: "video",
    video: { id: "asset", caption: "Vídeo" },
    context: { message_id: "quoted" },
  });
});
it("webhook Meta normaliza vídeo, grupo e status de participante", async () => {
  const f = await seed("meta"),
    events: any[] = [];
  const id = (await sha(`${f.conn.id}:incoming:asset`)).slice(0, 32);
  await env.MEDIA.put(f.p + "/" + id, "fake");
  await exec(
    env,
    "INSERT INTO media VALUES(?,?,?,?,?,?,?,?)",
    id,
    f.p,
    "video.mp4",
    "video/mp4",
    4,
    f.p + "/" + id,
    "transport",
    now(),
  );
  const response = await metaInbound(
    env,
    f.conn,
    {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1234" },
                contacts: [{ wa_id: "person", profile: { name: "Pessoa" } }],
                messages: [
                  {
                    from: "person",
                    id: "incoming",
                    group_id: "group",
                    type: "video",
                    video: { id: "asset", caption: "Legenda" },
                  },
                ],
                statuses: [
                  {
                    id: "out",
                    recipient_id: "group",
                    recipient_participant_id: "person",
                    status: "read",
                    timestamp: "10",
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    async (data) => {
      events.push(data);
      return Response.json({ ok: true });
    },
  );
  expect(response.ok).toBe(true);
  expect(events[0]).toMatchObject({ event: "status", participant: "person" });
  expect(events[1]).toMatchObject({
    chat_type: "group",
    external_id: "group",
    text: "Legenda",
    content: { type: "video", participant_name: "Pessoa" },
    attachments: [id],
  });
});
it.each([200, 302])(
  "download Meta no Workers preserva mídia ou rejeita redirecionamento (HTTP %i)",
  async (status) => {
    const f = await seed("meta"),
      events: any[] = [];
    const id = (await sha(`${f.conn.id}:download:asset`)).slice(0, 32);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("Authorization")).toBe("Bearer fake-token");
        expect(request.redirect).toBe("manual");
        if (new URL(request.url).hostname === "graph.facebook.com")
          return Response.json({
            url: "https://lookaside.fbsbx.com/asset",
            mime_type: "video/mp4",
          });
        expect(request.url).toBe("https://lookaside.fbsbx.com/asset");
        return status === 200
          ? new Response("sample", { headers: { "Content-Length": "6" } })
          : new Response(null, {
              status,
              headers: { Location: "https://example.com/" },
            });
      });
    await metaInbound(
      env,
      f.conn,
      {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "1234" },
                  messages: [
                    {
                      from: "person",
                      id: "download",
                      type: "video",
                      video: { id: "asset", caption: "Legenda" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      async (data) => {
        events.push(data);
        return Response.json({ ok: true });
      },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    const object = await env.MEDIA.get(f.p + "/" + id);
    if (status === 200) {
      expect(events[0].attachments).toEqual([id]);
      expect(events[0].content.media_error).toBeUndefined();
      expect(await object?.text()).toBe("sample");
    } else {
      expect(events[0].attachments).toEqual([]);
      expect(events[0].content.media_error).toBe(true);
      expect(object).toBeNull();
    }
  },
);
it("chamada de saída exige permissão, registra incerteza e não repete a execução", async () => {
  const f = await seed("meta");
  let posts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_url: any, init: any) => {
      if (init.method === "GET")
        return Response.json({
          permission: { status: "temporary" },
          actions: [{ action_name: "start_call", can_perform_action: true }],
        });
      posts++;
      throw Error("timeout");
    },
  );
  const r = await callCommand(
    env,
    admin,
    f.p,
    "call.start",
    { conversation_id: f.c.id, session: sdp },
    uid(),
  );
  expect(r.status).toBe("unknown");
  expect(posts).toBe(1);
  await expect(
    callCommand(
      env,
      admin,
      f.p,
      "call.start",
      { conversation_id: f.c.id, session: sdp },
      uid(),
    ),
  ).rejects.toThrow("anterior");
  expect(posts).toBe(1);
  expect(r.local_session).toBeUndefined();
  expect(r.remote_session).toBeUndefined();
});
it("chamada sem autorização Meta é recusada antes de conectar", async () => {
  const f = await seed("meta");
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      permission: { status: "no_permission" },
      actions: [{ action_name: "start_call", can_perform_action: false }],
    }),
  );
  await expect(
    callCommand(
      env,
      admin,
      f.p,
      "call.start",
      { conversation_id: f.c.id, session: sdp },
      uid(),
    ),
  ).rejects.toThrow("não autoriza");
  expect(mock).toHaveBeenCalledTimes(1);
  expect(
    await all(env, "SELECT * FROM calls WHERE profile_id=?", f.p),
  ).toHaveLength(0);
});
it("recepção de chamada tem dono único, SDP privado, evento deduplicado e fim definitivo", async () => {
  const f = await seed("meta");
  const hook = {
    event: "call",
    call: {
      id: "wacid." + uid(),
      event: "connect",
      direction: "USER_INITIATED",
      from: "5511999992222",
      timestamp: String(Math.floor(now() / 1000)),
      session: sdp,
    },
  };
  await callWebhook(env, f.conn, hook);
  await callWebhook(env, f.conn, hook);
  const row = await one(
    env,
    "SELECT * FROM calls WHERE connection_id=?",
    f.conn.id,
  );
  expect(row.remote_session).not.toContain("m=audio");
  const claimed = await callCommand(
    env,
    admin,
    f.p,
    "call.claim",
    { id: row.id },
    uid(),
  );
  expect(claimed.session).toEqual(sdp);
  await expect(
    callCommand(
      env,
      { ...admin, id: "other" },
      f.p,
      "call.claim",
      { id: row.id },
      uid(),
    ),
  ).rejects.toThrow("Outro atendente");
  await expect(
    callView(env, { ...admin, id: "other" }, f.p, row.id, true),
  ).rejects.toThrow("Assuma");
  await callWebhook(env, f.conn, {
    event: "call",
    call: {
      ...hook.call,
      event: "terminate",
      status: "COMPLETED",
      duration: 10,
      timestamp: String(Math.floor(now() / 1000) + 20),
    },
  });
  await callWebhook(env, f.conn, hook);
  expect(
    await one(
      env,
      "SELECT status,remote_session FROM calls WHERE id=?",
      row.id,
    ),
  ).toEqual({ status: "completed", remote_session: null });
  expect(
    await all(
      env,
      "SELECT * FROM call_events WHERE connection_id=?",
      f.conn.id,
    ),
  ).toHaveLength(2);
});
it("preparação e aceitação da ligação usam a mesma sessão e desligamento respeita o dono", async () => {
  const f = await seed("meta");
  await callWebhook(env, f.conn, {
    event: "call",
    call: {
      id: "in-" + uid(),
      event: "connect",
      direction: "USER_INITIATED",
      from: "5511999993333",
      timestamp: "100",
      session: sdp,
    },
  });
  const row = await one(env, "SELECT * FROM calls WHERE profile_id=?", f.p);
  await callCommand(env, admin, f.p, "call.claim", { id: row.id }, uid());
  const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ success: true })),
    answer = { ...sdp, sdp_type: "answer" };
  await callCommand(
    env,
    admin,
    f.p,
    "call.pre_accept",
    { id: row.id, session: answer },
    uid(),
  );
  await callCommand(
    env,
    admin,
    f.p,
    "call.accept",
    { id: row.id, session: answer },
    uid(),
  );
  await expect(
    callCommand(
      env,
      { ...admin, id: "other" },
      f.p,
      "call.terminate",
      { id: row.id },
      uid(),
    ),
  ).rejects.toThrow("responsável");
  await callCommand(env, admin, f.p, "call.terminate", { id: row.id }, uid());
  expect(mock).toHaveBeenCalledTimes(3);
  expect((await callView(env, admin, f.p, row.id)).status).toBe("completed");
});
it("alarme encerra áudio abandonado sem repetir desligamento ambíguo", async () => {
  const f = await seed("meta");
  await callWebhook(env, f.conn, {
    event: "call",
    call: {
      id: "idle-" + uid(),
      event: "connect",
      direction: "USER_INITIATED",
      from: "5511999994444",
      timestamp: "100",
      session: sdp,
    },
  });
  await exec(env, "UPDATE calls SET lease_until=0 WHERE profile_id=?", f.p);
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("timeout"));
  await expireCalls(env, f.p);
  await expireCalls(env, f.p);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(
    (await one(env, "SELECT status FROM calls WHERE profile_id=?", f.p)).status,
  ).toBe("unknown");
});
it("trabalhos de grupo são duráveis e recibos não se misturam com mensagens", async () => {
  const f = await seed();
  const result = await perform(
    env,
    admin,
    f.p,
    "group.action",
    { connection_id: f.conn.id, action: "sync" },
    uid(),
  );
  const command = (await transport(env, f.conn.id, "commands", {})).commands[0];
  expect(command.kind).toBe("group");
  expect(command.id).toBe(result.id);
  await transport(env, f.conn.id, "receipt", {
    id: result.id,
    status: "sent",
    result: { count: 2 },
  });
  await transport(env, f.conn.id, "receipt", {
    id: result.id,
    status: "sent",
    result: { count: 2 },
  });
  expect(
    (
      await one(
        env,
        "SELECT status FROM group_operations WHERE id=?",
        result.id,
      )
    ).status,
  ).toBe("sent");
  expect(
    await all(
      env,
      "SELECT * FROM messages WHERE direction='outbound' AND profile_id=?",
      f.p,
    ),
  ).toHaveLength(0);
});

async function appFixture(p: string, scopes: string[]) {
  const id = uid(),
    token = "wab_" + uid();
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
    id,
    "Integração de teste",
    JSON.stringify([p]),
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
    ...admin,
    id: "app:" + id,
    kind: "app",
    role: "service",
    profiles: [p],
    scopes,
  };
  async function request(path: string, data?: any, key = uid()) {
    return SELF.fetch(`https://test/api/v1/profiles/${p}${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  return { actor, request };
}
it("Meta lê data.groups e aguarda webhook para concluir criação assíncrona", async () => {
  const f = await seed("meta");
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_url: any, init: any) =>
      Response.json(
        init?.method === "POST"
          ? { request_id: "create-request" }
          : {
              data: { groups: [{ id: "meta-group", subject: "Equipe Meta" }] },
              paging: {
                cursors: { after: "next-page" },
                next: "https://graph.facebook.com/next",
              },
            },
      ),
  );
  const sync = await perform(
    env,
    admin,
    f.p,
    "group.action",
    { connection_id: f.conn.id, action: "sync" },
    uid(),
  );
  expect(sync.result).toEqual({ count: 1, cursor: "next-page" });
  expect(
    (
      await one(
        env,
        "SELECT title FROM conversations WHERE connection_id=? AND external_id='meta-group'",
        f.conn.id,
      )
    ).title,
  ).toBe("Equipe Meta");
  const created = await perform(
    env,
    admin,
    f.p,
    "group.action",
    { connection_id: f.conn.id, action: "create", subject: "Equipe" },
    uid(),
  );
  expect(created.status).toBe("sending");
  await metaInbound(
    env,
    f.conn,
    {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1234" },
                groups: [
                  {
                    request_id: "create-request",
                    type: "group_create",
                    errors: [{ code: 123 }],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    async (data) => Response.json(await channelEvent(env, f.conn, data)),
  );
  expect(
    (
      await one(
        env,
        "SELECT status FROM group_operations WHERE id=?",
        created.id,
      )
    ).status,
  ).toBe("failed");
});
it("webhook externo de ligação usa calls:read, assinatura e nunca inclui SDP", async () => {
  const f = await seed("meta"),
    app = await appFixture(f.p, ["calls:read", "webhooks:manage"]);
  const sub = await perform(
    env,
    app.actor,
    f.p,
    "webhook.create",
    { url: "https://example.com/hooks", events: ["call.updated"] },
    uid(),
  );
  await callWebhook(env, f.conn, {
    call: {
      id: uid(),
      event: "connect",
      direction: "USER_INITIATED",
      from: "5511999900003",
      timestamp: "100",
      session: sdp,
    },
  });
  const delivery = await one(
    env,
    "SELECT * FROM webhook_deliveries WHERE subscription_id=?",
    sub.id,
  );
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input: any, init: any) => {
      expect(init.body).not.toContain("m=audio");
      expect(init.body).not.toContain("session");
      expect(init.headers["Wabotia-Signature"]).toBe(
        "v1=" +
          (await hmac(
            sub.signing_secret,
            init.headers["Wabotia-Timestamp"] + "." + init.body,
          )),
      );
      return Response.json({ ok: true });
    });
  await deliverWebhook(env, delivery);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(
    (
      await one(
        env,
        "SELECT status FROM webhook_deliveries WHERE id=?",
        delivery.id,
      )
    ).status,
  ).toBe("delivered");
});
it("API de grupos exige escopo e idempotência sem duplicar operações", async () => {
  const f = await seed(),
    allowed = await appFixture(f.p, ["groups:manage"]),
    denied = await appFixture(f.p, ["conversations:read"]);
  const payload = { connection_id: f.conn.id, action: "sync" },
    key = uid();
  expect((await denied.request("/groups/actions", payload)).status).toBe(403);
  expect((await allowed.request("/groups/actions", payload, "")).status).toBe(
    400,
  );
  const first = await allowed.request("/groups/actions", payload, key),
    body = await first.json<any>();
  expect(first.status).toBe(200);
  const replay = await allowed.request("/groups/actions", payload, key);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual(body);
  expect(
    (
      await allowed.request(
        "/groups/actions",
        { ...payload, action: "create", subject: "Equipe" },
        key,
      )
    ).status,
  ).toBe(409);
  expect(
    await all(env, "SELECT id FROM group_operations WHERE profile_id=?", f.p),
  ).toHaveLength(1);
});
it("API de ligações permite assumir chamada livre e isola responsável, sessão e eventos", async () => {
  const f = await seed("meta"),
    a = await appFixture(f.p, [
      "calls:read",
      "calls:write",
      "conversations:write",
    ]),
    b = await appFixture(f.p, [
      "calls:read",
      "calls:write",
      "conversations:write",
    ]);
  await callWebhook(env, f.conn, {
    call: {
      id: uid(),
      event: "connect",
      direction: "USER_INITIATED",
      from: "5511999900001",
      timestamp: "100",
      session: sdp,
    },
  });
  const row = await one(env, "SELECT * FROM calls WHERE profile_id=?", f.p);
  expect((await b.request(`/calls/${row.id}?session=1`)).status).toBe(400);
  const claimed = await a.request(`/calls/${row.id}/claim`, {
    actor: b.actor.id,
  });
  expect(claimed.status).toBe(200);
  expect((await claimed.json<any>()).actor).toBe(a.actor.id);
  expect((await b.request(`/calls/${row.id}`)).status).toBe(404);
  expect((await b.request(`/calls/${row.id}/terminate`, {})).status).toBe(400);
  expect((await (await b.request("/calls")).json<any>()).data).toHaveLength(0);
  expect(
    await visibleEvent(env, b.actor, {
      kind: "call.updated",
      resource_id: row.id,
      payload: JSON.stringify({ conversation_id: row.conversation_id }),
    }),
  ).toBe(false);
});
it("histórico de ligações pagina por data e recebe duração depois do desligamento local", async () => {
  const f = await seed("meta"),
    app = await appFixture(f.p, ["calls:read"]);
  for (const [id, created] of [
    ["z-old", 100],
    ["a-new", 200],
    ["m-tie", 200],
  ] as const)
    await exec(
      env,
      "INSERT INTO calls(id,profile_id,connection_id,conversation_id,external_id,direction,status,created,updated) VALUES(?,?,?,?,?,'inbound','completed',?,?)",
      id + f.p,
      f.p,
      f.conn.id,
      f.c.id,
      id,
      created,
      created,
    );
  const r = await (await app.request("/calls?limit=2")).json<any>();
  expect(r.data.map((x: any) => x.created)).toEqual([200, 200]);
  expect(
    (
      await (
        await app.request(
          "/calls?limit=2&cursor=" + encodeURIComponent(r.next_cursor),
        )
      ).json<any>()
    ).data[0].created,
  ).toBe(100);
  await callWebhook(env, f.conn, {
    call: {
      id: "a-new",
      event: "terminate",
      timestamp: "3",
      duration: 12,
      start_time: "1",
      end_time: "3",
      status: "COMPLETED",
    },
  });
  const row = await one(env, "SELECT * FROM calls WHERE id=?", "a-new" + f.p);
  expect(row.duration).toBe(12);
  expect(row.status).toBe("completed");
  expect(row.ended).toBe(3000);
});
it("webhook de chamada recusa assinatura incorreta e deduplica evento assinado", async () => {
  const f = await seed("meta");
  await setSecret(env, "connection:" + f.conn.id, {
    app_secret: "test-signature",
    token: "fake",
  });
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            field: "calls",
            value: {
              metadata: { phone_number_id: "1234" },
              calls: [
                {
                  id: "signed-" + uid(),
                  direction: "USER_INITIATED",
                  event: "connect",
                  from: "5511999900002",
                  timestamp: "100",
                  session: sdp,
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const url = "https://test/webhooks/meta/" + f.conn.id;
  expect((await SELF.fetch(url, { method: "POST", body })).status).toBe(403);
  const headers = {
    "X-Hub-Signature-256": "sha256=" + (await hmac("test-signature", body)),
  };
  expect(
    (await SELF.fetch(url, { method: "POST", body, headers })).status,
  ).toBe(200);
  expect(
    (await SELF.fetch(url, { method: "POST", body, headers })).status,
  ).toBe(200);
  expect(
    await all(env, "SELECT * FROM calls WHERE profile_id=?", f.p),
  ).toHaveLength(1);
  expect(
    await all(
      env,
      "SELECT * FROM call_events WHERE connection_id=?",
      f.conn.id,
    ),
  ).toHaveLength(1);
});
it("envios abandonados expiram e arquivos concluídos antes de interrupção são recuperados", async () => {
  const f = await seed(),
    a = await uploadCommand(env, admin, f.p, "upload.create", {
      name: "documento.txt",
      type: "text/plain",
      size: 4,
    }),
    b = await uploadCommand(env, admin, f.p, "upload.create", {
      name: "salvo.txt",
      type: "text/plain",
      size: 4,
    });
  const row = await one(env, "SELECT * FROM media_uploads WHERE id=?", b.id);
  const up = env.MEDIA.resumeMultipartUpload(row.object_key, row.upload_id);
  await up.complete([await up.uploadPart(1, new TextEncoder().encode("test"))]);
  await exec(env, "UPDATE media_uploads SET created=0 WHERE profile_id=?", f.p);
  await expireUploads(env, f.p);
  await expireUploads(env, f.p);
  expect(
    (await one(env, "SELECT status FROM media_uploads WHERE id=?", a.id))
      .status,
  ).toBe("expired");
  expect(
    (await one(env, "SELECT status FROM media_uploads WHERE id=?", b.id))
      .status,
  ).toBe("complete");
  expect((await authorizedMedia(env, admin, f.p, b.id)).size).toBe(4);
});
