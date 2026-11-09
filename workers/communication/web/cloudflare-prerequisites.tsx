import React from "react";

const services = [
  [
    "Workers",
    "Mantém o painel e a API do Wabotia funcionando, mesmo com seu computador desligado.",
    "Escolha o plano da conta; produção usa Workers Paid como referência.",
  ],
  [
    "D1",
    "É o banco: guarda usuários, configurações, conversas, protocolos e registros.",
    "Disponível nos planos Workers. O instalador cria o banco exclusivo.",
  ],
  [
    "R2",
    "É o armazenamento de arquivos: guarda documentos, imagens, áudios e anexos.",
    "Ative a assinatura R2 antes do deploy, mesmo usando a franquia gratuita. Mantenha o bucket privado.",
  ],
  [
    "Durable Objects e alarmes",
    "Coordenam as conversas e os trabalhos pendentes, para manter a ordem e evitar operações duplicadas.",
    "Configurados pelo deploy; você não cria um servidor nem contrata cada alarme.",
  ],
  [
    "Zero Trust",
    "É a área da Cloudflare onde você administra a proteção do acesso ao Hermes.",
    "Ative um plano, como Zero Trust Free, antes de configurar o Access.",
  ],
  [
    "Access",
    "Confere se quem está chamando o Hermes é o seu Wabotia autorizado.",
    "Crie aplicações e políticas Service Auth; use Client ID e Client Secret na conexão.",
  ],
  [
    "Tunnel e cloudflared",
    "Criam a ligação entre a Cloudflare e a máquina do Hermes sem abrir portas no roteador.",
    "Instale cloudflared junto do Hermes e mantenha a máquina ligada.",
  ],
  [
    "DNS",
    "Associa nomes como api-hermes.seudominio.com ao túnel correto.",
    "Para os hostnames do túnel, use um domínio ativo na Cloudflare.",
  ],
  [
    "API da Cloudflare",
    "Recebe a publicação oficial pelo instalador e aplica as atualizações solicitadas no painel.",
    "Autorize o token da instalação. Não é necessário vincular GitHub ou configurar Builds.",
  ],
  [
    "Workers Secrets",
    "Guardam as chaves de instalação do Wabotia no ambiente protegido do Worker.",
    "O instalador gera e guarda MASTER_KEY e SETUP_TOKEN. Preserve as originais.",
  ],
];

