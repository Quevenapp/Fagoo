import test from "node:test";
import assert from "node:assert/strict";
import {
  messageContent,
  decodeMessage,
  groupOperation,
  ownIdentities,
  isOwnParticipant,
} from "../connectors/qr/features.mjs";
test("QR preserva vídeo, voz, figurinha e citação nativa", () => {
  const media = {
    bytes: Buffer.from("test"),
    type: "video/mp4",
    name: "video.mp4",
  };
  const video = messageContent(
    {
      destination: "g@g.us",
      text: "Legenda",
      content: {
        type: "video",
        reply_external_id: "q",
        reply_from_me: false,
        reply_participant: "p",
        reply_text: "Origem",
      },
    },
    media,
  );
  assert.equal(video.content.video, media.bytes);
  assert.equal(video.content.caption, "Legenda");
  assert.equal(video.options.quoted.key.id, "q");
  const voice = messageContent(
    { content: { type: "voice" } },
    { ...media, type: "audio/ogg" },
  );
  assert.equal(voice.content.ptt, true);
  assert.ok(voice.content.audio);
  assert.ok(
    messageContent(
      { content: { type: "sticker" } },
      { ...media, type: "image/webp" },
    ).content.sticker,
  );
});
test("QR decodifica participante de grupo, menções, citação e voz", () => {
  const decoded = decodeMessage(
    {
      key: { remoteJid: "g@g.us", participant: "p", id: "1" },
      pushName: "Pessoa",
    },
    {
      audioMessage: {
        ptt: true,
        mimetype: "audio/ogg",
        contextInfo: { stanzaId: "q", mentionedJid: ["bot"] },
      },
    },
    "bot",
  );
  assert.equal(decoded.payload.external_id, "g@g.us");
  assert.equal(decoded.payload.phone, null);
  assert.equal(decoded.payload.content.type, "voice");
  assert.equal(decoded.payload.content.participant, "p");
  assert.equal(decoded.payload.content.mentioned, true);
  assert.equal(decoded.payload.content.reply_external_id, "q");
});
test("QR edição, reação e revogação são eventos do alvo", () => {
  const m = { key: { remoteJid: "p", id: "e" }, messageTimestamp: 100 };
  assert.equal(
    decodeMessage(
      m,
      { reactionMessage: { key: { id: "target" }, text: "👍" } },
      "",
    ).payload.message_id,
    "target",
  );
  assert.equal(
    decodeMessage(
      m,
      { protocolMessage: { type: 0, key: { id: "target" } } },
      "",
    ).payload.event,
    "delete",
  );
  assert.equal(
    decodeMessage(
      m,
      {
        protocolMessage: {
          type: 14,
          key: { id: "target" },
          editedMessage: { conversation: "editada" },
        },
      },
      "",
    ).payload.text,
    "editada",
  );
});
test("QR preserva identidade do alvo ao marcar como lida e reagir", () => {
  const result = messageContent({
    destination: "g@g.us",
    content: {
      type: "reaction",
      target_external_id: "m",
      participant: "p",
      emoji: "",
      from_me: false,
    },
  });
  assert.deepEqual(result.content.react, {
    text: "",
    key: { id: "m", fromMe: false, remoteJid: "g@g.us", participant: "p" },
  });
});
test("sincronização de grupos usa a mesma sessão e informa administradores", async () => {
  const groups = [
      {
        id: "g",
        subject: "Equipe",
        participants: [{ id: "p", admin: "admin" }],
      },
    ],
    seen = [];
  const result = await groupOperation(
    { groupFetchAllParticipating: async () => ({ g: groups[0] }) },
    { action: "sync" },
    async (g) => seen.push(g),
  );
  assert.equal(result.count, 1);
  assert.equal(seen[0].participants[0].admin, "admin");
});
test("QR reconhece a própria conta por telefone ou LID sem sufixo de dispositivo", () => {
  const own = ownIdentities({
    id: "5511999990000:2@s.whatsapp.net",
    lid: "12345:2@lid",
  });
  assert.ok(isOwnParticipant({ id: "12345@lid" }, own));
  assert.ok(
    isOwnParticipant(
      { id: "other@lid", phoneNumber: "5511999990000@s.whatsapp.net" },
      own,
    ),
  );
  const result = decodeMessage(
    { key: { remoteJid: "g@g.us", id: "x" } },
    {
      extendedTextMessage: {
        text: "Olá",
        contextInfo: { mentionedJid: ["12345@lid"] },
      },
    },
    own,
  );
  assert.equal(result.payload.content.mentioned, true);
});
