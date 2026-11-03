# Custódia A1 offline

Pacote Node 24 que valida um PKCS#12, cifra PFX e senha juntos e permite usar um assinador opaco **somente em homologação offline**. Há entrada por descritores, rotação da chave de custódia e seleção/desativação com CAS. O [runtime dedicado](../fiscal-runtime/README.md) adiciona configuração autenticada e persistência cifrada com a SQL 041. As migrações 001–050 estão aplicadas; runtime e gateway estão publicados. O A1 enviado pelo usuário foi configurado para uso offline na versão 1, com leitura autenticada dos metadados confirmada.

A interface de assinatura offline da etapa 050 está publicada na versão `d9b098ee…`, com executor corrigido `cfd419ab…`. A assinatura com o certificado real ainda não foi exercitada. Não houve transmissão à SEFAZ nem autorização fiscal; a publicação e a custódia do A1 não habilitam emissão. A decisão de arquitetura está em [a1-custody.md](../../docs/integrations/a1-custody.md).

Há também um adaptador **interno e local**, ainda sem ativação remota, para contexto TLS exclusivo da obtenção de WSDL em homologação: `wsdl-tls-loader.mjs` e `withWsdlCredential` em `envelope.mjs`. O leitor PKCS#12 é compartilhado, mas o assinador público continua restrito ao uso offline. O novo bridge preserva AAD/contexto 041, confere hash, chave, titular, fingerprint e EKU e exige callback único aguardado, com prazo e cancelamento. Não concede autorização 051, escolhe destino ou faz rede; esses controles ficam na composição privada. Não há novo export no índice público. Buffers controlados são zerados; a liberação de objetos criptográficos nativos depende do Node/GC. Testes e revisões usaram apenas certificados fictícios; nenhum A1 real foi aberto por essa implementação. Veja o [contrato de evidência WSDL](../../docs/integrations/sefaz-sp-wsdl-evidence.md).

## Componentes executáveis

- `createOpenSslLoader`: OpenSSL 3 real, caminho absoluto configurado pelo operador, sem shell. PFX pelo stdin, senha pelo FD 3, chave/certificados pelo stdout capturado em RAM. Nenhum arquivo PEM, senha em argv/ambiente ou diagnóstico do OpenSSL é devolvido.
- `sealCredential`: valida primeiro; gera DEK aleatória de 32 bytes e cifra a carga com AES-256-GCM. A própria DEK é cifrada com uma KEK externa de 32 bytes, usando nonce independente. Contexto e metadados são autenticados como AAD.
- `withCredential`: exige contexto e `key_id` esperados, autentica os dois envelopes antes de interpretar qualquer plaintext, revalida CNPJ/chave/tempo e empresta um handle ao callback interno. O handle é invalidado e os buffers controlados são zerados no `finally`.
- `rewrapCredential`: exige hash anterior, autentica carga completa e troca somente a KEK/nonce de envelopamento. Os bytes cifrados do PFX e seus metadados permanecem idênticos. Não muda certificado nem ambiente.
- `openLocalVault`: custódia local com diretório 0700, arquivos 0600, objetos cifrados imutáveis por hash, lock exclusivo, atualização atômica do head, revisão CAS e ledger de comandos. `select_offline`, `rewrap` e `disable` não habilitam emissão. Não existe ativação de produção.

O contexto tem `vault_id`, `credential_id` (UUIDs), `credential_version`, `company_identity_version` (int4 positivo), `holder_cnpj`, `environment:'2'` e `purpose:'offline-homologation'`. `vault_id` é uma identidade fixa da instalação, não um UUID inventado para a tabela 016, que é singleton. A identidade da empresa deve vir do cadastro conferido pelo operador/backend. Um valor no JSON do arquivo não é, sozinho, prova de autorização.

## Compatibilidade de arquivos

