import React, { useEffect, useState } from "react";
import { Check, Copy, Download, Eye, EyeOff, KeyRound } from "lucide-react";

const keyFields = [
  {
    name: "MASTER_KEY",
    title: "Protege suas credenciais",
    description:
      "Cole no campo MASTER_KEY da Cloudflare. Guarde enquanto usar esta instalação: ela protege as credenciais salvas e não deve ser trocada por outra depois.",
  },
  {
    name: "SETUP_TOKEN",
    title: "Libera a primeira conta",
    description:
      "Cole no campo SETUP_TOKEN da Cloudflare. Depois, use a mesma chave como código de instalação ao criar o primeiro administrador no painel.",
  },
] as const;
type KeyName = (typeof keyFields)[number]["name"];
type Keys = Record<KeyName, string>;

function randomKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function InstallKeys() {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState<KeyName | null>(null);
  const [replace, setReplace] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (location.hash === "#chaves")
      document.getElementById("chaves")?.scrollIntoView();
  }, []);

  function generate() {
    try {
      const master = randomKey();
      let setup = randomKey();
      while (setup === master) setup = randomKey();
      setKeys({ MASTER_KEY: master, SETUP_TOKEN: setup });
      setVisible(false);
      setCopied(null);
      setReplace(false);
      setMessage(
        "Duas chaves criadas. Copie cada uma para o campo de mesmo nome na Cloudflare e guarde as duas antes de sair.",
      );
    } catch {
      setMessage(
        "Este navegador não conseguiu gerar as chaves com segurança. Abra esta página por HTTPS em um navegador atualizado e tente novamente.",
      );
    }
  }

  async function copy(name: KeyName) {
    if (!keys) return;
    try {
      await navigator.clipboard.writeText(keys[name]);
      setCopied(name);
      setMessage(`${name} copiada. Cole no campo ${name} da Cloudflare.`);
    } catch {
      setVisible(true);
      setMessage(
        `O navegador não permitiu copiar automaticamente. Clique no valor de ${name} para selecionar a chave e use Copiar (Ctrl+C ou ⌘C).`,
      );
    }
  }

  function download() {
    if (!keys) return;
    const contents = [
      "Wabotia — chaves de uma NOVA instalação",
      "Guarde este arquivo em local privado. Ele contém suas duas chaves.",
      "Preencha abaixo a URL do Worker para identificar a instalação:",
      "URL: ",
      "",
      `MASTER_KEY=${keys.MASTER_KEY}`,
      `SETUP_TOKEN=${keys.SETUP_TOKEN}`,
      "",
      "Cole cada valor no campo de mesmo nome na Cloudflare.",
      "MASTER_KEY: guarde enquanto usar esta instalação. Não a substitua depois.",
      "SETUP_TOKEN: use também como código ao criar o primeiro administrador.",
      "A senha de login do administrador será escolhida separadamente.",
      "Não publique este arquivo no GitHub nem envie em mensagens de suporte.",
      "",
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([contents], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wabotia-chaves-nova-instalacao.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(
      "Download solicitado. Confira o arquivo em Downloads e guarde-o em local privado: ele contém as duas chaves.",
    );
  }

  return (
    <section className="install-keys" id="chaves" aria-labelledby="keys-title">
      <div className="eyebrow">ANTES DE CLICAR EM IMPLANTAR</div>
      <h2 id="keys-title">Gere suas duas chaves</h2>
      <p className="keys-intro">
        A Cloudflare pede dois valores diferentes. Clique no botão abaixo e o
        gerador cria os dois para você, com 64 caracteres cada. Sua senha de
        login será escolhida depois, ao criar o administrador.
      </p>
      <div className="keys-actions">
        <button
          type="button"
          className="button"
          onClick={() => (keys ? setReplace(true) : generate())}
        >
          <KeyRound size={18} />
          {keys ? "Gerar outro par" : "Gerar minhas duas chaves"}
        </button>
        {keys && (
          <>
            <button
              type="button"
              className="button secondary"
              onClick={download}
            >
              <Download size={18} /> Baixar minhas chaves (.txt)
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => setVisible(!visible)}
              aria-pressed={visible}
            >
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
              {visible ? "Ocultar chaves" : "Mostrar chaves"}
            </button>
          </>
        )}
      </div>
      {replace && (
        <div className="keys-confirm" role="group" aria-label="Gerar outro par">
          <p>
            O novo par vai substituir as chaves exibidas nesta página. Guarde o
            par atual primeiro, se já o usou. Isso não altera nenhuma instalação
            existente.
          </p>
          <div className="keys-actions">
            <button
              type="button"
              className="button secondary small"
              onClick={() => setReplace(false)}
            >
              Manter estas chaves
            </button>
            <button type="button" className="button small" onClick={generate}>
              Gerar para outra instalação
            </button>
          </div>
        </div>
      )}
      <div className="keys-grid">
        {keyFields.map(({ name, title, description }) => (
          <article className="key-card" key={name}>
            <label htmlFor={`install-${name}`}>{name}</label>
            <h3>{title}</h3>
            <p id={`help-${name}`}>{description}</p>
            <input
              id={`install-${name}`}
              type={visible ? "text" : "password"}
              value={keys?.[name] ?? ""}
              placeholder="Clique em Gerar minhas duas chaves"
              readOnly
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`help-${name}`}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="button secondary small"
              disabled={!keys}
              onClick={() => copy(name)}
            >
              {copied === name ? <Check size={16} /> : <Copy size={16} />}
              Copiar {name}
            </button>
          </article>
        ))}
      </div>
      <p className="keys-status" role="status">
        {message}
      </p>
      <div className="keys-notes">
        <p>
          <strong>Guarde as duas.</strong> Use um gerenciador de senhas ou baixe
          o arquivo e mantenha-o em local privado. As chaves são geradas só no
          seu navegador; o Wabotia não recebe nem guarda esses valores. Elas
          somem desta página ao atualizar ou fechar a aba.
        </p>
        <p>
          <strong>Já instalou?</strong> Preserve as chaves originais. Este
          gerador é para uma nova instalação. Se usar nosso instalador pelo
          terminal, ele gera e salva as duas automaticamente.
        </p>
      </div>
    </section>
  );
}
