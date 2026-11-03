# Uso privado do A1 para candidatos de homologação

Porta local `createSignedCustodyPort({readObject, loader, keyring, now?})`. Devolve `withAuthorizedSigner(grant, action, {signal?, deadline})`, sem ambiente, rede padrão, HTTP ou acesso ao banco. Não foi publicada nem usada com o certificado instalado.

O chamador deve primeiro executar e validar `erp_fiscal_signed_use` pela sessão/ator autorizado, com a lease e o recibo fixados pela 050. A porta recebe a projeção privada de 13 campos do orquestrador: ator, comando, candidato, versão A1, lease, prazo, instante de uso, identidade, chave de acesso, objeto unsigned, contexto/metadata da credencial e objeto cifrado. Essa estrutura não é um token de autorização autônomo e nunca deve vir de um corpo de navegador.

A entrada é copiada antes de qualquer espera, recusando getters, símbolos, classes e campos extras. A porta confere ambiente 2, SP, emissão normal, chave recalculada, CNPJ, versão, caminho fechado do cofre, tamanho/hash e correspondência exata entre contexto/metadata esperados e envelope. A KEK é escolhida pelo identificador fixado, copiada apenas para a chamada e não é exposta ao callback. A recifragem pode ter aumentado a versão do cabeçalho sem alterar a versão original da credencial.

`readObject(reference, {signal, deadline})` é uma dependência privada obrigatória. Deve limitar a leitura a 1.500.000 bytes e ao bucket/caminho recebidos e devolver um `Uint8Array` de propriedade da porta. Esse buffer é zerado, inclusive se chegar depois de cancelamento. A própria porta reconfere tamanho e SHA-256 antes de analisar o envelope; o adaptador não pode substituir essa verificação.

O cofre existente autentica e abre o envelope, verifica novamente o certificado por meio do loader e fornece apenas o signer opaco a um único callback síncrono. O callback deve retornar `undefined`, capturando seu resultado apenas no contexto privado do orquestrador. Retornos assíncronos ou quaisquer outros valores são recusados. A porta descarta o signer imediatamente no `finally` do callback síncrono, antes de microtasks agendadas por ele. `withCredential` também descarta o signer e seus buffers em `finally`; o orquestrador reforça o mesmo descarte. Isso não é uma API genérica de assinatura.

Prazo total limitado a 45 segundos e ao prazo menor do chamador. Cancelamento, lease e validade do certificado são rechecados antes de usar o signer e ao concluir o callback. O loader OpenSSL tem seu próprio limite de processo: esta porta cancela a espera, impede callbacks tardios e permite que a limpeza do cofre termine quando o loader concluir. Ela não afirma interromper um subprocesso arbitrário fornecido por uma dependência nem eliminar cópias internas do runtime. A composição de produção deve usar somente o loader revisado e limitado.

Falhas de porta/envelope são códigos estáveis `SignedCustodyError`, sem mensagens do provedor ou `cause`. Um `FiscalXmlError` do callback conserva somente seu código. Validade e assinatura locais não comprovam cadeia ICP, revogação, correção tributária, credenciamento ou autorização SEFAZ.

## Verificação

```sh
node --test packages/fiscal-signed-custody/test/*.test.mjs
```

Doze testes passaram com certificado/PFX efêmeros, cofre AES-GCM e loader OpenSSL 3 reais em memória. Cobrem abertura e descarte, alteração da entrada durante espera, campos hostis, vínculos divergentes, hash/cifra adulterados, lease vencida, cancelamento, buffers e signer tardios, callback inválido e expiração do certificado durante o loader e sanitização de falhas locais de Proxy/relógio e impossibilidade de reutilizar o signer em microtask após o callback. Nenhum teste consulta ou abre o A1 instalado.
