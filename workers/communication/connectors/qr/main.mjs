import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { createWriteStream, openAsBlob } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import {
  features,
  messageContent,
  decodeMessage,
  groupOperation,
  ownIdentities,
  isOwnParticipant,
} from "./features.mjs";
const base = new URL(process.env.WABOTIA_URL || "");
if (
  base.protocol !== "https:" ||
  !process.env.WABOTIA_CONNECTION_ID ||
  !process.env.WABOTIA_CONNECTOR_TOKEN
)
  throw Error("Preencha a URL HTTPS, ID e chave do conector no .env.");
const root = path.resolve(process.env.WABOTIA_DATA || "./data");
await mkdir(root, { recursive: true, mode: 0o700 });
const lock = path.join(root, "process.lock");
try {
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
} catch {
  const pid = Number(await readFile(lock, "utf8"));
  let running = true;
  try {
    process.kill(pid, 0);
  } catch {
    running = false;
  }
  if (running) throw Error("Já existe um conector utilizando estes dados.");
  await unlink(lock);
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
}
const db = new DatabaseSync(path.join(root, "journal.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS incoming(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending'); CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,status TEXT NOT NULL,external_id TEXT,error TEXT,reported INTEGER DEFAULT 0);",
);
db.prepare(
  "UPDATE commands SET status='unknown',error='Processo interrompido durante envio' WHERE status='sending'",
).run();
if (
  !db
    .prepare("PRAGMA table_info(commands)")
    .all()
    .some((c) => c.name === "result")
)
  db.exec("ALTER TABLE commands ADD COLUMN result TEXT");
const prefix = `${base.origin}/internal/v1/connectors/${encodeURIComponent(process.env.WABOTIA_CONNECTION_ID)}`;
async function api(route, body, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(prefix + route, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.WABOTIA_CONNECTOR_TOKEN,
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error("Wabotia HTTP " + r.status);
  return r;
}
const logger = pino({ level: "silent" });
let socket,
  online = false,
  stopped = false,
  lastHeartbeat = 0;
function queue(payload) {
  db.prepare("INSERT OR IGNORE INTO incoming(id,payload) VALUES(?,?)").run(
    payload.event
      ? `${payload.external_id}:${payload.event}:${payload.message_id}:${payload.event_id || randomUUID()}`
      : `${payload.external_id}:${payload.message_id}`,
    JSON.stringify(payload),
  );
}
async function reportGroup(g, extra = {}) {
  const identities = ownIdentities(socket.user);
  const participants = g.participants.map((p) => ({
    id: p.id,
    name: p.name || "",
    admin: !!p.admin,
  }));
  queue({
    event: "group",
    external_id: g.id,
    message_id: g.id,
    subject: g.subject,
    description: g.desc || "",
    participants,
    own_admin: g.participants.some(
      (p) => isOwnParticipant(p, identities) && p.admin,
    ),
    announcement: !!g.announce,
    ...extra,
  });
}
const heartbeat = (state, extra = {}) =>
  api("/status", { state, protocol_version: 2, features, ...extra });
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(root, "session"),
  );
  socket = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async (update) => {
    try {
      if (update.qr) {
        console.log("QR disponível em Conexões no painel Wabotia.");
        await heartbeat("awaiting_qr", {
          qr: await QRCode.toDataURL(update.qr, { width: 300 }),
        });
      }
      if (update.connection === "open") {
        online = true;
        console.log("WhatsApp conectado.");
        await heartbeat("connected", { qr: null });
      }
      if (update.connection === "close") {
        online = false;
        if (
          update.lastDisconnect?.error?.output?.statusCode ===
          DisconnectReason.loggedOut
        ) {
          console.error(
            "Sessão desconectada no WhatsApp. Preserve o diário; renomeie apenas a pasta session para parear novamente.",
          );
          stopped = true;
        } else if (!stopped)
          setTimeout(
            () => connect().catch(() => console.error("Falha ao reconectar")),
            5000,
          );
      }
    } catch {
      console.error("Não foi possível atualizar estado no Wabotia.");
    }
  });
  socket.ev.on("groups.update", async (groups) => {
    for (const g of groups)
      try {
        await reportGroup(await socket.groupMetadata(g.id));
      } catch {
        console.error(
          "Não foi possível atualizar dados do grupo. Use Atualizar grupo no painel.",
        );
      }
  });
  socket.ev.on("group-participants.update", async (g) => {
    try {
      await reportGroup(await socket.groupMetadata(g.id));
    } catch {
      console.error("Atualização de participantes pendente.");
    }
  });
  socket.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      const status = {
        0: "failed",
        2: "sent",
        3: "delivered",
        4: "read",
        5: "played",
      }[update.status];
      if (status)
        queue({
          event: "status",
          external_id: key.remoteJid,
          message_id: key.id,
          status,
          timestamp: Date.now(),
        });
      if (update.message?.protocolMessage) {
        const decoded = decodeMessage(
          { key, messageTimestamp: Date.now() / 1000 },
          update.message,
          "",
        );
        queue(decoded.payload);
      }
    }
  });
  socket.ev.on("message-receipt.update", (updates) => {
    for (const { key, receipt } of updates)
      queue({
        event: "status",
        external_id: key.remoteJid,
        message_id: key.id,
        participant: receipt.userJid,
        status: receipt.playedTimestamp
          ? "played"
          : receipt.readTimestamp
            ? "read"
            : "delivered",
        timestamp:
          Number(
            receipt.playedTimestamp ||
              receipt.readTimestamp ||
              receipt.receiptTimestamp,
          ) * 1000 || Date.now(),
      });
  });
  socket.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      try {
        if (
          !m.key.id ||
          !m.message ||
          m.key.remoteJid === "status@broadcast" ||
          m.key.remoteJid?.endsWith("@newsletter")
        )
          continue;
        const content = normalizeMessageContent(m.message);
        if (!content) continue;
        if (
          m.key.fromMe &&
          !content.reactionMessage &&
          !content.protocolMessage
        )
          continue;
        const dest = m.key.remoteJid,
          id = dest + ":" + m.key.id;
        if (db.prepare("SELECT id FROM incoming WHERE id=?").get(id)) continue;
        // Offline deliveries arrive as append; journal IDs deduplicate the replay.
        const { payload, media } = decodeMessage(
          m,
          content,
          ownIdentities(socket.user),
        );
        if (payload.chat_type === "group")
          try {
            await reportGroup(await socket.groupMetadata(dest));
          } catch {}
        if (media) {
          if (Number(media.fileLength || 0) > 100 * 1024 * 1024)
            payload.text +=
              "\n[Anexo maior que 100 MB. Solicite arquivo menor.]";
          else {
            const name = createHash("sha256").update(id).digest("hex");
            try {
              const stream = await downloadMediaMessage(
                m,
                "stream",
                {},
                { logger, reuploadRequest: socket.updateMediaMessage },
              );
              let size = 0;
              await pipeline(
                stream,
                new Transform({
                  transform(chunk, encoding, callback) {
                    size += chunk.length;
                    callback(
                      size > 100 * 1024 * 1024 ? Error("Arquivo grande") : null,
                      chunk,
                    );
                  },
                }),
                createWriteStream(path.join(root, name), { mode: 0o600 }),
              );
              payload.local_media = {
                path: name,
                name:
                  media.fileName ||
                  `anexo.${{ image: "jpg", video: "mp4", voice: "ogg", audio: "ogg", sticker: "webp" }[payload.content.type] || "bin"}`,
                type: media.mimetype || "application/octet-stream",
              };
            } catch {
              await unlink(path.join(root, name)).catch(() => {});
              payload.text +=
                "\n[Não foi possível baixar o anexo. Solicite reenvio.]";
              payload.content.media_error = true;
            }
          }
        }
        queue(payload);
      } catch {
        console.error(
          "Falha ao registrar entrada; confira o diário local antes de reiniciar.",
        );
      }
    }
  });
}
async function tick() {
  for (const row of db
    .prepare(
      "SELECT * FROM incoming WHERE status='pending' ORDER BY rowid LIMIT 10",
    )
    .all()) {
    const payload = JSON.parse(row.payload);
    if (payload.local_media && !payload.attachments.length) {
      const m = payload.local_media,
        file = await openAsBlob(path.join(root, m.path), { type: m.type });
      const response = await fetch(prefix + "/media-content", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.WABOTIA_CONNECTOR_TOKEN,
          "Content-Type": m.type,
          "Content-Length": String(file.size),
          "X-Filename": encodeURIComponent(m.name),
          "Idempotency-Key": m.path,
        },
        body: file,
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok)
        throw Error("Falha ao enviar anexo: " + response.status);
      payload.attachments = [(await response.json()).id];
      db.prepare("UPDATE incoming SET payload=? WHERE id=?").run(
        JSON.stringify(payload),
        row.id,
      );
    }
    await api("/events", payload);
    db.prepare("UPDATE incoming SET status='done' WHERE id=?").run(row.id);
    if (payload.local_media)
      await unlink(path.join(root, payload.local_media.path)).catch(() => {});
  }
  if (!online) return;
  if (Date.now() - lastHeartbeat > 30000) {
    await heartbeat("connected", { qr: null });
    lastHeartbeat = Date.now();
  }
  const { commands } = await (await api("/commands")).json();
  for (const cmd of commands) {
    const old = db.prepare("SELECT * FROM commands WHERE id=?").get(cmd.id);
    if (old) {
      await api("/receipts", {
        ...old,
        result: JSON.parse(old.result || "{}"),
      });
      continue;
    }
    const check = await (await api(`/commands/${cmd.id}/check`, {})).json();
    if (!check.valid) continue;
    db.prepare("INSERT INTO commands(id,status) VALUES(?,'sending')").run(
      cmd.id,
    );
    try {
      let sent,
        result = {};
      if (cmd.kind === "group") {
        result = await groupOperation(socket, cmd.payload, reportGroup);
        sent = { key: { id: result.id || "group:" + cmd.id } };
      } else {
        let media;
        if (cmd.payload.media_id) {
          const r = await api(
            "/media/" + encodeURIComponent(cmd.payload.media_id),
          );
          media = {
            bytes: Buffer.from(await r.arrayBuffer()),
            type: r.headers.get("Content-Type"),
            name: decodeURIComponent(r.headers.get("X-Filename") || "anexo"),
          };
        }
        if (
          !(await (await api(`/commands/${cmd.id}/check`, {})).json()).valid
        ) {
          db.prepare("UPDATE commands SET status='cancelled' WHERE id=?").run(
            cmd.id,
          );
          continue;
        }
        const built = messageContent(
          { ...cmd.payload, destination: cmd.destination },
          media,
        );
        if (cmd.payload.content?.type === "read") {
          await socket.readMessages([built.key]);
          sent = { key: { id: cmd.payload.content.target_external_id } };
        } else
          sent = await socket.sendMessage(
            cmd.destination,
            built.content,
            built.options,
          );
      }
      if (!sent?.key?.id) throw Error("Sem recibo");
      db.prepare(
        "UPDATE commands SET status='sent',external_id=?,result=? WHERE id=?",
      ).run(sent.key.id, JSON.stringify(result), cmd.id);
    } catch {
      db.prepare(
        "UPDATE commands SET status='unknown',error='Envio sem confirmação; confira no WhatsApp antes de reconciliar' WHERE id=?",
      ).run(cmd.id);
    }
    const receipt = db.prepare("SELECT * FROM commands WHERE id=?").get(cmd.id);
    await api("/receipts", {
      ...receipt,
      result: JSON.parse(receipt.result || "{}"),
    });
  }
  // Deliver positive receipts lost after the provider confirmed the message.
  for (const row of db
    .prepare(
      "SELECT * FROM commands WHERE status IN ('sent','unknown') AND reported=0 LIMIT 20",
    )
    .all()) {
    await api("/receipts", { ...row, result: JSON.parse(row.result || "{}") });
    db.prepare("UPDATE commands SET reported=1 WHERE id=?").run(row.id);
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    stopped = true;
    online = false;
    socket?.end(undefined);
    db.close();
    await unlink(lock).catch(() => {});
    process.exit(0);
  });
await connect();
while (!stopped) {
  try {
    await tick();
  } catch {
    console.error(
      "Conexão indisponível. Diário preservado; tentando novamente em 3 segundos.",
    );
  }
  await new Promise((r) => setTimeout(r, 3000));
}
