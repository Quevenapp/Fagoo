# Gateway fiscal dedicado

O gateway de configuração A1 oferece a fronteira HTTPS da custódia. Ver [contrato operacional](../../packages/fiscal-runtime/README.md). O gateway autentica o usuário no serviço de autenticação configurado, recusa sessão anônima, aplica CORS exato e assina a solicitação para o executor. Não possui KEK, fingerprint key, PFX persistido ou service-role key.

A extensão `/v1/fiscal-unsigned` usa um protocolo separado para prévia, geração sem assinatura e consultas de jobs. Não recebe certificado nem senha. Seu contrato e configuração estão em [fiscal-unsigned-runtime](../../packages/fiscal-unsigned-runtime/README.md).

`wrangler.example.jsonc` é somente template de revisão. Secrets e origens precisam ser provisionados pelo responsável; a rota pública só deve ser habilitada depois de SQL/bucket/runtime revisados. Não reaproveitar o Worker geral do ERP para esses segredos ou corpos.
