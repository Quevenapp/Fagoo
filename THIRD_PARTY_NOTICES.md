# Atribuições de terceiros

A licença do projeto está em [LICENSE](LICENSE). Ela não substitui licenças, marcas, avisos ou condições de materiais de terceiros.

| Material | Origem e versão | Licença / evidência |
| --- | --- | --- |
| Manrope | Fontsource variable 5.3.0; família de Mikhail Sharanda e colaboradores | [SIL OFL 1.1](apps/erp/src/fonts/Manrope-OFL.txt) |
| Source Sans 3 | Fontsource variable 5.3.1; Adobe | [SIL OFL 1.1](apps/erp/src/fonts/SourceSans3-OFL.txt) |
| Pacotes npm | Lockfiles com versões e integridade | [Inventário](docs/legal/dependency-inventory.json) e [textos disponíveis](docs/legal/npm-license-texts.txt) |
| XSDs fiscais | Portal Nacional da NF-e e entrypoints locais; manifests ao lado dos esquemas | Origem e hashes presentes; termos específicos de redistribuição precisam de registro complementar |
| Âncoras ICP-Brasil | ITI; certificados públicos enumerados no manifest de trust | Origem e hashes presentes; não são certificados A1 nem chaves privadas |

As fontes foram obtidas sem alteração dos seguintes pacotes:

- https://registry.npmjs.org/@fontsource-variable/manrope/-/manrope-5.3.0.tgz
- https://registry.npmjs.org/@fontsource-variable/source-sans-3/-/source-sans-3-5.3.1.tgz

Os hashes dos arquivos distribuídos estão em [asset-inventory.json](docs/legal/asset-inventory.json). Materiais de terceiros mantêm suas licenças. Não se declara autoria exclusiva sobre formas geométricas genéricas nem sobre trabalhos de terceiros.

O inventário é reproduzido com `node tools/qa/audit-distribution.mjs`. Ele distingue metadados declarados de textos de licença efetivamente encontrados. Pacotes opcionais de outras plataformas e pacotes sem aviso na raiz exigem a conferência dos respectivos artefatos.
