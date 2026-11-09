import React, { useRef, useState } from "react";
import { ArrowRight, Check, Loader2 } from "lucide-react";

type Action = "test" | "discover";
type Bot = { id: string; name: string; remote_profile: string };
type Result = {
  error?: string;
  title?: string;
  bots?: Bot[];
};

export function ConnectionDiagnostics({
  hermes,
  demo,
  disabled,
  request,
  refresh,
  showBots,
  children,
}: {
  hermes: boolean;
  demo: boolean;
  disabled: boolean;
  request: (action: Action, signal: AbortSignal) => Promise<any>;
  refresh: () => Promise<void>;
  showBots: () => void;
  children: React.ReactNode;
}) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function check(action: Action) {
    if (inFlight.current || disabled) return;
    setResult(null);
    if (demo) {
      setResult({
        title: "Tela de referência",
        error:
          "Entre na sua instalação para testar a conexão e encontrar seus bots.",
      });
      return;
    }
    inFlight.current = true;
    setPending(action);
    const signal = AbortSignal.timeout(40000);
    try {
      const response = await request(action, signal);
      const found = Array.isArray(response) ? response : response?.bots;
      setResult({
        title:
          action === "test"
            ? "Conexão verificada com sucesso."
            : "Busca de bots concluída.",
        bots: hermes && Array.isArray(found) ? found : undefined,
      });
      await refresh();
    } catch (error) {
      setResult({
        error: signal.aborted
          ? "A verificação demorou mais que o esperado. Não foi possível confirmar o resultado. Confira se o Hermes e o túnel estão ligados antes de tentar novamente."
          : error instanceof Error
            ? error.message
            : "Não foi possível verificar a conexão. Tente novamente.",
      });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  return (
    <div className="connection-diagnostics">
      <div className="card-actions">
        <button
          className="button secondary"
          disabled={disabled || pending !== null}
          onClick={() => check("test")}
        >
          {pending === "test" && <Loader2 className="spin" size={16} />}
          {pending === "test" ? "Testando conexão…" : "Testar conexão"}
        </button>
        {children}
      </div>
      {hermes && (
        <button
          className="text-link"
          disabled={disabled || pending !== null}
          onClick={() => check("discover")}
        >
          {pending === "discover" ? (
            <>
              <Loader2 className="spin" size={16} /> Buscando bots…
            </>
          ) : (
            <>
              Descobrir bots <ArrowRight size={16} />
            </>
          )}
        </button>
      )}
      <div role="status" aria-live="polite" aria-atomic="true">
        {pending && !result && (
          <p className="connection-progress">
            {pending === "test"
              ? "Verificando o acesso ao serviço. Aguarde…"
              : "Consultando os perfis do Hermes. Aguarde…"}
          </p>
        )}
        {result && !result.error && (
          <div className="connection-result">
            <strong>
              <Check size={17} /> {result.title}
            </strong>
            {result.bots && (
              <>
                <p>
                  {result.bots.length === 0
                    ? "Nenhum bot encontrado. Confira os perfis criados no Hermes e tente novamente."
                    : `${result.bots.length} ${result.bots.length === 1 ? "bot encontrado" : "bots encontrados"}.`}
                </p>
                {result.bots.length > 0 && (
                  <>
                    <ul
                      className="discovered-bots"
                      aria-label="Bots encontrados"
                    >
                      {result.bots.map((bot) => (
                        <li key={bot.id}>{bot.name || bot.remote_profile}</li>
                      ))}
                    </ul>
                    <p>
                      Na Equipe Bot, habilite os perfis autorizados e escolha o
                      Atendente.
                    </p>
                    <button className="text-link" onClick={showBots}>
                      Ver bots na Equipe Bot <ArrowRight size={16} />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {result?.error && (
        <div className="connection-result error" role="alert">
          <strong>
            {result.title || "Não foi possível concluir a verificação."}
          </strong>
          <p>{result.error}</p>
        </div>
      )}
    </div>
  );
}
