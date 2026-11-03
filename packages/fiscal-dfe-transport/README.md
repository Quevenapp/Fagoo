# Transporte local de distribuição NF-e

Protótipo Node 24 isolado, sem driver de rede padrão, rota HTTP, scheduler, acesso ao cofre ou configuração de segredos. Os testes usam um driver de eventos e um servidor mTLS temporário em `127.0.0.1`, com certificados criados apenas em memória. Nenhuma consulta fiscal é realizada.

A ativação da coleta exige um coordenador único por escopo fiscal, homologação e checkpoint NSU confirmado com horário. Se outro coletor estiver ativo, o administrador deve coordenar sua pausa antes de liberar este serviço. O pacote não presume NSU inicial zero, não consulta em paralelo e não transfere automaticamente a responsabilidade pela coleta.

## Interface local

```js
import {
  prepareDistributionExchange,
  createDistributionTransport,
  DfeTransportError,
  DFE_TRANSPORT_LIMITS
} from './src/distribution-transport.mjs';

const plan = prepareDistributionExchange({
  environment: '2',
  authorUf: '35',
  interestedCnpj: 'CNPJ exato obtido no servidor',
  lastNsu: 'NSU confirmado de 15 dígitos'
});

// Somente driver sintético/local nesta etapa. Não há fallback para https.request.
const transport = createDistributionTransport({ requestImpl: syntheticDriver });
const response = await transport.exchange(plan, {
  secureContext: syntheticSecureContext,
  deadline: Date.now() + 20000,
  signal
});
```

O driver tem a assinatura de `node:https.request(options, callback)` e é uma dependência confiável de servidor, não algo fornecido pelo navegador. Injetar um driver de rede real é tecnicamente possível, mas não faz parte de nenhuma integração, autorização ou implantação deste bloco. Flags falsas não são um mecanismo de isolamento de rede para código servidor arbitrário; a ausência de wiring, driver padrão e acesso a credenciais mantém o produto sem essa capacidade ativada.

`prepareDistributionExchange` aceita somente os quatro campos acima, reutiliza o gerador de `distDFeInt` e deriva endpoint, método, headers e SOAP. O plano é congelado e atestado por identidade de objeto. `exchange` não aceita clones/JSON reidratado e consome o plano uma única vez antes de iniciar o driver. Isso evita repetição acidental local, mas **não substitui o comando/lease persistente da SQL045**. Recriar o plano não recupera nem autoriza uma tentativa anterior.

O retorno privado contém bytes completos, hashes separados da mensagem `distDFeInt`, do envelope enviado e da resposta, tamanho e a exigência de passar pelo parser. Nunca colocar o plano, o corpo, certificados, opções TLS ou erro nativo em logs. `DfeTransportError` contém somente código fixo, `request_write_started`, `may_have_been_sent`, `outcome` e `retry_automatically:false`.

## SOAP e endpoints

