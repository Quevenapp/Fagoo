# Recuperação da instalação

Antes de recuperar, preserve o estado e identifique a versão do banco, a versão da aplicação e o último backup concluído. O estado do atualizador está em `/opt/fagoo/state/update.json`; o manifesto instalado está em `/opt/fagoo/state/installed.json`.

Uma falha anterior à migração permite retomar a aplicação anterior. Depois que uma migração começa, o atualizador mantém a ocorrência como pendência de recuperação: trocar apenas a imagem pode ser incompatível com o banco.

## Ensaio de restauração

Teste primeiro em uma VPS ou projeto Docker separado, usando a mesma versão principal do PostgreSQL e uma versão compatível da aplicação. Baixe o `.dump` e seu `.sha256` do armazenamento privado. O restore substitui integralmente o banco `fagoo` da instalação escolhida.

```bash
sudo bash /opt/fagoo/current/scripts/restore.sh \
  /caminho/absoluto/fagoo-AAAAmmddTHHMMSSZ-123.dump \
  --confirm-database-replace
```

O script confere o checksum e a estrutura do arquivo antes de interromper a API e as tarefas. Em seguida recria o banco e restaura dentro de uma transação. Os serviços permanecem parados para que o responsável confira a compatibilidade e os resultados.

Valide administrador, cadastros, contagens, saldos, documentos, eventos pendentes e permissões. Recupere também as configurações e os segredos da instalação a partir de sua cópia protegida. Os objetos privados no R2 têm recuperação e retenção próprias; não estão dentro do dump PostgreSQL.

Depois de confirmar a compatibilidade, inicie `api` e `jobs` com o Compose da versão apropriada e confira `/health/ready`. Registre a duração real do ensaio e a data do último dado recuperado. Somente esses resultados permitem avaliar RTO e RPO.

Não apague volumes PostgreSQL nem execute `docker compose down -v` como tentativa de corrigir uma atualização. Para liberar novas atualizações após uma falha de migração, reconcilie primeiro o manifesto instalado e o estado real do banco. A edição do estado de recuperação deve ser uma ação administrativa consciente, com os serviços parados.
