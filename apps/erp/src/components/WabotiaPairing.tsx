import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { NativeRequestOptions, AccessState } from "../lib/real-access";
type Port = {
  wabotia: (path: string, options?: NativeRequestOptions) => Promise<unknown>;
};
type Status = {
  status: string;
  user_code?: string;
  verification_uri?: string;
  url?: string;
  name?: string;
  expires?: number;
};
export default function WabotiaPairing({
  controller,
  state,
}: {
  controller: Partial<Port>;
  state: AccessState;
}) {
  const [revoked, setRevoked] = useState(false);
  const [url, setUrl] = useState(""),
    [name, setName] = useState(""),
    [status, setStatus] = useState<Status | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [next, setNext] = useState(0);
  const admin = state.phase === "ready" && state.membership?.role === "admin";
  async function act(action = "", body: unknown = {}) {
    if (!admin || !controller.wabotia || busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await controller.wabotia(
        "/v1/system/wabotia" + (action ? "/" + action : ""),
        action ? { method: "POST", body } : {},
      );
      setStatus(value as Status);
      setNext(Date.now() + 5000);
    } catch {
      setError(
        "Não foi possível concluir. Confira a URL, a aprovação no Wabotia e a conexão. Aguarde cinco segundos entre consultas.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (admin) void act();
  }, [admin]);
  if (!admin)
    return (
      <section className="real-state-panel">
        <h1>Wabotia</h1>
        <p>Somente administradores podem configurar esta conexão.</p>
      </section>
    );
  return (
    <section className="real-state-panel">
      <nav>
        <Link to="/preferencias/sistema">Sistema</Link> › Wabotia
      </nav>
      <h1>Conectar ao Wabotia</h1>
      <p>
        Gere um código e aprove no painel Wabotia. As permissões, os bots e as
        linhas são escolhidos pelo administrador. Nenhum token precisa ser
        copiado.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act("start", { url, name });
        }}
      >
        <fieldset
          disabled={
            busy ||
            status?.status === "connected" ||
            status?.status === "authorization_pending" ||
            status?.status === "recovery_required"
          }
        >
          <label>
            Endereço do Wabotia{" "}
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://seu-wabotia.exemplo.com"
            />
          </label>
          <label>
            Nome desta instalação{" "}
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Fagoo da empresa"
            />
          </label>
          <button type="submit">Gerar código</button>
        </fieldset>
      </form>
      <div aria-live="polite">
        {status?.status === "authorization_pending" ? (
          <>
            <p>
              No Wabotia, abra Integrações → Parear Vinki ou Fagoo e aprove:
            </p>
            <strong style={{ fontSize: "1.8rem", letterSpacing: ".15em" }}>
              {status.user_code}
            </strong>
            <p>O código expira em dez minutos.</p>
            <a
              href={status.verification_uri}
              target="_blank"
              rel="noopener noreferrer"
            >
              Abrir Wabotia
            </a>
            <p>
              <button
                disabled={busy}
                onClick={() => {
                  if (Date.now() >= next) void act("poll");
                  else
                    setError(
                      "Aguarde cinco segundos antes de verificar novamente.",
                    );
                }}
              >
                Verificar aprovação
              </button>
            </p>
          </>
        ) : status?.status === "connected" ? (
          <p>
            Conectado a {status.url}. As permissões aprovadas estão disponíveis
            para os serviços do Fagoo.
          </p>
        ) : (
          <p>
            {status?.status === "expired"
              ? "Código expirado. Gere outro código."
              : status?.status === "recovery_required"
                ? "A configuração privada mudou e esta conexão precisa ser refeita."
                : "Ainda não conectado."}
          </p>
        )}
      </div>
      {status &&
        !["disconnected", "recovery_required"].includes(status.status) && (
          <button disabled={busy} onClick={() => void act("disconnect")}>
            Desconectar
          </button>
        )}
      {status?.status === "recovery_required" && (
        <div>
          <p>
            Primeiro, abra o Wabotia e revogue a aplicação desta instalação em
            Integrações. Esquecer aqui apaga apenas a configuração local; não
            revoga o acesso remoto.
          </p>
          <label>
            <input
              type="checkbox"
              checked={revoked}
              onChange={(e) => setRevoked(e.target.checked)}
            />{" "}
            Já revoguei o vínculo anterior no Wabotia.
          </label>
          <button
            disabled={busy || !revoked}
            onClick={() => void act("forget", { confirmed: true })}
          >
            Esquecer conexão local
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