O adaptador mantém o parser restrito do pacote `fiscal-xml` intacto e fornece uma alternativa para PFX com cadeia. Aceita exatamente uma chave privada e uma leaf correspondente; até dez certificados distintos. As ligações entre os certificados apresentados precisam formar um caminho sem ambiguidade, com pais CA e assinatura compatível. Não exige que a raiz esteja embutida, não busca cadeias pela rede e não transforma um certificado apresentado em âncora de confiança.

A leaf passa por `createSigner` de `fiscal-xml`: CNPJ exato no SAN OtherName, DV válido, uso de assinatura, condição não-CA, RSA e validade temporal. A cadeia apresentada também tem sua validade temporal conferida. O perfil do envelope admite RSA 2048, 3072 ou 4096. CNPJ numérico/alfanumérico segue o validador existente; não inferir titular pelo CN/razão social.

OpenSSL 3 lê PBES2/AES e formatos usuais legados. O provider legado só é carregado com `allowLegacy:true`/`--legacy-pfx`; não existe tentativa automática que relaxe a política após qualquer erro. Testes exercitam RC2/3DES+MAC SHA-1 e cadeia de três certificados. O PFX original permanece cifrado dentro do envelope AES-256-GCM; isso não converte ou reemite seu certificado.

MAC é obrigatório e verificado pelo OpenSSL, sem `-nomacver`. São aceitos MAC SHA-1/224/256/384/512 com 1–1.000.000 iterações; algoritmo e contagem ficam nos metadados. Um MAC SHA-1 não exige, por si, provider legado, portanto `legacy_provider_enabled:false` não significa que todos os algoritmos do arquivo sejam modernos. Key bag sem criptografia, MAC ausente, chave/leaf duplicadas, certificados alheios/ambíguos, tipos indevidos e senha incorreta são recusados.

Limites: PFX até 1 MiB; senha UTF-8 de 1–1024 bytes, sem NUL/CR/LF (o leitor por FD do OpenSSL é orientado a linha); saída até 2 MiB, diagnóstico até 64 KiB; execução 5 s por padrão, configurável 100 ms–10 s. O timeout encerra o processo, inclusive KDF excessiva. Não há garantia de compatibilidade com todo PKCS#12: MAC PBMAC1, senha vazia, senha separada de integridade, chaves não-RSA e estruturas fora desse perfil exigem avaliação. O binário fixado deve ter o provider necessário instalado; não se baixa código no importador.

## Entrada do operador sem segredo no comando

`src/cli.mjs` sela um arquivo e cria um destino exclusivo 0600. O arquivo de contexto contém apenas os campos acima; a KEK deve existir em um gerenciador de segredos separado do diretório do cofre.

```text
node packages/fiscal-vault/src/cli.mjs \
  --pfx /caminho/privado/certificado.pfx \
  --context /caminho/privado/contexto.json \
  --output /caminho/privado/credencial-cifrada.json \
  --openssl /caminho/confiavel/openssl3 \
  --key-id identificador-da-chave
```

O processo precisa receber **FD 3 com os bytes exatos da senha e FD 4 com a KEK binária de 32 bytes**, por pipes herdados de um lançador confiável/gerenciador de segredos. Não há prompt inseguro, argumento `--password`, variável de ambiente para senha/KEK ou exemplo contendo segredo. A CLI recusa descritores ausentes/oversized e não sobrescreve destino, inclusive depois de resposta perdida. Sucesso imprime somente hash do envelope e `can_transmit:false`; falha imprime código fixo, sem stack/caminhos/PEM.

O original não é alterado. O destino só contém ciphertext/metadados, mas continua privado. Se houver falha de escrita, um arquivo incompleto pode permanecer; não sobrescrevê-lo automaticamente. Inspecionar com `parseEnvelope`/autenticação, recuperar o resultado anterior ou escolher outro destino. A CLI não seleciona automaticamente o certificado para uso.

## Uso local e concorrência

