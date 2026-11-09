/// <reference path="./voice.d.ts" />
import React, { useEffect, useRef, useState } from "react";
import {
  Mic,
  Square,
  Paperclip,
  Send,
  Reply,
  Smile,
  MapPin,
  Contact,
  Download,
  X,
} from "lucide-react";
import Recorder from "opus-recorder";
import encoderPath from "opus-recorder/dist/encoderWorker.min.js?url";
import { CallPanel } from "./WhatsAppCalls";
type Row = Record<string, any>;
const parse = (v: any, f: any = {}) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : v || f;
  } catch {
    return f;
  }
};
const statuses: Row = {
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  played: "Ouvida",
  pending: "Na fila",
  sending: "Enviando",
  failed: "Falhou",
  unknown: "Sem confirmação",
  cancelled: "Cancelada",
};
export async function uploadFile(
  api: any,
  root: string,
  file: File,
  progress: (n: number) => void,
) {
  if (file.size > 100 * 1024 * 1024)
    throw Error(
      "Cada arquivo pode ter até 100 MB. O canal pode ter limites menores.",
    );
  const upload = await api(root + "/media/uploads", "POST", {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
  });
  try {
    for (let i = 0; i < upload.parts; i++) {
      const response = await (api.raw || fetch)(
        `${api.raw ? "" : "/api/"}${root}/media/uploads/${upload.id}/parts/${i + 1}`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/octet-stream",
            "Idempotency-Key": `${upload.id}:${i + 1}`,
          },
          body: file.slice(i * upload.part_size, (i + 1) * upload.part_size),
        },
      );
      if (!response.ok)
        throw Error(
          ((await response.json()) as any).error?.message ||
            "Não foi possível enviar esta parte.",
        );
      progress(Math.round(((i + 1) / upload.parts) * 100));
    }
    return (
      await api(root + `/media/uploads/${upload.id}/complete`, "POST", {})
    ).id;
  } catch (e) {
    await api(root + `/media/uploads/${upload.id}/abort`, "POST", {}).catch(
      () => {},
    );
    throw e;
  }
}
function MediaView({ file, root, api }: { file: Row; root: string; api:any }) {
  const [objectUrl,setObjectUrl]=useState("");
  useEffect(()=>{if(!api.raw)return; const abort=new AbortController();let object="";api.raw(`${root}/media/${file.id}/content?inline=1`,{signal:abort.signal}).then((r:Response)=>{if(!r.ok)throw Error("Arquivo indisponível");return r.blob();}).then((blob:Blob)=>{if(!abort.signal.aborted){object=URL.createObjectURL(blob);setObjectUrl(object);}}).catch(()=>{});return()=>{abort.abort();if(object)URL.revokeObjectURL(object);setObjectUrl("");};},[api,root,file.id]);
  const url=api.raw?objectUrl:`/api/${root}/media/${file.id}/content`,inline=api.raw?objectUrl:url+"?inline=1";
  if(api.raw && !objectUrl)return <span>Carregando arquivo…</span>;
  return (
    <div className="chat-media">
      {/^(image\/(jpeg|png|webp|gif))/.test(file.type) && (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={inline} alt={file.name} loading="lazy" />
        </a>
      )}
      {file.type.startsWith("video/") && (
        <video controls preload="metadata" src={inline} />
      )}
      {file.type.startsWith("audio/") && (
        <audio controls preload="metadata" src={inline} />
      )}
      <a href={url}>
        <Download size={14} />
        {file.name} <small>({(file.size / 1024 / 1024).toFixed(1)} MB)</small>
      </a>
    </div>
  );
}
export function WhatsAppConversation({
  selection,
  api,
  root,
  me,
  refresh,
  demo,
}: {
  selection: Row;
  api: any;
  root: string;
  me: Row;
  refresh: () => Promise<any>;
  demo: boolean;
}) {
  const [text, setText] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [voice, setVoice] = useState<File | null>(null),
    [recording, setRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [quote, setQuote] = useState<Row | null>(null),
    [kind, setKind] = useState("text"),
    [special, setSpecial] = useState<Row>({}),
    [mentions, setMentions] = useState<string[]>([]),
    [edit, setEdit] = useState<Row | null>(null);
  const recorder = useRef<any>(null),
    key = useRef(crypto.randomUUID()),
    pending = useRef<any>(null),
    mounted = useRef(true),
    c = selection.conversation,
    cap = selection.capabilities || {};
  const own = demo || (c.owner === me.id && c.state === "human");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recorder.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () =>
        setSeconds((n) => {
          if (n >= 119) {
            recorder.current?.stop();
            return n;
          }
          return n + 1;
        }),
      1000,
    );
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (demo) return;
    const timer = setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [c.id, demo]);
  async function act(action: string, body: Row = {}, route = "actions") {
    if (demo) {
      setError("Esta é uma demonstração. Faça os envios na sua instalação.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`${root}/conversations/${c.id}/${route}`, "POST", {
        action,
        ...body,
      });
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function record() {
    setError("");
    try {
      const rec = new Recorder({
        encoderPath,
        numberOfChannels: 1,
        encoderApplication: 2048,
        encoderBitRate: 24000,
      });
      recorder.current = rec;
      rec.ondataavailable = (data: Uint8Array) => {
        if (mounted.current) {
          setVoice(
            new File([data as BlobPart], "mensagem-de-voz.ogg", {
              type: "audio/ogg; codecs=opus",
            }),
          );
          setRecording(false);
        }
        rec.close();
        recorder.current = null;
      };
      await rec.start();
      if (!mounted.current) {
        rec.close();
        return;
      }
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      recorder.current?.close();
      recorder.current = null;
      setRecording(false);
      setError(
        "Não foi possível abrir o microfone. Permita o acesso no navegador e use uma página HTTPS.",
      );
    }
  }
  async function send() {
    if (demo) {
      setError("Demonstração: nenhum envio é realizado.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (edit) {
        await api(
          `${root}/conversations/${c.id}/message-actions`,
          "POST",
          { action: "edit", message_id: edit.id, text },
          undefined,
          key.current,
        );
        setEdit(null);
      } else {
        if (!pending.current) {
          const attachments: string[] = [];
          for (const file of voice ? [voice] : files)
            attachments.push(
              await uploadFile(api, root, file, (n) =>
                setProgress(`Enviando ${file.name}: ${n}%`),
              ),
            );
          const content: any = {
            type: voice ? "voice" : kind,
            ...(quote ? { reply_to: quote.id } : {}),
            ...(mentions.length ? { mentions } : {}),
          };
          if (kind === "location")
            content.location = {
              latitude: Number(special.latitude),
              longitude: Number(special.longitude),
              name: special.name || "",
              address: special.address || "",
            };
          if (kind === "contacts")
            content.contacts = [{ name: special.name, phone: special.phone }];
          pending.current = { action: "reply", text, attachments, content };
        }
        setProgress("Confirmando envio…");
        await api(
          `${root}/conversations/${c.id}/actions`,
          "POST",
          pending.current,
          undefined,
          key.current,
        );
      }
      pending.current = null;
      key.current = crypto.randomUUID();
      setText("");
      setFiles([]);
      setVoice(null);
      setQuote(null);
      setSpecial({});
      setKind("text");
      setMentions([]);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  const members = parse(selection.group?.participants, []);
  return (
    <>
      <CallPanel
        api={api}
        root={root}
        conversation={c}
        enabled={cap.calls}
        me={me}
        refresh={refresh}
        demo={demo}
      />
      {c.chat_type === "group" && (
        <div className="group-strip">
          <strong>Grupo · {members.length} participantes</strong>
          <label>
            Respostas da IA{" "}
            <select
              value={c.bot_policy || "mentions"}
              disabled={busy || demo}
              onChange={async (e) => {
                setBusy(true);
                try {
                  await api(`${root}/groups/${c.id}/policy`, "PUT", {
                    bot_policy: e.target.value,
                  });
                  await refresh();
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <option value="off">Somente atendimento humano</option>
              <option value="mentions">Quando mencionada ou /bot</option>
              <option value="all">Todas as mensagens</option>
            </select>
          </label>
          <small>
            {selection.group?.announcement
              ? "Somente administradores podem enviar."
              : "Participantes podem enviar mensagens."}
          </small>
        </div>
      )}
      <div className="messages">
        {selection.messages.map((m: Row) => {
          const content = parse(m.content);
          return (
            <article
              key={m.id}
              className={
                "message " +
                (m.direction === "customer"
                  ? "incoming"
                  : m.direction === "note"
                    ? "internal"
                    : "outgoing")
              }
            >
              <small>
                {m.direction === "note"
                  ? "Nota interna"
                  : m.direction === "customer"
                    ? content.participant_name || "Cliente"
                    : m.author === me.id
                      ? "Você"
                      : m.author}
              </small>
              {(content.reply_to || content.reply_external_id) && (
                <blockquote>
                  ↳{" "}
                  {content.reply_text ||
                    selection.messages.find(
                      (q: Row) =>
                        q.id === content.reply_to ||
                        q.external_id === content.reply_external_id,
                    )?.text ||
                    "Mensagem citada"}
                </blockquote>
              )}
              <p>{content.deleted ? "Mensagem apagada" : m.text}</p>
              {!content.deleted &&
                parse(m.attachments, []).map((id: string) => (
                  <MediaView api={api}
                    key={id}
                    file={
                      (selection.media || []).find((f: Row) => f.id === id) || {
                        id,
                        type: "application/octet-stream",
                        name: "Baixar anexo",
                        size: 0,
                      }
                    }
                    root={root}
                  />
                ))}
              {content.location && !content.deleted && (
                <a
                  href={`https://www.openstreetmap.org/?mlat=${encodeURIComponent(content.location.latitude)}&mlon=${encodeURIComponent(content.location.longitude)}#map=16/${encodeURIComponent(content.location.latitude)}/${encodeURIComponent(content.location.longitude)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  📍 {content.location.name || "Ver localização"} ·{" "}
                  {content.location.latitude}, {content.location.longitude}
                </a>
              )}
              {content.contacts &&
                !content.deleted &&
                content.contacts.map((ct: Row, i: number) => (
                  <div key={i}>
                    👤 {ct.name} · {ct.phone}
                  </div>
                ))}
              {Object.entries(content.reactions || {})
                .filter(([, r]: any) => r.emoji)
                .map(([id, r]: any) => (
                  <span className="reaction" key={id} title={id}>
                    {r.emoji}
                  </span>
                ))}
              <time>
                {new Date(m.created).toLocaleString("pt-BR", {
                  timeZone: "America/Sao_Paulo",
                  dateStyle: "short",
                  timeStyle: "short",
                })}
                {content.edited ? " · Editada" : ""}
                {m.delivery_status
                  ? " · " + (statuses[m.delivery_status] || m.delivery_status)
                  : ""}
              </time>
              {content.receipts && (
                <small>
                  Recibos por participante:{" "}
                  {
                    Object.values(content.receipts).filter((r: any) =>
                      ["read", "played"].includes(r.status),
                    ).length
                  }{" "}
                  leram · {Object.keys(content.receipts).length} receberam
                </small>
              )}
              {m.external_id &&
                m.direction !== "note" &&
                !content.deleted &&
                own && (
                  <div className="message-tools">
                    {cap.reply && (
                      <button
                        title="Responder a esta mensagem"
                        aria-label="Responder a esta mensagem"
                        onClick={() => setQuote(m)}
                      >
                        <Reply size={14} />
                      </button>
                    )}
                    {cap.reaction && (
                      <details>
                        <summary aria-label="Reagir à mensagem">
                          <Smile size={14} />
                        </summary>
                        <div className="emoji-choices">
                          {["👍", "❤️", "😊", "🙏", ""].map((emoji) => (
                            <button
                              disabled={busy}
                              key={emoji}
                              onClick={() =>
                                act(
                                  "reaction",
                                  { message_id: m.id, emoji },
                                  "message-actions",
                                )
                              }
                            >
                              {emoji || "Remover"}
                            </button>
                          ))}
                        </div>
                      </details>
                    )}
                    {cap.edit &&
                      m.direction === "outbound" &&
                      Date.now() - m.created < 900000 &&
                      parse(m.attachments, []).length === 0 && (
                        <button
                          onClick={() => {
                            setEdit(m);
                            setText(m.text);
                          }}
                        >
                          Editar
                        </button>
                      )}
                    {cap.delete && m.direction === "outbound" && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm("Apagar esta mensagem também no WhatsApp?")
                          )
                            act(
                              "delete",
                              { message_id: m.id },
                              "message-actions",
                            );
                        }}
                      >
                        Apagar
                      </button>
                    )}
                    {cap.read && m.direction === "customer" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          act("read", { message_id: m.id }, "message-actions")
                        }
                      >
                        Marcar como lida
                      </button>
                    )}
                  </div>
                )}
            </article>
          );
        })}
        {(selection.deliveries || [])
          .filter((d: Row) => !["sent", "cancelled"].includes(d.status))
          .map((d: Row) => (
            <div key={d.id} className="delivery-progress" role="status">
              {statuses[d.status] || d.status}
              {d.error ? " · " + d.error : ""}
            </div>
          ))}
      </div>
      <div className="reply-box rich-reply">
        {!own && (
          <p className="notice">
            Assuma a conversa para responder, enviar arquivos ou ligar.
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {quote && (
          <div className="quote-draft">
            Respondendo: {quote.text.slice(0, 100)}{" "}
            <button
              aria-label="Cancelar citação"
              onClick={() => setQuote(null)}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {edit && (
          <div className="quote-draft">
            Editando mensagem{" "}
            <button
              onClick={() => {
                setEdit(null);
                setText("");
              }}
            >
              Cancelar
            </button>
          </div>
        )}
        {pending.current && (
          <p>
            O pedido está guardado para uma tentativa segura.{" "}
            <button
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    "Abandonar este pedido? Confira Entregas antes de enviar outro para evitar duplicidade.",
                  )
                ) {
                  pending.current = null;
                  key.current = crypto.randomUUID();
                  setError(
                    "Pedido abandonado. Confira Entregas antes de reenviar.",
                  );
                }
              }}
            >
              Abandonar pedido
            </button>
          </p>
        )}
        <fieldset disabled={busy || !own || !!pending.current || recording}>
          <textarea
            aria-label="Mensagem"
            placeholder="Escreva sua resposta ou envie um anexo…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="compose-tools">
            <label className="file-picker">
              <Paperclip size={17} /> Anexar
              <input
                type="file"
                multiple
                aria-label="Anexar arquivos"
                onChange={(e) => {
                  setFiles(Array.from(e.target.files || []).slice(0, 10));
                  setVoice(null);
                  e.target.value = "";
                }}
              />
            </label>
            <select
              aria-label="Tipo de conteúdo"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="text">Automático pelo arquivo</option>
              <option value="document">Enviar como documento</option>
              {cap.sticker && <option value="sticker">Figurinha WebP</option>}
              {cap.location && <option value="location">Localização</option>}
              {cap.contacts && (
                <option value="contacts">Compartilhar contato</option>
              )}
            </select>
            {cap.voice && (
              <button type="button" onClick={record}>
                <Mic size={17} /> Gravar áudio
              </button>
            )}
          </div>
          {kind === "location" && (
            <div className="special-fields">
              <label>
                Latitude
                <input
                  type="number"
                  step="any"
                  value={special.latitude || ""}
                  onChange={(e) =>
                    setSpecial({ ...special, latitude: e.target.value })
                  }
                />
              </label>
              <label>
                Longitude
                <input
                  type="number"
                  step="any"
                  value={special.longitude || ""}
                  onChange={(e) =>
                    setSpecial({ ...special, longitude: e.target.value })
                  }
                />
              </label>
              <label>
                Nome do local
                <input
                  value={special.name || ""}
                  onChange={(e) =>
                    setSpecial({ ...special, name: e.target.value })
                  }
                />
              </label>
            </div>
          )}
          {kind === "contacts" && (
            <div className="special-fields">
              <label>
                Nome
                <input
                  value={special.name || ""}
                  onChange={(e) =>
                    setSpecial({ ...special, name: e.target.value })
                  }
                />
              </label>
              <label>
                Telefone com DDI
                <input
                  placeholder="5511999999999"
                  value={special.phone || ""}
                  onChange={(e) =>
                    setSpecial({ ...special, phone: e.target.value })
                  }
                />
              </label>
            </div>
          )}
          {cap.mentions && c.chat_type === "group" && (
            <label>
              Mencionar participante
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    setMentions([...new Set([...mentions, e.target.value])]);
                }}
              >
                <option value="">Escolher participante</option>
                {members.map((p: Row) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mentions.length > 0 && (
            <small>
              Menções: {mentions.join(", ")}{" "}
              <button onClick={() => setMentions([])}>Limpar</button>
            </small>
          )}
          {(voice ? [voice] : files).map((f, i) => (
            <div className="file-preview" key={i}>
              {voice ? "🎙" : "📎"} {f.name} ·{" "}
              {(f.size / 1024 / 1024).toFixed(1)} MB{" "}
              <button
                aria-label={"Remover " + f.name}
                onClick={() =>
                  voice
                    ? setVoice(null)
                    : setFiles(files.filter((_, n) => n !== i))
                }
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </fieldset>
        {recording && (
          <div className="recording" role="status">
            🔴 Gravando · {seconds}s{" "}
            <button onClick={() => recorder.current?.stop()}>
              <Square size={15} /> Parar e revisar
            </button>
          </div>
        )}
        {progress && <p role="status">{progress}</p>}
        <div className="compose-send">
          <small>
            Meta: foto até 5 MB; vídeo/áudio até 16 MB; documento até 100 MB.
            Gravação até 2 minutos.
          </small>
          <button
            disabled={busy || !own || recording}
            onClick={() => act("note", { text })}
          >
            Nota interna
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !own ||
              recording ||
              !(
                text.trim() ||
                files.length ||
                voice ||
                ["location", "contacts"].includes(kind) ||
                pending.current
              )
            }
            onClick={send}
          >
            {busy
              ? "Enviando…"
              : pending.current
                ? "Consultar / tentar novamente"
                : "Enviar"}{" "}
            <Send size={16} />
          </button>
        </div>
      </div>
    </>
  );
}
