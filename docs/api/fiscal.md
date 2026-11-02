# Documentos fiscais recebidos

O módulo de importação recebe XML NF-e 4.00 de saída do fornecedor, modelo 55, destinado ao documento da empresa configurada. O parser verifica limites, estrutura, chave de acesso, identidade e protocolo declarado no arquivo. O arquivo original permanece em armazenamento privado, com SHA-256 conferido no download.

O resultado distingue `signature_present`, `signature_verified`, `sefaz_checked`, `xsd_validated` e `tax_rules_validated`. A presença de um protocolo no XML não comprova consulta atual à autoridade fiscal. Nesta versão as quatro últimas verificações permanecem falsas. O regime cadastrado não ativa um motor tributário. Tributos declarados pelo emitente são preservados sem conversão automática para o tratamento fiscal do destinatário.

## Configuração

`GET /api/v1/company/fiscal` exige `fiscal:read` e retorna a identidade, o regime, `fiscal_version` e as capacidades. Um administrador usa `PATCH` no mesmo caminho com `command_id`, `expected_version`, `document` e `tax_regime`. São aceitos CNPJ numérico e alfanumérico com dígitos verificadores válidos. Depois de importar documentos, a identidade da empresa não pode ser trocada nessa instalação de empresa.

Regimes aceitos: `unconfigured`, `simples_nacional`, `lucro_presumido`, `lucro_real`. A configuração representa identificação; não comprova cobertura tributária.

## Importação e consulta

Envie `POST /api/v1/invoices/received/import` com `{command_id,xml}` e permissão `fiscal:write`. O limite do XML UTF-8 é 1 MiB; o envelope JSON admite 2 MiB. DTD, entidades declaradas, profundidade excessiva, itens duplicados, modelo ou ambiente não suportados e destinatário incompatível são recusados.

A importação só é habilitada quando o armazenamento privado e o documento da empresa estiverem configurados. Ela nunca faz lançamento de estoque, cria contas financeiras ou envia manifestação do destinatário. Um evento `invoice.received` permite ao agente iniciar a conciliação externa.

Repetir o comando devolve o resultado anterior. Importar o mesmo XML com outro comando retorna `already_imported:true`. Um arquivo diferente para a mesma chave não substitui o original.

`GET /api/v1/invoices/received/{id}` retorna metadados, itens, declarações fiscais e candidatos de produtos quando o ator tem `catalog:read`. Os candidatos consideram código do fornecedor, GTIN e código interno. Diferenças de unidade ficam explícitas, e o fator de embalagem só é apresentado quando existe um vínculo cadastrado. O agente deve resolver ambiguidades antes de lançar uma compra ou recebimento.

`GET /api/v1/invoices/received/{id}/xml` exige `fiscal:read` e entrega o arquivo como anexo, após conferir sua integridade. Objetos privados não são publicados por URL aberta.

## Interface de armazenamento

O servidor injeta `{put(key,bytes,{contentType,sha256}),get(key)}`. As chaves incluem a empresa e o hash do conteúdo. O adaptador deve manter objetos privados e preservar a imutabilidade. Uma falha de banco após upload pode deixar um objeto sem referência; a limpeza de objetos deve respeitar as referências persistidas e a política de retenção.

Coleta automática, emissão, manifestação, validação criptográfica e cálculo tributário geral não são acionados pelo importador. Esses serviços deverão passar por implementação e homologação específicas antes de serem anunciados como disponíveis.
