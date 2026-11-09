import React, { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";
type Row = Record<string, any>;
export const callStatus: Row = {
  ringing: "Recebendo ligação",
  dialing: "Chamando",
  connecting: "Conectando áudio",
  preaccepted: "Preparando áudio",
  active: "Em ligação",
  completed: "Encerrada",
  missed: "Não atendida",
  rejected: "Recusada",
  failed: "Falhou",
  unknown: "Sem confirmação",
};
const live = (s: string) =>
  !["completed", "missed", "rejected", "failed"].includes(s);
export function CallPanel({
  api,
  root,
  conversation,
  enabled,
  me,
  refresh,
  demo,
}: {
  api: any;
  root: string;
  conversation: Row;
  enabled: boolean;
  me: Row;
  refresh: () => Promise<any>;
  demo: boolean;
}) {
  const [calls, setCalls] = useState<Row[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [muted, setMuted] = useState(false),
    [permission, setPermission] = useState<Row | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null),
    stream = useRef<MediaStream | null>(null),
    audio = useRef<HTMLAudioElement | null>(null),
    active = useRef<string>(""),
    answerSet = useRef(false),
    alive = useRef(true);
  function close() {
    active.current = "";
    peer.current?.close();
    peer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    answerSet.current = false;
    setMuted(false);
    if (audio.current) audio.current.srcObject = null;
  }
  async function load() {
    if (demo || !enabled) return;
    const result = await api(
      `${root}/calls?conversation_id=${encodeURIComponent(conversation.id)}`,
    );
    if (!alive.current) return;
    setCalls(result.data || []);
    if (active.current) {
      const call = await api(`${root}/calls/${active.current}?session=1`);
      if (!alive.current) return;
      if (!live(call.status)) {
        close();
        return;
      }
      if (
        call.session?.sdp_type === "answer" &&
        peer.current &&
        !answerSet.current
      ) {
        answerSet.current = true;
        try {
          await peer.current.setRemoteDescription({
            type: "answer",
            sdp: call.session.sdp,
          });
        } catch (e) {
          setError(
            "Não foi possível conectar o áudio. Encerre a ligação e confira a rede.",
          );
        }
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    load().catch((e) => setError(e.message));
    const interval = setInterval(
      () => load().catch((e) => setError(e.message)),
      2500,
    );
    const keep = setInterval(() => {
      if (active.current)
        api(`${root}/calls/${active.current}/keepalive`, "POST", {}).catch(
          () => {},
        );
    }, 20000);
    return () => {
      alive.current = false;
      clearInterval(interval);
      clearInterval(keep);
      const id = active.current;
      close();
      if (id) api(`${root}/calls/${id}/terminate`, "POST", {}).catch(() => {});
    };
  }, [conversation.id, enabled, demo]);
  async function setup() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error("Use HTTPS e um navegador com microfone e WebRTC.");
    stream.current = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    const pc = new RTCPeerConnection();
    peer.current = pc;
    stream.current.getTracks().forEach((t) => pc.addTrack(t, stream.current!));
    pc.ontrack = (e) => {
      if (audio.current) {
        audio.current.srcObject = e.streams[0] || new MediaStream([e.track]);
        audio.current
          .play()
          .catch(() =>
            setNote("Clique em Reproduzir áudio para ouvir a ligação."),
          );
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed")
        setError(
          "A rede não conectou o áudio. Encerre a ligação e verifique firewall, VPN ou acesso UDP.",
        );
    };
    return pc;
  }
  async function gathered(pc: RTCPeerConnection) {
    if (pc.iceGatheringState !== "complete")
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", done);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          pc.removeEventListener("icegatheringstatechange", done);
          reject(
            Error("A rede demorou a preparar o áudio. Verifique sua conexão."),
          );
        }, 12000);
        pc.addEventListener("icegatheringstatechange", done);
      });
    return {
      sdp_type: pc.localDescription!.type,
      sdp: pc.localDescription!.sdp,
    };
  }
  async function perform(fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message || "Não foi possível completar a ligação.");
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    try {
      const pc = await setup();
      await pc.setLocalDescription(await pc.createOffer());
      const call = await api(root + "/calls", "POST", {
        conversation_id: conversation.id,
        session: await gathered(pc),
      });
      active.current = call.id;
      if (call.status === "unknown" || call.status === "failed") {
        close();
        setError(call.error || "Ligação não confirmada.");
      } else setNote("Aguardando o cliente atender.");
    } catch (e) {
      close();
      throw e;
    }
  }
  async function accept(call: Row) {
    try {
      const claimed = await api(`${root}/calls/${call.id}/claim`, "POST", {});
      active.current = call.id;
      await refresh();
      const pc = await setup();
      if (!claimed.session)
        throw Error("Oferta de áudio ainda não chegou. Aguarde a atualização.");
      await pc.setRemoteDescription({
        type: "offer",
        sdp: claimed.session.sdp,
      });
      await pc.setLocalDescription(await pc.createAnswer());
      const session = await gathered(pc);
      // Pre-accept establishes media before the user is told the call was accepted.
      stream.current?.getAudioTracks().forEach((t) => (t.enabled = false));
      await api(`${root}/calls/${call.id}/pre_accept`, "POST", { session });
      await api(`${root}/calls/${call.id}/accept`, "POST", { session });
      stream.current?.getAudioTracks().forEach((t) => (t.enabled = true));
      setNote("Ligação atendida.");
    } catch (e) {
      const id = active.current;
      close();
      if (id)
        await api(`${root}/calls/${id}/reject`, "POST", {}).catch(() => {});
      throw e;
    }
  }
  const current = calls.filter((c) => live(c.status)),
    own = conversation.owner === me.id && conversation.state === "human";
  if (!enabled) return null;
  return (
    <section className="call-panel" aria-label="Ligações de voz">
      <div className="call-toolbar">
        <strong>
          <Phone size={16} /> Ligação de voz
        </strong>
        <button
          disabled={busy || !own || demo}
          onClick={() =>
            perform(async () => {
              const p = await api(
                `${root}/conversations/${conversation.id}/call-permission`,
              );
              setPermission(p);
            })
          }
        >
          Verificar permissão
        </button>
        <button
          disabled={busy || !own || demo}
          onClick={() =>
            perform(async () => {
              await api(root + "/calls/permission", "POST", {
                conversation_id: conversation.id,
              });
              setNote(
                "Pedido de permissão entrou na fila. Aguarde a resposta do cliente.",
              );
            })
          }
        >
          Pedir permissão
        </button>
        <button
          disabled={busy || !own || demo || current.length > 0}
          onClick={() => perform(start)}
        >
          <Phone size={14} /> Ligar
        </button>
      </div>
      {permission && (
        <small>
          Permissão Meta:{" "}
          {permission.permission?.status === "no_permission"
            ? "Ainda não concedida"
            : permission.permission?.status || "Consultar novamente"}{" "}
          ·{" "}
          {permission.actions?.some(
            (a: Row) => a.action_name === "start_call" && a.can_perform_action,
          )
            ? "Pode ligar agora"
            : "Aguarde a autorização ou o fim do limite."}
        </small>
      )}
      {current.map((call) => (
        <div className="current-call" key={call.id}>
          <span>
            {callStatus[call.status]} ·{" "}
            {call.direction === "inbound" ? "Recebida" : "Realizada"}
          </span>
          {call.direction === "inbound" &&
            call.status === "ringing" &&
            (!call.actor || call.actor === me.id) && (
              <>
                <button
                  disabled={busy}
                  onClick={() => perform(() => accept(call))}
                >
                  Atender com microfone
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api(`${root}/calls/${call.id}/claim`, "POST", {});
                      await api(`${root}/calls/${call.id}/reject`, "POST", {});
                    })
                  }
                >
                  Recusar
                </button>
              </>
            )}
          {call.actor === me.id && call.status !== "unknown" && (
            <button
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await api(`${root}/calls/${call.id}/terminate`, "POST", {});
                  close();
                })
              }
            >
              <PhoneOff size={15} /> Encerrar
            </button>
          )}
          {call.status === "unknown" && call.actor === me.id && (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    "Você conferiu no WhatsApp que esta ligação terminou?",
                  )
                )
                  perform(async () => {
                    await api(`${root}/calls/${call.id}/reconcile`, "POST", {
                      confirmed_ended: true,
                    });
                    close();
                  });
              }}
            >
              Confirmar encerramento
            </button>
          )}
        </div>
      ))}
      {active.current && (
        <button
          onClick={() => {
            const next = !muted;
            stream.current
              ?.getAudioTracks()
              .forEach((t) => (t.enabled = !next));
            setMuted(next);
          }}
        >
          {muted ? <MicOff size={15} /> : <Mic size={15} />}{" "}
          {muted ? "Ativar microfone" : "Silenciar microfone"}
        </button>
      )}
      <audio
        controls
        ref={audio}
        autoPlay
        aria-label="Áudio da ligação"
        hidden={!active.current}
      />
      {note && <p role="status">{note}</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {calls.length > 0 && (
        <details>
          <summary>Histórico de ligações</summary>
          {calls.map((call) => (
            <p key={call.id}>
              {new Date(call.created).toLocaleString("pt-BR")} ·{" "}
              {call.direction === "inbound" ? "Recebida" : "Realizada"} ·{" "}
              {callStatus[call.status]}
              {call.duration ? ` · ${call.duration}s` : ""}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
