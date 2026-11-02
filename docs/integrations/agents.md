# Integração com agentes externos

O FAGOO fornece dados e operações. O agente interpreta solicitações, executa análises externas e escolhe ferramentas dentro da autorização recebida. Nenhum modelo de linguagem é uma dependência do ERP.

Crie uma integração no painel administrativo e selecione apenas os escopos necessários. A credencial aparece uma vez; depois somente seu hash permanece no banco. Ela tem validade e pode ser revogada. Não compartilhe a credencial com o usuário final do atendimento.

## REST e MCP

Use `Authorization: Bearer <credencial>` em `/api/v1` e `/api/mcp`. O endpoint MCP implementa inicialização e as operações `tools/list` e `tools/call` por HTTP. As ferramentas visíveis são filtradas pelos escopos da integração; as regras também são verificadas na API de negócio.

Exemplo de configuração do bot equipe no Hermes, substituindo as variáveis no ambiente privado do agente:

```yaml
mcp_servers:
  fagoo:
    url: https://seu-servidor.example/api/mcp
    headers:
      Authorization: Bearer SUA_CREDENCIAL_PRIVADA
```

Este exemplo não modifica os perfis do WABABOTAI. As ferramentas precisam ser habilitadas no perfil correto, e a conexão deve ser testada antes de permitir operações reais. A identidade de integração não é uma conta administrativa do servidor.

## Dados para os cinco processos

| Processo | Dados e operações |
|---|---|
| Recebimento de mercadorias | Documento recebido, candidatos do catálogo, pedido, unidades e conferência; comandos de recebimento e financeiro separados. |
| Reposição | `analytics/replenishment-context`, `analytics/sales-series` e `stock/movements`, incluindo custos, mínimo/máximo, reservas, recebimentos e entradas previstas. |
| Pedido por conversa | Produtos, contatos, `commerce/customer-context`, regras de preço e criação/confirmação de pedido. |
| Orçamento de compra | Contexto de reposição e fornecedor. Calcular externamente as quantidades, custos e prioridades; não tratar custo desconhecido como zero. |
| Recorrência de cliente/produto | Séries com `group=customer_product_month`, distinguindo perda de recorrência do produto e inatividade do cliente. |

`next_cursor` é opaco e deve ser devolvido sem alteração à mesma consulta. Continue até `has_more=false`. Verifique a cobertura e a data de referência; uma página não é o conjunto completo. Valores monetários e quantidades são strings decimais, para cálculo exato com `Decimal` ou equivalente.

## Operações confiáveis

Gere um UUID `command_id` por intenção de alteração e preserve-o ao repetir a chamada após timeout. Uma intenção diferente exige outro UUID. Reutilizar uma identificação com conteúdo diferente é recusado.

Leia a versão atual antes de enviar `expected_version`. Um conflito exige nova consulta e reavaliação, não repetição automática com uma versão inventada. A confirmação física de recebimento deve vir do responsável pela mercadoria.

Os eventos persistidos podem ser consultados após um cursor e confirmados por consumidor. A conversa pode ser interrompida; o estado comercial deve ser recuperado da API. O agente não precisa receber credenciais de PostgreSQL, certificado fiscal ou acesso ao atualizador.

Classificações fiscais sugeridas precisam de evidências e regras aplicáveis. Os flags de validação dos documentos importados são parte do contrato e não podem ser substituídos por uma afirmação do modelo.

## Limites do piloto

O fluxo comercial foi exercitado com uma credencial de integração, por REST/MCP, incluindo cadastro de fornecedor, compra, recebimento, parcelas, venda, consulta de histórico e confirmação dos eventos. Esse ensaio verifica os contratos do FAGOO; não substitui configurar e avaliar o container do Hermes e suas instruções no ambiente do cliente.

A conciliação da nota recebida ainda não possui um vínculo persistente com pedido, recebimento e parcelas. Não use uma nova intenção de comando para repetir uma operação já executada. A coleta automática de documentos e a validação tributária operacional continuam indisponíveis.

O total do pedido é a soma dos itens. Frete, seguro, descontos globais, despesas e tributos adicionais ainda não possuem composição própria no pedido; uma nota cujo total inclua esses valores pode não corresponder ao pedido e deve ficar pendente. Não altere artificialmente o preço dos produtos para esconder a diferença. Parcelas armazenam valor e vencimento; linha digitável, PDF de boleto e pagamento bancário não fazem parte deste fluxo.

Para orçamento limitado, trate custo cadastral menor ou igual a zero como cotação pendente, salvo gratuidade confirmada explicitamente. O cálculo deve considerar embalagens, prazo, capital disponível e custos ainda ausentes. A projeção e a análise de recorrência são executadas pelo agente com ferramentas de cálculo; não representam uma previsão garantida pelo ERP.
