# Porta Node para XSD fiscal integral

Implementação local, sem publicação ou ligação ao cofre. Executa o validador Python já existente sobre os bytes finais de um candidato assinado de homologação. O schema oficial completo exige a assinatura; esta porta não modifica o XSD nem acrescenta assinatura fictícia para aceitar XML sem assinatura.

`createFiscalSchemaRunner({pythonPath, validatorPath, spawnImpl?})` recebe caminhos absolutos definidos pelo servidor e devolve `validate(xmlBytes, {expectedModel, expectedHash, signal?, deadline?})`. O hash esperado é obrigatório. A porta copia a entrada, confere SHA-256, verifica o hash fixado do código Python e executa `python -I -B validator.py --model 55|65`, com XML somente em stdin. Não aceita caminhos, comandos ou argumentos vindos do navegador. `spawnImpl` é uma porta para testes internos, não configuração de HTTP.

O processo recebe um ambiente mínimo, sem herdar tokens, KEKs ou outras variáveis do servidor. Não usa shell nem arquivo temporário. O Python verifica o manifesto e cada XSD local e proíbe resolução de rede. Esta porta não é isolamento de rede do sistema operacional; os testes de processo executam em contêiner com rede desabilitada. Nenhuma imagem de produção foi modificada.

Limites: XML de até 512.000 bytes; stdout 16 KiB; stderr 8 KiB; prazo total de até 10 segundos ou o prazo menor do chamador. Prazo e cancelamento abrangem a leitura do código Python e o subprocesso. Timeout, aborto, excesso de saída ou falha encerram o processo com `SIGKILL`. Saídas tardias são ignoradas. O stderr nunca é retornado ou registrado, e os buffers mantidos pela porta são zerados ao concluir. Isso não promete eliminar cópias internas do runtime ou do sistema operacional.

Um resultado positivo precisa corresponder exatamente ao hash, modelo, ambiente e perfil esperados e manter todas as afirmações de confiança externas como falsas. A porta acrescenta tamanho, versão do runner, hash do validador e hash do manifesto. `xsdValidated:true` se refere exclusivamente à estrutura dos bytes examinados: a porta não verifica assinatura criptográfica, regras tributárias, cadeia ICP, revogação ou autorização SEFAZ.

Rejeições estruturais conhecidas retornam `ok:false`, código estável e até 20 diagnósticos com linha, coluna e categorias, sem valores, XML ou caminhos. Falha de processo, perfil, integridade, prazo ou transporte gera `FiscalSchemaRunnerError`; não é classificada como XML fiscal inválido. O chamador deve manter distintos esses dois resultados.

## Verificação

```sh
node --test packages/fiscal-schema-runner/test/runner.test.mjs
```

Dez testes unitários verificam hashes e perfis, argumentos e ambiente isolados, limites, aborto, prazo, resposta tardia, formatos inválidos e recusa de indicadores de confiança indevidos. Um teste adicional executou o Python real na imagem local de testes `brufap-fiscal-schema-test:local`, sem rede, com filesystem somente leitura e 256 MiB. NF-e e NFC-e com QR v3, ambas integralmente fictícias, passaram; candidatos com decimal inválido retornaram rejeição XSD. Não houve acesso ao A1 instalado ou à SEFAZ.
