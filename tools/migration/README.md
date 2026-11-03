# Backup Origin: diagnóstico e staging privado

`stage_origin_backup.py` prepara e aplica uma cópia histórica em `origin_backup`, separada do ERP e de `origin_sync`. Não vincula por nome/SKU, não recalcula saldos, não lança estoque/financeiro e não emite documentos fiscais. Preserva os CSVs como strings, inclusive zeros iniciais e linhas repetidas.

## Preparar e conferir sem rede

```sh
python3 tools/migration/stage_origin_backup.py prepare \
  --source '/caminho/backup.zip' \
  --output-dir private/migration/prepared-novo-lote

python3 tools/migration/stage_origin_backup.py validate \
  --plan-dir private/migration/prepared-novo-lote
```

O destino precisa ser novo. A ferramenta nunca sobrescreve um plano anterior. Em falha, pode restar um diretório parcial; ele não terá manifesto completo e não pode ser aplicado. Use outro diretório para uma nova tentativa. O manifesto só é gravado após a leitura e conferência do hash final do backup.

O plano contém `summary.json` agregado, `manifest.json`, objetos nomeados por SHA-256 e chunks JSON privados. Permissões: diretório `0700`, arquivos `0600`. Os chunks contêm dados pessoais, financeiros e chaves fiscais. Não publicar, incluir no Git ou imprimir seus conteúdos. O stdout mostra somente contagens, hashes do lote e códigos de erro.

O Storage recebe o ZIP original e uma cópia de cada XML distinto por SHA-256. ZIPs internos e CSVs continuam preservados dentro do original; suas entradas no manifesto guardam cadeia de arquivos, índices ZIP, hash e tamanho. Os índices distinguem nomes repetidos. Todas as ocorrências XML ficam no staging, mesmo quando compartilham o mesmo objeto.

Limites: original e objeto de Storage até **40 MiB**; arquivo ZIP interno até **128 MiB**; XML até **8 MiB**; outros membros até **40 MiB**; soma expandida até **512 MiB**; 25 mil membros; 500 mil linhas CSV; profundidade máxima de três ZIPs internos; taxa máxima de expansão 1.000. Entradas inseguras, links simbólicos, ZIP criptografado e limites excedidos interrompem a preparação. XML com DTD/entidades é preservado como bytes e colocado em quarentena, sem expansão.

O parser CSV foi calibrado no backup recebido: UTF-8 com ou sem BOM, separador `;`, cabeçalhos conhecidos por módulo. Formatos diferentes exigem revisão; não há inferência automática de encoding, coluna de identidade ou valores monetários. Falhas de esquema/linha geram pendências, preservando o original.

XML é inspecionado estruturalmente. A presença de assinatura ou protocolo não comprova validade criptográfica/fiscal. NF-e/NFC-e exigem protocolo correspondente; eventos verificam seu próprio retorno/protocolo, sem exigir protocolo de autorização de nota dentro do arquivo de evento. Ausências, estruturas inesperadas e mesma identidade fiscal com bytes diferentes ficam em quarentena. Não há validação XSD, certificado, assinatura ou consulta à SEFAZ nesta ferramenta.

## Aplicar após revisar o plano

Requer a migração `202610160003_origin_backup_staging.sql`, bucket privado `origin-backups` e credencial de servidor. Essa migração não concede acesso a `anon` ou `authenticated` e não cria políticas públicas de Storage. As RPCs são restritas a `service_role`; nenhuma tabela do ERP ou do conector API é escrita.

```sh
python3 tools/migration/stage_origin_backup.py apply \
  --plan-dir private/migration/prepared-novo-lote \
  --project-ref 'referencia-do-projeto' \
  --key-file '/caminho/privado/service-key.txt' \
  --workers 4 \
  --confirm-private-staging
```

O arquivo da chave deve conter somente a credencial e ter permissão `0600`. Nunca passar a chave na linha de comando. O domínio é construído a partir da referência do projeto e restrito a HTTPS Supabase; redirecionamentos não são seguidos. A ferramenta não lê credenciais durante `prepare` ou `validate`.

Antes de qualquer escrita remota, todos os objetos/chunks são conferidos localmente. Os uploads não usam upsert e cada objeto é relido autenticadamente para comparar seu hash. Um conflito de objeto só é aceito se os bytes forem idênticos. Há até quatro uploads concorrentes, timeout de 30 segundos e até três tentativas; erros de autorização não são repetidos. Upload padrão é usado neste escopo de arquivos de até 40 MiB; se a conexão interromper, reaplicar o mesmo plano revalida/reutiliza os objetos já existentes. Upload resumível poderá ser acrescentado para conexões menos estáveis. [Uploads oficiais](https://supabase.com/docs/guides/storage/uploads/standard-uploads), [download privado](https://supabase.com/docs/guides/storage/serving/downloads).

Lote = SHA-256 do ZIP. Chunks e registros são imutáveis: reenvio idêntico é idempotente; conteúdo diferente para a mesma identidade falha. O lote permanece `uploading` até conferir contagens e presença de todos os objetos. O resultado final é `stored` ou `stored_with_issues`; ambos significam **staging histórico**, sem aprovação para uso operacional. Em interrupção, reaplicar o mesmo plano; não apagar manualmente tabelas/objetos para “reiniciar”. [Acesso de Storage](https://supabase.com/docs/guides/storage/security/access-control), [funções de banco](https://supabase.com/docs/guides/database/functions).

## Plano real preparado em 16/10/2026

Plano concluído: `private/migration/prepared-origin-2026-10-16-v2/`. Contém 97.200 linhas CSV, 7.412 ocorrências de arquivos, 7.399 XMLs e nove pendências estruturais. Para upload: 7.392 objetos, 93.099.868 bytes. As pendências são oito notas sem protocolo correspondente e uma sem elemento de assinatura. A tentativa sem sufixo `-v2` ficou incompleta, sem manifesto, e não foi sobrescrita.

Até a preparação documentada aqui, **não foram executados upload, migração SQL003 ou importação remota**. A execução remota é uma etapa separada do responsável pela implantação.

Validação local com fixtures sintéticas:

```sh
python3 -m unittest discover -s tools/migration -p 'test_*.py'
node --test tools/migration/test_backup_sql.mjs
```

Os 17 testes do preparador/aplicador e oito testes SQL passaram. O teste SQL executa a migração real em PGlite, com papéis e tabelas mínimas de Storage. Verifica begin/apply/finish, replay, conflitos imutáveis, rollback de CSV não textual, ausência de grants diretos, negação a anon/authenticated, quarentena, bucket público e objetos ausentes. Não testa o servidor HTTP de Storage nem substitui a conferência das políticas e downloads autenticados no projeto de destino.
