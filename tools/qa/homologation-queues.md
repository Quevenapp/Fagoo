# Aceite HTTP de filas na homologação

O roteiro `homologation_queues.py` reutiliza as contas e as duas unidades sintéticas
do run de Auth/CRM. Execute somente após a conclusão da fase HTTPS/API de
`homologation_auth_crm.py`, sem executar os dois scripts simultaneamente.
O destino é fixo: `/opt/fagoo-homolog`, projeto `fagoo-homolog`, porta `18081` e
as origens `homolog.fagoo.com.br`, `api-homolog.fagoo.com.br` e
`services-homolog.fagoo.com.br`. Não recebe outro host ou token pela linha de comando.

Na raiz da homologação, o primeiro comando apenas lê a configuração e as fixtures
e consulta a versão pública. O segundo autoriza os dados sintéticos:

```sh
python3 tools/qa/homologation_queues.py --run-id 9e786a54cb21
python3 tools/qa/homologation_queues.py --run-id 9e786a54cb21 --execute
```

O ensaio confirma os e-mails `@synthetic.invalid`, o marcador `qa_run`, os nomes
das unidades e a ausência de dispositivos ativos externos ao ensaio. Preserva
`crm.read`/`crm.write` e acrescenta somente `queue.read`, `queue.operate` e
`ticket.issue` aos dois operadores QA, cada um em sua unidade. Nenhum papel global
ou usuário de produção é alterado.

As verificações incluem 12 emissões concorrentes, 12 repetições do mesmo UUID,
recuperação de recibo, rejeição de payload diferente, leitura/escrita entre unidades,
contadores independentes e 16 chamadas simultâneas disputando 13 senhas. As filas
são exclusivas do ensaio; as senhas não contêm telefone nem inscrições push.

Um dispositivo **HTTP sintético** recebe `panel.read`, `ticket.issue` e
`print.execute`. O roteiro verifica projeção pública sem dados privados e nega
acesso a pessoas, chat, WhatsApp e outra unidade. O token permanece no estado
privado; nunca é instalado em um aparelho. O único job de impressão fica nesse
dispositivo: oito claims disputam o job, o vencedor confirma `incerto`, e novas
reservas não podem entregá-lo outra vez. Não há conexão a impressora, byte físico,
áudio ou mensagem externa. Isso não comprova a perda física de ACK nem seu timeout
de 60 segundos, que continuam sendo verificações distintas.

UUIDs e payloads são salvos **antes** do envio em
`private/qa/<run>/queues-state.json`; o relatório sem credenciais fica em
`queues-report.json`. Após uma resposta incerta, retome o mesmo run. Um token de
dispositivo perdido durante emissão exige inspeção e rotação explícita; o roteiro
não inventa outro comando para contornar a incerteza. Ele também interrompe se não
conseguir identificar o vencedor de um claim. Não limpa dados automaticamente.
Uma execução já concluída preserva o relatório, sem declarar novos testes.

O dispositivo sintético permanece cadastrado para inspeção. Não reutilize sua
credencial no aplicativo; o vínculo físico deve receber um dispositivo próprio.

```sh
python3 -m unittest discover -s tools/qa -p test_homologation_queues.py -v
```

Os oito testes locais verificam as travas e o próprio roteiro com transportes
simulados. Somente a execução HTTPS aprovada pelo operador produz evidência real
de filas na instalação homologada.