```js
const store = await openLocalVault({ directory, vaultId, create: true });
const result = await store.command({
  commandId, expectedRevision: 0, action: 'select_offline', envelope,
  reason: 'Configuração conferida pelo operador',
  kekBytes, expectedKeyId: keyId, loader,
});
// Guardar commandId/body até conhecer o resultado. Replay entrega recibo histórico
// separado de result.current; um comando antigo não reativa credencial desativada.

await store.use({ expectedRevision: result.current.revision,
  expectedContext, kekBytes, expectedKeyId: keyId, loader }, signer => {
  // Apenas operação fiscal offline autorizada pelo chamador confiável.
  // signNfeXml revalida as restrições de modelo/ambiente/identidade.
});
```

Troca do certificado: selar nova credencial com UUID novo, conferir metadados, selecionar explicitamente com `expectedRevision` atual. A seleção anterior permanece apenas no histórico cifrado, sem uso automático. Desativação exige revisão/hash selecionado/motivo e não apaga XMLs assinados nem revoga o certificado na AC. O `rewrap` exige revisão/hash anteriores, mesmo contexto e conteúdo, `key_id` novo e prova de abertura com a nova KEK. KEKs antigas não devem ser removidas antes da conferência de rewrap/backup e da política de eliminação de versões antigas.

O lock local abrange validação/uso para que desativação não seja confirmada enquanto uma operação offline estiver em execução. Requer filesystem local com semântica normal de exclusão/rename/fsync, não NFS/objeto remoto. `VAULT_STORE_BUSY` não rouba lock: após queda de processo, um operador deve confirmar sua inexistência antes de recuperação manual. Limite de 1000 comandos por cofre exige revisão/arquivamento administrativo, nunca truncamento automático do ledger. Objetos órfãos após falha entre gravação e head não são selecionados.

Esta autorização é do usuário do sistema operacional proprietário do diretório. Não equivale ao RBAC do ERP. Um callback do processo é código confiável, não uma função recebida do navegador; ele poderia copiar dados e por isso não constitui isolamento contra código malicioso dentro do mesmo processo. Não há rota de assinatura arbitrária.

## Limites de confiança e retenção

`icp_brasil_chain_validated`, `revocation_checked`, `a1_policy_verified`, `client_auth_eku_verified` e `can_transmit` permanecem false. Verificar assinaturas entre a cadeia apresentada é diferente de ancorá-la na ICP-Brasil. RSA+PFX+CNPJ não comprova política A1, revogação, credenciamento ou aceitação SEFAZ.

Buffers controlados são zerados e o handle é descartado; JS/OpenSSL/KeyObject podem manter cópias sob GC, kernel e dumps de processo. Não se promete apagamento físico da RAM. A operação do runtime deve manter limites de memória/processos, core dumps e inspeção pública desabilitados, sem registrar bodies/ambiente/certificados. Administradores capazes de ler KEK e ciphertext ou alterar o runtime estão dentro da fronteira de confiança; AES não substitui separação operacional de acesso.

A chave privada não é necessária para verificar XML histórico. Definir eliminação da cópia cifrada/KEKs quando expirada, revogada ou substituída, com política de backup e recuperação explícita; conservar somente certificado público/metadados/auditoria necessários. A biblioteca não apaga material original do usuário nem afirma revogação na AC. Rotação da KEK não torna antigos backups criptograficamente inacessíveis enquanto suas KEKs antigas existirem.

## Testes

```sh
BRUFAP_TEST_OPENSSL_PATH=/caminho/confiavel/openssl3 node --test packages/fiscal-vault/test/*.test.mjs
```

Fixtures geradas em memória, chaves/certificados fictícios e filesystem temporário para a custódia cifrada. Nenhuma rede SEFAZ/Auth/Storage nem certificado real é usado. Os testes verificam cadeia/legado, MAC/senha, adulteração em cada parte AEAD, troca de empresa/identidade/ambiente, rotação, buffers mutáveis, CAS/replay/desativação, exclusão concorrente, symlinks/permissões, timeout/diagnósticos e entrada CLI. Não há teste fiscal de aceitação pela SEFAZ.
