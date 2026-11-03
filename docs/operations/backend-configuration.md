# Configuração das conexões

O contrato de rede continua usando `/auth/v1`, `/rest/v1` e `/storage/v1`. Alterar a origem não substitui esses serviços nem converte dados.

| Configuração | Supabase hospedado | Instalação própria |
| --- | --- | --- |
| `SUPABASE_DEPLOYMENT` nos serviços | `hosted` ou ausente | `self-hosted` |
| `VITE_SUPABASE_DEPLOYMENT` no frontend | `hosted` ou ausente | `self-hosted` |
| `SUPABASE_URL` / `VITE_SUPABASE_URL` | Origem do projeto | Origem HTTPS do proxy compatível |
| Chave pública | Chave pública do projeto | JWT público com papel `anon`, ou chave publishable quando o gateway instalado suportar esse formato |
| Chave de serviço | Somente no serviço autorizado | Somente no serviço autorizado |

Os nomes efetivamente usados por cada Worker estão em seu arquivo de configuração. O frontend não recebe a chave de serviço.

O modo próprio é explícito e exige hostname DNS HTTPS canônico, sem usuário/senha, porta personalizada, caminho, query ou fragmento. Use TLS na porta padrão no proxy. A origem vem do ambiente da instalação, nunca de parâmetros HTTP enviados pelo usuário ou agente. Chamadas autenticadas mantêm caminhos fixos, limites de tamanho/tempo e recusa de redirecionamentos.

Os identificadores técnicos de buckets, assinaturas e envelopes históricos não foram rebatizados indiscriminadamente. Uma migração precisa transportar seus conteúdos sem mudar bytes, hashes ou chaves de criptografia. Um mapa de namespaces, quando necessário, é privado e deve ser revisado objeto por objeto.

Os endpoints do conector externo são fornecidos pela instalação e a integração permanece desabilitada até configuração explícita. Exemplos de domínio não são destinos operacionais.