export function CloudflarePrerequisites() {
  return (
    <section
      className="account-setup hermes-guide"
      id="requisitos"
      aria-labelledby="prerequisites-title"
    >
      <div className="eyebrow">ANTES DE EXECUTAR O INSTALADOR</div>
      <h2 id="prerequisites-title">Prepare os serviços da Cloudflare</h2>
      <p>
        Ter a conta criada não ativa todos os serviços. Confira R2, D1 e Zero
        Trust na conta que vai receber o Wabotia. Se já estão disponíveis,
        continue sem repetir contratações ou criar recursos duplicados.
      </p>
      <details id="servicos-cloudflare" open>
        <summary>Para que serve cada serviço?</summary>
        <div className="guide-detail">
          <p>
            Uma conversa chega ao <strong>Worker</strong>, seus registros ficam
            no <strong>D1</strong> e os anexos no <strong>R2</strong>. Os{" "}
            <strong>Durable Objects</strong> organizam o trabalho. Quando
            precisa de um bot, o Worker passa pelo <strong>Access</strong> e
            pelo <strong>Tunnel</strong> até o <strong>Hermes</strong>, que
            executa o modelo na sua máquina ou VPS.
          </p>
          <div className="guide-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Serviço</th>
                  <th>Função no Wabotia</th>
                  <th>O que preparar</th>
                </tr>
              </thead>
              <tbody>
                {services.map(([name, purpose, setup]) => (
                  <tr key={name}>
                    <td>
                      <strong>{name}</strong>
                    </td>
                    <td>{purpose}</td>
                    <td>{setup}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            O plano do site/domínio na Cloudflare, o Workers, a assinatura R2 e
            o Zero Trust são configurações diferentes. Ativar Zero Trust Free
            não ativa R2 nem muda o plano Workers. As franquias gratuitas têm
            limites; confira os preços e o uso da conta.
          </p>
        </div>
      </details>
      <details open>
        <summary>1. R2: ativar a assinatura, mesmo com uso gratuito</summary>
        <div className="guide-detail">
          <ol>
            <li>
              Na Cloudflare, selecione a conta da instalação. Abra{" "}
              <strong>
                Armazenamento e bancos de dados → R2 → Visão geral
              </strong>
              .
            </li>
            <li>
              Se aparecer a tela de adesão, conclua a ativação da assinatura R2.
              Preencha os dados de cobrança que a Cloudflare solicitar e confira
              os termos e valores antes de confirmar. A franquia gratuita não
              dispensa essa adesão.
            </li>
            <li>
              Confirme que aparece a lista de buckets ou{" "}
              <strong>Criar bucket</strong>. O instalador cria o bucket privado
              com o nome da instalação seguido de <code>-media</code>. Não é
              preciso criar um bucket antes.
            </li>
          </ol>
          <p>
            R2 armazena os arquivos; a gratuidade inicial não significa
            armazenamento ilimitado.{" "}
            <a
              href="https://developers.cloudflare.com/r2/get-started/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Requisito oficial de assinatura R2 ↗
            </a>
          </p>
        </div>
      </details>
      <details open>
        <summary>2. D1 e Workers: conferir acesso e plano</summary>
        <div className="guide-detail">
          <ol>
            <li>
              Abra{" "}
              <strong>
                Armazenamento e bancos de dados → Banco de dados SQL D1
              </strong>
              . Confirme que consegue acessar a lista e o botão{" "}
              <strong>Criar banco de dados</strong>.
            </li>
            <li>
              <strong>
                O D1 já está incluído nos planos Workers Free e Paid.
              </strong>{" "}
              Não há uma assinatura D1 separada equivalente à ativação do R2. Os
              limites e eventuais cobranças seguem o plano Workers.
            </li>
            <li>
              O instalador do Wabotia cria o banco. Não precisa criar um banco
              de teste antes. Na instalação concluída, confira o banco ligado ao
              Worker em <strong>Bindings → DB</strong>.
            </li>
            <li>
              Para produção, prepare Workers Paid conforme a referência do
              projeto. O plano Zero Trust Free não substitui essa escolha.
              Confira o plano e as condições na área de assinatura do Workers.
            </li>
          </ol>
          <p>
            O Worker acessa D1 e R2 pelas ligações criadas na instalação. Você
            não precisa gerar chaves D1 ou S3/R2 para preencher no Wabotia.{" "}
            <a
              href="https://developers.cloudflare.com/d1/platform/pricing/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Planos e limites oficiais do D1 ↗
            </a>
          </p>
        </div>
      </details>
      <details open>
        <summary>
          3. Zero Trust: ativar o plano antes de conectar o Hermes
        </summary>
        <div className="guide-detail">
          <ol>
            <li>
              Abra{" "}
              <strong>Zero Trust → Controles de acesso → Aplicativos</strong>.
              Se aparecer a apresentação, clique <strong>Começar</strong> e
              conclua a ativação do plano escolhido. Zero Trust Free atende a
              configuração inicial deste guia.
            </li>
            <li>
              Revise os termos e qualquer informação de cobrança solicitada,
              mesmo escolhendo o plano gratuito. Se pedir nome de equipe,
              escolha um disponível.
            </li>
            <li>
              Confirme que consegue entrar em <strong>Aplicativos</strong> e{" "}
              <strong>Credenciais de serviço</strong>. Isso libera a
              configuração posterior do Access. Ativar o plano sozinho ainda não
              cria as políticas ou o túnel.
            </li>
          </ol>
          <p>
            Esse requisito é necessário para o caminho Hermes privado com Tunnel
            + Access. Se já ativou, siga para a{" "}
            <a href="#cloudflare-hermes">
              configuração da proteção e da conexão
            </a>
            , sem contratar novamente.
          </p>
        </div>
      </details>
      <aside className="account-return">
        <strong>Pronto para continuar?</strong>
        <p>
          Confira: R2 permite criar buckets; D1 permite criar bancos; Zero Trust
          permite gerenciar aplicações; e o domínio do túnel está ativo. Depois
          execute o instalador e guarde a pasta privada que ele criar.
        </p>
      </aside>
    </section>
  );
}
