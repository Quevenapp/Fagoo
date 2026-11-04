# Conexão externa opcional

Uma instalação nova funciona sem conexão com outro ERP. A conexão opcional API v3 é configurada pelo operador no arquivo privado da instalação e reaproveita o Worker da API, seu domínio e o processo normal de atualização. Não exige um terceiro Worker.

## Modos

| Modo | Recebimento | Envio |
| --- | --- | --- |
| `paused` | Parado | Parado |
| `receive` | Coleta e aplica alterações compatíveis | Parado |
| `bidirectional` | Coleta e aplica alterações compatíveis | Processa a fila de alterações locais |

O modo não é alterado pela autorização OAuth. Habilitar somente flags antigas `ORIGIN_*` não ativa a conexão no instalador: é necessário `FAGOO_INTEGRATION_ENABLED=true`.

## Configuração do operador

No código da release ativa, execute:

```sh
sudo python3 infra/configure-integration.py --env-file /opt/fagoo/private/install/.env --configure --mode paused
```

O assistente pede nome da conexão, data inicial, origem HTTPS da API, endpoints OAuth e credenciais do aplicativo. Client ID e secret usam entrada oculta. A chave de criptografia já existente é preservada; uma instalação sem chave recebe uma nova. O comando valida todos os campos antes de substituir o arquivo, preserva outras configurações e grava com permissão `0600`. Ele não publica nem inicia sincronização.

Registre no aplicativo externo a URL de retorno `https://SEU-DOMINIO-DA-API/oauth/callback`. Use os endpoints e escopos documentados pelo fornecedor. Não reutilize um par de refresh tokens que esteja sendo renovado por outra instalação.

Publique a configuração pelo procedimento do operador da instalação (`infra/deploy-application.py` da release ativa, com `--env-file`, `--credentials-file`, conta e zona existentes). Use o mesmo domínio e os mesmos Workers. A próxima atualização comum também lê a configuração persistida. Não execute novamente o instalador inicial.

O administrador passa a encontrar **Sincronizar → Configurar conexão**. A página de configuração fica em `https://SEU-DOMINIO-DA-API/integracao-externa` e solicita `INTEGRATION_ADMIN_TOKEN`, guardado no arquivo privado. A chave é enviada somente ao próprio servidor, não fica em armazenamento do navegador e não aparece no frontend. Autorize o aplicativo e confira o estado da conexão.

## Ativação

Antes de receber ou enviar dados, confira o ator técnico, as permissões, os vínculos de depósitos, contas, categorias, formas de pagamento, situações e a numeração dos documentos. Filas históricas importadas devem ser reconciliadas antes de ativar o envio. Receber dados também pode atualizar cadastros, estoque e baixas locais; faça backup e confira a janela de operação.

Para mudar o modo, execute o mesmo comando sem `--configure`, escolhendo `--mode receive` ou `--mode bidirectional`, e publique a configuração. A opção `receive` nunca cria o cliente de escrita nem consome a fila de envio. A coleta e a aplicação também dependem de `erp_sync.settings.enabled` e de um ator técnico válido. Não altere esses controles sem conferir a origem das filas.

No modo ativo, o cron roda a cada dois minutos. O botão **Sincronizar agora** pede uma rodada manual em mão dupla. O painel exibe contagens, fases, últimas atividades e pendências. Os limites do fornecedor e as dependências entre registros podem exigir mais de um ciclo.

## Entregas sem confirmação

Se uma alteração pode ter sido gravada externamente, mas sua resposta se perdeu, o FAGOO não a repete automaticamente. O mesmo vale para um pedido criado cuja etapa seguinte falhou. A fila preserva o ID recebido quando disponível e marca a entrega para conferência. O botão de sincronização, novas edições e a expiração de uma execução não removem essa trava.

O operador precisa conferir o registro e seus efeitos no serviço externo, registrar a decisão e reconciliar o vínculo e a fila. Não remova a marcação apenas para fazer o erro desaparecer. Não há garantia de entrega exatamente uma vez quando a API externa não fornece idempotência.

## Vínculos financeiros

Contas, categorias e formas de pagamento precisam de correspondência única. A integração não escolhe a primeira opção disponível. O recebimento pode usar uma conta padrão explicitamente configurada e ativa quando não houver correspondência; a baixa considera a conta informada no próprio pagamento.

Cada parcela recebida mantém sua referência externa de forma de pagamento, inclusive quando um documento mistura formas diferentes. Uma forma local informada precisa de vínculo válido. Para registros antigos sem referência, a recuperação exige correspondência única por descrição ou pela combinação de vencimento e valor da parcela original. Ausência ou ambiguidade gera pendência e impede o envio, para evitar trocar a forma de pagamento silenciosamente.

Receber documentos também avança a numeração local. A atualização ajusta as sequências para o maior número já existente, inclusive em documentos importados ou excluídos, sem renumerar os documentos.

## Limites

O conector cobre cadastros, pedidos, propostas, títulos, baixas e movimentos compatíveis com a API v3 configurada. Ordens de serviço, estorno de baixa, operações fiscais, lojas e logística dependem das capacidades específicas do fornecedor; ter um campo na interface não garante escrita externa. Estoque recebido pode ser um ajuste pela diferença de saldo, sem reproduzir os movimentos originais.

Se uma transição de situação no serviço externo cria estoque ou financeiro automaticamente, confira a responsabilidade por cada efeito antes de enviar os lançamentos correspondentes do FAGOO. A integração não deve produzir o mesmo efeito pelos dois caminhos.

As atualizações preservam as configurações e chaves privadas. A distribuição pública contém somente o mecanismo genérico. Credenciais, dados, instruções de fornecedores e procedimentos particulares da empresa não pertencem ao repositório público.
