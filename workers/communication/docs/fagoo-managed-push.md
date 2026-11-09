# Notificações pessoais no Fagoo

O aplicativo recebe mensagens de dados. No iOS, o motor envia `content-available: 1`, `apns-push-type: background` e prioridade 5, sem `notification` ou `aps.alert`. O aviso local só aparece depois de o aplicativo conferir a sessão, o modo usuário, a unidade, a origem da API e a autorização atual sobre a conversa ou o chat. O modo painel não exibe essas mensagens.

Os eventos pessoais utilizam os tipos `internal` (`chat_id`), `message` e `transfer` (`conversation_id`), ou `queue` (`conversation_id` da fila mínima). O envelope contém `user_id`, `unit_id`, `profile_id` canônico e `server` igual à origem da API registrada pelo dispositivo. A aceitação do envio pelo FCM não comprova entrega ao aparelho; o iOS pode adiar notificações de segundo plano.

## Teste de dispositivo

A sessão web pode solicitar `POST /v1/communication/units/{unit}/devices/{id}/test`. O gateway verifica o acesso canônico à unidade; o motor só aceita um dispositivo habilitado da mesma pessoa, unidade e origem da instalação. A autorização e o registro são conferidos novamente depois de obter a credencial OAuth, imediatamente antes do envio ao FCM. Dispositivo desabilitado, removido, transferido, registrado em outra unidade ou com permissão revogada não recebe o teste.

No modo gerenciado, esse teste também é exclusivamente de dados, com título Fagoo, texto genérico e identidade/unidade/origem canônicas. Ele não contém conversa, chat, nome de contato ou mensagem privada. Os aplicativos atuais ignoram `type=test`, portanto o retorno indica somente o resultado de envio ao provedor. Para verificar um aviso visível, use uma mensagem interna autorizada entre contas de homologação, incluindo a verificação de silêncio depois da mudança para painel.

A superfície mobile não permite essa rota de teste. As rotas standalone `/system/push/test` e de configuração do provedor permanecem bloqueadas no modo gerenciado. O comportamento standalone do motor não é alterado por esse contrato.

## Configuração privada

O publicador da instalação fornece `FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON` aos Workers da API e de comunicação através de arquivo privado de segredos. A credencial não faz parte do bundle web ou dos aplicativos. O nome atual dessa variável atende tanto o envio pessoal quanto os avisos de filas; as inscrições precisam pertencer ao projeto Firebase configurado. A chave APNs do aplicativo iOS deve ser configurada no Firebase para o bundle e a equipe Apple correspondentes.
