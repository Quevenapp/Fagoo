# Registro do redesenho

Data: 2026-11-03. Branch: `feat/fagoo-visual-identity`.

## Solicitação recebida

Resumo do direcionamento do mantenedor, com referências externas e informações privadas omitidas:

- Criar identidade própria: cores, fontes, ícones, logotipo e componentes.
- Redesenhar dashboard, menus, cadastros e detalhes de pedidos; a troca de cor é insuficiente.
- Auditar código, bibliotecas, imagens, estilos, textos, arquivos importados e licenças.
- Preservar commits, registros de autoria e decisões, sem reescrever o histórico.
- Preparar comparação das telas antes da versão redesenhada.
- Reforço durante a implementação: menus, filtros e posições devem mudar; utilizar menu lateral; o resultado deve apresentar identidade de produto própria.

O mantenedor informou que fará a avaliação jurídica por conta própria. Não foi solicitada revisão externa.

## Registro de autoria e método

Implementação assistida por IA no Codex, sob orientação do mantenedor. O símbolo e os caminhos do conjunto FAGOO Line foram escritos diretamente em código vetorial para esta implementação. Manrope, Source Sans 3 e dependências npm são trabalhos de terceiros, com licenças próprias.

Base preservada: `1509174fb4007539fec9816760de9960271d0c09`. Foram criadas alterações normais em uma branch derivada. Não houve force push, rebase de ocultação, substituição do histórico ou remoção de atribuições de terceiros.

A conversa original permanece como fonte dos direcionamentos recebidos. O material local do mantenedor guarda as comparações visuais e trechos do briefing desta revisão. Este arquivo é um resumo, não uma transcrição integral nem uma reconstrução dos prompts antigos.

## Evidências e decisões

- O código recebido contém marcadores de referência visual e arquivos gerados. O inventário técnico registra pistas de revisão e hashes; não atribui autoria apenas com base em comentários.
- A identidade anterior foi capturada usando a base preservada e os mesmos dados fictícios.
- A nova navegação reorganiza destinos existentes, depois da resolução de permissões.
- Contatos e configurações também receberam nova composição; a validação do produto passou para a coluna de navegação por assunto.
- Foram preservados os handlers de gravação, idempotência, validação, recuperação e alterações não salvas.
- Dois testes desatualizados foram reproduzidos na base: texto do cartão de NF-e e fixture de produto sem `getSnapshot`. As fixtures/expectativas foram alinhadas ao comportamento já existente, sem relaxar as verificações de negócio.
- A publicação da aplicação é uma etapa separada da revisão desta branch.

Ver [identidade e composição](identity.md), [auditoria técnica](../legal/audit.md) e [atribuições](../../THIRD_PARTY_NOTICES.md).
