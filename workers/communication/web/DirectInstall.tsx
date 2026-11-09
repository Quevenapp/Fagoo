import React, { useState } from "react";
import { Copy, Download } from "lucide-react";
import { NodeInstall, type InstallSystem } from "./NodeInstall";
export function DirectInstall() {
  const [os, setOs] = useState<InstallSystem>("vps"),
    [copied, setCopied] = useState(false);
  const command =
    os === "windows"
      ? "Invoke-WebRequest https://wabotia.queven.app/install-wabotia.mjs -OutFile install-wabotia.mjs\nnode .\\install-wabotia.mjs"
      : "curl -fL https://wabotia.queven.app/install-wabotia.mjs -o install-wabotia.mjs\nnode install-wabotia.mjs";
  return (
    <>
      <NodeInstall
        os={os}
        onChange={(value) => {
          setOs(value);
          setCopied(false);
        }}
      />
      <section className="account-setup hermes-guide" id="instalar">
        <div className="eyebrow">
          INSTALAÇÃO DIRETA · SEM REPOSITÓRIO PRÓPRIO
        </div>
        <h2>Instale na sua Cloudflare</h2>
        <p>
          Você executa o instalador uma vez no computador ou na VPS. O painel, o
          banco e os arquivos ficam na sua conta Cloudflare. As próximas
          atualizações são feitas pelo painel. Não precisa de conta GitHub,
          cópia do código ou Deploy Hook.
        </p>
        <ol>
          <li>
            Conclua o <a href="#nodejs">passo a passo do Node.js acima</a> e
            confira os <a href="#requisitos">requisitos Cloudflare</a>.
          </li>
          <li>
            Copie o <strong>Account ID</strong> da conta Cloudflare onde vai
            instalar.
          </li>
          <li>
            Crie o token descrito a seguir. Ele será digitado no terminal e
            guardado como secret no seu Worker. O site Wabotia não recebe seu
            token.
          </li>
          <li>
            Use o mesmo terminal e usuário em que node e npm funcionaram.
            Execute os comandos abaixo. Informe Account ID, token e um nome
            novo, como
            <code> wabotia-atendimento</code>.
          </li>
          <li>
            Ao terminar, abra a URL exibida. O instalador cria uma pasta com o
            nome escolhido. Abra <code>chaves.local.json</code> e copie{" "}
            <code>SETUP_TOKEN</code> para criar seu administrador. Guarde a
            pasta em local privado.
          </li>
        </ol>
        <details>
          <summary>Como criar o token da instalação</summary>
          <div className="guide-detail">
            <ol>
              <li>
                Na Cloudflare, abra{" "}
                <strong>
                  My Profile → API Tokens → Create Token → Custom Token
                </strong>
                .
              </li>
              <li>
                Dê um nome, como “Wabotia instalação”. Adicione três permissões
                de conta:
                <strong> Workers Scripts: Edit</strong>,{" "}
                <strong>D1: Edit</strong> e{" "}
                <strong>Workers R2 Storage: Edit</strong>.
              </li>
              <li>
                Em Account Resources, escolha{" "}
                <strong>Include → Specific account</strong> e somente sua conta
                de instalação. Defina a validade e crie o token.
              </li>
              <li>
                Copie o valor exibido uma vez. Ele autoriza publicar Workers e
                administrar D1/R2 nessa conta. Depois da instalação, você pode
                substituí-lo no painel por outro com somente{" "}
                <strong>Workers Scripts: Edit</strong> para atualizar.
              </li>
            </ol>
            <p>
              O token da instalação é diferente do token usado para preparar
              Access, Tunnel e DNS do Hermes.
            </p>
          </div>
        </details>
        <label className="field">
          <span>Terminal escolhido para instalar</span>
          <select
            value={os}
            onChange={(e) => {
              setOs(e.target.value as InstallSystem);
              setCopied(false);
            }}
          >
            <option value="vps">VPS Ubuntu / Hostinger</option>
            <option value="ubuntu">Ubuntu no computador / WSL2</option>
            <option value="windows">Windows / PowerShell</option>
            <option value="mac">macOS / Terminal</option>
          </select>
        </label>
        <pre className="guide-code">{command}</pre>
        <div className="guide-actions">
          <button
            className="button"
            onClick={async () => {
              await navigator.clipboard.writeText(command);
              setCopied(true);
            }}
          >
            <Copy size={17} />
            {copied ? "Comandos copiados" : "Copiar comandos"}
          </button>
          <a
            className="button secondary"
            href="https://wabotia.queven.app/install-wabotia.mjs"
            download
          >
            <Download size={17} />
            Baixar instalador
          </a>
        </div>
        <aside className="account-return">
          <strong>Está esperando você ou executando?</strong>
          <p>
            <strong>AGUARDANDO VOCÊ</strong>: preencha o dado pedido e pressione
            Enter. O token fica invisível ao digitar.{" "}
            <strong>EM EXECUÇÃO</strong>: a etapa começou. A cada 10 segundos,{" "}
            <strong>AGUARDANDO RESULTADO</strong>
            mostra o tempo decorrido; isso não confirma que a Cloudflare
            terminou. A publicação pode levar alguns minutos. Aguarde{" "}
            <strong>5/5 · Pronto</strong>e a URL. Não execute duas instalações
            em paralelo.
          </p>
        </aside>
        <aside className="account-return">
          <strong>O instalador gera as chaves para você.</strong>
          <p>
            MASTER_KEY protege suas credenciais. SETUP_TOKEN libera a criação do
            primeiro administrador. Elas são diferentes e ficam juntas em
            chaves.local.json. Não precisa gerar ou colar essas duas chaves
            antes de instalar.
          </p>
        </aside>
        <details id="reinstalar">
          <summary>Vou reinstalar ou a instalação parou</summary>
          <div className="guide-detail">
            <p>
              Para reinstalar, use um nome novo e mantenha a instalação anterior
              até conferir a nova. O histórico não é importado automaticamente.
              Faça backup se tiver dados importantes. Mantenha as APIs, bots e
              túnel do Hermes existentes; cadastre a conexão na nova instalação
              e teste antes de transferir os canais.
            </p>
            <p>
              Para retomar uma instalação interrompida, use{" "}
              <code>node install-wabotia.mjs --name NOME --resume</code>
              no mesmo diretório e informe a mesma conta. O instalador reconhece
              a pasta privada. Não apague recursos para resolver uma etapa
              pendente.
            </p>
            <p>
              A cópia GitHub anterior só pode ser removida depois que a
              instalação antiga não for mais usada. A nova instalação funciona
              sem essa cópia.
            </p>
          </div>
        </details>
      </section>
    </>
  );
}
