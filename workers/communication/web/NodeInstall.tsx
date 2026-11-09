import React, { useEffect, useState } from "react";
import { Copy } from "lucide-react";

export type InstallSystem = "vps" | "ubuntu" | "windows" | "mac";

function Commands({ text, label }: { text: string; label: string }) {
  const [message, setMessage] = useState("");
  return (
    <div className="node-commands">
      <pre className="guide-code">{text}</pre>
      <button
        className="button secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMessage("Copiado. Cole no terminal escolhido.");
          } catch {
            setMessage("Selecione os comandos acima e copie manualmente.");
          }
        }}
      >
        <Copy size={17} /> {label}
      </button>
      <span className="node-copy-status" role="status">
        {message}
      </span>
    </div>
  );
}

export function NodeInstall({
  os,
  onChange,
}: {
  os: InstallSystem;
  onChange: (os: InstallSystem) => void;
}) {
  const [root, setRoot] = useState(os === "vps");
  useEffect(() => setRoot(os === "vps"), [os]);
  const ubuntu = os === "vps" || os === "ubuntu";
  const prefix = root ? "" : "sudo ";
  return (
    <section className="account-setup hermes-guide" id="nodejs">
      <div className="eyebrow">PRIMEIRO PASSO · PREPARE O TERMINAL</div>
      <h2>Instale o Node.js, sem pular etapas</h2>
      <p>
        O Node.js executa o instalador do Wabotia. O npm vem junto e baixa as
        ferramentas necessárias. Você pode fazer isso no computador ou na VPS; o
        painel será publicado na Cloudflare. Se escolher a VPS, a pasta com as
        chaves ficará nela.
      </p>
      <label className="field">
        <span>Onde você vai executar o instalador?</span>
        <select
          value={os}
          onChange={(event) => {
            const value = event.target.value as InstallSystem;
            setRoot(value === "vps");
            onChange(value);
          }}
        >
          <option value="vps">VPS Ubuntu / Hostinger</option>
          <option value="ubuntu">Ubuntu no computador / WSL2</option>
          <option value="windows">Windows / PowerShell (sem WSL)</option>
          <option value="mac">macOS / Terminal</option>
        </select>
      </label>

      {ubuntu ? (
        <div>
          <h3>1. Abra o terminal e confira o usuário</h3>
          {os === "vps" ? (
            <p>
              No painel da Hostinger, abra <strong>VPS</strong>, selecione seu
              servidor e abra <strong>Terminal</strong> ou{" "}
              <strong>Terminal do navegador</strong>. Use o terminal do Ubuntu
              da VPS, fora do contêiner Docker do Hermes.
            </p>
          ) : (
            <p>
              No Ubuntu, abra <strong>Terminal</strong>. No Windows com WSL2,
              abra o aplicativo <strong>Ubuntu</strong> pelo menu Iniciar. Use
              esta mesma janela para instalar o Node.js e o Wabotia.
            </p>
          )}
          <p>
            Digite <code>whoami</code> e pressione Enter. Se aparecer
            <code> root</code>, escolha root abaixo. Se aparecer outro nome,
            escolha usuário comum.
          </p>
          <label className="field">
            <span>Resultado do comando whoami</span>
            <select
              value={root ? "root" : "user"}
              onChange={(e) => setRoot(e.target.value === "root")}
            >
              <option value="root">root (comum no terminal da VPS)</option>
              <option value="user">Outro nome: usuário comum com sudo</option>
            </select>
          </label>
          <p>
            Cole uma linha de cada vez e pressione Enter. Espere o nome do
            usuário reaparecer antes da próxima. Copie só os comandos: não copie
            o prefixo <code>root@servidor:~#</code> do terminal.
          </p>

          <h3>2. Prepare o Ubuntu, incluindo a biblioteca libatomic1</h3>
          <Commands
            key={`prepare-${prefix}`}
            label="Copiar preparação do Ubuntu"
            text={`${prefix}apt-get update\n${prefix}apt-get install -y ca-certificates curl git libatomic1`}
          />
          <p>
            <code>libatomic1</code> evita o erro <code>libatomic.so.1</code> ao
            abrir o Node.js. Com usuário comum, sudo pode pedir a senha do
            Ubuntu: ela não aparece enquanto você digita. Com root, os comandos
            são executados sem sudo. Continue apenas se não houver erro.
          </p>

          <h3>3. Instale o Node.js LTS com o NVM</h3>
          <p>
            NVM é o gerenciador de versões do Node.js. Estes comandos usam o
            instalador oficial. Execute no mesmo terminal e com o mesmo usuário
            da etapa anterior. O download pode levar alguns minutos.
          </p>
          <Commands
            label="Copiar instalação do Node.js"
            text={
              "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash\nsource \"$HOME/.nvm/nvm.sh\"\nnvm install --lts\nnvm alias default 'lts/*'\nnvm use --lts"
            }
          />
          <p>
            <code>--lts</code> escolhe a versão com suporte prolongado. Não
            coloque sudo antes de nvm, node ou do instalador Wabotia. O Node.js
            instalado assim fica disponível para este usuário.
          </p>
        </div>
      ) : (
        <div>
          <h3>1. Baixe o instalador próprio para seu sistema</h3>
          <ol>
            <li>
              Abra o{" "}
              <a
                href="https://nodejs.org/en/download"
                target="_blank"
                rel="noreferrer"
              >
                site oficial do Node.js
              </a>{" "}
              e escolha a versão <strong>LTS</strong>.
            </li>
            <li>
              {os === "windows"
                ? "Escolha Windows e baixe Windows Installer (.msi). Em um PC Intel/AMD comum, use x64; escolha ARM64 somente se o computador for ARM."
                : "Escolha macOS e baixe macOS Installer (.pkg). Use o instalador gráfico oferecido para o seu Mac."}
            </li>
            <li>
              Abra o arquivo baixado, avance pelo assistente e mantenha npm e
              PATH nas opções padrão. Não é preciso usar os comandos de NVM para
              Linux mostrados no site.
            </li>
            <li>
              Feche os terminais que já estavam abertos.{" "}
              {os === "windows"
                ? "Abra uma nova janela do PowerShell pelo menu Iniciar."
                : "Abra uma nova janela de Terminal em Aplicativos → Utilitários."}
            </li>
          </ol>
          {os === "windows" && (
            <p>
              Se você usa Ubuntu/WSL2 para executar o instalador, selecione a
              opção Ubuntu/WSL2 acima e faça a instalação dentro dele.
            </p>
          )}
        </div>
      )}

      <h3>{ubuntu ? "4" : "2"}. Confira antes de continuar</h3>
      <Commands
        key={`check-${os}`}
        label="Copiar verificação do Node.js"
        text={os === "windows" ? "node -v\nnpm.cmd -v" : "node -v\nnpm -v"}
      />
      <p>
        Os dois comandos precisam mostrar números de versão, sem erro. Exemplo:
        <code> v26.13.0</code> e <code>11.20.0</code>. Os números podem ser mais
        novos. O Wabotia exige Node.js <strong>22.13 ou superior</strong> e npm.
      </p>

      <details id="nodejs-erros">
        <summary>Deu erro? Corrija aqui antes de instalar o Wabotia</summary>
        <div className="guide-detail">
          <h3>libatomic.so.1: cannot open shared object file</h3>
          <p>
            O Node.js já foi instalado, mas falta uma biblioteca do Ubuntu.
            Selecione acima o usuário correto e repita a etapa 2 (preparação do
            Ubuntu). Depois execute node -v e npm -v. Não é necessário apagar o
            Node.js ou o Wabotia.
          </p>
          <h3>nvm: command not found ou node: command not found</h3>
          <p>
            No Ubuntu, entre com o mesmo usuário usado para instalar e execute:
          </p>
          <pre className="guide-code">
            {'source "$HOME/.nvm/nvm.sh"\nnvm use --lts\nnode -v\nnpm -v'}
          </pre>
          <p>
            Se o arquivo nvm.sh não existir, volte à etapa 3. No Windows ou Mac,
            feche o terminal e abra outro após concluir o instalador gráfico.
          </p>
          <h3>O terminal ficou mostrando somente &gt;</h3>
          <p>
            Geralmente faltou fechar uma aspa. Pressione <strong>Ctrl+C</strong>
            e cole novamente a linha inteira, incluindo as duas aspas de
            <code> "$HOME/.nvm/nvm.sh"</code>.
          </p>
          <h3>Permission denied, sudo ou npm.ps1</h3>
          <p>
            No Ubuntu, confira whoami e a opção root/usuário comum antes de
            repetir a preparação. Se seu usuário não puder usar sudo, entre com
            uma conta administradora. No PowerShell, use <code>npm.cmd -v</code>
            se a mensagem disser que npm.ps1 foi bloqueado.
          </p>
        </div>
      </details>
      <aside className="account-return">
        <strong>Pronto: node e npm mostram suas versões.</strong>
        <p>
          Agora confira os <a href="#requisitos">serviços Cloudflare</a> e siga
          para <a href="#instalar">Instale na sua Cloudflare</a>. Execute o
          instalador no mesmo terminal e com o mesmo usuário. Se estiver
          gravando, pause a gravação antes de preencher tokens ou abrir o
          arquivo privado de chaves.
        </p>
      </aside>
    </section>
  );
}
