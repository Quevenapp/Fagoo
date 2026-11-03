# Inventário de distribuição

O FAGOO é distribuído sob AGPL v3, conforme [LICENSE](../../LICENSE). Dependências, fontes, esquemas e certificados públicos possuem origens e condições próprias.

## Arquivos de referência

- [dependency-inventory.json](dependency-inventory.json): entradas dos lockfiles, incluindo ferramentas, dependências transitivas e opcionais; versão, integridade, licença declarada e textos locais encontrados.
- [npm-license-texts.txt](npm-license-texts.txt): avisos encontrados nas instalações locais com versão correspondente ao lockfile.
- [asset-inventory.json](asset-inventory.json): imagens, vetores, fontes, esquemas fiscais e certificados públicos, com tamanho e SHA-256.
- [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md): atribuições dos materiais distribuídos.

O campo `summary` do inventário informa as contagens, licenças desconhecidas e textos ausentes. Metadados declarados não constituem uma conclusão de compatibilidade de toda forma de distribuição.

## Condições de empacotamento

| Material | Verificação |
| --- | --- |
| Pacotes npm | Conferir avisos no ambiente que produz o artefato. Pacotes opcionais de Linux podem não estar instalados em Windows |
| Lightning CSS e binários | Conservar os avisos MPL aplicáveis |
| libvips e variantes de Sharp | Conferir condições LGPL e avisos ao redistribuir imagens ou binários |
| Esquemas fiscais e XMLDSig | Manifests registram origem e hashes; registrar os termos aplicáveis aos arquivos exatos |
| Certificados públicos | Preservar origem ITI, escopo e hashes |
| Fontes | Distribuir os avisos SIL OFL junto aos arquivos |

O campo `developmentOnly` não prova ausência do pacote em uma imagem ou instalador. Textos encontrados na raiz dos pacotes não constituem uma coletânea completa para todas as plataformas. Os inventários são verificações técnicas e não certificam titularidade ou autorização sobre cada arquivo.

## Reprodução

Depois de instalar as dependências exatas dos lockfiles, execute:

```sh
node tools/qa/audit-distribution.mjs
```

Repita no ambiente de empacotamento e confira `summary.unknown` e `summary.missingTexts`. Os textos de terceiros devem ser preservados integralmente.
