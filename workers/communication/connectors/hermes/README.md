# Transporte mínimo para WhatsApp pelo Hermes

Use somente se Meta/QR continuar configurado no Hermes. Telegram direto e WhatsApp direto não usam este plugin. O painel fica no Worker.

Compatibilidade examinada: Hermes `0e427d788d253630d38a3a51cd76849e73cd6925`, contrato `exclusive_ingress` versão 1. A extensão usa APIs internas do gateway, que podem mudar. Não aplique o patch cegamente em outra revisão.

1. Faça backup do perfil e do checkout Hermes. Pause o atendimento e o consumidor antigo do número; resolva entregas pendentes.
2. Crie no Wabotia uma conexão **WhatsApp pelo Hermes**, escolhendo `whatsapp` (QR) ou `whatsapp_cloud` (Meta). Emita a chave do conector e copie o ID.
3. Pare o gateway que serve o perfil antes de alterar o checkout. Em implantação multiplexada isso pode interromper outros perfis; programe a manutenção.
4. No checkout Hermes realmente executado, confira a extensão:

```sh
git apply --check /CAMINHO/Wabotia/connectors/hermes/hermes-exclusive-ingress.patch
git apply /CAMINHO/Wabotia/connectors/hermes/hermes-exclusive-ingress.patch
```

Se a extensão já estiver presente, não reaplique. Se `--check` falhar, verifique a versão e as alterações locais, sem usar `--force`. `hermes-whatsapp-shared-ingress.patch` é adicional para a modalidade Meta compartilhada entre perfis; aplique somente se sua implantação usa esse ingresso e a revisão for compatível. Não substitui a extensão exclusiva.

5. Na pasta Wabotia, execute o instalador com o diretório do **perfil existente** (o diretório que contém `config.yaml`):

```sh
python3 scripts/install-hermes-transport.py \
  --profile-home /CAMINHO/DO/PERFIL \
  --url https://SUA_INSTALACAO.workers.dev \
  --connection-id ID_DA_CONEXAO \
  --platform whatsapp
```

Use `--platform whatsapp_cloud` para Meta. A chave é pedida sem aparecer na tela. O script preserva os bots, faz cópia do plugin anterior e recusa vínculo do canal com outro consumidor. O token fica no arquivo privado `wabotia-connector.json` do perfil.

6. No perfil correto:

```sh
hermes -p NOME_DO_PERFIL config set plugins.isolation in_process
hermes -p NOME_DO_PERFIL plugins enable wabotia_transport
```

7. Reinicie o gateway pela supervisão que já usa, ative a conexão no Wabotia e teste entrada, saída, anexos, tomada humana e recuperação. A extensão retém a entrada em spool; não permite que a mesma mensagem caia no agente padrão do Hermes.

Em Docker, instale na imagem/volume efetivamente usados pelo processo, com o gateway parado. Preserve o volume do perfil. Não há imagem Hermes substituta neste repositório.

Mantenha `exclusive-ingress.json`, `wabotia-connector.json`, `wabotia-transport/` e o spool do gateway privados. Eles não devem ir para o GitHub. Não há expurgo automático do diário nesta versão; monitore disco e faça backup parado.

Para remover, primeiro pause o canal e pare o gateway. Confirme pendências no Wabotia, desabilite o plugin e remova somente o vínculo daquele consumidor em `exclusive-ingress.json`. Depois reative o consumidor escolhido. Não exclua todos os vínculos nem todo o perfil.

Os testes Python cobrem diário, confirmação perdida e recebimento. Homologação real Meta/QR exige suas credenciais e números autorizados.

## Atualização 0.5.0

Pause a conexão, confira Entregas, pare o gateway e faça backup do perfil/checkout. Atualize a cópia Wabotia. Se já aplicou exatamente a extensão fornecida até 0.4.0, execute:

```sh
python3 scripts/update-hermes-ingress.py --hermes-checkout /CAMINHO/DO/HERMES
```

O atualizador confere o hash da extensão conhecida, faz uma cópia e troca somente `gateway/exclusive_ingress.py`. Recusa arquivos de outras versões ou modificados; não force a substituição. A extensão nova reconhece menções do bridge atual e aceita arquivos até 100 MiB. Para instalação inicial continue usando o patch completo, com `git apply --check`.

Repita `install-hermes-transport.py` com o **mesmo perfil, conexão e token** já existentes. Isso atualiza `content.py` e o consumidor, preservando `wabotia-transport/`, `exclusive-inbox/`, configurações de bots e sessão WhatsApp. Reinicie o gateway pela supervisão existente e ative a conexão. Não inicie o conector QR direto para o mesmo número.

O protocolo 2 anuncia as funções nativas implementadas no adaptador concreto. O envio de imagem/vídeo/voz/documento usa esses métodos; não aceita como suporte uma implementação base que apenas envia o caminho local como texto. Na Meta Hermes, conteúdo nativo inclui citação, reação, figurinha, localização e contatos. Não há encaminhamento completo de recibos/edições recebidas nem API de administração de grupos neste transporte. Para isso prefira o modo direto.

Grupos são encaminhados com autor separado da conversa. A política normal de grupos do Hermes pode filtrar a entrada antes da extensão; configure grupos permitidos nele. A política Wabotia padrão responde apenas a menção ou `/bot`. O QR Hermes usa o método de voz do adaptador também para arquivos de áudio; a conversão depende das ferramentas instaladas nele. Ligações ao vivo exigem Meta direto, não esta extensão.
