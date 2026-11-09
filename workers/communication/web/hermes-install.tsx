import React from "react";

const manual =
  "https://github.com/Quevenapp/Wabotia/blob/main/docs/HERMES-CLOUDFLARE.md";
const prepare = `python3 scripts/prepare-hermes.py --profile wabotia --create-profile \\
  --admin-hostname hermes-local.seudominio.com \\
  --api-hostname api-hermes-local.seudominio.com`;

export function HermesInstall() {
  return (
    <section
      className="account-setup hermes-guide"
      id="hermes"
      aria-labelledby="hermes-guide-title"
    >
      <div className="eyebrow">DEPOIS DO DEPLOY · HERMES E CLOUDFLARE</div>
      <h2 id="hermes-guide-title">Ligue a API e conecte o seu Hermes</h2>
      <p>
        O Hermes pode estar no seu computador ou em uma VPS. Siga a ordem
        abaixo. Se o Wabotia já está instalado, mantenha sua MASTER_KEY e seu
        SETUP_TOKEN originais.
      </p>
      <p>
        <a href={manual} target="_blank" rel="noopener noreferrer">
          Abrir todos os comandos para computador local e VPS Docker ↗
        </a>{" "}
        · <a href="/guide/wabotia-instalacao.pdf">Abrir PDF ilustrado</a>
      </p>
      <details open>
        <summary>1. API desligada? Prepare o Hermes primeiro</summary>
        <div className="guide-detail">
          <p>
            No Ubuntu/Linux, abra o Terminal com o usuário do Hermes. No
            Windows, abra o Ubuntu/WSL2 onde ele foi instalado. No Mac, abra
            Terminal. Entre na pasta do código Wabotia; se não tiver uma cópia:
          </p>
          <pre>
            <code>{`git clone https://github.com/Quevenapp/Wabotia.git\ncd Wabotia`}</code>
          </pre>
          <p>
            Troque <code>seudominio.com</code> pelo domínio que está ativo na
            sua Cloudflare e execute:
          </p>
          <pre>
            <code>{prepare}</code>
          </pre>
          <p>
            O assistente cria o perfil <strong>wabotia</strong> se necessário,
            faz backup, gera chaves ausentes e habilita a API no loopback.
            Canais e bots existentes são preservados. As chaves ficam no arquivo
            privado <code>~/.config/wabotia/hermes/chaves.local.txt</code>.
          </p>
          <p>
            <strong>Depois, ligue os processos.</strong> No Ubuntu com o gateway
            instalado como serviço de usuário:
          </p>
          <pre>
            <code>{`mkdir -p ~/.config/systemd/user
install -m 600 ~/.config/wabotia/hermes/hermes-wabotia-admin.service \\
  ~/.config/systemd/user/hermes-wabotia-admin.service
systemctl --user daemon-reload
systemctl --user enable --now hermes-wabotia-admin.service
systemctl --user restart hermes-gateway.service
python3 scripts/prepare-hermes.py --check`}</code>
          </pre>
          <p>
            Espere dois resultados <strong>OK</strong>: descoberta autenticada e
            API de bots autenticada. O teste também confirma que acesso sem
            chave é recusado. Reinicie fora de um atendimento em andamento. Se o
            serviço não existir, use o gerenciador pelo qual seu Hermes já
            inicia; não abra um segundo gateway.
          </p>
          <p>
            No macOS ou para execução manual, mantenha{" "}
            <code>python3 scripts/prepare-hermes.py --serve-admin</code> em
            outro terminal e reinicie o gateway pelo método existente. Confira
            modelo e provedor no perfil novo.
          </p>
        </div>
      </details>
      <details>
        <summary>2. Hermes em VPS Ubuntu com Docker</summary>
        <div className="guide-detail">
          <p>
            Entre por SSH ou pelo terminal da Hostinger. O{" "}
            <a href={manual + "#a2-vps-ubuntu-com-hermes-em-docker"}>
              roteiro Docker completo
            </a>{" "}
            usa a imagem oficial, contêiner <code>hermes</code>, dados
            persistentes em <code>/opt/data</code> e rede <code>host</code>.
            Confira antes de alterar:
          </p>
          <pre>
            <code>{`docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker inspect -f '{{.HostConfig.NetworkMode}}' hermes`}</code>
          </pre>
          <p>
            O manual mostra como copiar e executar o assistente dentro do
            contêiner, reiniciar o gateway e manter o backend administrativo
            como serviço. Preserve seu Compose e os volumes. Para rede{" "}
            <code>bridge</code>, o loopback do host e o do contêiner são
            diferentes; adapte a rede antes de continuar.
          </p>
          <p>
            Use endereços exclusivos: <code>hermes-vps.seudominio.com</code> e{" "}
            <code>api-hermes-vps.seudominio.com</code>, com túnel{" "}
            <code>wabotia-hermes-vps</code>. Os comandos da máquina local não
            devem ser executados fora do contêiner para configurar um Hermes
            Docker.
          </p>
        </div>
      </details>
      <details id="deploy-hermes">
        <summary>
          3. Fazer deploy da configuração Cloudflare pelo Wabotia
        </summary>
        <div className="guide-detail">
          <p>
            Depois dos dois OK locais, você pode preparar Access, túnel e DNS
            pelo painel. O Hermes continua na sua máquina ou VPS. Se já conectou
            esta máquina pelo procedimento manual, mantenha a conexão existente.
          </p>
          <ol>
            <li>
              Ative Zero Trust e confirme seu domínio ativo na Cloudflare. Abra{" "}
              <strong>
                My Profile → API Tokens → Create Token → Custom Token
              </strong>
              .
            </li>
            <li>
              Limite o token à sua conta e zona. Na conta, conceda{" "}
              <strong>Cloudflare Tunnel: Edit</strong>,{" "}
              <strong>Access: Apps and Policies: Edit</strong> e{" "}
              <strong>Access: Service Tokens: Edit</strong>. Na zona,{" "}
              <strong>Zone: Read</strong> e <strong>DNS: Edit</strong>.
            </li>
            <li>
              Na visão geral do domínio, copie Account ID e Zone ID. No Wabotia,
              vá a{" "}
              <strong>
                Sistema e atualizações → Preparação do Hermes na Cloudflare
              </strong>
              . Cole os IDs e o token e clique em{" "}
              <strong>Verificar e salvar autorização</strong>. Esse token de API
              é diferente do Client ID/Secret do Access.
            </li>
            <li>
              Em <strong>Conexões → Preparar Hermes na Cloudflare</strong>,
              informe dois subdomínios novos, o nome do perfil Hermes, as portas
              e as duas chaves Hermes do arquivo privado{" "}
              <code>chaves.local.txt</code>. Para outra máquina, escolha outros
              endereços.
            </li>
            <li>
              Confirme que as APIs estão ligadas, clique em{" "}
              <strong>Revisar configuração</strong> e confira o resumo. Clique
              em <strong>Fazer deploy da configuração</strong> e acompanhe as 12
              etapas.
            </li>
            <li>
              Quando aparecer <strong>Configuração pronta</strong>, escolha
              Linux/WSL2, Docker no Linux ou macOS/terminal. Baixe o instalador
              do conector e execute na máquina onde está o Hermes. O arquivo
              contém uma credencial: envie à VPS somente por meio privado.
            </li>
          </ol>
          <pre>
            <code>bash wabotia-conector-linux.sh</code>
          </pre>
          <p>
            Instale <code>cloudflared</code> antes pelo site oficial, ou Docker
            se escolheu essa opção. Linux/WSL2 usa um serviço separado de
            usuário. Em VPS, habilite a permanência após logout com{" "}
            <code>sudo loginctl enable-linger "$USER"</code>. macOS/terminal
            precisa ficar aberto. Em Docker Linux, o conector usa a rede do host
            e precisa alcançar as portas locais do Hermes.
          </p>
          <p>
            Volte ao cartão criado, clique em{" "}
            <strong>Ativar → Testar conexão → Descobrir bots</strong>. O
            resultado aparece no próprio cartão, com um atalho para a Equipe
            Bot. Selecione o Atendente e ative o atendimento somente depois dos
            testes.
          </p>
          <p>
            O assistente preserva DNS, aplicações e túneis existentes. Se um
            endereço já estiver usado, escolha outro ou mantenha o procedimento
            manual. Se a criação ficar sem confirmação, confira a etapa no
            dashboard antes de continuar. A credencial Access gerada vale por um
            ano; renove-a antes do vencimento.
          </p>
        </div>
      </details>
      <details id="cloudflare-hermes">
        <summary>
          Alternativa manual: ativar Zero Trust e criar o Access
        </summary>
        <div className="guide-detail">
          <ol>
            <li>
              Na Cloudflare, escolha a conta que possui seu domínio ativo. Abra{" "}
              <strong>Zero Trust → Controles de acesso → Aplicativos</strong>.
            </li>
            <li>
              Se aparecer a tela de boas-vindas, clique <strong>Começar</strong>
              . Escolha o plano adequado; <strong>Zero Trust gratuito</strong>,
              quando disponível, atende a configuração inicial. Confira valores
              e termos antes de concluir. É separado do plano Workers.
            </li>
            <li>
              Abra{" "}
              <strong>
                Credenciais de serviço → Service Tokens → Criar token de serviço
              </strong>
              . Em telas antigas: Access → Service Auth. Nomeie{" "}
              <code>wabotia-hermes-local</code> e escolha a validade.
            </li>
            <li>
              A Cloudflare gera <strong>Client ID</strong> e{" "}
              <strong>Client Secret</strong>. Guarde os dois. O segredo pode ser
              mostrado somente uma vez.
            </li>
            <li>
              Em{" "}
              <strong>Aplicativos → Adicionar aplicativo → Self-hosted</strong>,
              cadastre <code>hermes-local.seudominio.com</code>. Deixe o caminho
              vazio para proteger todo o hostname.
            </li>
            <li>
              Adicione a política <strong>Somente Wabotia</strong>: ação{" "}
              <strong>Service Auth</strong>, regra{" "}
              <strong>Include → Service Token</strong>, selecionando o token
              criado. Salve. Não use Everyone ou Bypass.
            </li>
            <li>
              Repita para <code>api-hermes-local.seudominio.com</code>, com o
              mesmo token desta conexão. Confirme as duas proteções antes de
              publicar o túnel.
            </li>
          </ol>
          <p>
            O Worker usa o par Client ID/Secret. Uma política que exige login
            por e-mail não permite essa comunicação automática.
          </p>
        </div>
      </details>
      <details>
        <summary>4. Cloudflare: criar túnel, rotas e DNS</summary>
        <div className="guide-detail">
          <ol>
            <li>
              Abra <strong>Rede → Túneis → Criar túnel</strong> (ou Zero Trust →
              Networks → Connectors). Escolha Cloudflared e nomeie{" "}
              <code>wabotia-hermes-local</code>.
            </li>
            <li>
              Escolha o sistema da máquina do Hermes e instale cloudflared pelos
              comandos oficiais exibidos. O comando de conexão contém um{" "}
              <strong>token do túnel</strong>: ele fica somente nessa máquina.
            </li>
            <li>
              Se já existe um serviço cloudflared, siga o{" "}
              <a
                href={
                  manual + "#e2-serviço-separado-no-ubuntulinuxwsl2-com-systemd"
                }
              >
                modelo de serviço separado do manual
              </a>
              . Não substitua o túnel existente. Aguarde o estado{" "}
              <strong>Healthy / Íntegro</strong>.
            </li>
            <li>
              Em{" "}
              <strong>Published application routes / Public Hostnames</strong>,
              cadastre as duas rotas da tabela. Os nomes de domínio devem ser os
              mesmos protegidos pelo Access.
            </li>
          </ol>
          <div className="guide-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Campo</th>
                  <th>Administrativo</th>
                  <th>Bots</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Subdomínio</td>
                  <td>hermes-local</td>
                  <td>api-hermes-local</td>
                </tr>
                <tr>
                  <td>Domínio</td>
                  <td>seudominio.com</td>
                  <td>seudominio.com</td>
                </tr>
                <tr>
                  <td>Path no Tunnel</td>
                  <td>
                    <code>^/api/profiles$</code>
                  </td>
                  <td>
                    <code>^/p/wabotia/v1/.*$</code>
                  </td>
                </tr>
                <tr>
                  <td>Tipo e serviço</td>
                  <td>HTTP · 127.0.0.1:9119</td>
                  <td>HTTP · 127.0.0.1:8642</td>
                </tr>
                <tr>
                  <td>HTTP Host Header</td>
                  <td>127.0.0.1:9119</td>
                  <td>Deixar padrão</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            O HTTP Host Header fica em{" "}
            <strong>Additional application settings → HTTP Settings</strong>.
            Confira em DNS os CNAMEs criados para o túnel, com proxy ativo. Não
            abra portas no roteador. Na VPS, use os subdomínios com{" "}
            <code>vps</code>.
          </p>
          <p>
            Sem chaves, o Access deve bloquear as rotas. A raiz do endereço pode
            retornar 404: só os caminhos acima são publicados. O teste
            autenticado será pelo Wabotia.
          </p>
        </div>
      </details>
      <details>
        <summary>5. Wabotia: onde colar cada URL e cada chave</summary>
        <div className="guide-detail">
          <p>
            Na <strong>sua instalação</strong>, crie um perfil de atendimento e
            abra <strong>Conexões → Nova conexão → Hermes</strong>. Mantenha o
            atendimento pausado até concluir os testes.
          </p>
          <div className="guide-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Campo</th>
                  <th>Valor / origem</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>URL administrativa</td>
                  <td>https://hermes-local.seudominio.com</td>
                </tr>
                <tr>
                  <td>URL da API dos bots</td>
                  <td>https://api-hermes-local.seudominio.com</td>
                </tr>
                <tr>
                  <td>Token administrativo</td>
                  <td>Token administrativo Hermes de chaves.local.txt</td>
                </tr>
                <tr>
                  <td>Nome do perfil Hermes</td>
                  <td>wabotia</td>
                </tr>
                <tr>
                  <td>API_SERVER_KEY</td>
                  <td>Chave desse perfil de chaves.local.txt</td>
                </tr>
                <tr>
                  <td>Cloudflare Access: Client ID e Client Secret</td>
                  <td>Par gerado em Service Tokens na Cloudflare</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Use as URLs base, sem acrescentar <code>/api/profiles</code> ou{" "}
            <code>/p/wabotia/v1</code>. No arquivo privado, copie somente os
            valores. O token do túnel não entra no Wabotia.
          </p>
          <p>
            Salve, clique <strong>Testar conexão</strong> e{" "}
            <strong>Descobrir bots</strong>. Ative a conexão, habilite{" "}
            <code>wabotia</code> em Equipe Bot e selecione-o como Atendente.
            Confira modelo e provedor no Hermes antes de testar uma conversa.
          </p>
        </div>
      </details>
      <details>
        <summary>6. Parou de funcionar? Como religar a API e o túnel</summary>
        <div className="guide-detail">
          <p>No Ubuntu nativo com os serviços deste guia:</p>
          <pre>
            <code>{`systemctl --user start hermes-gateway.service
systemctl --user start hermes-wabotia-admin.service
systemctl --user start cloudflared-wabotia.service
python3 scripts/prepare-hermes.py --check`}</code>
          </pre>
          <p>
            Se desabilitou a API na configuração, repita a preparação do passo 1
            e depois{" "}
            <code>systemctl --user restart hermes-gateway.service</code>. As
            chaves existentes são preservadas. No Docker, use os comandos da{" "}
            <a
              href={
                manual + "#g-a-api-ou-o-túnel-desligou-como-ligar-novamente"
              }
            >
              seção de recuperação da VPS
            </a>
            .
          </p>
          <p>
            <strong>502:</strong> confira as portas e o teste local.{" "}
            <strong>1033:</strong> ligue o túnel. <strong>401/403:</strong>{" "}
            confira chaves, validade e Service Auth.{" "}
            <strong>Invalid Host:</strong> confira o HTTP Host Header.{" "}
            <strong>Perfil não executa:</strong> confira modelo e autenticação
            do provedor no Hermes.
          </p>
          <p>
            Mantenha a máquina e o WSL ligados, sem suspensão. Com Hermes
            offline, o painel continua disponível e o atendimento humano
            funciona nos canais ainda conectados.
          </p>
        </div>
      </details>
    </section>
  );
}
