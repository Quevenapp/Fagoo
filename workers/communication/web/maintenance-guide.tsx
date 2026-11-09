import React from "react";
export function MaintenanceGuide() {
  return (
    <section
      className="account-setup hermes-guide"
      id="atualizacoes"
      aria-labelledby="updates-guide-title"
    >
      <div className="eyebrow">DEPOIS DA INSTALAÇÃO · MANUTENÇÃO</div>
      <h2 id="updates-guide-title">Atualize pelo painel</h2>
      <p>
        O instalador já autoriza a atualização direta na sua Cloudflare. Em
        <strong> Sistema e atualizações</strong>, clique{" "}
        <strong>Verificar atualização</strong>. Quando houver uma versão oficial
        publicada, clique <strong>Atualizar Wabotia</strong>. Aguarde
        “Atualização publicada e verificada” e reabra o painel.
      </p>
      <details>
        <summary>O que é preservado e como funciona?</summary>
        <div className="guide-detail">
          <p>
            O Wabotia baixa o pacote oficial, confere sua integridade, prepara
            os arquivos, aplica migrações com recibo e publica na sua conta.
            Banco, mídias, domínios e credenciais são mantidos. Não precisa
            sincronizar GitHub ou configurar Deploy Hook.
          </p>
          <p>
            A consulta é renovada a cada cinco minutos. Um commit no repositório
            só aparece para atualizar depois que o mantenedor publicar seu
            pacote oficial.
          </p>
        </div>
      </details>
      <details>
        <summary>Como renovar o token?</summary>
        <div className="guide-detail">
          <p>
            Crie um token Cloudflare com <strong>Workers Scripts: Edit</strong>,
            limitado à conta desta instalação. No painel, abra{" "}
            <strong>Alterar configuração de atualização</strong>, cole o token e
            clique <strong>Verificar e salvar token</strong>. Depois de
            confirmar, revogue o token anterior. Preserve MASTER_KEY.
          </p>
          <p>
            O token inicial também cria D1/R2. Você pode substituí-lo por esse
            token mais restrito depois de instalar. O token do deploy do Hermes
            é separado.
          </p>
        </div>
      </details>
      <details>
        <summary>A publicação falhou ou ficou sem confirmação?</summary>
        <div className="guide-detail">
          <p>
            Confira <strong>Cloudflare → seu Worker → Implantações</strong> e a
            versão em
            <code> /api/health</code>. Não repita uma publicação que ainda pode
            estar em andamento. Após falha confirmada ou 15 minutos sem
            confirmação, o painel permite liberar nova tentativa, exigindo
            conferir que a publicação anterior terminou.
          </p>
          <p>
            Faça backup antes de atualizar. Guarde a pasta privada do instalador
            para recuperação. Alterações incompatíveis em recursos exigem
            revisão manual.
          </p>
          <a
            href="https://github.com/Quevenapp/Wabotia/blob/main/docs/ATUALIZACOES.md"
            target="_blank"
            rel="noreferrer"
          >
            Roteiro completo de atualização e recuperação
          </a>
        </div>
      </details>
      <p>
        Instalação feita pelo fluxo antigo?{" "}
        <a href="#reinstalar">
          Veja o roteiro de reinstalação sem repositório próprio.
        </a>
      </p>
    </section>
  );
}
