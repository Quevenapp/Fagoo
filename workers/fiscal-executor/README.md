# Executor fiscal privado

O serviço privado de custódia A1 está publicado como service binding → Durable Object → Container Node. Só usa o DO de nome fixo `a1-custody-v1`. Confere HMAC antes de iniciar o Container; o runtime confere novamente e consome nonce na SQL 041. Segredos são passados por whitelist no início e nunca devolvidos.

A extensão publicada para jobs de XML sem assinatura executa diretamente no Worker, em rotas e protocolo separados, sem iniciar o contêiner ou ler as chaves do cofre. Seu estado de publicação e contrato estão em [fiscal-unsigned-runtime](../../packages/fiscal-unsigned-runtime/README.md).

`ctx.container.start`, `getTcpPort` e variáveis de ambiente seguem a [documentação oficial de Containers](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/). A imagem usa `linux/amd64`, conforme o [guia oficial](https://developers.cloudflare.com/containers/get-started/). A extensão unsigned reutiliza o serviço existente e não modifica a imagem de custódia.

Template de revisão em `wrangler.example.jsonc`, com URLs públicas e logs desabilitados. A aplicação só encaminha ao nome único e usa inatividade de 60 s; a política nativa `durable_object` não aceita `max_instances` no Wrangler atual. Portanto isso não é uma promessa de teto financeiro: conferir consumo, limites da conta e comportamento de rollout antes de contratar/publicar. Segredos de custódia ficam neste executor/runtime, fora do gateway e da API geral do ERP. Instruções completas, bucket e limites em [fiscal-runtime](../../packages/fiscal-runtime/README.md).
