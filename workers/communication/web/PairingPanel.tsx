import React, { useEffect, useRef, useState } from "react";
import { Link2, ShieldCheck, X } from "lucide-react";

type Row = Record<string, any>;
const names: Row = {
  "routing:read": "Consultar linhas autorizadas",
  "routing:send": "Enviar mensagens pelas linhas escolhidas",
  "conversations:read": "Consultar conversas autorizadas",
  "conversations:write": "Enviar mensagens nas conversas autorizadas",
  "tickets:read": "Consultar protocolos",
  "tickets:write": "Atualizar protocolos",
  "bots:read": "Consultar bots",
  "bots:invoke": "Consultar os bots escolhidos",
  "events:read": "Acompanhar eventos",
};
export function PairingPanel({
  api,
  demo,
  profiles,
}: {
  api: any;
  demo: boolean;
  profiles: Row[];
}) {
  const [items, setItems] = useState<Row[]>([]),
    [code, setCode] = useState(""),
    [request, setRequest] = useState<Row | null>(null);
  const [profile, setProfile] = useState(profiles[0]?.id || ""),
    [scopes, setScopes] = useState<string[]>([]);
  const [numbers, setNumbers] = useState<Row[]>([]),
    [pools, setPools] = useState<Row[]>([]),
    [bots, setBots] = useState<Row[]>([]);
  const [numberIds, setNumberIds] = useState<string[]>([]),
    [poolIds, setPoolIds] = useState<string[]>([]),
    [botIds, setBotIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    if (!profile && profiles[0]?.id) setProfile(profiles[0].id);
  }, [profiles, profile]);
  async function load() {
    if (!demo) setItems((await api("v1/pairings")).data);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [demo]);
  useEffect(() => {
    const current = ++sequence.current;
    setNumberIds([]);
    setPoolIds([]);
    setBotIds([]);
    setNumbers([]);
    setPools([]);
    setBots([]);
    if (demo || !request || !profile) return;
    setLoading(true);
    Promise.all([
      api(`v1/profiles/${profile}/router`),
      api(`v1/profiles/${profile}/bots`),
    ])
      .then(([router, list]) => {
        if (sequence.current !== current) return;
        setNumbers(router.numbers || []);
        setPools(router.pools || []);
        setBots((list.data || list).filter((bot: Row) => bot.enabled));
      })
      .catch((e) => {
        if (sequence.current === current) setError(e.message);
      })
      .finally(() => {
        if (sequence.current === current) setLoading(false);
      });
    return () => {
      sequence.current++;
    };
  }, [request?.id, profile, demo]);
  async function action(fn: () => Promise<void>) {
    if (demo) {
      setNotice(
        "Demonstração: o pareamento funciona na sua instalação, com o código gerado pelo Vinki ou Fagoo.",
      );
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((v) => v !== id) : [...values, id];
  return (
    <section className="card pairing-panel">
      <h2>
        <Link2 size={21} /> Parear Vinki ou Fagoo
      </h2>
      <p>
        No sistema que deseja conectar, escolha{" "}
        <strong>Conectar ao Wabotia</strong> e informe o endereço desta
        instalação. Ele mostrará um código. Confirme o mesmo código aqui; as
        credenciais são trocadas automaticamente entre os servidores.
      </p>
      <form
        className="pairing-code"
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            const value = await api("v1/pairings/lookup", "POST", {
              user_code: code,
            });
            setRequest(value);
            setScopes(
              value.allowed_scopes.filter((scope: string) =>
                [
                  "routing:read",
                  "routing:send",
                  "conversations:write",
                ].includes(scope),
              ),
            );
          });
        }}
      >
        <label>
          Código mostrado no outro sistema
          <input
            value={code}
            maxLength={12}
            placeholder="ABCD-2345"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            required
          />
        </label>
        <button className="button" disabled={busy}>
          Conferir código
        </button>
      </form>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {request && (
        <form
          className="pairing-review"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api(`v1/pairings/${request.id}/approve`, "POST", {
                profile_id: profile,
                scopes,
                number_ids: numberIds,
                pool_ids: poolIds,
                bot_ids: botIds,
              });
              setRequest(null);
              setCode("");
              setNotice(
                "Acesso aprovado. Volte ao outro sistema para concluir a conexão.",
              );
              await load();
            });
          }}
        >
          <div className="section-heading">
            <h3>
              {request.client === "vinki" ? "Vinki" : "Fagoo"} ·{" "}
              {request.instance_name}
            </h3>
            <button
              type="button"
              className="icon-button"
              aria-label="Fechar revisão"
              onClick={() => setRequest(null)}
            >
              <X size={16} />
            </button>
          </div>
          <p>
            Confira se este nome e código correspondem à instalação que você
            acabou de abrir. Um código recebido de outra pessoa pode autorizar o
            sistema dela.
          </p>
          <fieldset disabled={busy || loading}>
            <label>
              Perfil de atendimento
              <select
                required
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              >
                <option value="">Escolha um perfil</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <legend>O que este sistema poderá fazer</legend>
            {request.allowed_scopes.map((scope: string) => (
              <label className="check-line" key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => setScopes(toggle(scopes, scope))}
                />
                {names[scope] || scope}
              </label>
            ))}
            {scopes.includes("routing:send") && (
              <>
                <h4>Linhas e grupos permitidos</h4>
                {numbers.map((n) => (
                  <label className="check-line" key={n.id}>
                    <input
                      type="checkbox"
                      checked={numberIds.includes(n.id)}
                      onChange={() => setNumberIds(toggle(numberIds, n.id))}
                    />
                    {n.name} {n.number && `· +${n.number}`}
                  </label>
                ))}
                {pools.map((p) => (
                  <label className="check-line" key={p.id}>
                    <input
                      type="checkbox"
                      checked={poolIds.includes(p.id)}
                      onChange={() => setPoolIds(toggle(poolIds, p.id))}
                    />
                    Grupo: {p.name}
                  </label>
                ))}
                {!numbers.length && !pools.length && (
                  <p>
                    Cadastre os números em WhatsApp e canais antes de autorizar
                    envios.
                  </p>
                )}
                <small>
                  O pareamento não autoriza modelos pagos. As regras e a janela
                  de 24 horas de cada linha continuam valendo.
                </small>
              </>
            )}
            {scopes.includes("bots:invoke") && (
              <>
                <h4>Bots que o sistema pode consultar</h4>
                {bots.map((b) => (
                  <label className="check-line" key={b.id}>
                    <input
                      type="checkbox"
                      checked={botIds.includes(b.id)}
                      onChange={() => setBotIds(toggle(botIds, b.id))}
                    />
                    {b.name}
                  </label>
                ))}
              </>
            )}
          </fieldset>
          <div className="card-actions">
            <button
              className="button"
              disabled={
                busy ||
                loading ||
                !profile ||
                !scopes.length ||
                (scopes.includes("routing:send") &&
                  !numberIds.length &&
                  !poolIds.length) ||
                (scopes.includes("bots:invoke") && !botIds.length)
              }
            >
              <ShieldCheck size={16} /> Autorizar esta instalação
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api(`v1/pairings/${request.id}/deny`, "POST", {});
                  setRequest(null);
                  setNotice("Solicitação recusada.");
                })
              }
            >
              Recusar
            </button>
          </div>
        </form>
      )}
      <h3>Instalações pareadas</h3>
      {!items.length && <p>Nenhuma instalação pareada por código.</p>}
      {items.map((item) => (
        <div className="connection-row" key={item.id}>
          <div>
            <strong>
              {item.client === "vinki" ? "Vinki" : "Fagoo"} ·{" "}
              {item.instance_name}
            </strong>
            <small>
              {(
                {
                  approved: "Aguardando confirmação do sistema",
                  consumed: "Credencial entregue",
                  revoked: "Acesso revogado",
                  expired: "Pareamento expirado",
                } as Row
              )[item.status] || item.status}{" "}
              ·{" "}
              {profiles.find((p) => p.id === item.profile_id)?.name || "Perfil"}
            </small>
          </div>
          {item.status !== "revoked" && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api(`v1/pairings/${item.id}`, "DELETE");
                  setNotice(
                    "Acesso revogado. O sistema precisa parear novamente para se conectar.",
                  );
                  await load();
                })
              }
            >
              Revogar acesso
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
