# Entrega persistente de eventos

O serviço `jobs` entrega eventos para destinos HTTPS configurados pelo administrador. Sem assinaturas cadastradas, não realiza chamadas de rede. O atendimento pode continuar consumindo o fluxo de eventos da API por cursor; webhook é uma opção adicional.

O administrador configura nome, URL pública e tipos de evento, como `purchase.received`, ou `*`. A criação retorna uma chave secreta **uma única vez**. Guarde-a no receptor. No banco, a chave é cifrada com AES-256-GCM, derivada do segredo da instalação e vinculada à empresa e à assinatura. A cópia protegida de `BETTER_AUTH_SECRET` é necessária para restaurar essas credenciais.

Por padrão, o registro começa depois da sequência atualmente observada. `from_sequence: "0"` solicita o histórico completo. O processamento seleciona eventos ainda sem entrega, incluindo transações que tenham terminado depois de uma leitura anterior. A combinação assinatura/evento é única no banco.

O corpo JSON inclui `id` da entrega, `event_id`, `company_id`, `type`, `resource_id`, `payload` e `occurred_at`. Cada tentativa envia:

- `X-Fagoo-Delivery-Id`: identificação estável entre tentativas.
- `X-Fagoo-Event-Id`: sequência do evento.
- `X-Fagoo-Timestamp`: horário Unix em segundos.
- `X-Fagoo-Signature`: `v1=` seguido do HMAC SHA-256 hexadecimal de `timestamp + "." + corpo_bruto`, usando o segredo recebido na criação como texto UTF-8.

O receptor deve conferir a assinatura sobre os bytes originais, limitar a diferença de horário e registrar as identificações já processadas. A entrega é **pelo menos uma vez**: uma resposta perdida pode causar uma repetição. Eventos podem chegar fora de ordem durante novas tentativas; consulte a API para obter o estado atual antes de executar uma ação de negócio.

O serviço utiliza leases no PostgreSQL, retoma tarefas abandonadas e aplica espera progressiva após erros. Depois de oito tentativas, mantém a entrega como `dead` para inspeção e reenvio administrativo. Desativar uma assinatura cancela suas entregas pendentes. A consulta administrativa de entregas informa status, tentativas e resultado HTTP sem revelar segredos.

Somente destinos HTTPS públicos são aceitos. Credenciais na URL, endereços locais, redes privadas e redirecionamentos são recusados. A resolução DNS é conferida a cada tentativa e a conexão usa o endereço validado, preservando a validação TLS do hostname. O tempo e o tamanho da resposta são limitados.

Os testes do projeto usam receptores simulados. Cadastrar uma assinatura real autoriza o serviço instalado a enviar os eventos selecionados ao destino informado.
