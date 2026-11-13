# Acesso de agentes externos

Uma instalação pode permitir que um agente externo (um assistente de IA, um robô de integração) chame a API com um token próprio, sem sessão de navegador. O recurso vem desligado. Uma instalação nova, ou uma atualização, não cria agentes nem tokens.

O agente é um membro comum da empresa: uma conta técnica do serviço de autenticação, sem senha e sem login, com um perfil. As mesmas regras de qualquer usuário valem para ele em cada chamada: perfil, permissões de **Sistema → Usuários**, horários de acesso, validações de negócio e auditoria. O que ele grava fica registrado em nome do próprio agente, que aparece em **Sistema → Usuários** como os demais membros.

## Limites

- Perfis disponíveis: `consulta`, `vendas`, `estoque` e `fiscal`. Um agente nunca é `admin` nem `financeiro`.
- O agente não recebe os poderes financeiros que exigem segundo fator: baixar, cancelar, transferir, gerar remessa, ler retornos e boletos. Um token não tem sessão com segundo fator.
- Esse limite é conferido a cada chamada. Se o perfil ou as permissões do agente forem alterados depois para algo além do limite, as chamadas passam a responder `403 ERP_AGENT_ACCESS_DENIED` até a correção.
- O token não é aceito de navegadores (requisições com `Origin`) nem nas rotas de segurança, importação de backup, atualizações do sistema e pareamento com o Wabotia.
- O servidor MCP consulta e faz um conjunto pequeno de gravações comuns, listado abaixo. Pela API direta, o agente grava o que o perfil dele permite.
- A conta de uma pessoa nunca vira agente, e um agente não entra pela tela de login.

## Habilitar

Defina `FAGOO_AGENT_ACCESS_ENABLED=true` em `private/install/.env` e publique a API pelo procedimento do operador (`infra/deploy-application.py` da release ativa). O valor aceita somente `true` ou `false`, é preservado nas atualizações e não entra no build público. Com `false`, todo token de agente responde `401`, mesmo que exista no banco.

A migração `202611130001_access_agents.sql` precisa estar aplicada. Ela acompanha a atualização normal do sistema.

## Criar um agente

No servidor, com o código da release ativa:

```sh
sudo python3 infra/agent-access.py --env-file /opt/fagoo/private/install/.env create --name "Hermes" --role consulta
```

O comando cria a conta técnica, registra o agente e emite o primeiro token, válido por 90 dias. Use `--expires-days N` para outro prazo ou `--no-expiry` para um token sem validade. O token aparece uma única vez; o banco guarda apenas o seu SHA-256. Copie-o direto para a configuração privada do agente e não o registre em chamados, conversas ou repositórios.

Comece pelo perfil `consulta`, que só lê. Para restringir módulos, ajuste as permissões do agente em **Sistema → Usuários**, como faria com um usuário.

## Usar

O agente envia o token em cada chamada à API, sem cabeçalho `Origin`:

```sh
curl -H "Authorization: Bearer fagoo_agt_..." https://SEU-DOMINIO-DA-API/v1/me
```

As rotas, os corpos e os erros são os mesmos da API autenticada. Comandos de escrita continuam exigindo `command_id`; repetir o mesmo comando devolve o resultado já gravado.

| Resposta | Significado |
| --- | --- |
| `401 ERP_UNAUTHENTICATED` | Recurso desligado, ou token inexistente, vencido ou revogado |
| `403 ERP_AGENT_ACCESS_DENIED` | Agente inativo ou com perfil/permissões além do limite |
| `403 ERP_ACCESS_OUTSIDE_SCHEDULE` | Fora do horário de acesso configurado para o agente |
| `403 ERP_FORBIDDEN` | Rota fechada para agentes ou operação que o perfil não permite |
| `403 ERP_ORIGIN_NOT_ALLOWED` | Token de agente enviado por um navegador |

## Servidor MCP

