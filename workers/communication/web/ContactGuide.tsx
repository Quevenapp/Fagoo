import agendaImage from "../docs/screenshots/23-agenda.jpg";

export function ContactGuide() {
  return (
    <section id="agenda" className="system-card card">
      <div className="eyebrow">DEPOIS DE INSTALAR · VERSÃO 0.4.0</div>
      <h2>Organize sua agenda de contatos</h2>
      <p>
        No painel, escolha o perfil de atendimento e abra{" "}
        <strong>Agenda de contatos</strong>. Use <strong>Novo contato</strong>{" "}
        para cadastrar nome, telefone, e-mail, empresa e observações. Só o nome
        é obrigatório. Clique no nome de uma pessoa para editar ou abrir suas
        conversas vinculadas.
      </p>
      <h3>Salvar o cliente de uma conversa</h3>
      <ol>
        <li>
          Abra <strong>Conversas</strong>, selecione o atendimento e clique em{" "}
          <strong>Salvar contato</strong>.
        </li>
        <li>
          Escolha <strong>Criar novo contato</strong> ou{" "}
          <strong>Vincular contato existente</strong>. Confira o telefone com
          DDI e DDD e preencha o nome.
        </li>
        <li>
          Salve. O nome aparece no atendimento. Use{" "}
          <strong>Editar contato</strong> para corrigir os dados ou desvincular
          uma pessoa escolhida por engano.
        </li>
      </ol>
      <h3>Importar uma planilha CSV</h3>
      <ol>
        <li>
          Baixe o{" "}
          <a href="/modelo-contatos.csv" download>
            modelo de CSV
          </a>
          . Mantenha as colunas{" "}
          <code>nome;telefone;email;empresa;observacoes</code> e substitua o
          exemplo.
        </li>
        <li>
          Formate a coluna telefone como Texto antes de preencher. Use o número
          completo, como <code>5511999990000</code>.
        </li>
        <li>
          No Excel, use <strong>Arquivo → Salvar como → CSV UTF-8</strong>. No
          Google Planilhas, escolha{" "}
          <strong>
            Arquivo → Fazer download → Valores separados por vírgulas (.csv)
          </strong>
          . No LibreOffice, escolha Texto CSV com UTF-8.
        </li>
        <li>
          Na agenda, clique em <strong>Importar CSV</strong> e selecione o
          arquivo. Limites: <strong>500 contatos e 1 MB</strong> por arquivo.
        </li>
        <li>
          Confira a prévia. Se houver erro, corrija a linha indicada, salve e
          selecione o arquivo novamente. Nenhum contato é salvo enquanto houver
          erro.
        </li>
        <li>
          Clique em <strong>Importar N contato(s)</strong>. Linhas idênticas já
          importadas são ignoradas. Dados diferentes geram outro cadastro; para
          corrigir uma pessoa, edite na agenda.
        </li>
      </ol>
      <p>
        Importar não envia mensagens nem concede consentimento. O mesmo telefone
        não une clientes automaticamente. Os contatos ficam separados por
        perfil; integrações externas acessam apenas seus próprios cadastros.
      </p>
      <details>
        <summary>Ver a tela de referência</summary>
        <img
          src={agendaImage}
          alt="Agenda com os botões Modelo CSV, Importar CSV e Novo contato e três contatos fictícios"
          style={{ width: "100%", borderRadius: 10 }}
        />
      </details>
      <p>
        <a href="https://github.com/Quevenapp/Wabotia/blob/main/docs/CONTATOS.md">
          Guia completo da agenda ↗
        </a>{" "}
        · <a href="/api-docs">Agenda pela API ↗</a>
      </p>
    </section>
  );
}
