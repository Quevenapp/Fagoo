export const features = [
  "image",
  "video",
  "audio",
  "voice",
  "sticker",
  "reply",
  "reaction",
  "location",
  "contacts",
  "read",
  "edit",
  "delete",
  "groups",
  "mentions",
];
export const jid = (p) =>
  p.includes("@") ? p : p.replace(/^\+/, "") + "@s.whatsapp.net";
export function messageContent(payload, media) {
  const c = payload.content || {},
    kind = c.type || "text";
  let content = { text: payload.text || "" };
  if (media) {
    const type =
      kind === "text"
        ? media.type.startsWith("image/")
          ? "image"
          : media.type.startsWith("video/")
            ? "video"
            : media.type.startsWith("audio/")
              ? "audio"
              : "document"
        : kind;
    const key = type === "voice" ? "audio" : type;
    content = {
      [key]: media.bytes,
      mimetype: media.type,
      ...(["image", "video", "document"].includes(key)
        ? { caption: payload.text || "" }
        : {}),
      ...(key === "document" ? { fileName: media.name } : {}),
      ...(key === "audio" ? { ptt: type === "voice" } : {}),
    };
  }
  if (kind === "location")
    content = {
      location: {
        degreesLatitude: c.location.latitude,
        degreesLongitude: c.location.longitude,
        name: c.location.name,
        address: c.location.address,
      },
    };
  if (kind === "contacts")
    content = {
      contacts: {
        displayName: c.contacts[0].name,
        contacts: c.contacts.map((x) => ({
          displayName: x.name,
          vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${x.name.replace(/[\r\n;\\]/g, " ")}\nTEL;type=CELL;type=VOICE;waid=${x.phone.replace(/\D/g, "")}:${x.phone}\nEND:VCARD`,
        })),
      },
    };
  const key = {
    id: c.target_external_id,
    fromMe: !!c.from_me,
    remoteJid: payload.destination,
    ...(c.participant ? { participant: c.participant } : {}),
  };
  if (kind === "reaction") content = { react: { text: c.emoji, key } };
  if (kind === "delete") content = { delete: key };
  if (kind === "edit") content = { text: c.text, edit: key };
  if (c.mentions?.length) content.mentions = c.mentions;
  const options = c.reply_external_id
    ? {
        quoted: {
          key: {
            remoteJid: payload.destination,
            id: c.reply_external_id,
            fromMe: !!c.reply_from_me,
            ...(c.reply_participant
              ? { participant: c.reply_participant }
              : {}),
          },
          message: { conversation: c.reply_text || "" },
        },
      }
    : {};
  return { content, options, key };
}
// Baileys v7 can identify the same account by phone JID or private LID.
export const normalizedJid = (id = "") => id.replace(/:\d+(?=@)/, "");
export function ownIdentities(user = {}) {
  return [user.id, user.lid].filter(Boolean).map(normalizedJid);
}
export function isOwnParticipant(participant, identities) {
  return [participant.id, participant.phoneNumber, participant.lid]
    .filter(Boolean)
    .some((id) => identities.includes(normalizedJid(id)));
}
export function decodeMessage(m, content, ownJid) {
  const identities = (Array.isArray(ownJid) ? ownJid : [ownJid]).map(
    normalizedJid,
  );
  const chat = m.key.remoteJid,
    group = chat?.endsWith("@g.us"),
    participant =
      m.key.participant ||
      m.key.participantAlt ||
      (group ? "" : m.key.remoteJidAlt || chat);
  const media =
    content.imageMessage ||
    content.audioMessage ||
    content.videoMessage ||
    content.documentMessage ||
    content.stickerMessage;
  const context =
    content.extendedTextMessage?.contextInfo || media?.contextInfo || {};
  let type = content.imageMessage
    ? "image"
    : content.audioMessage
      ? content.audioMessage.ptt
        ? "voice"
        : "audio"
      : content.videoMessage
        ? "video"
        : content.documentMessage
          ? "document"
          : content.stickerMessage
            ? "sticker"
            : content.locationMessage
              ? "location"
              : content.contactMessage || content.contactsArrayMessage
                ? "contacts"
                : "text";
  const metadata = {
    type,
    participant,
    participant_name: m.pushName || participant,
    reply_external_id: context.stanzaId || null,
    mentions: context.mentionedJid || [],
    mentioned: (context.mentionedJid || []).some((id) =>
      identities.includes(normalizedJid(id)),
    ),
    ...(content.locationMessage
      ? {
          location: {
            latitude: content.locationMessage.degreesLatitude,
            longitude: content.locationMessage.degreesLongitude,
            name: content.locationMessage.name,
            address: content.locationMessage.address,
          },
        }
      : {}),
  };
  if (type === "contacts")
    metadata.contacts = (
      content.contactsArrayMessage?.contacts || [content.contactMessage]
    )
      .filter(Boolean)
      .map((x) => ({
        name: x.displayName || "Contato",
        phone: (x.vcard?.match(/TEL[^:]*:([^\n\r]+)/) || [])[1] || "",
        vcard: x.vcard,
      }));
  const payload = {
    external_id: chat,
    phone: group ? null : (m.key.remoteJidAlt || chat).split("@")[0],
    chat_type: group ? "group" : "direct",
    message_id: m.key.id,
    text:
      content.conversation ||
      content.extendedTextMessage?.text ||
      media?.caption ||
      "",
    attachments: [],
    content: metadata,
  };
  if (content.reactionMessage)
    return {
      payload: {
        event: "reaction",
        external_id: chat,
        message_id: content.reactionMessage.key.id,
        participant,
        event_id: m.key.id,
        emoji: content.reactionMessage.text,
        timestamp:
          Number(content.reactionMessage.senderTimestampMs) || Date.now(),
      },
    };
  if (
    content.protocolMessage?.key &&
    (content.protocolMessage.type === 0 || content.protocolMessage.type === 14)
  )
    return {
      payload: {
        event: content.protocolMessage.type === 0 ? "delete" : "edit",
        external_id: chat,
        message_id: content.protocolMessage.key.id,
        event_id: m.key.id,
        participant,
        text:
          content.protocolMessage.editedMessage?.conversation ||
          content.protocolMessage.editedMessage?.extendedTextMessage?.text ||
          "",
        timestamp: Number(m.messageTimestamp) * 1000 || Date.now(),
      },
    };
  return { payload, media };
}
export async function groupOperation(socket, p, report) {
  let destination = p.destination,
    result = {};
  if (p.action === "sync") {
    const groups = Object.values(await socket.groupFetchAllParticipating());
    for (const g of groups) await report(g);
    return { count: groups.length };
  }
  if (p.action === "create") {
    const g = await socket.groupCreate(p.subject, p.participants.map(jid));
    destination = g.id;
    result = { id: g.id };
  }
  if (p.action === "join") {
    destination = await socket.groupAcceptInvite(p.invite);
    result = { id: destination };
  }
  if (p.action === "subject")
    await socket.groupUpdateSubject(destination, p.subject);
  if (p.action === "description")
    await socket.groupUpdateDescription(destination, p.description);
  if (p.action === "announcement")
    await socket.groupSettingUpdate(
      destination,
      p.enabled ? "announcement" : "not_announcement",
    );
  if (p.action === "participants")
    result = {
      participants: await socket.groupParticipantsUpdate(
        destination,
        p.participants.map(jid),
        p.operation,
      ),
    };
  if (p.action === "invite")
    result = {
      invite_link:
        "https://chat.whatsapp.com/" +
        (await socket.groupInviteCode(destination)),
    };
  if (p.action === "leave") {
    await socket.groupLeave(destination);
    return { left: true };
  }
  const group = await socket.groupMetadata(destination);
  await report(group, result);
  return result;
}
