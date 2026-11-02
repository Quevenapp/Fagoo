import React, { useState } from "react";
import { api } from "./api.mjs";
import { consentContinuation } from "./redirect.mjs";
import { ErrorNotice, Logo, Notice } from "./components.jsx";
export default function Consent({ user }) {
  const query = new URLSearchParams(location.search),
    oauthQuery = location.search.slice(1),
    complete = query.has("sig") && query.has("exp"),
    client = query.get("client_id"),
    scopes = (query.get("scope") || "").split(" ").filter(Boolean);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  async function decide(accept) {
    setBusy(true);
    setError(null);
    try {
      const result = await api("/api/auth/oauth2/consent", {
        body: { accept, oauth_query: oauthQuery },
      });
      location.assign(consentContinuation(result.url || result.redirect_uri));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <main className="boot">
      <Logo />
      <section className="panel consent-card">
        <span className="eyebrow">Autorização de aplicativo</span>
        <h1>Conectar à sua conta</h1>
        <p>
          Você está conectado como <strong>{user?.email || user?.name}</strong>{" "}
          em <strong>{location.host}</strong>.
        </p>
        <dl>
          <dt>Identificação do aplicativo</dt>
          <dd className="mono break-word">{client || "Não informada"}</dd>
        </dl>
        {scopes.length > 0 && (
          <>
            <p>O aplicativo solicita os seguintes acessos:</p>
            <ul>
              {scopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
          </>
        )}
        <ErrorNotice error={error} />
        {!complete && (
          <Notice>
            Esta solicitação está incompleta. Inicie a conexão novamente no
            aplicativo.
          </Notice>
        )}
        <div className="form-actions">
          <button
            className="button secondary"
            disabled={!complete || busy}
            onClick={() => decide(false)}
          >
            Não autorizar
          </button>
          <button
            className="button primary"
            disabled={!complete || busy}
            onClick={() => decide(true)}
          >
            {busy ? "Processando…" : "Autorizar acesso"}
          </button>
        </div>
      </section>
    </main>
  );
}
