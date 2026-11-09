import { all, one, exec } from "./db";
import { access, sha } from "./security";
import { Actor, ApiError, Env, now, uid, requireValue } from "./types";
import { visibleConversation } from "./visibility";
import { configured,canonicalActor } from './managed';

export const MEDIA_MAX = 100 * 1024 * 1024;
export const PART_SIZE = 5 * 1024 * 1024;
export async function expireUploads(env: Env, profile: string) {
  for (const row of await all(
    env,
    "SELECT * FROM media_uploads WHERE profile_id=? AND status='uploading' AND created<? LIMIT 10",
    profile,
    now() - 86400000,
  )) {
    // Recover a completed object if the process stopped before persisting its receipt.
    const object = await env.MEDIA.head(row.object_key);
    if (object?.size === row.size) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(
          row.id,
          profile,
          row.name,
          row.type,
          row.size,
          row.object_key,
          row.actor,
          now(),
        ),
        env.DB.prepare(
          "UPDATE media_uploads SET status='complete' WHERE id=?",
        ).bind(row.id),
      ]);
    } else {
      await env.MEDIA.resumeMultipartUpload(
        row.object_key,
        row.upload_id,
      ).abort();
      await exec(
        env,
        "UPDATE media_uploads SET status='expired' WHERE id=?",
        row.id,
      );
    }
  }
}
export async function putStream(
  env: Env,
  key: string,
  type: string,
  response: Response,
) {
  requireValue(response.ok && response.body, "Arquivo indisponível.");
  const length = Number(response.headers.get("Content-Length") || 0);
  requireValue(length <= MEDIA_MAX, "Arquivo excede 100 MB.");
  if (length > 0) {
    const fixed = new FixedLengthStream(length);
    await Promise.all([
      response.body.pipeTo(fixed.writable),
      env.MEDIA.put(key, fixed.readable, {
        httpMetadata: { contentType: type },
      }),
    ]);
    return length;
  }
  const upload = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: type },
    }),
    parts: R2UploadedPart[] = [];
  const reader = response.body.getReader();
  let pending = new Uint8Array(0),
    size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MEDIA_MAX)
        throw new ApiError(413, "file_too_large", "Arquivo excede 100 MB.");
      const merged = new Uint8Array(pending.length + next.value.length);
      merged.set(pending);
      merged.set(next.value, pending.length);
      pending = merged;
      while (pending.length >= PART_SIZE) {
        parts.push(
          await upload.uploadPart(
            parts.length + 1,
            pending.slice(0, PART_SIZE),
          ),
        );
        pending = pending.slice(PART_SIZE);
      }
    }
    if (pending.length)
      parts.push(await upload.uploadPart(parts.length + 1, pending));
    requireValue(size > 0, "Arquivo vazio.");
    await upload.complete(parts);
    return size;
  } catch (e) {
    await reader.cancel().catch(() => {});
    await upload.abort().catch(() => {});
    throw e;
  }
}
export function multipartStream(
  fields: Record<string, string>,
  name: string,
  filename: string,
  type: string,
  file: ReadableStream<Uint8Array>,
  size: number,
) {
  const boundary = "wabotia-" + uid(),
    encoder = new TextEncoder();
  const start = encoder.encode(
    Object.entries(fields)
      .map(
        ([k, v]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      )
      .join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename.replace(/["\r\n\\]/g, "_")}"\r\nContent-Type: ${type.replace(/[\r\n]/g, "")}\r\n\r\n`,
  );
  const end = encoder.encode(`\r\n--${boundary}--\r\n`),
    reader = file.getReader();
  let phase = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!phase) {
        phase = 1;
        controller.enqueue(start);
        return;
      }
      const next = await reader.read();
      if (!next.done) controller.enqueue(next.value);
      else {
        controller.enqueue(end);
        controller.close();
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return {
    stream,
    length: start.length + size + end.length,
    type: `multipart/form-data; boundary=${boundary}`,
  };
}
export function mediaKind(mime: string) {
  const m = mime.toLowerCase().split(";")[0].trim();
  return m === "image/webp"
    ? "sticker"
    : m.startsWith("image/")
      ? "image"
      : m.startsWith("video/")
        ? "video"
        : m.startsWith("audio/")
          ? "audio"
          : "document";
}
export async function authorizedMedia(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  const row = await one(
    env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (actor.fagoo && row) {
    const links=await all(env,"SELECT DISTINCT c.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.profile_id=? AND EXISTS(SELECT 1 FROM json_each(m.attachments) WHERE value=?)",profile,id);
    if(configured(actor) || (links.length ? links.some(c=>visibleConversation(actor,c)) : canonicalActor(actor,row.actor)===actor.id)) return row;
    throw new ApiError(404,'not_found','Arquivo não encontrado ou sem permissão.');
  }
  let allowed = !!row && (actor.kind !== "app" || row.actor === actor.id);
  if (row && !allowed && actor.scopes.includes("conversations:read")) {
    const links = await all(
      env,
      "SELECT DISTINCT c.external_namespace FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.profile_id=? AND m.direction!='note' AND EXISTS(SELECT 1 FROM json_each(m.attachments) WHERE value=?)",
      profile,
      id,
    );
    allowed = links.some((c) => visibleConversation(actor, c));
  }
  if (!allowed)
    throw new ApiError(
      404,
      "not_found",
      "Arquivo não encontrado ou sem permissão.",
    );
  return row;
}
export async function mediaResponse(env: Env, row: any, request: Request) {
  const range = request.headers.get("Range");
  let offset = 0,
    length = row.size;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${row.size}` },
      });
    offset = m[1] ? Number(m[1]) : Math.max(0, row.size - Number(m[2]));
    const end =
      m[1] && m[2] ? Math.min(Number(m[2]), row.size - 1) : row.size - 1;
    if (
      !Number.isSafeInteger(offset) ||
      offset > end ||
      offset >= row.size ||
      (!m[1] && Number(m[2]) === 0)
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${row.size}` },
      });
    length = end - offset + 1;
  }
  const obj = await env.MEDIA.get(
    row.object_key,
    range ? { range: { offset, length } } : undefined,
  );
  if (!obj) throw new ApiError(404, "not_found", "Arquivo ausente.");
  const inline =
    new URL(request.url).searchParams.get("inline") === "1" &&
    /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|wav|webm)|video\/(mp4|webm|3gpp))(;|$)/i.test(
      row.type,
    );
  return new Response(obj.body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": row.type,
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      ...(range
        ? {
            "Content-Range": `bytes ${offset}-${offset + length - 1}/${row.size}`,
          }
        : {}),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
export async function uploadCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
) {
  access(actor, profile, "media:write");
  if (op === "upload.create") {
    await expireUploads(env, profile);
    requireValue(
      Number.isInteger(data.size) && data.size > 0 && data.size <= MEDIA_MAX,
      "Envie até 100 MB por arquivo.",
    );
    requireValue(
      typeof data.name === "string" &&
        data.name.length > 0 &&
        data.name.length <= 200,
      "Nome de arquivo inválido.",
    );
    requireValue(
      typeof data.type === "string" &&
        /^[\w.+-]+\/[\w.+-]+(?:;[\w =.-]+)?$/.test(data.type),
      "Tipo de arquivo inválido.",
    );
    const pending = await one(
      env,
      "SELECT count(*) n FROM media_uploads WHERE actor=? AND status='uploading'",
      actor.id,
    );
    requireValue(
      pending.n < 5,
      "Conclua ou cancele os envios pendentes antes de enviar mais arquivos.",
    );
    const id = uid(),
      key = `${profile}/${id}`;
    const upload = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: data.type },
    });
    await exec(
      env,
      "INSERT INTO media_uploads(id,profile_id,actor,name,type,size,object_key,upload_id,created) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      profile,
      actor.id,
      data.name,
      data.type,
      data.size,
      key,
      upload.uploadId,
      now(),
    );
    return {
      id,
      part_size: PART_SIZE,
      parts: Math.ceil(data.size / PART_SIZE),
    };
  }
  const row = await ownedUpload(env, actor, profile, data.id);
  if (op === "upload.abort") {
    requireValue(row.status !== "complete", "Este arquivo já foi concluído.");
    await env.MEDIA.resumeMultipartUpload(
      row.object_key,
      row.upload_id,
    ).abort();
    await exec(
      env,
      "UPDATE media_uploads SET status='aborted' WHERE id=?",
      row.id,
    );
    return { id: row.id, status: "aborted" };
  }
  if (row.status === "complete")
    return { id: row.id, name: row.name, size: row.size };
  requireValue(row.status === "uploading", "Envio cancelado.");
  const parts = await all(
    env,
    "SELECT * FROM media_parts WHERE upload_id=? ORDER BY part",
    row.id,
  );
  requireValue(
    parts.length === Math.ceil(row.size / PART_SIZE) &&
      parts.every((p, i) => p.etag && p.part === i + 1) &&
      parts.reduce((s, p) => s + p.size, 0) === row.size,
    "Envie todas as partes antes de concluir.",
  );
  // Complete is recoverable after R2 has committed but before the D1 receipt.
  if (!(await env.MEDIA.head(row.object_key)))
    await env.MEDIA.resumeMultipartUpload(
      row.object_key,
      row.upload_id,
    ).complete(parts.map((p) => ({ partNumber: p.part, etag: p.etag })));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      row.id,
      profile,
      row.name,
      row.type,
      row.size,
      row.object_key,
      actor.id,
      now(),
    ),
    env.DB.prepare(
      "UPDATE media_uploads SET status='complete' WHERE id=?",
    ).bind(row.id),
  ]);
  return { id: row.id, name: row.name, size: row.size };
}
export async function ownedUpload(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  const row = await one(
    env,
    "SELECT * FROM media_uploads WHERE id=? AND profile_id=? AND actor=?",
    id,
    profile,
    actor.id,
  );
  if (!row) throw new ApiError(404, "not_found", "Envio não encontrado.");
  return row;
}
export async function uploadPart(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
  part: number,
  request: Request,
) {
  access(actor, profile, "media:write");
  requireValue(
    !!request.headers.get("Idempotency-Key"),
    "Envie Idempotency-Key. A identidade de cada parte é upload + número.",
  );
  const row = await ownedUpload(env, actor, profile, id);
  requireValue(
    ["uploading", "complete"].includes(row.status),
    "O envio não está aberto.",
  );
  requireValue(
    Number.isInteger(part) &&
      part > 0 &&
      part <= Math.ceil(row.size / PART_SIZE),
    "Parte inválida.",
  );
  const bytes = await request.arrayBuffer();
  requireValue(
    bytes.byteLength === Math.min(PART_SIZE, row.size - (part - 1) * PART_SIZE),
    "Tamanho da parte incorreto.",
  );
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO media_parts(upload_id,part,digest,size) VALUES(?,?,?,?)",
  )
    .bind(id, part, digest, bytes.byteLength)
    .run();
  if (!inserted.meta.changes) {
    const old = await one(
      env,
      "SELECT * FROM media_parts WHERE upload_id=? AND part=?",
      id,
      part,
    );
    if (old.digest !== digest)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Esta parte já recebeu outro conteúdo.",
      );
    if (!old.etag)
      throw new ApiError(
        409,
        "upload_part_unknown",
        "Envio anterior sem confirmação. Cancele este envio e inicie outro.",
      );
    return { part, received: true };
  }
  const sent = await env.MEDIA.resumeMultipartUpload(
    row.object_key,
    row.upload_id,
  ).uploadPart(part, bytes);
  await exec(
    env,
    "UPDATE media_parts SET etag=? WHERE upload_id=? AND part=?",
    sent.etag,
    id,
    part,
  );
  return { part, received: true };
}
