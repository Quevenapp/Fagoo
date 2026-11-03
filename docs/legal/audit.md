# Auditoria técnica de distribuição

Data da revisão: 2026-11-03. Base preservada: `1509174fb4007539fec9816760de9960271d0c09`.

## Resultado

O repositório contém licença AGPL v3. As 186 entradas dos quatro lockfiles representam 183 combinações de pacote e versão; todas declaram uma licença reconhecível de software livre/open-source nos metadados analisados. Nenhuma entrada ficou com licença `UNKNOWN`.

Isso não equivale a uma confirmação de titularidade de todo o código recebido ou à conclusão de compatibilidade de toda forma de distribuição. Os itens abaixo permanecem identificados para avaliação do mantenedor.

## Escopo e evidências

- [dependency-inventory.json](dependency-inventory.json): todas as entradas dos quatro lockfiles, incluindo ferramentas de build, dependências transitivas e opcionais; versão, integridade, licença declarada e textos locais encontrados.
- [npm-license-texts.txt](npm-license-texts.txt): avisos encontrados nas instalações locais com versão correspondente ao lockfile. Não é uma coletânea completa das licenças de todas as plataformas.
- [asset-inventory.json](asset-inventory.json): imagens/vetores, fontes, esquemas fiscais e certificados públicos, com tamanho e SHA-256.
- [source-evidence.json](source-evidence.json): busca de marcadores de geração, licença, copyright e referência visual em código, CSS e documentação. Os marcadores são pistas, não conclusões de autoria.
- [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md): fontes novas, materiais históricos e arquivos fiscais importados.

A análise foi estática e rastreável. Não foi feita revisão humana linha a linha de todos os arquivos, nem comparação automática de código com bases proprietárias. Não foram recuperados prompts de desenvolvimento que não estavam disponíveis.

## Licenças encontradas

MIT, Apache-2.0, ISC, BSD-3-Clause, 0BSD, CC0-1.0, MPL-2.0, LGPL-3.0-or-later e expressões que combinam essas licenças. As fontes usam OFL-1.1; os ícones históricos incluem CC BY 4.0.

Os casos MPL correspondem a Lightning CSS e seus binários. Os casos LGPL correspondem a libvips e variantes distribuídas com Sharp. São dependências transitivas de ferramentas, mas sua distribuição em imagens, instaladores ou binários exige atenção aos respectivos avisos e condições; o campo `dev` não é prova de que um pacote está ausente de um artefato.

## Itens ainda não encerrados

| Item | Evidência observada | Tratamento |
| --- | --- | --- |
| Código recebido antes desta branch | Histórico e licença do repositório preservados; comentários incluem geração e referência visual | Não inferir autorização ou autoria a partir do redesign; manter os registros de origem do mantenedor |
| Textos de licença npm | 106 entradas sem texto na raiz da instalação local: 97 pacotes não instalados nesta plataforma e 9 pacotes instalados sem aviso na raiz | Conservar a lista em `summary.missingTexts`; revisar os avisos do artefato Linux e de qualquer imagem redistribuída |
| Pacotes instalados sem texto na raiz | `@cloudflare/kv-asset-handler`, `@cloudflare/unenv-preset`, `@cloudflare/workerd-windows-64`, `@esbuild/win32-x64`, `@rolldown/binding-win32-x64-msvc`, `miniflare`, `workerd`, `wrangler`, `qrcode-generator` | Metadados declaram licença; ausência do arquivo na raiz não prova ausência de licença. Verificar avisos do upstream e do pacote completo |
| Esquemas oficiais e derivados XMLDSig | Manifests registram URLs, datas e hashes; os arquivos examinados não apresentam licença específica de redistribuição | Registrar os termos aplicáveis aos arquivos exatos; não atribuir automaticamente a AGPL do projeto |
| Certificados públicos de confiança | Manifest de origem ITI e hashes | Preservar origem, escopo e avisos; não tratar como material autoral próprio |
| Comparação visual | Capturas locais da base e da proposta com a mesma fixture | A comparação mostra o redesenho do FAGOO; não certifica ausência de similaridade com todos os produtos existentes |

## Como reproduzir

```sh
node tools/qa/audit-distribution.mjs
npm run typecheck:erp
node --test apps/erp/test/fagoo-workspace.test.mjs
```

Execute o inventário novamente no ambiente que produz o artefato final, depois de instalar as dependências exatas dos quatro lockfiles. Não publicar um parecer automático de “tudo liberado” a partir dos campos de licença.

O mantenedor fará a avaliação dos itens de autoria e distribuição. Não foi encaminhado material a terceiros.
