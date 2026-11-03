# Geração privada de XML sem assinatura

Implementação local validada, com portas obrigatórias de RPC e Storage. Não lê ambiente, não usa rede padrão, não expõe HTTP, não reserva números e não acessa A1 ou SEFAZ. O pacote liga as bases persistidas 022/035/040/047 aos jobs privados 048 e ao serializer determinístico.

```js
const executor = createUnsignedXmlOrchestrator({rpc, storage});
const preview = await executor.preview({actor, draftId, completionVersion}, {signal, deadline});
const result = await executor.run({
  actor, commandId, reservationId, draftId,
  completionVersion, completionHash, basisHash,
}, {signal, deadline});
```

`actor` deve vir da sessão verificada pelo adaptador privado. Não existe rota pública neste pacote. Série, número, chave, data, `cNF`, XML e token de execução nunca são entradas desta interface. A reserva 046 precisa existir e ter sido confirmada separadamente. O pacote não chama o alocador nem libera uma reserva após falha.

A prévia lê as bases atuais e executa `resolveBusinessContent`, sem identidade fiscal ou XML. Retorna contagem, modelo, hashes de vinculação e pendências. `arithmetic_verified=true` demonstra somente as igualdades do perfil implementado; não valida regras tributárias, XSD ou habilitação fiscal.

A geração começa consultando o mesmo comando. Um resultado terminal é histórico, com contexto atual separado. Uma tentativa ainda ativa não permite outra execução. Só a resposta de `begin` com `execution` autoriza a geração local; após expiração, a recuperação conserva comando, reserva, data e chave persistidos. O seed inicial usa `crypto.randomInt` e relógio do servidor; o executor sempre usa a identidade efetivamente devolvida pelo banco.

O binder exige a saída imutável do resolver e confere o recibo 048, suas bases e a chave recalculada. O XML é limitado a 480.000 bytes. O caminho fixo é `jobs/<jobUUID>/<sha256>.xml`, no bucket privado `brufap-fiscal-artifacts`. Leitura prévia só permite upload se houver ausência comprovada. Criação é imutável; depois dela, inclusive após ACK perdido, os bytes completos devem ser lidos e conferidos por tamanho e SHA-256 antes de `finish`.

RPC e Storage devem respeitar `signal` e o prazo absoluto até consumir o corpo. O prazo global é no máximo 45 segundos; a lease do banco dura 60 segundos e não é renovada automaticamente. Há no máximo quatro chamadas Storage. Um timeout interrompe a espera local e impede novas etapas, mas não prova rollback de uma operação já enviada. Recuperar nunca usa um novo número ou sobrescreve arquivo. Após confirmação, consulta-se o job atual; um arquivo histórico não é promovido a atual.

Erros determinísticos do conteúdo/builder podem registrar um dos cinco códigos fechados da 048. Erro de rede, Storage, cancelamento, resposta inválida ou finalização incerta não vira falha definitiva: conserva o comando para consulta. Perda de resposta de `begin` exige aguardar a lease antes de recuperar. Não há laço, cron, retry automático de escrita ou espera ativa.

A resposta não inclui XML, dados do emitente/destinatário, identidade, token de lease, entradas brutas ou mensagens externas. Os resultados continuam sem assinatura, validação XSD ou autorização. `numbering_reserved=false` indica que esta execução não consumiu numeração; `reservation_id` identifica a reserva prévia. O SQL confere metadados de Storage, enquanto a verificação dos bytes pertence a este executor. Banco e Storage não compartilham transação, portanto arquivos órfãos são possíveis e não são removidos automaticamente.

## Portas

- `rpc(name,args,{signal,deadline})`: somente RPCs `erp_fiscal_unsigned_*`; retorna JSON direto e preserva SQLSTATE em `error.code`. O adaptador deve limitar resposta, rejeitar redirecionamentos e não expor mensagens brutas.
- `storage.read({bucket,key,signal,deadline})`: `Response` binária 200 ou `null` exclusivamente para ausência comprovada. MIME `application/octet-stream`, sem codificação ou com `identity`, comprimento coerente e corpo limitado.
- `storage.putImmutable({bucket,key,bytes,contentType,upsert:false,ifNoneMatch:'*',signal,deadline})`: cria se ausente e retorna status 200/201/409. Deve consumir/copiar os bytes durante sua Promise e encerrar o acesso após cancelamento. Nenhum driver pode reter a referência após concluir.

A porta implementada em `fiscal-artifact-storage` atende ao contrato mediante injeção explícita de um driver. As credenciais são fornecidas pelo servidor e o bucket privado precisa ser provisionado na instalação; os testes deste pacote não o acessam.

## Validação

31 testes com SQL real em PGlite e portas fictícias passaram. Cobrem modelos 55/65, 250 itens, ACL, bases alteradas, lease expirada, perdas de resposta em begin/upload/finish/readback, arquivo divergente, abortos e prazos até o consumo completo do corpo. Cinco cenários vieram de revisão independente. Nenhum teste usa certificado, banco remoto, SEFAZ ou número fiscal real. Os resultados incluem `completion_hash` e `basis_hash` para a interface conferir o vínculo ao consultar o comando após resposta incerta.