Com o acesso de agentes habilitado, a API também atende `POST /mcp`, um servidor [Model Context Protocol](https://modelcontextprotocol.io) para assistentes que trabalham com ferramentas. O endereço usa o mesmo token do agente e não existe (`404`) enquanto `FAGOO_AGENT_ACCESS_ENABLED` for `false`. Tokens de sessão de pessoas e navegadores não são aceitos nele.

Cada ferramenta é uma chamada fixa a uma rota `/v1` já existente, feita pela própria API em nome do agente. Valem o perfil, as permissões e os horários do agente, e o token é conferido em toda mensagem. O que o perfil não permite volta como erro da ferramenta, com o código da API (por exemplo `ERP_FORBIDDEN`).

### Consultas

| Ferramenta | O que consulta |
| --- | --- |
| `consultar_acesso` | Perfil e recursos do agente |
| `listar_cadastros`, `consultar_cadastro` | Contatos, produtos e depósitos |
| `listar_documentos`, `consultar_documento` | Propostas, pedidos de venda, pedidos de compra e ordens de serviço |
| `listar_posicoes_estoque` | Saldo dos produtos e situação frente ao mínimo e ao máximo |
| `listar_titulos`, `consultar_titulo` | Contas a receber e a pagar |
| `consultar_vencimentos` | Totais diários a receber e a pagar, sem nomes |
| `consultar_painel` | Indicadores do painel inicial |

As listas devolvem até 50 itens por página, e uma resposta com mais de 200 mil caracteres é recusada com a orientação de refinar a busca.

### Gravações

| Ferramenta | O que grava | Perfis de agente que gravam |
| --- | --- | --- |
| `criar_contato`, `atualizar_contato` | Clientes, fornecedores e transportadores | `vendas` |
| `criar_produto`, `atualizar_produto` | Produtos e serviços | `estoque` |
| `criar_proposta` | Proposta comercial, em rascunho | Os que gravam propostas, como `vendas` |
| `criar_pedido_venda` | Pedido de venda, em aberto | Os que gravam pedidos, como `vendas` |
| `registrar_ocorrencia` | Anotação no histórico de um documento, sem mudar a situação | Os que gravam o documento |

O banco decide quem grava, como na API; a coluna resume os perfis disponíveis para agentes. Um agente `consulta` não grava nada: use esse perfil quando o assistente só deve ler.

O servidor MCP não oferece mudança de situação, cancelamento, exclusão, arquivamento, edição de documentos existentes, pedidos de compra, ordens de serviço novas, notas fiscais, baixas, transferências nem cobrança. Um pedido criado por ele não fatura, não movimenta estoque e não emite nota.

Três cuidados valem para toda gravação:

- **Comando.** Cada gravação leva um `comando_id` (UUID). O agente pode enviar o seu; sem ele, o servidor gera um e o devolve em qualquer recusa. Repetir a chamada com o mesmo `comando_id` devolve o que já foi gravado, sem duplicar. É o caminho depois de uma falha de conexão.
- **Versão.** Atualizações e ocorrências pedem o `version` lido do registro. Se o registro mudou, a resposta é `ERP_CONFLICT` e nada é gravado.
- **Avisos.** Contato com documento repetido ou inválido e produto com código ou GTIN repetido não são gravados de primeira: a ferramenta devolve `MCP_WARNINGS_UNCONFIRMED` com os registros parecidos. O assistente deve mostrar o aviso à pessoa e só então repetir com `confirmar_avisos`.

O que o agente grava fica na auditoria em nome dele. Textos lidos de cadastros e documentos podem conter instruções escritas por terceiros; o servidor orienta o assistente a tratá-los como dados e a gravar apenas quando a pessoa pedir, mas essa é uma orientação ao modelo, não uma garantia. O limite real é o perfil do agente, somado à aprovação de gravações que o próprio assistente oferecer.

O transporte é Streamable HTTP sem sessão, com uma resposta JSON por requisição (sem SSE), nas versões `2025-11-25`, `2025-06-18`, `2025-03-26` e `2024-11-05` do protocolo. O servidor oferece somente ferramentas; não há prompts nem recursos.

### Hermes Agent

Em `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  fagoo:
    url: "https://SEU-DOMINIO-DA-API/mcp"
    headers:
      Authorization: "Bearer fagoo_agt_..."
    tools:
      prompts: false
      resources: false
```

O arquivo passa a conter o token: mantenha-o legível apenas pelo usuário do agente (`chmod 600 ~/.hermes/config.yaml`) e fora de repositórios e cópias compartilhadas. As ferramentas aparecem no Hermes como `mcp_fagoo_consultar_acesso`, `mcp_fagoo_listar_cadastros` e assim por diante. As de consulta se anunciam como somente leitura (`readOnlyHint`); as de gravação não.

Para que o Hermes peça aprovação antes de cada gravação, a documentação dele indica marcar o servidor com `trust: untrusted`: as chamadas que gravam passam a perguntar e as de leitura seguem sem pergunta. Para um assistente que só deve ler, mesmo com um perfil que grava, restrinja a lista pelos nomes das ferramentas:

```yaml
    trust: untrusted
    tools:
      include: ["consultar_*", "listar_*"]
      prompts: false
      resources: false
```

Confira as duas opções na versão do Hermes instalada; elas pertencem ao Hermes, não ao FAGOO, e não foram testadas aqui.

Para conferir o servidor sem o agente:

```sh
curl -X POST https://SEU-DOMINIO-DA-API/mcp \
  -H "Authorization: Bearer fagoo_agt_..." -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Trocar, revogar e conferir

```sh
sudo python3 infra/agent-access.py --env-file /opt/fagoo/private/install/.env list
sudo python3 infra/agent-access.py --env-file /opt/fagoo/private/install/.env issue --agent UUID-DO-AGENTE
sudo python3 infra/agent-access.py --env-file /opt/fagoo/private/install/.env revoke --token-id UUID-DO-TOKEN
```

`list` mostra agentes, perfil, situação e, de cada token, os quatro últimos caracteres, a validade e o último uso (com precisão de um minuto). Para trocar um token, emita o novo, atualize o agente e revogue o antigo. A revogação vale na chamada seguinte e não volta atrás.

Para suspender um agente por inteiro, desative o usuário em **Sistema → Usuários**. Para suspender todos, volte `FAGOO_AGENT_ACCESS_ENABLED` para `false` e publique.

## O que sai da instalação

Tudo o que o agente lê pode ser enviado ao provedor de modelo que ele utiliza. O perfil e as permissões do agente definem quais dados, inclusive dados pessoais de contatos, ficam ao alcance dele. Textos de cadastros e observações chegam ao agente como dados de terceiros; por isso as operações que movimentam dinheiro e as fiscais ficam fora do alcance de um token.

Não há limite de chamadas por token nesta versão. Dimensione o uso considerando a carga do servidor.
