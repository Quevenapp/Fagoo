# Instalação da linha reconstruída

Esta linha recupera o ERP completo da referência, com o template original. O manual do piloto `v0.1.0-alpha.1` instalava outra aplicação e não deve ser usado para esta árvore. O piloto existente pode continuar separado durante a validação. Não há conversão automática entre seu schema reduzido e o banco completo desta linha.

## Antes de uma instalação de cliente

O instalador Ubuntu precisa ser refeito e ensaiado com a aplicação original e os serviços de que ela depende:

1. PostgreSQL com a versão principal compatível, roles, extensões, schemas, funções, políticas e grants.
2. Auth compatível com os contratos de usuários, sessões, MFA, convites e recuperação de acesso.
3. PostgREST com os mesmos RPCs, contexto de identidade e permissões.
4. Storage com API, buckets, políticas, metadados e armazenamento persistente dos bytes.
5. Proxy HTTPS e configuração explícita dos endereços públicos do frontend e dos serviços.
6. Workers e runtime fiscal, respeitando as restrições de homologação e as chaves privadas existentes.
7. Backups consistentes, restauração ensaiada, serviço de atualização e rollback compatíveis com esta linha.

As configurações de exemplo não incluem conta, domínio ou projeto de um cliente. Tarefas agendadas e integrações que produzem efeitos começam desabilitadas. A execução fiscal/bancária depende da configuração e da validação próprias de cada módulo.

## Validação local de desenvolvimento

Siga os comandos do [README](../../README.md). Eles compilam a aplicação e executam testes; não instalam o stack completo. O botão de deploy e o botão de atualização do piloto não devem ser reaproveitados sem adaptar e testar seus contratos de versão, serviços e banco.

Para a validação do container fiscal, a partir da raiz:

```sh
docker build --target test -f packages/fiscal-runtime/Dockerfile -t fagoo-fiscal-validation .
```

Esse comando gera uma imagem de teste local. Não publica imagem, não cria DNS e não implanta Worker.

## Instalação nova e migração são procedimentos distintos

Uma instalação nova precisa de bootstrap de empresa/administrador sem dados comerciais de exemplo e com isolamento de credenciais. Uma migração precisa preservar o histórico completo. Não use a exportação comercial da interface como backup integral e não recrie movimentos antigos através dos endpoints de cadastro.

O roteiro de inventário, restauração em ambiente de ensaio, conferência e corte está em [migração do Supabase](supabase-migration.md). O ensaio deve validar login/MFA, cadastros, vendas, compras, PDV, estoque, financeiro/CNAB, anexos, fiscal e permissões antes da troca de endereço de produção.

## Distribuição e atualização

O objetivo continua sendo download público e atualização dentro do sistema sem token GitHub. Os artefatos precisam de assinatura, verificação de integridade, declaração de compatibilidade do banco, backup anterior à alteração e recuperação após falha. A reconstrução não deve ser anunciada como atualização compatível do piloto; ela exige um caminho de instalação/migração próprio e validado.

Os passos gravados de Cloudflare/Hostinger serão incorporados novamente ao manual operacional depois do ensaio do instalador correto. Nenhuma credencial deve ser publicada na documentação.
