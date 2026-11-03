# Fronteira HTTP de consulta WSDL

Pacote privado para a consulta explícita de um WSDL fixo da SEFAZ-SP em homologação. A implementação e os testes deste pacote usam portas e dados sintéticos. Não configuram o A1 da empresa, não consultam a SEFAZ e não publicam o runtime.

`createWsdlGateway({fetchImpl,now,nonce})` oferece somente:

- `POST /v1/fiscal-wsdl/run`: `{command_id,model,operation,expected_a1_version,expected_identity_version,confirmed:true}`. Modelo `55` ou `65`; operação `protocol`, `status`, `authorization` ou `receipt`. O nome `authorization` seleciona o WSDL do serviço; não autoriza transmitir uma nota.
- `GET /v1/fiscal-wsdl/commands/:uuid`: consulta o resultado do mesmo comando, sem nova obtenção de WSDL.

Não há URL, XML, certificado, senha, ator, lease ou autorização livre no corpo. As versões e a confirmação são obrigatórias. O servidor deve autenticar novamente o ator nas RPCs 051, incluindo consulta, replay e consumo do grant. O gateway valida a sessão no Auth; não usa `user_metadata` como autorização de papel. As permissões `admin`/`fiscal` são verificadas no servidor.

O transporte privado usa `signRuntimeRequest`/`verifyRuntimeRequest`, HMAC-SHA256, domínio `brufap-wsdl-request-v1`, cabeçalho `Brufap-Wsdl` e audience `${A1_AUDIENCE}-wsdl`. As claims vinculam ator, nonce, método, caminho, hash do corpo e uma janela de 60 segundos, com até 5 segundos de tolerância futura. Esse HMAC não é um token de consumo único. A SQL 051 mantém o comando idempotente e consome a autorização de GET antes do handshake; repetir a entrega HTTP não permite repetir o GET consumido.

O corpo é limitado a 4 KiB e a resposta a 128 KiB. O gateway limita a sessão Auth a 10 segundos e a requisição completa a 55 segundos, cancela streams tardios, recusa compressão e redirecionamentos e permite apenas origens HTTPS configuradas. O handler privado tem orçamento próprio; a composição permanece responsável por suas portas e encerramento. Nenhum bearer Auth ou chave do backend é encaminhado ao runtime privado.

`publicResult` confere o comando e os campos capturados, separando recibo histórico do estado atual da identidade e do A1. Só projeta estado, horários, versões, códigos fechados e resumo do artefato. Não retorna bytes WSDL, evidência TLS, fingerprint, CNPJ, referência ao cofre ou Storage. Todos os indicadores de autorização fiscal, transmissão e binding verificado permanecem falsos, inclusive em `stored`.

Após falha de transporte de `run`, `recovery_required:true` exige consultar o mesmo comando. Não criar um novo UUID nem repetir automaticamente uma consulta externa. Um estado `unconfirmed` pode trazer o último contexto conhecido; não comprova que o GET deixou de ocorrer. A consulta não modifica nem reabre o comando.

Testes locais:

```sh
node --test packages/fiscal-wsdl-runtime/test/*.test.mjs
BRUFAP_RUN_WORKERD_TESTS=1 node --test packages/fiscal-wsdl-runtime/test/gateway-workerd.test.mjs
```

O teste workerd usa um entrypoint sintético do adaptador, com Auth e runtime interceptados; não exercita uma publicação ou conexão externa. Os testes cobrem confirmação/CAS, isolamento dos domínios HMAC, limites/cancelamento, CORS, recusa de redirects, redução da resposta e recuperação sem reenvio automático.
