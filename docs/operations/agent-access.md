# Acesso de agentes externos

Uma instalação pode permitir que um agente externo (um assistente de IA, um robô de integração) chame a API com um token próprio, sem sessão de navegador. O recurso vem desligado. Uma instalação nova, ou uma atualização, não cria agentes nem tokens.

O agente é um membro comum da empresa: uma conta técnica do serviço de autenticação, sem senha e sem login, com um perfil. As mesmas regras de qualquer usuário valem para ele em cada chamada: perfil, permissões de **Sistema → Usuários**, horários de acesso, validações de negócio e auditoria. O que ele grava fica registrado em nome do próprio agente, que aparece em **Sistema → Usuários** como os demais membros.

## Limites

- Perfis disponíveis: `consulta`, `vendas`, `estoque` e `fiscal`. Um agente nunca é `admin` nem `financeiro`.
- O agente não recebe os poderes financeiros que exigem segundo fator: baixar, cancelar, transferir, gerar remessa, ler retornos e boletos. Um token não tem sessão com segundo fator.
- Esse limite é conferido a cada chamada. Se o perfil ou as permissões do agente forem alterados depois para algo além do limite, as chamadas passam a responder `403 ERP_AGENT_ACCESS_DENIED` até a correção.
- O token não é aceito de navegadores (requisições com `Origin`) nem nas rotas de segurança, importação de backup, atualizações do sistema e pareamento com o Wabotia.
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
