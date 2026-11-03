# Build da interface para distribuição

Configure as variáveis públicas de frontend conforme o [manual de instalação](installation.md), instale as dependências fixadas no lockfile e execute:

```sh
npm run build:erp:release
npm run check:erp:build
```

O resultado fica em `apps/erp/dist`. Esse comando verifica os tipos, compila a interface, inspeciona os arquivos e inclui somente os assets produzidos nessa execução. Ele não publica no Cloudflare nem cria uma release no GitHub.

O build é feito em um diretório temporário. Os diretórios de saída e cache só são substituídos depois da validação; falhas anteriores à substituição mantêm o artefato existente. O cache passa a conter apenas o build recém-gerado.

Para atualizações de uma instalação em operação, `npm run build:erp` mantém até duas compilações anteriores por até sete dias. Essa retenção permite que abas abertas concluam o carregamento de módulos da versão que receberam. O build de distribuição inicia um novo conjunto de assets; ao implantá-lo sobre uma instalação existente, abas abertas podem precisar ser recarregadas.

Os inventários e avisos de dependências estão em [atribuições](../../THIRD_PARTY_NOTICES.md). Testes e ferramentas locais não são pontos de entrada do frontend publicado.
