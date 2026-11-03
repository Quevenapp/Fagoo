# Atribuições de terceiros

A licença do projeto está em [LICENSE](LICENSE). Ela não substitui licenças, marcas, avisos ou condições de materiais de terceiros. As novas contribuições de interface seguem a licença do projeto.

| Material | Origem e versão | Licença / evidência |
| --- | --- | --- |
| Manrope | Fontsource variable 5.3.0; família de Mikhail Sharanda e colaboradores, conforme o arquivo de licença | [SIL OFL 1.1](apps/erp/src/fonts/Manrope-OFL.txt) |
| Source Sans 3 | Fontsource variable 5.3.1; Adobe, conforme o arquivo de licença | [SIL OFL 1.1](apps/erp/src/fonts/SourceSans3-OFL.txt) |
| Inter, material histórico | Arquivos recebidos na base, sem alteração | [SIL OFL 1.1](apps/erp/src/fonts/Inter-OFL.txt) |
| Font Awesome Free 6.5.2, material histórico | Fonticons, Inc.; caminhos recebidos em `fa-icons.ts`; o novo componente Icon não os importa | [Aviso oficial](docs/legal/FontAwesome-LICENSE.txt); ícones CC BY 4.0 |
| Pacotes npm | Quatro lockfiles com versões e integridade | [Inventário](docs/legal/dependency-inventory.json) e [textos disponíveis localmente](docs/legal/npm-license-texts.txt) |
| XSDs fiscais | Portal Nacional da NF-e e entrypoints locais; manifests ao lado dos esquemas | Origem e hashes presentes; termos específicos de redistribuição precisam de registro complementar |
| Âncoras ICP-Brasil | ITI; somente certificados públicos enumerados no manifest de trust | Origem e hashes presentes; não são certificados A1 nem chaves privadas |

Fontes novas foram obtidas sem alteração dos pacotes:

- https://registry.npmjs.org/@fontsource-variable/manrope/-/manrope-5.3.0.tgz
- https://registry.npmjs.org/@fontsource-variable/source-sans-3/-/source-sans-3-5.3.1.tgz

O aviso histórico de ícones foi obtido de:

- https://registry.npmjs.org/@fortawesome/fontawesome-free/-/fontawesome-free-6.5.2.tgz

Os hashes dos arquivos distribuídos estão em [asset-inventory.json](docs/legal/asset-inventory.json). Fontes, ícones e outros materiais importados mantêm suas licenças. Não se declara autoria exclusiva sobre formas geométricas genéricas nem sobre trabalhos de terceiros.

O inventário é reproduzido com `node tools/qa/audit-distribution.mjs`. Ele distingue metadados declarados de textos de licença efetivamente encontrados. Pacotes opcionais de outras plataformas e pacotes sem aviso na raiz não são considerados revisados só por aparecerem no lockfile.
