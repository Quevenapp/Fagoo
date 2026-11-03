# Runner Node de protocolo — local 061

`src/protocol.mjs` exporta `createFiscalProtocolRunner({pythonPath,validatorPath,spawnImpl?})`. Recebe `validate(bytes,{expectedModel,expectedHash,expectedAccessKey,expectedReferenceDigest?,direction:'request'|'response',signal?,deadline?})`. Não altera o export/runner do XSD integral da nota.

O Python `protocol_validator.py` e sua dependência `validator.py` têm hashes próprios fixados. O processo `python -I -B -c <bootstrap fixo>` relê e confere ambos antes de executar seus bytes; não adiciona um diretório ao PYTHONPATH. O contexto e XML passam somente por stdin. O ambiente do processo contém apenas LANG/PATH mínimos. O manifesto `protocol-pl010d-v1.03` e todos os XSDs são conferidos pelo Python existente, sem resolução externa.

Limites de 512.000 bytes de XML, 16 KiB de stdout, 8 KiB de stderr e 10 s incluindo leitura dos fontes, sempre reduzido pelo prazo externo. Aborto/timeout/excesso de saída encerram com SIGKILL; saídas tardias são ignoradas. Erros não incluem XML, chave, protocolo bruto, xMotivo, caminhos ou stderr. O relatório positivo contém protocolo estruturado somente quando validado pelo XSD/contexto; isso não verifica origem, assinatura do protocolo, cadeia, revogação ou autorização SEFAZ.

Entrada é copiada antes do primeiro await; options aceitam somente propriedades próprias de dados. SharedArrayBuffer e getters são recusados. Resultado e protocolo são congelados. Report negativo estrutural é `ok:false`; processo/perfil indisponível lança `FiscalProtocolRunnerError`, sem classificar a nota como inválida. Flags verified/tlsOriginVerified/signatureVerified/sefazAuthorized/canTransmit/canEmit/canQuery permanecem false.

Testes: `test/protocol.test.mjs` usa subprocessos sintéticos; `test/protocol-process.test.mjs` é opt-in com `BRUFAP_PROTOCOL_PYTHON=/caminho/python3` e lxml. Nenhum arquivo de empresa/certificado real ou rede é necessário.
