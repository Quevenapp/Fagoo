# Interface FAGOO

Aplicação React/Vite em português, servida com os dados da instalação. Não contém cadastros de demonstração nem substitui respostas indisponíveis por dados fictícios.

## Desenvolvimento

Na raiz do repositório, instale as dependências e inicie a API. Use `FAGOO_PUBLIC_URL=http://localhost:5173` na API durante o desenvolvimento com proxy:

```sh
npm run dev --workspace @fagoo/web -- --host localhost
```

O Vite encaminha `/api` e `/.well-known` para `http://127.0.0.1:3000`. O endereço público precisa corresponder ao usado pelo navegador para autenticação e validação de origem.

```sh
npm run build --workspace @fagoo/web
npm run test --workspace @fagoo/web
```

O resultado é `dist/`. Os testes cobrem restrições de redirecionamento, o proxy de API e a preservação de precisão decimal. A verificação integrada deve utilizar banco e contas de teste, nunca credenciais de produção.

## Cloudflare

`worker.mjs` serve os arquivos construídos e encaminha chamadas de API ao Tunnel da instalação. `wrangler.jsonc` é uma configuração de origem sem domínios nem credenciais reais. A instalação gera a configuração correspondente ao cliente.

- `FAGOO_API_ORIGIN`: origem HTTPS do backend, diferente do domínio público da interface.
- `FAGOO_PROXY_SECRET`: segredo compartilhado entre o Worker e o backend. Deve ser provisionado como secret, nunca como variável publicada.
- `ASSETS`: binding dos arquivos de `dist/`.

O proxy preserva cookies, remove valores de autenticação de proxy enviados pelo cliente e proíbe cache de respostas da API. Esta pasta não implica que exista uma publicação ativa no Cloudflare.

## Autenticação e aplicativo futuro

A sessão utiliza os endpoints Better Auth sob `/api/auth`. Tokens de sessão não são persistidos no armazenamento local do navegador pela aplicação.

`/login` preserva a consulta OAuth assinada recebida do servidor e `/oauth/consent` solicita consentimento por `/api/auth/oauth2/consent`. O retorno nativo reconhecido é `app.fagoo://oauth/callback`; aplicativos móveis não são distribuídos por esta interface.

## Dados e operações

Os formulários enviam comandos com identificação única, preços e quantidades como strings decimais, e versões de registros quando exigidas. O preço de um item pode ficar em branco para o servidor aplicar a regra comercial vigente. Recebimento físico e entrega exigem confirmação explícita.

O modelo comercial de compra e venda usa os dados e snapshots do pedido para impressão A4. Perfis CNAB podem ser criados e editados pela interface; permanecem pendentes de homologação e não autorizam transmissão bancária ou baixa financeira.

O painel exibe erros retornados pelo servidor e recursos ainda indisponíveis. A consulta de versões e o pedido de atualização dependem do serviço atualizador instalado no Ubuntu.
