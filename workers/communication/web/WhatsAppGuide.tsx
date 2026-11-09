import mediaImage from "../docs/screenshots/26-whatsapp-midias.jpg";
import groupsImage from "../docs/screenshots/27-whatsapp-grupos.jpg";
import callsImage from "../docs/screenshots/28-whatsapp-ligacoes.jpg";

export function WhatsAppGuide() {
  return (
    <section id="whatsapp-recursos" className="system-card card">
      <div className="eyebrow">DEPOIS DE INSTALAR · VERSÃO 0.5.0</div>
      <h2>Arquivos, áudio, grupos e ligações</h2>
      <p>
        Atualize o painel em <strong>Sistema e atualizações</strong>. Se usa QR
        ou WhatsApp pelo Hermes, atualize também o conector no computador/VPS,
        preservando a sessão e os diários. O botão do painel atualiza a parte
        que fica na Cloudflare.
      </p>
      <h3>Enviar uma mídia</h3>
      <ol>
        <li>
          Abra <strong>Conversas</strong>, selecione o atendimento e clique em{" "}
          <strong>Assumir conversa</strong>.
        </li>
        <li>
          Clique <strong>Anexar</strong>, selecione o arquivo e escreva uma
          legenda se desejar. Para voz, use <strong>Gravar áudio</strong>,
          permita o microfone, pare e ouça a prévia.
        </li>
        <li>
          Clique <strong>Enviar</strong> e acompanhe a porcentagem. Na fila
          ainda não significa entregue. Se aparecer Sem confirmação, confira
          Entregas antes de tentar outra mensagem.
        </li>
        <li>
          Reproduza vídeo/áudio recebido no painel e clique no nome do arquivo
          para baixar. Use a seta da mensagem para responder citando.
        </li>
      </ol>
      <p>
        Meta: foto JPG/PNG até 5 MB, vídeo MP4 e áudio até 16 MB, documento
        PDF/TXT/Office até 100 MB. Voz gravada: até dois minutos. Figurinhas:
        WebP 512 × 512. O limite do upload Wabotia é 100 MB; o canal pode impor
        limites menores.
      </p>
      <details>
        <summary>Ver a tela de mídias</summary>
        <img
          src={mediaImage}
          alt="Conversa de teste com imagem, áudio e resposta citada"
          className="guide-reference-image"
        />
      </details>
      <h3>Participar de grupos</h3>
      <p>
        Em <strong>Grupos WhatsApp</strong>, selecione o QR e clique{" "}
        <strong>Buscar grupos</strong>. Pode criar um grupo ou entrar por
        convite. Na conversa, escolha IA desligada, somente menções ou todas as
        mensagens. Nome, participantes e convite dependem de o número ser
        administrador.
      </p>
      <p>
        A Meta tem uma API de grupos empresariais com elegibilidade própria, até
        oito participantes na referência consultada e entrada por convite. Ela
        não dá acesso geral aos grupos do aplicativo pessoal. Pelo Hermes, a
        política de grupos dele também precisa permitir a entrada.
      </p>
      <details>
        <summary>Ver a tela de grupos</summary>
        <img
          src={groupsImage}
          alt="Lista e controles de grupos com dados fictícios"
          className="guide-reference-image"
        />
      </details>
      <h3>Fazer e receber ligação de voz</h3>
      <ol>
        <li>
          Use <strong>Meta direto</strong> com Calling API elegível. No
          aplicativo Meta, assine o evento <strong>calls</strong> na mesma URL
          de webhook, além de messages.
        </li>
        <li>
          Em <strong>Conexões</strong>, clique{" "}
          <strong>Habilitar ligações de voz</strong>. O token precisa ter as
          permissões Meta necessárias.
        </li>
        <li>
          Assuma uma conversa individual. Use{" "}
          <strong>Verificar permissão</strong> e, se necessário,{" "}
          <strong>Pedir permissão</strong>. O cliente deve autorizar a chamada.
        </li>
        <li>
          Clique <strong>Ligar</strong> ou abra o aviso de ligação recebida e
          escolha <strong>Atender com microfone</strong>. Mantenha a conversa
          aberta até encerrar.
        </li>
      </ol>
      <p>
        O áudio usa o navegador e a infraestrutura Meta. QR e transporte Hermes
        não oferecem ligações neste projeto. Videochamadas não são suportadas.
        Permissões, limites e cobranças Meta continuam aplicáveis.
      </p>
      <details>
        <summary>Ver a tela de ligações</summary>
        <img
          src={callsImage}
          alt="Controles de voz com dados fictícios, sem ligação real"
          className="guide-reference-image"
        />
      </details>
      <p>
        <strong>Antes de usar com clientes:</strong> teste com seu número real
        todos os tipos de mídia, grupos, recuperação após queda e ligações
        elegíveis. Os testes automatizados usam provedores simulados.
      </p>
      <p>
        <a href="https://github.com/Quevenapp/Wabotia/blob/main/docs/WHATSAPP.md">
          Passo a passo completo e atualização dos conectores ↗
        </a>{" "}
        · <a href="/api-docs">Usar estes recursos pela API ↗</a>
      </p>
    </section>
  );
}
