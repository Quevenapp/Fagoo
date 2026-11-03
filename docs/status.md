# Estado da reconstrução

O FAGOO desta linha deriva da aplicação completa do Brufap no commit `97be7a7eab5c132e540748757120a55897f1e971`. O template original permanece. A linha do piloto fica identificada pelo histórico e pela versão `v0.1.0-alpha.1`; o número `0.2.0-dev.0` identifica desenvolvimento, sem anunciar release instalável.

## Recuperado e adaptado

- Código original da interface, módulos comerciais, cadastros, estoque, PDV, financeiro, CNAB, fiscal e permissões.
- Histórico das 311 migrações, com funções e guardas mantidas. Os hashes de guardas afetados pela normalização de nomes foram recalculados somente após comparação com os corpos da fonte.
- Configuração explícita de backend próprio nos adaptadores e no frontend, preservando o modo hospedado e seus contratos de Auth/Storage/PostgREST.
- Configurações de exemplo sem destinos de cliente; agendamentos e integrações de efeitos desabilitados até configuração explícita.
- Inventário somente leitura e comparação offline para preparar a migração do Supabase.
- Rastreabilidade por arquivo e registro das alterações da referência em `tools/reference`.

## Ainda necessário para a próxima instalação

1. Montar e validar o stack compatível em Ubuntu: PostgreSQL, PostgREST, Auth, Storage e HTTPS. Confirmar migrações/bootstrap para instalação virgem e restauração para cliente existente.
2. Integrar o instalador à aplicação original e validar empresa inicial, administrador, e-mail, certificados, armazenamento, backup/restauração e logs.
3. Adaptar o provisionamento Cloudflare e a atualização pelo painel ao novo conjunto de serviços. Distribuição pública sem token GitHub continua sendo requisito; assinatura dos artefatos e compatibilidade do banco precisam ser verificadas antes da atualização.
4. Ensaiar a restauração de uma cópia autorizada do Supabase, incluindo Auth, objetos de Storage e material criptográfico privado, com reconciliação de saldos, documentos e movimentos.
5. Acrescentar os contratos de integração para Hermes/Vinki e descoberta de servidor para Android/iOS sobre as regras originais do ERP. A IA externa interpreta e propõe; permissões, validações, idempotência e registros contábeis/de estoque permanecem no ERP.
6. Validar capacidade e operação com o container Hermes na VPS de 1 vCPU/4 GB antes de definir esse tamanho como configuração de produção.

O novo template visual é uma etapa posterior. Nenhuma destas pendências autoriza remover módulos ou reduzir o modelo do ERP para acomodar o piloto anterior.

## Limite das evidências

Compilação, testes sintéticos e comparação estrutural não demonstram que dados de um cliente foram migrados. Nenhum banco de produção foi conectado, restaurado ou alterado durante a recomposição. A publicação de uma branch de código não atualiza a instalação existente nem libera emissão fiscal/bancária em produção.
