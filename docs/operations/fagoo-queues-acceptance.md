# Filas, painéis e comunicação: evidências de implementação

Estado em 09/11/2026: desenvolvimento do Fagoo 1.0.0. Este registro não declara homologação física completa nem publicação estável.

## Autoridade e contratos

- `202611090003_fagoo_queues.sql`: PostgreSQL é a autoridade das filas. Todos os comandos serializam por unidade, revalidam o ator após esperar o bloqueio e gravam estado, evento, efeitos e recibo na mesma transação. Não há central no aparelho, SQLite operacional, descoberta LAN, Quall ou fila de comandos offline.
- Preserva emissão por dia local, sequência por fila original, prioridades, alternância, reservas por guichê, transferência mantendo identidade/número/data e o mesmo atendimento reaberto, estados das senhas, pedidos, avaliações, cinco modelos e campanhas com validade.
- `202611090009_fagoo_print_destination.sql`: uma impressão exige executor vinculado e ativo da mesma unidade. Falha desfaz emissão, contador e efeito. O dispositivo público não pode escolher uma impressora de outra unidade nem usar identidade humana.
- Impressão tem destino explícito e reserva de execução. Perder a confirmação produz `uncertain`; não recoloca trabalho na fila. Reimpressão exige confirmação humana. Áudio antigo não toca ao abrir/reconectar e é revalidado antes da execução.
- O aparelho guarda somente credencial restrita e recibos técnicos de efeitos/comandos, isolados por origem da instalação e dispositivo. Número de senha e QR de acompanhamento não são credenciais de pareamento.
- A interface web opera fila, emissão, pedidos, histórico, apresentação, campanhas e volume/silêncio por aparelho. O vínculo com contato do CRM é uma escolha explícita com controle de versão; não une cadastros por telefone.

## Acompanhamento e notificações

`/v1/queues/public/{token}` e os contratos legados `/v1/s/{token}/estado`, `/nota` e `/push` permanecem disponíveis. O retorno público é fechado: número, situação, guichê pertinente e datas necessárias, sem telefone, identificadores internos ou operador. A validade mantém os limites de 24 horas da emissão e 12 horas do encerramento.

Uma senha pode ter até dez inscrições de acompanhamento. FCM e APNs continuam sendo os provedores do consumidor legado; não foram convertidos em WebPush. WhatsApp depende de inscrição autorizada e envio `free_only`. O motor de comunicação revalida a autorização também antes da entrega real. Resultado desconhecido nunca é reenviado automaticamente; só há reconciliação de status da entrega existente.

Configuração privada de push do consumidor: `FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON`, `FAGOO_QUEUE_APNS_PRIVATE_KEY`, `FAGOO_QUEUE_APNS_KEY_ID`, `FAGOO_QUEUE_APNS_TEAM_ID`, `FAGOO_QUEUE_APNS_TOPIC`, `FAGOO_QUEUE_APNS_ENVIRONMENT`. A origem pública usa `FAGOO_WEB_ORIGIN`, inclusive nos QR de papel e tela. Isso não configura o push pessoal do aplicativo Fagoo, que possui credenciais próprias e isolamento de sessão.

## Verificações executadas

