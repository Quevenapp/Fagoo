# Operar a interface FAGOO

## Primeiro acesso

Esta versão inicial destina-se à avaliação e instalação piloto com dados de teste. Consulte o [estado da implementação](../status.md) antes de planejar uma operação real.

Entre pelo endereço configurado durante a instalação, usando a conta do administrador. A interface consulta a identificação do próprio servidor e usa uma sessão autenticada. O cadastro inicial de administrador pertence ao processo de instalação.

## Preparar a operação

1. Cadastre clientes e fornecedores em **Contatos**. Um contato pode exercer os dois papéis.
2. Cadastre os produtos com código, unidade, preços e limites de estoque.
3. Em **Estoque**, crie os depósitos necessários. Ajustes iniciais ou correções exigem quantidade e motivo.
4. Cadastre regras de preço quando houver condições específicas por produto, cliente, pagamento ou período.

## Compra e recebimento

Crie um pedido de compra, escolha o fornecedor e o depósito, adicione itens e revise o rascunho. A confirmação do pedido não é uma confirmação de chegada da mercadoria.

Nos detalhes do pedido, use **Conferir recebimento** para registrar somente as quantidades fisicamente recebidas. Quantidades parciais podem ser conferidas em momentos diferentes. A conversão de embalagem definida no pedido é aplicada pelo servidor.

O lançamento financeiro é uma operação própria, disponível nos detalhes do pedido. Informe os vencimentos e valores das parcelas. Isso cria obrigações em aberto; não realiza pagamento bancário.

## Venda

O pedido de venda usa o preço calculado pelo servidor quando o campo de preço fica em branco. Uma alteração manual depende das permissões de quem realiza a operação.

Preços unitários aceitam até dez casas decimais. Os totais financeiros são apresentados em centavos. Nos detalhes da compra ou venda, **Imprimir pedido** abre o modelo comercial FAGOO para impressão ou exportação em PDF pelo navegador. O documento não substitui uma nota fiscal nem comprova pagamento.

Confirme o pedido para registrar as reservas correspondentes. **Concluir entrega** exige confirmação e efetiva a saída do estoque. As contas a receber são geradas pelo lançamento financeiro do pedido.

## Equipe e integrações

Administradores podem criar acessos individuais e definir permissões. Operadores precisam das permissões correspondentes aos dados e ações utilizados.

Integrações recebem credenciais próprias, com escopos específicos. A credencial é mostrada uma vez após sua criação. Configure-a no ambiente do bot equipe ou do aplicativo conectado; não a coloque em documentos públicos.

Criar o acesso no FAGOO não configura automaticamente o container do agente. Siga o [guia de conexão](../integrations/agents.md), habilite as ferramentas no perfil correto e teste uma consulta antes de autorizar operações.

O painel de atividades consulta eventos registrados no servidor. O processamento e a confirmação de eventos por consumidores externos são tratados pela API.

## Fiscal e XML

O cadastro de CNPJ e regime identifica a empresa. Ele não ativa, por si só, um serviço de emissão ou validação tributária.

A importação de XML exige armazenamento privado configurado. Um XML importado é apresentado como documento declarado, com a situação de verificação informada pelo servidor. A importação não confirma assinatura, não valida tributos e não gera automaticamente estoque ou contas a pagar.

## Configuração de cobrança CNAB

Em **Cobrança CNAB**, cadastre os dados da agência, conta, carteira e convênio. O CNPJ deve coincidir com o cadastro fiscal da empresa. A interface permite criar e editar perfis Itaú CNAB 400, carteira 109, e Inter CNAB 400, carteiras 110 e 112.

As declarações de conferência de convênio, política de cobrança e faixa reservada devem refletir a confirmação recebida do banco. O cadastro permanece pendente de homologação. A tela não transmite arquivos, não registra boletos e não faz baixa financeira. Os recursos de prévia de arquivos são acessados pela API e não constituem operação bancária homologada.

## Atualizações e recuperação

A tela de atualizações consulta versões públicas e permite solicitar a aplicação ao atualizador local. A execução depende das verificações de assinatura, compatibilidade e recuperação. Uma solicitação aceita não equivale a uma atualização concluída.

Se o serviço atualizador ou o backend estiver indisponível, a interface informa a falha. Consulte os registros da instalação antes de repetir operações cujo resultado ficou desconhecido.

## Celular

A interface se adapta a telas pequenas. No celular, o botão de navegação abre o menu lateral e as tabelas permitem rolagem interna. Os aplicativos Android e iOS são entregas futuras; a identificação pública do servidor e o fluxo OAuth preparam sua conexão.
