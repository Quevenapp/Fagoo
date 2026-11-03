# Runtime isolado de custódia A1

Implementação local para configurar, consultar metadados, trocar a KEK e desativar uma credencial. Node 24, OpenSSL 3 e a migração 041 operam sobre um bucket privado com objetos cifrados. Não há endpoint de assinatura genérica, emissão, XML ou transmissão à SEFAZ. O estado `configured_offline` informa somente custódia conferida dentro do perfil implementado.

A composição também inclui o [fluxo restrito de candidatos assinados](../fiscal-signed-runtime/README.md), ligado à persistência 050 e ao artefato sem assinatura da 048. Usa o mesmo Container privado, com autenticação de transporte em domínio separado, e recebe apenas referências e versões de dados previamente conferidos. Python 3 e lxml 6.1.1 validam os bytes finais pelo pacote XSD fixado. A validação estrutural e a assinatura local não liberam emissão ou transmissão.

A composição 051 acrescenta o [fluxo WSDL de homologação](../fiscal-wsdl-runtime/README.md), com terceiro domínio HMAC e autorização específica persistida antes de usar o A1. Abre somente GET nos alvos SP fixados, com TLS validado e confirmação explícita; não envia SOAP ou notas. O fluxo revalida a preparação antes de abrir o envelope, consome a autorização antes do handshake e guarda a evidência em Storage privado. A admissão total de duas solicitações é compartilhada por custódia, assinatura e WSDL. Consultar um comando existente não repete o acesso à SEFAZ.

Em 16/10/2026, o responsável aplicou a SQL 041 e provisionou o bucket privado; a auditoria inicial confirmou sete tabelas com RLS, sete RPCs exclusivas de service_role e zero credenciais/comandos naquele momento. Executor, gateway e formulário foram publicados posteriormente, conforme a seção de implantação. Após o envio do administrador, a leitura restrita aos metadados confirmou A1 `configured_offline`, versão 1, dentro da validade e com identidade da empresa sem alteração. Consulte [RPCs e invariantes SQL](../../docs/integrations/a1-custody-rpc.md) e [decisão de arquitetura e custos](../../docs/integrations/a1-custody.md).

## Fluxo e fronteiras

1. A interface administrativa recebe arquivo/senha em memória e envia HTTPS ao **gateway fiscal dedicado**. Não usa o Worker geral do ERP.
2. O gateway aceita apenas origens exatas configuradas, valida a sessão no Supabase Auth e recusa usuários anônimos. Não recebe KEK nem service-role key.
3. O gateway assina ator, método, caminho, hash do corpo, audience, horário e nonce com HMAC de transporte. O destino é um único binding `A1_RUNTIME`, nunca uma URL fornecida pelo navegador.
4. O executor confere o cabeçalho antes de iniciar o Container. O runtime confere novamente e a RPC consome o nonce, verifica o membro ativo e a permissão atual. A autenticação do hash declarado precede a leitura; o hash dos bytes reais é obrigatoriamente conferido depois da leitura limitada.
5. A reserva SQL tem lease de 60 s, CAS do cofre e da identidade 016. O runtime valida o PFX, cifra PFX/senha em AES-256-GCM, grava sem sobrescrever e lê novamente o objeto para conferir todos os bytes por SHA-256/tamanho/MIME.
6. Só a finalização SQL seleciona o objeto, depois de repetir ACL, lease, CAS e requisitos do Storage. Upload órfão não configura a empresa. Nenhum segredo entra na RPC.

Cada entrada tem uma DEK aleatória de 32 bytes. A DEK fica envelopada por uma KEK externa; ambas usam nonces independentes de 12 bytes e tags de 16 bytes. Instalação, credencial, CNPJ, identidade, ambiente, propósito e metadados compõem o AAD. `rewrap` autentica também a carga e preserva seus bytes, identidade e metadados históricos.

## Segredos e configuração

| Local | Configuração |
| --- | --- |
| Gateway | `SUPABASE_URL`, chave pública `SUPABASE_ANON_KEY`, `ALLOWED_ORIGINS` e `A1_RUNTIME` |
| Gateway e executor/runtime | `A1_TRANSPORT_SECRET` (32 bytes em base64), `A1_TRANSPORT_KEY_ID`, `A1_AUDIENCE` |
| Somente executor/runtime | `A1_FINGERPRINT_SECRET` (32 bytes), `A1_KEK_RING_JSON` (mapa identificador → base64), `A1_CURRENT_KEK_ID`, `SUPABASE_SERVICE_ROLE_KEY` |
| Runtime | `A1_OPENSSL_PATH`, `A1_ALLOW_LEGACY_PFX` explícito; porta 8080 no Container |

