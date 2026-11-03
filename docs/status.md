# Estado do FAGOO

A versão de desenvolvimento é `0.2.0-dev.0`. O FAGOO reúne interface web, API, módulos comerciais, estoque, PDV, financeiro, CNAB, fiscal, preferências e permissões, mantendo o template atual.

## Disponível no código

- Interface e módulos completos do ERP.
- Estrutura versionada do banco, funções, permissões e verificações de integridade.
- Adaptadores e frontend com configuração explícita de backend próprio.
- Configurações de exemplo sem destinos de cliente, com agendamentos e integrações de efeitos desabilitados até configuração explícita.
- Suítes de testes sintéticos, verificação de tipos, build da interface, empacotamento local dos Workers e perfil de testes do container fiscal.
- Núcleo local em Docker com PostgreSQL 17, autenticação, PostgREST, armazenamento e gateway restrito ao loopback, com imagens fixadas por digest.
- Script de provisionamento para Ubuntu 24.04, geração privada de credenciais e aplicação das 311 versões do schema com histórico e verificação de hashes.
- Cadastro inicial pelo serviço real de autenticação, com permissão administrativa e marcador permanente que impede repetir o bootstrap.
- Atualizador local do núcleo, após seleção manual da revisão pública: verifica compatibilidade, cria backup do banco e dos arquivos, preserva credenciais e aplica somente versões pendentes do schema.

## Entregas necessárias para uma release instalável

1. Ensaiar o provisionamento em uma VPS Ubuntu nova e integrar HTTPS, frontend, Workers e runtime fiscal ao fluxo completo.
2. Validar pela interface publicada o cadastro da empresa, login, MFA, recuperação de acesso e permissões.
3. Validar SMTP, certificados, logs, recuperação completa após falha e atualização entre duas releases distintas. O núcleo local já teve autenticação, arquivos, backup e restauração lógica exercitados com dados sintéticos.
4. Integrar provisionamento Cloudflare e atualização pelo painel, usando artefatos públicos assinados e contratos de compatibilidade de aplicação e banco.
5. Ampliar os contratos de integração para agentes externos, gerenciamento de filas e descoberta de servidor para os aplicativos móveis.
6. Medir capacidade e operação na VPS de referência, considerando os demais serviços executados no mesmo servidor.

## Contrato da distribuição

O bootstrap de produção cria uma instalação própria, sem dados comerciais de demonstração ou de outra empresa. Catálogos oficiais, permissões e padrões técnicos fazem parte da estrutura do sistema.

Todas as instalações recebem a mesma distribuição e seguem o mesmo contrato de atualização. O sistema preserva os dados e configurações locais enquanto aplica mudanças compatíveis e versionadas do banco. As releases não dependem de uma edição específica por cliente.

O novo template visual é uma etapa posterior. Alterações de infraestrutura ou aparência devem preservar os módulos, os campos e os fluxos do ERP.

## Limite das verificações

Os resultados em [verificação](verification.md) cobrem código, testes sintéticos, builds e serviços reais em Docker local. O atualizador disponível cuida apenas do núcleo local; download de releases e atualização pelo painel continuam pendentes. A release instalável depende do ensaio operacional completo descrito no [manual de instalação](operations/installation.md), incluindo recuperação após falha. As condições de habilitação e homologação de operações fiscais e bancárias permanecem próprias de cada módulo.
