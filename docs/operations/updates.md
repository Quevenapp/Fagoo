# Atualizações do FAGOO

Todas as instalações utilizam a mesma distribuição, o mesmo schema e o mesmo caminho de atualização. O nome da empresa e a existência de dados comerciais não selecionam outra edição do produto.

## Atualização local disponível

Na versão `0.2.0-dev.0`, `scripts/update-runtime.sh` atualiza o núcleo local após o operador selecionar uma revisão pública compatível do código. Ele não baixa releases, não verifica assinatura de release, não publica Workers/frontend e não implementa o botão de atualização do painel.

Com a revisão desejada já obtida e a configuração privada preservada, execute na raiz da instalação:

```sh
sudo bash scripts/update-runtime.sh
```

O comando entra em manutenção. Ele verifica o histórico `fagoo_system.schema_migration` e a versão principal do PostgreSQL, impede dois processos de atualização simultâneos e interrompe os serviços que recebem escrita. Uma mudança de versão principal do PostgreSQL exige procedimento próprio e é recusada por esse caminho.

Antes da troca, grava um diretório privado em `private/backups/` com:

- `database.dump`: backup lógico completo do banco.
- `storage.tar`: bytes dos arquivos armazenados.
- `runtime.env`: configuração e segredos existentes.
- `previous-runtime-images.json`: identidades reais das imagens dos containers anteriores, capturadas antes da substituição.
- `target-runtime-manifest.json`: contrato da versão selecionada para atualização.

O manifesto de destino não identifica a versão anterior do código. Preserve também a release anterior e sua configuração de publicação para planejar a recuperação dos Workers, da interface e dos serviços. O diretório de backup contém segredos e dados da instalação; mantenha acesso restrito e cópia protegida fora da VPS.

Após o backup, o comando obtém as imagens fixadas por digest, inicia os serviços internos, aplica as versões públicas pendentes do schema e reabre o gateway. Ele não regenera chaves, não repete o cadastro inicial e não insere dados de demonstração. Mudanças já aplicadas são verificadas por hash; cada nova versão do schema e sua entrada no histórico são confirmadas na mesma transação.

Se houver falha depois do início da manutenção, o gateway é interrompido e o caminho do backup é informado. Não há rollback destrutivo automático. Investigue a falha e siga um plano de recuperação validado; trocar apenas a imagem da aplicação não desfaz alterações no banco. Se uma interrupção abrupta deixar `private/update-fagoo.lock`, confira os processos e o estado dos serviços antes de remover somente esse diretório de bloqueio vazio.

## Escopo do ensaio local

O núcleo foi criado a partir de uma base vazia, atualizado e conferido com administrador e arquivo sintéticos. O ensaio verificou preservação das credenciais, do histórico do schema, das permissões e dos bytes do arquivo. O backup do banco foi restaurado em um segundo banco descartável, com conferência do histórico, do administrador e dos metadados de armazenamento; o tar também continha os bytes exatos do arquivo. Alteração de hash é recusada; uma falha intencional de SQL não confirma nem os objetos dessa transação nem sua entrada no histórico.

Esse ensaio não substitui a validação em Ubuntu novo, a recuperação completa da implantação, a atualização entre duas releases distintas nem os testes dos Workers, do runtime fiscal e da interface pela origem pública.

## Serviço de atualização pelo painel

O objetivo do serviço de atualização é obter releases públicas sem exigir token GitHub do cliente. A implementação ainda precisa integrar download, verificação de assinatura e integridade dos artefatos, compatibilidade de versões, manutenção, backup, ativação, verificações de saúde e recuperação.

Cada release deve declarar a versão da aplicação, as versões de schema aceitas e resultante, os serviços necessários e o procedimento de recuperação. O serviço deverá preservar empresa, usuários, permissões, cadastros, documentos, movimentos, saldos, auditoria, arquivos, metadados, certificados, identificadores de armazenamento e credenciais locais. A atualização dos Workers e da interface deverá corresponder à versão do núcleo, sem substituir a configuração da instalação por exemplos da distribuição.