A chave de fingerprint é distinta e estável durante a vida dos comandos. O banco recebe HMAC do ator, ação, caminho e corpo exato, não SHA simples de PFX/senha. A rotação de KEK não muda essa chave. Remover uma chave de fingerprint sem um plano de compatibilidade impede recuperar comandos antigos; não fazê-lo como parte de uma rotação comum.

A configuração rejeita chaves repetidas entre transporte, fingerprint e KEKs. O keyring admite até cinco KEKs para transição. Segredos são injetados somente no início do processo; não entram em Dockerfile, build args, URLs, bundle ou logs. O processo remove suas referências do ambiente após inicialização; isso não promete apagar cópias internas do sistema operacional/JS. O gerenciador de segredos e seus administradores continuam na fronteira de confiança.

## HTTP público e recuperação

| Método e rota no gateway | Corpo/resultado |
| --- | --- |
| `GET /v1/a1` | Metadados atuais para admin/fiscal |
| `POST /v1/a1/configure` | Binário BA1: metadados JSON + PFX + senha |
| `POST /v1/a1/rewrap` | `command_id`, `expected_version`, `expected_identity_version`, `reason` |
| `POST /v1/a1/disable` | `command_id`, `expected_version`, `reason` |
| `GET /v1/a1/commands/:uuid` | Resultado do comando do próprio admin e estado atual separado |

O formato BA1 é `u32 magic=0x42413100`, `u32 tamanhoJSON`, `u32 tamanhoPFX`, `u32 tamanhoSenha`, seguido pelos três blocos. Todos os inteiros são big-endian. Metadados exatos: `command_id`, `expected_version`, `expected_identity_version`, `reason`. `encodeConfigure` é compatível com Web APIs e pode ser reutilizado pela interface; não importar os módulos Node no frontend.

PFX: até 1 MiB. Senha UTF-8: 1–1024 bytes sem NUL/CR/LF. Metadados/JSON: até 4096 bytes. Leitura do corpo: 10 s. Operação no runtime: 45 s; gateway: 55 s. OpenSSL: 5 s, stdout até 2 MiB e stderr até 64 KiB. Resposta pública: até 64 KiB. Duas operações concorrentes por runtime; excesso retorna erro sem iniciar uma operação. Não há retry automático de mutações.

Após resultado incerto, a interface deve manter **o mesmo comando e os mesmos bytes**, consultar `/commands/:uuid` e apresentar o estado atual. Se pendente, aguardar expiração da reserva antes de repetir exatamente a solicitação. Se rejeitado definitivamente, mostrar o código e permitir um novo comando explícito. Recibo antigo não é estado atual: replay de configuração anterior não reativa credencial desativada. O usuário pode sair com aviso, sobretudo se perdeu acesso; nunca persistir arquivo/senha em localStorage, sessionStorage, URL ou analytics para facilitar recuperação.

## Implantação da custódia

O adaptador em `workers/fiscal-executor` usa a API nativa de Container/DO: um nome fixo, porta 8080, recursos explícitos `{vcpu:0.25,memoryMib:1024,diskMb:4000}` e inatividade de 60 s. O gateway se conecta por service binding. O executor mantém `workers_dev`, URLs de prévia e observabilidade desativados. O gateway HTTPS público exige sessão válida, origem permitida e autorização no banco; não recebe a KEK.

Em 16/10/2026, a SQL 041, o executor e o gateway foram publicados; a consulta autenticada da custódia pela tela `/certificado-a1` foi conferida. O administrador enviou o A1 pela plataforma. A consulta restrita aos metadados confirmou `configured_offline`, versão 1, validade vigente e identidade da empresa sem alteração. Isso não comprova homologação fiscal nem liberação operacional. A imagem de produção está fixada por digest no `wrangler.jsonc`; os templates continuam exemplos. Emissão, assinatura fiscal, revogação e transmissão continuam sem liberação.