| Verificação | Evidência |
| --- | --- |
| Regras SQL, autorização, projeção pública, inscrições, recibos, transferências, incerteza física e impressora sem vínculo | `workers/erp-api/test/queues-sql.test.mjs`: 7 testes agrupados sobre as migrações reais em PGlite |
| Concorrência real PostgreSQL 17 | `queues-postgres.test.mjs`: 12 emissões paralelas, 12 repetições idempotentes, 16 chamadas disputando 13 senhas, independência entre unidades, 8 reservas de impressão, revogação enquanto espera e alternância em chamadas paralelas |
| Fronteira HTTP e QR canônico | `queues-http.test.mjs`: 4 testes, identidades fixadas pelo servidor, comandos fechados, capacidade de dispositivo, retorno público e URL nos recibos |
| FCM/APNs | `queues-push.test.mjs`: 2 testes com JWT reais de chaves efêmeras e provedores simulados; aceitação, resposta perdida, cancelamento e expiração |
| Modelo web | `fagoo-queues.test.ts`: 2 testes; unidade/revisão e armazenamento apenas do identificador de recibo |
| Tipos da aplicação web | `tsc -p apps/erp/tsconfig.json --noEmit` aprovado após integração de contato |
| Android integrado | `:app:assembleDebug :app:testDebugUnitTest`, aplicativo completo e kit real; 12 testes de limites móveis, revogação/respostas tardias, regras de painel e bytes ESC/POS. Artefato de desenvolvimento, não assinatura de loja |
| iOS integrado e inicialização física | Build de simulador e build assinado de desenvolvimento aprovados; nove XCTest aprovados. Fagoo 1.0.0 instalado e aberto no iPad A16 em bundle próprio; captura confirmou somente entrada do endereço da empresa e aviso de internet. Firebase iOS corresponde ao bundle; isso não comprova entrega APNs nem login, impressão ou áudio reais |
| Inicialização física Android | APK final `1.0.0-debug` instalado por atualização no A10s/Android 11 autorizado; abertura a frio em 9,6 s, processo vivo e zero falhas fatais no log restrito ao processo. Após o usuário desbloquear a tela, a árvore nativa mostrou somente endereço/e-mail/senha/entrada, sem navegação privada. `FLAG_SECURE` foi preservado. Autenticação real e painéis ainda dependem do ambiente de homologação |
| Backup/restauração real local | `tools/qa/synthetic-communication-backup.mjs`: executa os scripts oficiais com Wrangler D1/R2 local; compara registros, FTS/rowid, bytes SHA256 e MIME; recusa corrupção antes de escrever, reutilização de origem e destino não vazio |

Os resultados de provedores simulados não comprovam entrega em aparelhos. Bytes corretos em teste não comprovam papel ou corte. O ensaio de backup usa dados sintéticos em `.cache/qa`, novos identificadores de origem/destino e nenhuma escrita em produção.

O APK Android dessa rodada não contém cliente Firebase debug: o arquivo fornecido corresponde somente ao pacote release. O Gradle validou o pacote e não aplicou Google Services ao debug; a inspeção do APK encontrou zero recursos de cliente Firebase. Não há prova de push nessa rodada. A configuração release original foi preservada e a cópia por variante permanece ignorada pelo Git.

## Bancada ainda necessária

1. Autenticar no ambiente de homologação, vincular dispositivo e comprovar saída online autorizada, troca de usuário/unidade e revogação durante uma operação.
2. Conferir os cinco modelos em orientações/relações de tela diferentes, emissão híbrida, leitura do QR digital/impresso e rotação/validade das campanhas.
3. Medir áudio real, volume/silêncio, interrupção/reabertura e reconexão por Wi-Fi ou hotspot sem repetir chamada velha.
4. Imprimir e conferir papel/QR/corte nas combinações de aparelho, sistema e transporte aprovadas. Android integra USB, Wi-Fi/TCP, Bluetooth clássico e BLE; a disponibilidade depende do sistema e da unidade. Não executar a suíte instrumental do kit indiscriminadamente: ela pode enviar papel real.
5. Interromper conexão depois de iniciar os bytes e antes do ACK, reiniciar o aplicativo e comprovar que o trabalho incerto não é impresso outra vez. Reimpressão apenas mediante confirmação.
6. Entregar push FCM/APNs nos consumidores e push pessoal do Fagoo com credenciais de homologação; validar remoção de inscrição pessoal ao mudar usuário/modo.
7. Homologar as funções e combinações Apple separadamente. A compilação e abertura do iOS foram conferidas; um resultado funcional Android não se estende ao iOS.

As notas antigas da bancada Vinki/Printher identificam A10s, A07, X230, iPad/iPhones e unidades T210, Elgin i9FULL 2, GoldenSky, Bematech e Tomate. São inventário histórico, não confirmação de disponibilidade, endereço, perfil ou homologação atual. Não reutilizar automaticamente um papel ou perfil de outra versão como prova do Fagoo.
