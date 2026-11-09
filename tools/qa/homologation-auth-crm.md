# QA real de autenticação e CRM

`homologation_auth_crm.py` só aceita a instalação `/opt/fagoo-homolog`,
`FAGOO_INSTANCE_ID=fagoo-homolog`, a porta local 18081 e as três origens HTTPS
explicitamente revisadas em `ORIGINS`. Se a conta/domínio de homologação mudar,
revise essa lista e a configuração privada antes de executar. O teste nunca
escolhe automaticamente uma instalação a partir de DNS ou do primeiro container.
As origens aprovadas são `https://homolog.fagoo.com.br`,
`https://api-homolog.fagoo.com.br` e `https://services-homolog.fagoo.com.br`.

O padrão executa apenas preflight de leitura e grava o relatório privado. Para
criar as três contas sintéticas e testar Auth pelo gateway local:

```sh
python3 tools/qa/homologation_auth_crm.py --run-id 0123456789ab --phase auth --execute
```

O Auth cria contas `@synthetic.invalid` já confirmadas, sem convite ou mensagem.
Uma é administradora QA; duas têm papel `operacao`. A atribuição de papel confere
o UUID, o e-mail e o marcador `qa_run` dos usuários recém-criados. Não altera
usuários existentes, política MFA global ou o marcador do primeiro administrador.
Testa login, refresh, logout local com revogação de refresh, TOTP inválido/válido,
sessão AAL2 e reconhecimento pelo ERP. JWT já emitido pode permanecer válido até
expirar; o teste não confunde essa propriedade com a revogação do refresh.

Somente depois da publicação HTTPS revisada, retome o mesmo run:

```sh
python3 tools/qa/homologation_auth_crm.py --run-id 0123456789ab --phase auth --auth-transport https --execute
python3 tools/qa/homologation_auth_crm.py --run-id 0123456789ab --phase api --auth-transport https --execute
```

A segunda fase cria duas unidades QA, vincula um operador a cada unidade, testa
negação de administração e de outra unidade, cria um contato canônico sintético,
oportunidade, tarefa e histórico, confere recibo/repetição idempotente e conflito
de versão. Marcar a oportunidade como ganha não deve criar registros financeiros.
O contato usa o RPC de projeção local com namespace `qa`; os demais comandos
funcionais passam pela API HTTPS. Não gera filas, impressões ou mensagens reais.

Senhas, segredo TOTP e sessões ficam em
`private/qa/<run-id>/credentials.json` (0600, diretório 0700). O relatório separado
`report.json` não contém esses valores. Guarde ambos na instalação privada;
nunca envie o arquivo de credenciais para Git, logs ou o chat. O stdout contém
nomes de verificações e caminhos, sem respostas Auth. Redirecionamentos HTTP
são recusados, inclusive para não encaminhar Authorization a outro host.
O cliente se identifica como `Fagoo-Homologation-QA/1.0`; não simula navegador,
não resolve desafios e não altera regras de segurança da Cloudflare.

Após resposta incerta, retome o mesmo run: contas são recuperadas pelo marcador
QA e comandos mantêm o mesmo UUID/payload. Não troque o run para tentar novamente
uma operação ainda incerta. O teste mantém os dados para inspeção e para uso no
aplicativo de homologação; ele não contém uma rotina destrutiva de limpeza.

```sh
python3 -m unittest discover -s tools/qa -p test_homologation_auth_crm.py -v
```

Os testes locais validam travas e primitivas. Eles não substituem a execução
real do Auth/HTTPS, o fluxo visual de login/MFA ou ensaios em aparelhos físicos.