O gateway usa `redirect: 'manual'` e rejeita respostas de redirecionamento. O workerd não suporta `redirect: 'error'` nessa versão; a regressão [documentada](../../docs/integrations/a1-gateway-workerd.md) executa o pacote real no workerd com tráfego inteiramente sintético. A implantação inicial somente da custódia usava `lite`, com 256 MiB, 1/16 vCPU e 2 GB, conforme a [tabela oficial](https://developers.cloudflare.com/containers/platform/limits/).

Para a composição ampliada, a simulação local de `lite` excedeu o limite de dez segundos do processo XSD. A comparação com recursos equivalentes a `basic` (1/4 vCPU, 1 GiB, 4 GB) passou os mesmos dois cenários de custódia e schemas NF-e/NFC-e, preservando os limites de processo. Esses números vêm de Docker amd64 no Mac e não são um benchmark do host Cloudflare. A configuração conserva o encerramento por inatividade e a admissão total de duas solicitações. Não cria outro plano ou serviço: consome a franquia compartilhada do Workers Paid e pode gerar excedentes. A cobrança considera memória/disco provisionados durante execução e CPU ativa, segundo os [preços oficiais consultados em 16/10/2026](https://developers.cloudflare.com/containers/platform/pricing/); não se presume custo adicional zero.

A composição foi publicada em 16/10/2026: executor privado corrigido `cfd419ab-0dc0-49b3-89b4-c0a74ee8dae8`, gateway `11878afb-36a4-4a4c-8230-0d6a66904223`, imagem fixada em `sha256:2d9aeb85e6cd45a405094e6c732820e4bd05ae9f8817149f75cbd102d77bbd1f`. A tentativa inicial com o alias `basic` falhou imediatamente em `container.start()` com TypeError. Substituir apenas esse alias pelo objeto de recursos acima recuperou a consulta autenticada de metadados pela interface: credencial offline, versão 1. O resultado observado se refere a este runtime implantado; os limites documentados de tamanhos personalizados divergem, portanto conferir compatibilidade em futuras atualizações, sem aumentar recursos automaticamente. O diagnóstico de falhas contém somente fase fixa, tempo limitado e um booleano de tipo; nunca imprime o erro, requisição, ambiente ou material do cofre.

O endpoint de assinatura respondeu OPTIONS 204 somente à origem permitida e POST sem sessão com 401 `SIGNED_UNAUTHENTICATED`. Isso confirma o controle externo de acesso, não uma assinatura com o A1 instalado. A publicação não criou candidatos nem transmitiu documentos fiscais.

O runtime precisa de saída HTTPS para o projeto Supabase fixado em configuração e, somente após autorização WSDL 051, para os dois hosts de homologação SP fixados no perfil. A custódia chama somente as sete RPCs 041; o fluxo de candidatos usa as sete RPCs 050 e o fluxo WSDL usa cinco RPCs 051. Caminhos Storage são derivados internamente e limitados aos buckets privados do cofre e dos artefatos. `enableInternet:true` no Container não é uma política de egress por domínio; restringir a rede na infraestrutura quando suportado e tratar comprometimento do executor como comprometimento de sua custódia. Não oferecer SSH, debugger, inspector ou endpoint de ambiente ao usuário.

Provisionamento separado realizado pelo responsável: bucket **`brufap-a1-vault`**, privado, limite **1.500.000 bytes**, MIME único **`application/json`**, e SQL 041 com RLS/grants/política restritiva conferidos. Em outras instalações, esse provisionamento permanece obrigatório. O runtime não cria nem relaxa bucket/políticas; finalização falha se qualquer requisito divergir. Nunca conceder SELECT/INSERT direto a anon/authenticated nem fornecer signed URL para esse material.

Antes de publicação: revisar custo e evidência SQL/bucket, cadastrar segredos por canal seguro, construir `linux/amd64`, conferir digest, publicar executor privado e gateway, validar somente fixtures sintéticas, então habilitar o formulário. Não colocar uma senha real em comando de terminal ou mensagem. O certificado real continua sendo entrada privada do titular.

## Validação local

```sh
node --test packages/fiscal-runtime/test/*.test.mjs packages/fiscal-vault/test/*.test.mjs workers/erp-api/test/a1-custody-sql.test.mjs
docker build --platform linux/amd64 --target test -f packages/fiscal-runtime/Dockerfile -t brufap-a1-synthetic-test .
docker build --platform linux/amd64 --target production -f packages/fiscal-runtime/Dockerfile -t brufap-a1-runtime .
```

O Dockerfile usa usuário sem root e contexto com whitelist, excluindo backups, arquivos privados, `.env` e node_modules do host. O snapshot público de confiança inclui somente o manifesto fixado e as oito raízes ITI explicitamente enumeradas na whitelist. Isso permite os testes offline de cadeia e CRL no container; não habilita essas avaliações no fluxo operacional nem atualiza a imagem publicada automaticamente. A imagem-base Node 24 está fixada por digest; dependências JS são instaladas pelo lockfile, sem scripts de instalação. Pacotes do sistema seguem o repositório Debian assinado no build; registrar o digest final e versões de OpenSSL/Node na liberação.

Os testes cobrem nonce/HMAC, tamanho/tempo, tipo de conteúdo, Auth anônimo, hash/tamanho/MIME, revogação durante upload, commit com resposta perdida, replay após desativação e SQL real em PGlite. Certificados são exclusivamente sintéticos. PGlite não substitui um teste de concorrência PostgreSQL em conexões distintas nem valida aceitação pela SEFAZ.

Em 16/10/2026, o alvo Docker de teste passou 41 cenários. Os 29 cenários de confiança/CRL também passaram em execução sem rede, com filesystem somente leitura, memória de 256 MiB e `/tmp` em memória. Esse `/tmp` permite execução apenas porque uma fixture sintética de timeout cria um executável temporário. A imagem local de teste não foi publicada nem substituiu o cofre em produção.

A composição anterior à 051 tinha 70 testes dentro da imagem: 41 de cofre, 23 de custódia/validador e seis de composição HTTP. Estes últimos verificam os dois domínios de autenticação, a remoção de segredos do ambiente, as RPCs exatas, a ausência de abertura de PFX em consultas e o cancelamento quando o cliente fecha a resposta depois de enviar o corpo. Uma admissão compartilhada limita a duas solicitações a soma de custódia e assinatura, mesmo que os dois fluxos sejam acionados juntos. O handler de assinatura fecha a admissão, aborta solicitações ativas e descarta sua cópia da chave em `dispose()`. Respostas concluídas não são canceladas retroativamente.

O teste `test/image-smoke.mjs`, montado somente para verificação, executa a imagem de produção sem rede, com filesystem somente leitura, 256 MiB, uma CPU e usuário sem root. Confere ausência de arquivos privados e de testes da aplicação na imagem, autenticação sem acesso ao cofre e autorização negada por uma RPC inteiramente sintética. Não usa o certificado instalado.

Na composição WSDL 051, o alvo Docker executou 102 cenários: 101 passaram e um ensaio mTLS opt-in de loopback permaneceu desativado nessa execução. Não houve falhas. Os 21 casos de composição/custódia/confiança incluem a terceira autenticação, autorização revalidada antes da abertura e confiança explícita do servidor. Fora da imagem, 34 testes integrados de serviço/RPC/SQL passaram, além de 12 disputas reais em conexões PostgreSQL 17 independentes. Esses resultados são sintéticos e não demonstram conectividade com a SEFAZ nem homologação do emitente.


## Publicação da composição WSDL

Frontend `3fef329c-fb77-4a6d-a047-4f494063b405`, gateway `484d0f7a-be66-4ed7-a352-7d73118cab84` e executor privado `b36bac56-9163-4927-a582-914aa94f3104`; imagem `sha256:af794a0a161bc1cc5322addca32425fb3d09428a2ceab81041dcab92f4cd1fda`. Código revisado em `702f73b`. A SQL 051 foi aplicada com quatro tabelas RLS e cinco RPCs restritas ao serviço, sem grants diretos para tabelas ou chamadas de RPC pelo navegador.

OPTIONS retornou 204 com origem exata e `no-store`; POST sem sessão retornou 401 `WSDL_UNAUTHENTICATED`. A tela autenticada exibiu empresa e metadados vigentes, seletor vazio, confirmação desmarcada e botão de execução desabilitado. Console sem erros. A evidência privada está em `docs/evidence/sefaz-connection-production-20261016.png` (fora do Git). Nenhuma consulta WSDL real foi executada nessa verificação; NFStock e coleta DF-e não foram alterados.
