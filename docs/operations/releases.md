# Releases verificadas

O processo de publicação é manual. GitHub Actions deve permanecer desativado nas configurações do repositório; a ausência de arquivos de workflow não substitui essa configuração.

1. Revise e versione o código, execute `npm test`, `npm run check`, `npm run build`, `node scripts/verify-compose.mjs`, `python -m unittest infra/test_updater.py` e os ensaios de instalação/restauração aplicáveis.
2. Conserve a chave privada Ed25519 fora do repositório, com acesso restrito. A chave pública de confiança está em `infra/release-root.pem` e no bootstrap.
3. Prepare os artefatos num diretório externo ao checkout:

```bash
node scripts/release.mjs --version v0.1.0-alpha.1 \
  --key /diretorio-privado/signing.pem --out /diretorio-de-publicacao/v0.1.0-alpha.1
```

O comando exige arquivos web já construídos e um commit de origem, prepara a imagem Linux amd64, empacota a imagem e os arquivos de implantação e assina o manifesto. A opção `--image` permite reaproveitar uma imagem local previamente construída e testada; o identificador exato dela é gravado no manifesto. Isso não executa nenhuma publicação Cloudflare.

Publique `install.sh`, `manifest.json`, `manifest.sig`, `deployment.tar.gz` e `app-image.tar.gz` na mesma release GitHub, com tag idêntica à versão do manifesto. Marque builds não homologadas como pré-release. A instalação não consulta o branch principal para obter comandos de atualização.

O manifesto fixa o produto, plataforma, versão, identificador da imagem, hashes e tamanhos dos artefatos e a compatibilidade do banco. O atualizador rejeita arquivos alterados, imagens com identidade diferente, caminhos inseguros no pacote e versões que não tenham sido verificadas anteriormente.

## Atualizador local

O serviço systemd recebe pedidos apenas em `/run/fagoo/updater.sock`. A API usa um segredo por instalação no header `Authorization: Bearer ...` e deve restringir a função de atualização ao administrador. O segredo fica em `/run/secrets/updater-token` dentro do container da API.

| Operação local | Contrato |
| --- | --- |
| `GET /v1/status` | Retorna instalação e estado persistente da atualização. |
| `POST /v1/check` com `{}` | Baixa e verifica o manifesto da release estável pública. |
| `POST /v1/update` com `{"version":"vX.Y.Z"}` | Aceita somente a versão verificada; retorna `202` e identificação da tarefa. |

O serviço aceita versões, nunca comandos de shell enviados pela aplicação. Ele verifica e carrega a imagem, pausa os processos da aplicação, gera backup, migra o banco, inicia e verifica a nova API e, quando configurado, publica a interface Cloudflare. Chamadas simultâneas são recusadas.

Depois de iniciar uma migração, uma falha exige recuperação explícita. O atualizador não restaura silenciosamente um backup sobre operações posteriores. O estado registra se o banco pode ter mudado. A troca de chave de assinatura também exige um procedimento de confiança explícito; não se deve aceitar uma chave nova apenas porque veio junto com um pacote.