O [registro oficial de produção](https://www.nfe.fazenda.gov.br/PORTAl/webServices.aspx?AspxAutoDetectCookieSupport=1&tipoConteudo=OUC%2FYVNWZfo%3D) e o [registro de homologação](https://hom.nfe.fazenda.gov.br/portal/webServices.aspx?AspxAutoDetectCookieSupport=1&SVC-AN=) informam, respectivamente:

- `https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx`
- `https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx`

SOAP 1.1 e os wrappers `nfeDistDFeInteresse`/`nfeDadosMsg` seguem o exemplo da [NT 2014.002 v1.40](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=uWO2d%2FgTuWg%3D), usada pelo [parser de distribuição](../../packages/fiscal-xml/src/distribution.mjs). O `SOAPAction` é o candidato correspondente a essa operação/namespace, **ainda não confirmado pelo WSDL**. Uma obtenção pública de `?WSDL` em homologação, sem certificado ou consulta fiscal, retornou HTTP 403 em 16/10/2026. Isso não comprova a causa da recusa. O pacote não muda para SOAP 1.2, outro host ou outro método quando algo falha.

As respostas mantêm `binding_verified:false`, `operation_authorized:false`, `can_query:false`, `can_manifest:false`, `can_emit:false`, `tls_origin_verified:false` e `sefaz_authorized:false`. O port de teste pode simular eventos TLS; essas flags não promovem a simulação a evidência SEFAZ. O recebimento de um corpo HTTP também não comprova que seja uma resposta DF-e válida.

## Transporte e limites

- Uma conexão por execução, sem agente global, reutilização, cache de sessão, proxy derivado do ambiente, redirecionamento ou retry.
- SNI/Host fixos; autenticação do servidor e verificação de hostname nativas mantidas. TLS mínimo 1.2/máximo 1.3; também confere a versão negociada antes de iniciar a escrita HTTP.
- O contexto TLS deve ser criado pelo futuro adaptador autorizado com o mesmo mínimo. Um `SecureContext` fornecido não comprova validade do certificado cliente, política A1, revogação, CNPJ ou permissão de uso. O transporte não extrai chave de um signer offline.
- Requisição até 10 KiB, headers de resposta até 16 KiB, corpo até 8 MiB. SOAP 1.1 `text/xml`, UTF-8 ou charset ausente; sem compressão HTTP. `docZip` gzip é tratado separadamente pelo parser já existente.
- Um prazo de parede cobre abertura/TLS, headers, corpo e hash; padrão 20 s, máximo 30 s. Não depende apenas de timeout por inatividade. Abort/erro encerra request, response, socket e agente, descarta fragmentos e não entrega resultado parcial.
- Content-Length, framing e completude devem coincidir. HTTP 3xx, HTTP diferente de 200, MIME/encoding incompatíveis, tamanhos ambíguos e conexões truncadas falham sem fallback.

Os controles usam as interfaces oficiais de [HTTPS](https://nodejs.org/api/https.html) e [TLS](https://nodejs.org/api/tls.html) do Node; a compatibilidade executável foi testada no Node 24 do ambiente. A cadeia de confiança do servidor TLS é diferente da análise ICP-Brasil do certificado cliente. Não substituir a primeira pelas raízes ICP apenas por conveniência.

Antes de chamar `request.end`, uma falha tem `outcome:'not_written'`; a partir da tentativa de escrita, qualquer falha é `outcome:'uncertain'`, mesmo que o servidor de teste não tenha processado o corpo. Isso não significa que o certificado não participou de um handshake. Também não permite desfazer um `dispatch` persistido: a SQL045 continua conservadora depois de emitir o ticket, inclusive se esta camada local informa que não escreveu.

## Encaixe futuro obrigatório

O runtime atual de custódia não foi alterado. Seu envelope 041 é restrito a `offline-homologation`/ambiente 2; `withCredential` oferece somente um signer offline, não material mTLS. A mudança de finalidade não pode ser obtida alterando flags nem interpretando `configured_offline` como autorização para consultar.

Para um uso real ainda faltam:

1. Concluir a homologação, coordenar a pausa de outro coletor quando existir, obter o último NSU SEFAZ e horário e registrar checkpoint confirmado antes da ativação. CNPJ interessado e identidade do certificado precisam estar versionados. Não escolher outro estabelecimento ou certificado por inferência.
2. WSDL/binding verificado e política explícita de uso da credencial para distribuição no ambiente escolhido, distinta da preparação offline.
3. Callback mTLS escopado no runtime, após autorização e CAS atuais: identidade, credencial, associação, cadeia/perfil e revogação sob política de frescor. Os avaliadores trust/CRL existentes são evidências offline e não concedem essa finalidade; CRLs fornecidas não provam última publicação.
4. Orquestrador interno que reserve pela SQL045, revalide contexto, consuma um ticket único imediatamente antes da consulta e registre toda incerteza. Nenhum SOAP, URL, CA ou opções TLS deve vir do browser. O adaptador não deve devolver chave/PFX/senha.
5. Parser atestado sobre bytes originais → objetos imutáveis privados com leitura/hash de conferência → `finalize`045 atômico para o lote inteiro. Só essa transação pode avançar NSU. Depois de 137/656, respeitar espera mínima e revisão; sem reset ou manifestação automática.

O executor HTTP não implementa nenhum desses passos de autorização ou persistência. Não há endpoint que o chame, nem cron ou leitura do cofre. NF-e 55 é o único modelo; NFC-e 65 permanece fora da distribuição.

## Verificação

```sh
node --test packages/fiscal-dfe-transport/test/distribution-transport.test.mjs
node --test packages/fiscal-dfe-transport/test/loopback-mtls.test.mjs
```

O primeiro comando roda inteiramente com eventos sintéticos. O segundo requer permissão local para abrir uma porta efêmera em `127.0.0.1`; não faz DNS externo. Certificados/chaves são gerados em memória, o driver substitui o destino pelo loopback e mantém a verificação de SNI/hostname. Valida sucesso mTLS, ausência de certificado cliente, CA errada e hostname divergente.

Testes locais não certificam o WSDL, a aceitação de um A1 real, a política fiscal ou o comportamento do Ambiente Nacional. Nenhuma transmissão real foi tentada.
