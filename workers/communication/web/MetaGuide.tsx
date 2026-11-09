import accountType from "../docs/screenshots/32-meta-tipo-conta.jpg";
import verified from "../docs/screenshots/34-meta-empresa-verificada.jpg";
import messaging from "../docs/screenshots/35-meta-conta-mensagens.jpg";
import appCreated from "../docs/screenshots/40-meta-app-criado.jpg";
import webhook from "../docs/screenshots/39-meta-webhook.jpg";
import appSecret from "../docs/screenshots/41-meta-app-secret-oculto.jpg";
import tokenPermissions from "../docs/screenshots/42-meta-token-permissoes.jpg";
import added from "../docs/screenshots/37-meta-numero-adicionado.jpg";
import status from "../docs/screenshots/38-meta-status-numero.jpg";
import wabotia from "../docs/screenshots/30-router-conta.jpg";

export function MetaGuide() {
  return (
    <section id="meta-whatsapp" className="system-card card hermes-guide">
      <div className="eyebrow">WHATSAPP OFICIAL · DO CHIP AO PAINEL</div>
      <h2>Cadastre seu número na API do WhatsApp</h2>
      <p>
        Comece aqui se ainda não tem o telefone na Meta. Este roteiro usa um
        <strong> número novo e Meta direto</strong>. Você recebe o código por
        SMS ou ligação, prepara o aplicativo e coloca as chaves na sua
        instalação Wabotia. Não precisa ler QR Code nem configurar WhatsApp no
        Hermes.
      </p>
      <p>
        <a href="/guide/wabotia-meta-whatsapp.pdf">
          Baixar este passo a passo em PDF
        </a>
        {" · "}
        <a
          href="https://github.com/Quevenapp/Wabotia/blob/main/docs/META-WHATSAPP.md"
          target="_blank"
          rel="noreferrer"
        >
          Abrir o roteiro completo
        </a>
      </p>
      <p>
        As telas reais foram conferidas em 06/11/2026 e recortadas para proteger
        dados privados. Alguns nomes aparecem em inglês. Se seu número já usa
        WhatsApp, pare antes do cadastro: migração e coexistência têm outro
        procedimento. Não apague a conta atual para experimentar.
      </p>
      <details open>
        <summary>1. O que a empresa precisa preparar</summary>
        <ul>
          <li>
            Administrador com acesso à Meta e ao e-mail; autenticação de dois
            fatores.
          </li>
          <li>
            Nome comercial, razão social, endereço, site, contato e documentos
            corretos. No Brasil, deixe o CNPJ disponível para a verificação
            solicitada.
          </li>
          <li>
            Site acessível com identificação da empresa e política de
            privacidade.
          </li>
          <li>
            Portfólio empresarial no Meta Business Suite e permissão para
            gerenciar os ativos.
          </li>
          <li>
            Número próprio com DDI e DDD, linha ativa e recebimento de SMS ou
            ligação.
          </li>
          <li>
            Wabotia instalado em HTTPS, administrador e perfil de atendimento.
          </li>
          <li>
            Responsável por revisar tarifas e configurar pagamento quando a Meta
            exigir.
          </li>
        </ul>
        <p>
          A operadora mantém sua linha. A Meta opera a API do WhatsApp. A
          Cloudflare mantém o Wabotia. São serviços e cobranças separados. Não
          cadastre o número novo no WhatsApp do celular antes deste roteiro.
        </p>
      </details>
      <details>
        <summary>2. Confira a empresa e entenda as verificações</summary>
        <ol>
          <li>
            Abra{" "}
            <a
              href="https://business.facebook.com/"
              target="_blank"
              rel="noreferrer"
            >
              Meta Business Suite
            </a>
            , selecione a empresa e entre em{" "}
            <strong>Configurações → Informações da empresa</strong>.
          </li>
          <li>
            Confira os dados e <strong>Status de verificação da empresa</strong>
            . Se já estiver Verificada, não crie outro portfólio.
          </li>
          <li>
            Quando solicitado, siga a <strong>Central de Segurança</strong>. A
            Meta pode pedir documentos e confirmação por contato ou domínio.
          </li>
          <li>
            Acompanhe a análise e corrija divergências pelos canais da própria
            Meta.
          </li>
        </ol>
        <img
          src={verified}
          className="guide-reference-image"
          alt="Status real de uma empresa verificada, sem dados cadastrais"
        />
        <p>
          Verificação da empresa, aprovação do nome do telefone e selo pago Meta
          Verified são coisas diferentes. A verificação como Provedor de
          Tecnologia é outra etapa, voltada a integrar ativos de outras
          empresas. Os limites de produção e escala dependem do que a Meta
          liberar para sua conta.
        </p>
      </details>
      <details>
        <summary>3. Cadastre o perfil e confirme o telefone</summary>
        <ol>
          <li>
            Abra{" "}
            <strong>
              Contas → Contas do WhatsApp → Adicionar → Criar conta do WhatsApp
            </strong>
            .
          </li>
          <li>
            Informe o nome comercial que o cliente deve ver e a categoria real
            da empresa. Leia os termos antes de continuar.
          </li>
          <li>
            Marque <strong>Adicionar um novo número</strong>. Não escolha “Usar
            somente um nome de exibição” para este roteiro.
          </li>
          <li>
            Selecione <strong>BR +55</strong> e digite DDD + telefone, sem
            repetir o +55.
          </li>
          <li>
            Escolha <strong>SMS</strong> ou <strong>Ligação telefônica</strong>.
            Clique Continuar e informe o código na Meta.
          </li>
          <li>
            Se não chegar, confira a linha e aguarde o prazo da tela antes de
            reenviar. O código SMS não é o token nem o PIN.
          </li>
        </ol>
        <img
          src={accountType}
          className="guide-reference-image"
          alt="Opções reais da Meta: criar conta, solicitar para cliente ou vincular conta existente"
        />
      </details>
      <details>
        <summary>4. Crie ou selecione a conta de mensagens</summary>
        <p>
          Na interface nova, <strong>Contas do WhatsApp</strong> reúne os
          telefones e <strong>Contas de mensagens</strong> organiza modelos e
          cobrança. As telas antigas usam o nome WABA. O portfólio empresarial e
          o aplicativo têm outros IDs; não misture esses identificadores.
        </p>
        <ol>
          <li>
            Se aparecer <strong>Create a new Messaging account</strong>, informe
            um nome reconhecível.
          </li>
          <li>
            Confira o fuso <strong>(GMT-03:00) America/Sao Paulo</strong>,
            quando for o fuso da operação.
          </li>
          <li>
            Leia os termos e conclua. Espere{" "}
            <strong>Conta do WhatsApp adicionada</strong>.
          </li>
          <li>
            Para os próximos telefones do mesmo grupo, adicione à mesma conta
            pelo WhatsApp Manager ou pela Configuração da API.
          </li>
        </ol>
        <img
          src={messaging}
          className="guide-reference-image"
          alt="Cadastro real da conta de mensagens com nome e fuso de São Paulo"
        />
        <img
          src={added}
          className="guide-reference-image"
          alt="Confirmação de conta WhatsApp adicionada na Meta"
        />
        <p>
          Não crie uma conta de mensagens para cada telefone do mesmo grupo. O
          limite de 20 do Wabotia não amplia o limite concedido pela Meta.
        </p>
      </details>
      <details>
        <summary>5. Crie o aplicativo Meta da integração</summary>
        <ol>
          <li>
            Abra{" "}
            <a
              href="https://developers.facebook.com/apps/"
              target="_blank"
              rel="noreferrer"
            >
              Meus apps
            </a>
            . Conclua o cadastro de desenvolvedor, se solicitado.
          </li>
          <li>
            Clique <strong>Criar aplicativo</strong>, informe nome e e-mail de
            contato.
          </li>
          <li>
            Escolha <strong>Conectar-se com clientes pelo WhatsApp</strong> e
            selecione o portfólio correto.
          </li>
          <li>
            Revise os requisitos, os termos e conclua. A Meta pode pedir sua
            senha novamente.
          </li>
          <li>
            Confirme que abriu o painel do aplicativo em Meus apps. A conta de
            mensagens no Business Suite é outra tela e não comprova a criação do
            aplicativo.
          </li>
          <li>
            Abra{" "}
            <strong>
              Personalizar o caso de uso WhatsApp → Configuração básica → Etapa
              2. Configuração da produção
            </strong>
            . Expanda
            <strong> Registre seu número de telefone do WhatsApp</strong> e
            confira a conta e o telefone já cadastrado. Nas telas antigas, use
            <strong> Começar a usar a API / Configuração da API</strong>.
          </li>
        </ol>
        <img
          src={appCreated}
          className="guide-reference-image"
          alt="Painel real do aplicativo criado, com o caso de uso WhatsApp"
        />
        <p>
          O aplicativo é um cadastro da integração, não um app para instalar no
          celular. Alterar o webhook de um aplicativo já usado pode afetar outro
          sistema.
        </p>
      </details>
      <details>
        <summary>6. Quais chaves guardar e onde encontrar</summary>
        <table>
          <thead>
            <tr>
              <th>Dado</th>
              <th>Origem e destino</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>ID da conta / WABA ID</td>
              <td>
                Copie o Messaging Account ID na Configuração de produção, ou o
                WABA ID na Configuração da API antiga. No Wabotia, use WABA ID.
                Não é o ID do app ou do portfólio.
              </td>
            </tr>
            <tr>
              <td>Phone Number ID</td>
              <td>
                Identifica um telefone na API. O roteador o encontra na busca;
                não é o telefone com DDI/DDD.
              </td>
            </tr>
            <tr>
              <td>Token Meta</td>
              <td>
                Gere para um usuário do sistema com acesso à conta e ao app.
                Cole no campo protegido Token Meta.
              </td>
            </tr>
            <tr>
              <td>App Secret</td>
              <td>
                App Meta → Configurações → Básico → Chave secreta do aplicativo.
                Cole em App Secret.
              </td>
            </tr>
            <tr>
              <td>Verify Token</td>
              <td>
                Escolha uma senha aleatória e coloque exatamente igual no
                Wabotia e na verificação do webhook Meta.
              </td>
            </tr>
            <tr>
              <td>PIN de seis dígitos</td>
              <td>
                Você define para registrar/proteger o número na Cloud API.
                Guarde separado; não é o código SMS.
              </td>
            </tr>
          </tbody>
        </table>
        <img
          src={appSecret}
          className="guide-reference-image"
          alt="Campo Chave Secreta do Aplicativo ainda oculto, com botão Mostrar"
        />
        <p>
          Pause a gravação ao revelar ou copiar segredos. Guarde em um
          gerenciador de senhas ou arquivo privado. O token temporário da
          Configuração da API expira rapidamente e não deve ser usado como
          credencial definitiva. Nada disso é sua MASTER_KEY, SETUP_TOKEN ou
          chave de integração Wabotia.
        </p>
      </details>
      <details>
        <summary>7. Gere o token de produção</summary>
        <ol>
          <li>
            Abra <strong>Configurações → Usuários → Usuários do sistema</strong>{" "}
            no Business Suite e crie o usuário da integração como
            <strong> Employee</strong>. Um nome simples como Wabotia foi aceito
            no cadastro de referência.
          </li>
          <li>
            Em <strong>Atribuir ativos</strong>, autorize o app e a conta do
            atendimento. Restrinja aos ativos necessários. Na tela atual,
            <strong> Apps → Gerenciar app</strong> autoriza o app;
            <strong> Contas de mensagens → Contas vinculadas → Tudo</strong>
            inclui envio, mas também configurações, usuários e dados de
            pagamento da conta. O administrador precisa avaliar esse alcance.
          </li>
          <li>
            Clique <strong>Gerar token</strong>, escolha o aplicativo e a
            validade. <strong>60 dias</strong> é a opção recomendada pela Meta;
            anote o vencimento e substitua antes dele. Nunca exige uma decisão
            explícita do administrador sobre acesso sem prazo.
          </li>
          <li>
            Conceda <code>whatsapp_business_management</code> e{" "}
            <code>whatsapp_business_messaging</code>. O roteiro Meta também
            inclui <code>business_management</code> quando necessário à gestão
            de ativos.
          </li>
          <li>
            Copie o token para seu local privado e para o campo protegido do
            Wabotia. Mesmo um token “sem expiração” pode ser revogado.
          </li>
        </ol>
        <img
          src={tokenPermissions}
          className="guide-reference-image"
          alt="Duas permissões selecionadas: gestão do WhatsApp e mensagens, antes da geração do token"
        />
        <p>
          Se não houver permissões disponíveis, confira o caso de uso WhatsApp,
          o portfólio e os ativos atribuídos ao usuário do sistema.
        </p>
      </details>
      <details>
        <summary>8. Confira se o telefone está conectado à Cloud API</summary>
        <p>
          Abra <strong>Gerenciador do WhatsApp → Números de telefone</strong>.
          Confirmar SMS, registrar na Cloud API e aprovar o nome são etapas
          distintas. A tela pode mostrar <strong>Conectado</strong> enquanto o
          nome ainda está <strong>Em análise</strong>.
        </p>
        <img
          src={status}
          className="guide-reference-image"
          alt="Nome em análise, telefone conectado e qualidade alta são estados diferentes"
        />
        <p>
          Se faltar registro, siga a etapa indicada pela Meta. A documentação
          oficial usa <code>POST /PHONE_NUMBER_ID/register</code> com o token e
          um PIN escolhido pelo responsável. O PDF explica o caminho de apoio
          para essa chamada. Não redefina PIN nem repita registro para tentar
          corrigir um erro de token.
        </p>
      </details>
      <details>
        <summary>9. Preencha o Wabotia e copie o webhook</summary>
        <ol>
          <li>
            Entre como administrador na <strong>sua instalação</strong>,
            selecione o perfil e abra <strong>Roteador de números</strong>. Pode
            começar com um número só.
          </li>
          <li>
            Abra <strong>Cadastrar ou editar a conta Meta</strong>. Preencha
            nome, ID da conta, fuso, Token Meta, App Secret e Verify Token.
          </li>
          <li>
            Clique <strong>Salvar conta Meta</strong> e espere a confirmação.
          </li>
          <li>
            Copie <strong>Webhook único desta conta</strong>. Use o domínio da
            sua instalação; nunca o endereço local fictício da imagem.
          </li>
        </ol>
        <img
          src={wabotia}
          className="guide-reference-image"
          alt="Campos protegidos e webhook do Wabotia, com dados fictícios"
        />
        <p>
          Use o caminho do roteador ou a conexão Meta individual, evitando
          cadastrar o mesmo telefone duas vezes. Para adotar uma conexão
          existente, pause e reconcilie suas entregas.
        </p>
      </details>
      <details>
        <summary>10. Ative o recebimento na Meta</summary>
        <ol>
          <li>
            No aplicativo, abra{" "}
            <strong>
              Personalizar o caso de uso WhatsApp → Configuração básica → Etapa
              2. Configuração da produção → Configurar webhooks
            </strong>
            . Na interface antiga, procure WhatsApp → Configuração.
          </li>
          <li>
            Cole a URL de callback do Wabotia e o{" "}
            <strong>mesmo Verify Token</strong>. Clique{" "}
            <strong>Verificar e salvar</strong>.
          </li>
          <li>
            Assine o campo <strong>messages</strong> para mensagens e recibos.
            Ligações e grupos podem exigir os eventos próprios.
          </li>
          <li>
            Confira se a conta de mensagens está inscrita nesse app. A
            assinatura dos campos e o vínculo da conta são verificações
            distintas. Na tela nova, abra o bloco do número e ligue
            <strong> Assinar webhooks</strong> na conta correta.
          </li>
        </ol>
        <img
          src={webhook}
          className="guide-reference-image"
          alt="Configuração de produção da Meta com campos vazios e aviso sobre publicação"
        />
        <p>
          O webhook precisa ser HTTPS e acessível à Meta. App Secret valida os
          eventos; Verify Token valida a configuração. Um teste fictício do
          webhook não comprova recebimento de mensagens reais.
        </p>
      </details>
      <details>
        <summary>
          11. Publique o aplicativo para receber mensagens reais
        </summary>
        <p>
          A Meta informa que aplicativos não publicados recebem somente eventos
          de teste do painel. Um webhook verificado ainda não basta para receber
          mensagens de produção.
        </p>
        <ol>
          <li>
            Abra <strong>Publicar</strong> no menu do aplicativo e confira as
            pendências.
          </li>
          <li>
            Complete os dados e as URLs públicas solicitadas com informações
            reais da empresa, incluindo política de privacidade e instruções de
            exclusão de dados quando exigidas.
          </li>
          <li>
            Conclua as verificações e publique quando os requisitos estiverem
            atendidos. Confira o status <strong>Publicado</strong> antes do
            teste real.
          </li>
        </ol>
        <p>
          Não invente uma URL nem use a política de outra empresa. Publicar o
          app não substitui a aprovação do nome do telefone nem eventuais
          análises da Meta.
        </p>
      </details>
      <details>
        <summary>12. Busque o telefone e faça o primeiro teste</summary>
        <ol>
          <li>
            No Wabotia, clique <strong>Buscar números na Meta</strong>,
            selecione o telefone e dê um nome.
          </li>
          <li>
            Informe o uso real do mês, confirme o fuso e adicione ao roteador.
            Zero somente se não houve uso.
          </li>
          <li>
            Confira na Meta o registro, as pendências, qualidade, limites e
            cobrança. Ative o número e o perfil quando estiver pronto.
          </li>
          <li>
            Use outro WhatsApp para iniciar uma conversa com o novo número.
            Confira em <strong>Conversas</strong>, assuma e responda.
          </li>
          <li>
            Confira a resposta no celular e o recibo em{" "}
            <strong>Entregas</strong>. Depois teste mídia e bot, se for usar
            Hermes.
          </li>
        </ol>
        <p>
          Cadastro concluído não autoriza envio pago a clientes. Modelos pagos
          precisam de modelo aprovado, consentimento e autorização explícita por
          envio.
        </p>
      </details>
      <details>
        <summary>13. Não funcionou? Confira estes pontos</summary>
        <ul>
          <li>
            <strong>Busca vazia:</strong> ID da conta, acesso do usuário do
            sistema e conta selecionada no app.
          </li>
          <li>
            <strong>Token inválido:</strong> validade e permissões; não confunda
            com App Secret ou Verify Token.
          </li>
          <li>
            <strong>Webhook recusado:</strong> conta salva no Wabotia, HTTPS
            público, URL exata e Verify Token idêntico.
          </li>
          <li>
            <strong>Verificou, mas não recebe:</strong> messages assinado, conta
            inscrita no app, aplicativo publicado, App Secret correto e número
            ativo.
          </li>
          <li>
            <strong>Recebe, mas não envia:</strong> registro Cloud API, janela,
            token, limites, situação da conta e cobrança.
          </li>
          <li>
            <strong>Duas respostas:</strong> confira se outro sistema ainda
            atende o mesmo número.
          </li>
        </ul>
      </details>
      <p className="small">
        Fontes:{" "}
        <a
          href="https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started/"
          target="_blank"
          rel="noreferrer"
        >
          Introdução oficial à Cloud API
        </a>
        {" · "}
        <a
          href="https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers"
          target="_blank"
          rel="noreferrer"
        >
          Requisitos e registro de telefones
        </a>
        {" · "}
        <a href="#roteador">
          Continuar para grupos, contadores e integração pela API Wabotia
        </a>
        .
      </p>
    </section>
  );
}
