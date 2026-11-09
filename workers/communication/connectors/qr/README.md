# QR direto

Processo externo Node.js 22.13+ com Baileys. O painel, API e dados operacionais ficam na Cloudflare. Este conector não precisa do Hermes para enviar mensagens humanas; bots dependem das APIs Hermes.

1. No Wabotia, crie uma conexão `qr`, informe o número com DDI e emita o token do conector. Ative-a após preparar o processo.
2. Copie `.env.example` para `.env` e preencha URL HTTPS, ID da conexão e token. Guarde o arquivo em local privado.
3. Execute `npm ci` e `npm start`, ou `docker compose up -d --build` nesta pasta.
4. Veja o QR em **Conexões** no painel e leia pelo WhatsApp > Aparelhos conectados.

Não são publicadas portas de entrada. O processo usa HTTPS de saída e precisa permanecer ligado. O token autoriza apenas o transporte daquela conexão, não o painel/API administrativa.

A sessão e o diário SQLite ficam em `data/` (ou no volume `qr-data` no Compose). Faça backup com o conector parado. Não exclua o volume ao atualizar. O diário marca envio interrompido como desconhecido para conferência, evitando repetir automaticamente um efeito ambíguo. Monitore espaço: não há expurgo automático do spool nesta versão.

Para pausar/trocar modo, pause a conexão no painel, pare o processo, reconcilie pendências e só depois ative outro consumidor do número. Nunca execute duas cópias sobre a mesma sessão.

Baileys 7.0.0-rc13 foi instalado e importado em validação técnica; pareamento com conta real ainda precisa de homologação. O Compose é fornecido para operação e não foi validado com uma sessão WhatsApp real.

## Atualizar sem perder a sessão

1. Pause a conexão no painel e confira Entregas e Operações de grupos. Pare o processo com o gerenciador que o executa. No Docker: `docker compose stop`.
2. Faça uma cópia privada de `.env` e de `data/`, ou do volume `qr-data` com o serviço parado. Não use `down -v`.
3. Atualize a cópia do repositório oficial com `git pull --ff-only`. Se houver alterações locais, preserve-as e resolva antes de continuar.
4. Dentro de `connectors/qr`, execute `npm ci` e `npm start`. Se usa Docker, execute `docker compose up -d --build`, preservando o volume. Use a mesma URL, ID de conexão, token e pasta de dados.
5. Ative a conexão no painel. O heartbeat deve anunciar `protocol_version:2`. Não deve ser necessário ler outro QR se a sessão continua válida; se o WhatsApp tiver encerrado a sessão, pare o processo e renomeie somente `data/session` antes de parear. Preserve `journal.sqlite`.

A versão 0.5 transmite imagem, vídeo, áudio/voz, documento, figurinha, localização, cartão de contato, citação, menção, reação, edição/revogação e recibos. Inclui criação/sincronização/administração de grupos usando a mesma sessão. Mensagens offline `append` passam pelo diário de deduplicação; histórico antigo não é importado em massa.

Arquivos recebidos são transferidos por streaming para o disco e o Worker, com limite de 100 MiB. O envio pelo Baileys pode manter o arquivo na memória do host. O host deve ter disco para spool e memória para as operações internas do Baileys. O conector anuncia somente mensagens/grupos; Baileys não oferece iniciar/atender chamada ou videochamada neste caminho. Para voz ao vivo use Meta direto. [Guia e homologação](../../docs/WHATSAPP.md).
