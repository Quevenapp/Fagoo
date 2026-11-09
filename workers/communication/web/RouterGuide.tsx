import countersImage from "../docs/screenshots/29-router-contadores.jpg";
import accountImage from "../docs/screenshots/30-router-conta.jpg";
import poolImage from "../docs/screenshots/31-router-grupo.jpg";
import policyImage from "../docs/screenshots/43-router-funcoes.jpg";

export function RouterGuide() {
  return (
    <section id="roteador" className="system-card card hermes-guide">
      <div className="eyebrow">DEPOIS DE INSTALAR · VERSÃO 0.9.0</div>
      <h2>Uma entrada para seus números WhatsApp</h2>
      <p>
        Use <strong>Meta direto</strong> para conectar os números da mesma conta
        empresarial do WhatsApp, chamada WABA. A quantidade permitida é definida
        pela Meta; o Wabotia não impõe um limite fixo de linhas. O roteador usa
        um webhook compartilhado e permite escolher um número ou grupo pela API.
        Hermes não precisa de alteração para este recurso.
      </p>
      <p>
        Atualize em{" "}
        <strong>
          Sistema e atualizações → Verificar atualização → Atualizar Wabotia
        </strong>
        . Depois, escolha o perfil e abra
        <strong> Roteador de números</strong>. Faça backup antes de atualizar.
      </p>
      <h3>Primeiro, entenda o que pode ser distribuído</h3>
      <p>
        Ainda não cadastrou o chip na Meta ou não sabe onde obter os tokens?
        Comece pelo{" "}
        <a href="#meta-whatsapp">passo a passo do número e da API oficial</a>.
      </p>
      <p>
        Segundo o{" "}
        <a
          href="https://whatsappbusiness.com/resources/faq/"
          target="_blank"
          rel="noreferrer"
        >
          FAQ da Meta
        </a>
        , desde 01/10/2026 as primeiras 1.000 mensagens de atendimento por
        número empresarial/mês são gratuitas. O Wabotia acompanha a franquia e
        permite a continuidade com serviço pago. Modelos ficam separados e
        exigem autorização em cada envio. Uma resposta sem template enviada
        depois de um modelo continua sendo mensagem de serviço e entra no
        contador.
      </p>
      <p>
        O cliente precisa ter falado com{" "}
        <strong>aquele mesmo número nas últimas 24 horas</strong>. Quando a
        franquia acaba, a conversa mantém o remetente e continua com cobrança do
        excedente. O link público do grupo alterna{" "}
        <strong>novos contatos</strong> desde o início, priorizando números com
        franquia e usando serviço pago quando todos a esgotarem.
      </p>
      <details>
        <summary>1. Cadastre a conta Meta e suas chaves</summary>
        <ol>
          <li>
            Na Meta, tenha uma WABA com os números já habilitados na Cloud API.
            O Wabotia não compra nem registra números.
          </li>
          <li>
            Separe o <strong>WABA ID</strong>, o <strong>token Meta</strong> com
            acesso aos números e o <strong>App Secret</strong> do aplicativo.
          </li>
          <li>
            Escolha um <strong>Verify Token</strong>: uma chave que você vai
            colocar igual no Wabotia e na Meta para confirmar o webhook.
          </li>
          <li>
            Abra <strong>Cadastrar ou editar a conta Meta</strong>. Informe
            nome, WABA ID, fuso igual ao da conta Meta e os três campos
            protegidos. Clique <strong>Salvar conta Meta</strong> e aguarde a
            confirmação.
          </li>
        </ol>
        <p>
          O token precisa permitir consultar a WABA/modelos e enviar mensagens
          pelos números. App Secret, Verify Token e token Meta têm funções
          diferentes; nenhum deles é sua senha de entrada ou a chave de
          integração do Wabotia.
        </p>
        <img
          src={accountImage}
          alt="Cadastro da conta Meta, campos protegidos e endereço do webhook; dados fictícios"
          className="guide-reference-image"
        />
      </details>
      <details>
        <summary>2. Coloque o webhook único na Meta</summary>
        <ol>
          <li>
            Copie <strong>Webhook único desta conta</strong>, exibido depois de
            salvar.
          </li>
          <li>
            No aplicativo Meta, procure{" "}
            <strong>WhatsApp → Configuração → Webhook</strong>. Cole essa URL e
            o mesmo Verify Token. Verifique e salve.
          </li>
          <li>
            Assine <strong>messages</strong>. Confirme que a WABA está inscrita
            nesse aplicativo Meta. Chamadas e grupos podem exigir também os
            eventos próprios desses recursos.
          </li>
          <li>
            Use essa mesma URL para os números da conta. O Wabotia identifica
            cada telefone pelo Phone Number ID.
          </li>
        </ol>
        <p>
          O endereço correto começa com o domínio{" "}
          <strong>da sua instalação</strong>. As imagens mostram um ambiente
          local fictício; não copie o endereço 127.0.0.1 delas. O App Secret
          valida as mensagens recebidas. Evite outro sistema respondendo
          simultaneamente pelo mesmo número.
        </p>
      </details>
      <details>
        <summary>3. Busque números e informe o consumo inicial</summary>
        <ol>
          <li>
            Clique <strong>Buscar números na Meta</strong> e selecione um
            telefone encontrado.
          </li>
          <li>
            Confira na Meta quantas mensagens de atendimento ele já usou neste
            mês. Informe esse valor, mesmo que os envios tenham sido feitos por
            outro sistema.
          </li>
          <li>
            Informe a franquia gratuita, até 1.000, e marque a confirmação do
            consumo e fuso. Clique <strong>Adicionar ao roteador</strong>.
          </li>
          <li>
            O número entra pausado. Confira o webhook, clique{" "}
            <strong>Ativar</strong> na lista e repita para os demais números.
          </li>
        </ol>
        <p>
          Se o número já está em Conexões, pause-o, resolva entregas sem
          confirmação e aguarde os comprovantes de mensagens anteriores antes de
          adicioná-lo. Seu histórico é preservado.
        </p>
        <img
          src={countersImage}
          alt="Dois números fictícios com uso mensal, reservas, saldo e configuração de consumo"
          className="guide-reference-image"
        />
        <p>
          <strong>Uso protegido</strong> soma o histórico inicial, as entregas
          de atendimento e as reservas. Falha confirmada ou cancelamento antes
          do envio libera a reserva. Um resultado sem confirmação continua
          reservado. Modelos pagos não consomem esse contador.
        </p>
        <p>
          Os contadores são uma proteção local, não a fatura Meta. Confira
          envios feitos fora do Wabotia, atrasos nos recibos e o fuso. “Cobrança
          não informada” não significa gratuito. O mês muda conforme o fuso
          cadastrado.
        </p>
      </details>
      <details>
        <summary>3.1. Escolha a função e as permissões de cada número</summary>
        <ol>
          <li>
            Em <strong>Uso por número</strong>, abra{" "}
            <strong>Função e permissões</strong> no telefone desejado.
          </li>
          <li>
            Escolha <strong>Atendimento oficial</strong> para seu número fixo de
            contato: menu, bots, atendentes e templates autorizados; fora dos
            grupos por padrão.
          </li>
          <li>
            Escolha <strong>Integração com janela de 24 horas (Vinki)</strong>{" "}
            para responder pela API: permite serviço e grupos, bloqueia
            templates e desliga menu, bots e atendimento manual.
          </li>
          <li>
            Marque ou desmarque cada opção conforme precisar. A função passa a{" "}
            <strong>Personalizado</strong>.
          </li>
          <li>
            Clique <strong>Salvar função e permissões</strong>. Aguarde a
            confirmação. Isso não ativa o canal nem a automação do perfil.
          </li>
        </ol>
        <p>
          As permissões do número prevalecem sobre as dos grupos e programas. A
          janela continua vinculada ao mesmo remetente. Recebimento, histórico e
          contadores são preservados; desligar uma opção também bloqueia
          mensagens ainda na fila.
        </p>
        <img
          src={policyImage}
          alt="Função de integração com 24 horas: serviço, API e grupos habilitados; templates, atendentes, menu e bots desligados. Dados fictícios."
          className="guide-reference-image"
        />
        <p>
          O roteador também pode atender retirada de pedidos, check-in de
          recepção, estacionamento e solicitações ao ERP. Use templates
          autorizados para avisos fora da janela. Mil mensagens não significam
          mil clientes: cada resposta conta.
        </p>
      </details>
      <details>
        <summary>4. Crie o grupo e divulgue seu link</summary>
        <ol>
          <li>
            Abra <strong>Criar grupo de roteamento</strong>, dê um nome e marque
            os números da mesma conta.
          </li>
          <li>
            O grupo usa{" "}
            <strong>Rodízio com prioridade à franquia gratuita</strong>. Cada
            novo atendimento passa à próxima linha elegível, sem esperar que uma
            linha consuma toda a franquia.
          </li>
          <li>
            Ative o grupo e marque <strong>Criar link público</strong> se
            desejar uma entrada única para novos clientes.
          </li>
          <li>
            Se usará modelos pagos, marque a permissão específica. Cada envio
            ainda precisa de autorização explícita.
          </li>
          <li>
            Salve. Divulgue o link para o cliente abrir o WhatsApp e começar a
            conversa. Copie o ID do grupo para seu sistema integrador.
          </li>
        </ol>
        <img
          src={poolImage}
          alt="Grupo de exemplo com dois números, link público e autorização de modelos pagos"
          className="guide-reference-image"
        />
        <p>
          O link não envia mensagem nem transfere atendimentos antigos. Grupos
          podem compartilhar números; a contagem de cada número continua única.
        </p>
      </details>
      <details>
        <summary>5. Autorize seu programa e os modelos pagos</summary>
        <ol>
          <li>
            Crie a aplicação e sua chave em <strong>API e integrações</strong>,
            com acesso ao perfil.
          </li>
          <li>
            Em <strong>Autorizar programas externos</strong>, selecione a
            aplicação e marque os números diretos ou grupos permitidos.
          </li>
          <li>
            Marque modelos pagos somente se esse programa deverá usá-los. Salve.
            Um grupo autoriza seus membros atuais e futuros; escolher um número
            diretamente exige a permissão individual.
          </li>
          <li>
            No servidor do integrador, envie um pedido com{" "}
            <code>number_id</code> ou <code>pool_id</code>, o telefone do
            cliente e um identificador externo estável.
          </li>
        </ol>
        <p>
          Modelo pago exige <code>allow_paid: true</code> naquele pedido, modelo
          aprovado e referência do consentimento do destinatário na mesma
          categoria. O Wabotia não transforma uma resposta comum ou notificação
          automática em modelo pago.
        </p>
        <p>
          A resposta 202 significa <strong>na fila</strong>. Consulte o estado
          até obter o recibo. Repetir o mesmo pedido usa a mesma chave de
          idempotência. Se aparecer Sem confirmação, confira antes de tentar
          novamente ou trocar de número.
        </p>
        <p>
          <a
            href="https://github.com/Quevenapp/Wabotia/blob/main/docs/ROTEADOR.md"
            target="_blank"
            rel="noreferrer"
          >
            Exemplos cURL, JavaScript e Python e configuração detalhada
          </a>{" "}
          · <a href="/api-docs">API interativa</a>
        </p>
      </details>
      <p>
        <strong>Antes de atender clientes:</strong> teste com seus números reais
        a entrada em cada telefone, a escolha de grupo, o modelo autorizado, os
        recibos e os contadores. Os testes do projeto usam dados fictícios; a
        homologação da sua conta Meta é a última etapa.
      </p>
    </section>
  );
}
