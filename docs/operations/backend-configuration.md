# Configuração das conexões

Os serviços do FAGOO usam os contratos HTTP `/auth/v1`, `/rest/v1` e `/storage/v1` para autenticação, dados e arquivos. A instalação deve disponibilizar essas APIs em uma origem HTTPS configurada pelo administrador.

## Variáveis técnicas

Os nomes das variáveis abaixo são identificadores de configuração mantidos pelo código. Para instalação própria, use os valores da coluna de configuração.

| Variável | Configuração da instalação |
| --- | --- |
| `SUPABASE_DEPLOYMENT` nos serviços | `self-hosted` |
| `VITE_SUPABASE_DEPLOYMENT` no frontend | `self-hosted` |
| `SUPABASE_URL` / `VITE_SUPABASE_URL` | Origem HTTPS do proxy das APIs de autenticação, dados e arquivos |
| Chave pública do frontend | JWT público com papel `anon`, ou chave publishable quando o gateway instalado suportar esse formato |
| Chave de serviço | Somente no serviço autorizado; nunca no build do frontend |

Os nomes efetivamente usados por cada Worker estão em seu arquivo de configuração. As variáveis com prefixo `VITE_` podem entrar no build público e devem conter apenas valores públicos.

O modo de instalação própria é explícito. Ele exige hostname DNS HTTPS canônico, sem usuário/senha, porta personalizada, caminho, query ou fragmento. Configure TLS na porta padrão do proxy. A origem é definida pelo ambiente da instalação; parâmetros de requisições HTTP não selecionam o destino das credenciais.

Chamadas autenticadas mantêm caminhos fixos, limites de tamanho e tempo e recusa de redirecionamentos. Os identificadores técnicos de buckets, assinaturas e envelopes pertencem ao contrato dos serviços. A configuração visual da empresa não modifica esses identificadores ou os bytes de seus arquivos.

## Integrações

Os endpoints de conectores externos são fornecidos pela instalação. Cada integração permanece desabilitada até receber sua configuração explícita. Exemplos de domínio não são destinos operacionais.

As credenciais e configurações locais devem persistir entre versões da aplicação, conforme o [contrato de atualização](updates.md).
