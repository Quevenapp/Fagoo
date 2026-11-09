import Foundation

/// Uma linha da tira de página, e a decisão de perfil inteira que escolhê-la grava.
///
/// `label` é vocabulário da bancada — `sem acentos`, `CP850`, `n=08` — e **não vai ao papel nem à
/// tela**. Quem está com a tira na mão responde por letra; o código só aparece no comprovante
/// final, onde serve ao catálogo. Ver a decisão de 12/08 em `docs/estado.md`.
///
/// A tira mede modelo de codificação **e** página na mesma pergunta: a etapa separada que
/// perguntava "byte único ou UTF-8?" saiu, porque ninguém com o papel na mão responde isso.
public struct CodePageProbeCandidate: Equatable, Sendable {
    /// Letra impressa e aceita como resposta pela máquina.
    public let letter: Character
    public let textEncoding: ThermalTextEncoding
    public let codePage: ThermalCodePage?
    /// Endereço emitido em `ESC t`; `nil` em quem não seleciona página nenhuma.
    public let selector: UInt8?
    /// Nomes vencem endereços porque carregam uma medição mais informativa.
    public let isAddress: Bool
    public let label: String

    /// A linha que sai sem `ESC t` nenhum, na tabela que a firmware já ligou sozinha.
    public var isFirmwareDefault: Bool { textEncoding == .firmwareDefaultPage }

    public init(
        letter: Character,
        textEncoding: ThermalTextEncoding,
        codePage: ThermalCodePage?,
        selector: UInt8?,
        isAddress: Bool = false,
        label: String? = nil
    ) {
        self.letter = letter
        self.textEncoding = textEncoding
        self.codePage = codePage
        self.selector = selector
        self.isAddress = isAddress
        self.label = label ?? codePage?.label ?? textEncoding.receiptLabel
    }
}

public struct CutProtocolProbeCandidate: Equatable, Sendable {
    public let cutProtocol: CutProtocol
    public let commandBytes: Data

    public init(cutProtocol: CutProtocol, commandBytes: Data) {
        self.cutProtocol = cutProtocol
        self.commandBytes = commandBytes
    }
}

/**
 O custo em papel da homologação inteira, contado das sondas em vez de escrito à mão na tela.

 Tira aqui é pedaço de papel na mão de quem mede, não envio: a sonda de corte manda um dialeto por
 vez e a régua de avanço sai num envio só, mas cada corte produz um pedaço, e é pedaço que a pessoa
 conta antes de dizer se paga.

 A conta mora ao lado das sondas porque quem sabe quantas tiras saem é a sequência delas. Escrita à
 mão nas telas ela divergiu: em 20/08 o Android anunciava "de 4 a 17" e o iOS "de 4 a 7" — o
 literal do iOS ficou parado em 12/08, quando os seis dialetos de corte e a régua de oito avanços
 entraram, e **nenhum dos dois** contava a tira das réguas de largura, que abre toda medição e já
 era contada no piso. Etapa nova que gaste papel acrescenta a parcela aqui, e as duas telas mudam
 junto. É a mesma conta do `PrinterHomologationPaperCost` do Android, parcela por parcela.
 */
public enum PrinterHomologationPaperCost {
    /// As réguas de 58 e 80 mm saem juntas, numa tira só, e abrem toda homologação.
    public static let widthRulers = 1

    /// A régua completa de 24 a 64 colunas: só quem responde "Nenhum" à comparação a paga.
    public static let fullGeometry = 1

    /// Uma tira de meio tom em largura cheia, em toda impressora: encolhimento não se adivinha.
    public static let rasterThroughput = 1

    /// Uma tira com o QR e o código de barras nativos, em toda impressora: firmware não se
    /// adivinha. Entra no **piso**, e não só no teto, pelo mesmo argumento da tira de vazão: ela
    /// sai em toda medição, e não existe caminho de remedição parcial para quem pular.
    public static let nativeCode = 1

    /// Uma tira só, com todas as candidatas de texto — a etapa separada saiu em 12/08.
    public static let codePage = 1

    /// O comprovante final, que é a certidão transcrita da medição.
    public static let finalReceipt = 1

    /// Um dialeto por tira: comparar corte exige as tiras lado a lado.
    public static var cutProtocolStrips: Int { PrinterHomologationMachine.allCutProtocols.count }

    /// A régua inteira do avanço, um corte por valor medido.
    public static var cutFeedStrips: Int { PrinterProbePayloads.cutFeedCandidates.count }

    /// Sem guilhotina: largura, vazão, código nativo, texto e comprovante final.
    public static var minimumStrips: Int {
        widthRulers + rasterThroughput + nativeCode + codePage + finalReceipt
    }

    /// Com guilhotina, régua de avanço inteira e a régua completa de geometria.
    public static var maximumStrips: Int {
        minimumStrips + fullGeometry + cutProtocolStrips + cutFeedStrips
    }
}

/// Tabelas que antes viviam apenas em sondas de teste. A ordem faz parte da medição: se duas
/// linhas forem legíveis, a primeira impressa vence.
public enum PrinterProbePayloads {
    public static let textEncodingSample = "café, açúcar, três"

    // Estes acentos ocupam os mesmos bytes em CP437, CP850, CP858 e CP860. A sonda ainda não sabe
    // o endereço de `ESC t` — e a T210 provou que o endereço canônico pode estar errado —, então
    // usa a página padrão após `ESC @` e não seleciona uma tabela em nome da impressora.
    /// Os **cinco bytes que distinguem**, sem `ESC t`. A amostra anterior era `café, açúcar, três`,
    /// montada com bytes comuns às quatro páginas DOS — e por isso cega: `é ç ú ê` têm o mesmo
    /// desenho em CP437 e CP860, e "certa" ali não significava nada.
    ///
    /// A conclusão que se tirou disso em 10/08 — "a tabela padrão da T210 é CP437" — também era da
    /// cegueira, e caiu em 12/08: com a impressora desligada da tomada e a amostra completa, a
    /// linha sem `ESC t` saiu inteira. O que a T210 tem de torto é o endereço: `ESC t 3` leva a
    /// outra tabela, e a CP860 responde em `n=08`.
    private static let textEncodingSingleByteSample = Data([0x84, 0x87, 0x94, 0xA0, 0x88])

    /// O inventário de acentos da tira de página — **minúsculas e maiúsculas**.
    ///
    /// A frase `cão, ações, avô, você, água` media só a metade baixa da tabela. Medido no papel da
    /// T210 em 12/08: com o endereço que a frase aprovou, `ação` saiu perfeito e `HOMOLOGAÇÃO
    /// CONCLUÍDA` saiu `HOMOLOGACÃO CONCLUrDA` — a mesma tabela acerta embaixo e erra em cima.
    ///
    /// A ordem agrupa cada vogal com os acentos dela e espelha minúscula e maiúscula: errado não
    /// aparece como palavra torta, aparece como quebra no ritmo.
    ///
    /// **Só o que a língua usa e o kit imprime.** `ü Ü` entraram e saíram no mesmo dia: o trema
    /// caiu do português em 2009 e sobrevive em nome próprio, que não é o que esta bancada mede.
    /// `ª º` entraram por especulação — "1ª via", "nº" — e saíram porque nada no kit nem no app
    /// imprime ordinal; medir o que ninguém imprime é gastar papel e leitura à toa. E a dobra ASCII
    /// não os representa: a linha `a` terminava em `? ?`.
    public static let codePageSample =
        "à ã á â é ê í ó ô õ ú À Ã Á Â É Ê Í Ó Ô Õ Ú ç Ç"

    /// Endereços varridos por `ESC t`. Começa em zero desde 12/08: com a CP437 fora da lista de
    /// nomes, `n=00` só continua medido se um endereço o cobrir.
    public static let codePageSelectorRange = Array(UInt8(0)...UInt8(20))

    /// Nomes de página que sobrevivem à frase inteira, derivados da própria tabela.
    ///
    /// A CP860 fica de fora porque a linha dela seria byte a byte igual à do endereço `n=03` —
    /// mesma seleção, mesma tabela —, e duas linhas idênticas na tira são papel gasto e escolha
    /// ambígua para quem responde.
    /// A CP858 fica de fora junto com a CP860: para esta frase ela emite os mesmos bytes da CP850
    /// — o euro é a única diferença —, e a lista precisava caber no alfabeto.
    static let namedCodePages: [ThermalCodePage] = ThermalCodePage.allCases.filter { page in
        page != .cp860 && page != .cp858
            && codePageSample.unicodeScalars.allSatisfy { $0.isASCII || page.encode($0) != nil }
    }

    /// A tira única: sem acento, sem seleção, UTF-8, os nomes e os endereços — nessa ordem.
    ///
    /// Ela mede modelo de codificação e página de uma vez. A ordem é a medição:
    ///
    /// - **`a` é o ASCII**, a frase sem acento nenhum. É a resposta de quem não conseguiu acento em
    ///   lugar nenhum, e vem primeira porque é o piso. A instrução avisa que ela não é a "linha
    ///   legível" por padrão — sem isso, todo mundo pararia nela.
    /// - **`b` é a sem seleção**, a tabela que a firmware liga sozinha. Só é honesta enquanto
    ///   nenhum `ESC t` a precede na tira.
    /// - **`c` é o UTF-8**, o modelo da MTP-II.
    ///
    /// **Só entra quem consegue imprimir a frase inteira acentuada.** A dobra para ASCII sairia
    /// limpa e sem acento, e é por isso que esse texto existe uma vez só, rotulado, na linha `a`.
    /// CP437 e CP866 caem por esse critério, medido na tabela.
    public static let codePageCandidates: [CodePageProbeCandidate] = {
        var letter = Character("a").asciiValue!
        func next() -> Character {
            defer { letter += 1 }
            return Character(UnicodeScalar(letter))
        }
        let fixed: [CodePageProbeCandidate] = [
            CodePageProbeCandidate(
                letter: next(),
                textEncoding: .ascii,
                codePage: nil,
                selector: nil,
                label: "sem acentos"
            ),
            CodePageProbeCandidate(
                letter: next(),
                textEncoding: .firmwareDefaultPage,
                codePage: .cp860,
                selector: nil,
                label: "sem seleção"
            ),
            CodePageProbeCandidate(
                letter: next(),
                textEncoding: .utf8,
                codePage: nil,
                selector: nil,
                label: "UTF-8"
            ),
        ]
        let named = namedCodePages.map { page in
            CodePageProbeCandidate(
                letter: next(),
                textEncoding: .singleByteCodePage,
                codePage: page,
                selector: page.rawValue
            )
        }
        let addresses = codePageSelectorRange.map { selector in
            CodePageProbeCandidate(
                letter: next(),
                textEncoding: .singleByteCodePage,
                codePage: .cp860,
                selector: selector,
                isAddress: true,
                label: String(format: "n=%02d", Int(selector))
            )
        }
        let candidates = fixed + named + addresses
        precondition(
            candidates.last!.letter <= "z",
            "A tira de página não cabe no alfabeto; a resposta deixaria de ser uma letra."
        )
        return candidates
    }()

    /// A letra da tira que produz esta medição, ou `nil` quando nenhuma linha produz.
    ///
    /// A letra não é persistida no perfil: ela é função da tira, e `(codificação, página, seletor)`
    /// identifica uma linha só. Configuração manual pode gravar uma combinação que nenhuma linha
    /// imprime, e aí o comprovante não inventa letra. Espelha `codePageLetter` do Android.
    public static func codePageLetter(
        textEncoding: ThermalTextEncoding,
        codePage: ThermalCodePage?,
        codePageSelector: UInt8?
    ) -> Character? {
        codePageCandidates.first { candidate in
            candidate.textEncoding == textEncoding
                && candidate.codePage == codePage
                && (candidate.isAddress ? candidate.selector : nil) == codePageSelector
        }?.letter
    }

    public static let cutProtocolCandidates: [CutProtocolProbeCandidate] = CutProtocol.allCases.map {
        CutProtocolProbeCandidate(cutProtocol: $0, commandBytes: $0.command)
    }

    public static let cutFeedCandidates = PrinterCapabilities.allowedCutFeedLines

    /// Único texto de instrução da tira, quebrado à mão para caber em 32 colunas.
    ///
    /// Sai em ASCII e sem `ESC t`: a página ainda não foi medida, então a instrução não pode
    /// depender dela. Nenhum código técnico entra aqui — a resposta é uma letra.
    /// A ressalva sobre a linha `a` não é enfeite: ela é a frase **sem acento nenhum**, e é a
    /// única que sai legível em qualquer firmware. Sem o aviso, "escolha a linha legível" faria
    /// todo mundo parar nela e gravar um perfil que nunca acentua.
    public static let codePageInstructions = """
        Escolha a letra da linha em
        que TODOS os acentos sairam,
        maiusculas tambem.
        A linha a) e sem acento:
        escolha ela so se nenhuma
        outra sair certa.


        """

    /// Avanço final das sondas que não cortam, em linhas. Com 4 a MP-4200 e a i9 seguraram as
    /// réguas raster e as amostras de página dentro da impressora: a distância entre a cabeça e a
    /// serrilha é maior que isso, e o operador não conseguia ler o que a sonda acabara de imprimir.
    /// 12 é o maior avanço que o próprio kit aceita como medida de corte, então é o único valor
    /// que garante a última linha do lado de fora em toda impressora já suportada.
    static let probeTearFeedLines: UInt8 = 12

    /// A MP-4200 e a i9 fazem corte parcial; se o bloco do parcial saiu solto, quem falhou foi a
    /// medição, não a guilhotina. A sonda não pode induzir a conclusão contrária: ela mede qual
    /// comando a impressora obedece e o papel só descreve as duas formas, sem mandar desistir do
    /// parcial. O aviso de não puxar vem primeiro porque a aba de um corte parcial rasga na mão
    /// igual a picote e a tira passa a parecer corte total.
    public static let cutProbeInstructions = """
        Nao puxe as tiras antes de ver
        todas.
        Corte total: a tira sai solta.
        Corte parcial: a tira fica presa
        por um pedaco no meio.
        Cada bloco tenta um comando
        diferente. Anote o numero do
        bloco que deu o corte que voce
        quer usar.
        Nenhum cortou = rolo inteiro.
        O que voce escolher fica salvo e
        passa a ser o corte de toda venda.


        """

    /// O aviso diz o que vai sair e para quê, e não pede permissão. Oito tiras é o preço de medir
    /// a distância entre a cabeça e a lâmina desta impressora; quem não quiser pagá-lo agora pula.
    public static let cutFeedBenchWarning =
        "Vamos imprimir 8 tiras para você escolher o espaçamento."

    /// Resolução das cabeças que este kit homologa: 203 dpi, que arredonda para 8 dots por
    /// milímetro. Não é palpite — a bancada de 20/08 mediu 120 dots em 15,0 mm no papel da T210.
    public static let rasterDotsPerMillimetre = 8

    /// Altura da tira de vazão, em dots. **384**, e o número tem três razões.
    ///
    /// - É múltiplo de 24, a faixa que `EscPosRasterEmitter` usa para toda foto de venda. A tira
    ///   sai com a mesma forma de bytes que a foto que falha; com outra banda mediria outra coisa.
    /// - A 203 dpi dá 48,0 mm de papel. É comprimento que se lê numa régua comum: o defeito de 22%
    ///   encurta a tira em mais de um centímetro, à vista.
    /// - É o maior múltiplo de 24 dentro da faixa de 300 a 400 dots. Quanto mais alta a tira, menos
    ///   pesa o erro de leitura de ±1 mm, e mais bytes atravessam o buffer da impressora antes do
    ///   fim — que é o que precisa acontecer para o descarte de linha aparecer.
    public static let rasterThroughputStripDots = 384

    /// O que a tira deve medir na régua quando nada é descartado.
    ///
    /// Este número **não vai à tira**. Nas outras tiras o número impresso é a identidade da régua;
    /// aqui ele seria a resposta da pergunta, e quem lê a resposta antes de medir mede menos.
    ///
    /// Nos **comprovantes** ele aparece, e a proibição não vale lá: em `Vazão: 38/48 mm` a medição
    /// já aconteceu, e sem o denominador "38 mm" não diz se a tira encolheu ou se ela é curta. Ver
    /// ``verticalRasterScaleLine(_:)``.
    public static let rasterThroughputStripMillimetres =
        rasterThroughputStripDots / rasterDotsPerMillimetre

    /// Espessura do traço cheio em cada ponta da tira de vazão: 1 mm, para a régua ter borda.
    private static let rasterThroughputRuleDots = rasterDotsPerMillimetre

    /// Instrução da tira de vazão. ASCII e sem código técnico, como as outras, e sem dizer quanto
    /// a tira deveria medir. Espelha o Android byte a byte.
    public static let rasterThroughputInstructions = """
        Meca a altura do bloco, do traco
        de cima ao traco de baixo.

        """

    /**
     A tira que mede vazão: largura cheia, altura conhecida, trama de meio tom.

     **O que ela mede.** A firmware da T210 descarta linhas inteiras quando os bytes chegam mais
     rápido do que a cabeça imprime, e a imagem sai coerente, só menor. Nada no enlace denuncia
     isso: o ACK do ATT prova recepção no rádio, não papel. O único instrumento honesto é uma altura
     declarada saindo do outro lado para ser medida com régua.

     **Por que não é preto sólido.** Os bytes na linha são os mesmos com qualquer padrão — raster
     `GS v 0` não comprime —, então o preto cheio não acrescentaria um byte à medição e cobraria a
     cabeça inteira de uma vez. Cabeça castigada aciona proteção térmica, que também encurta a saída
     e por outro motivo: a medida sairia contaminada por um segundo fenômeno. O xadrez de um dot dá
     exatamente 50% de cobertura, nunca dispara dois elementos vizinhos na mesma linha e é o que um
     meio-tom de foto vira no papel.

     **Os dois traços cheios** de 1 mm nas pontas existem para a régua ter borda: uma trama a 50%
     some contra o papel na primeira e na última linha. Se o descarte comer parte de um traço, o
     erro cabe no ±1 mm que a margem de segurança já cobre.

     As faixas saem com a altura de `EscPosRasterEmitter.stripeHeightDots`, a mesma de toda foto de
     venda. Sem alinhamento e sem decoração — é instrumento de medida.
     */
    public static func rasterThroughput(printableDots: Int) -> Data? {
        guard printableDots >= 8, printableDots % 8 == 0 else { return nil }
        let widthBytes = printableDots / 8
        var data = EscPos.initialize()
        data.append(text("SONDA DE VAZAO\n", alignment: 1, bold: true))
        data.append(text(rasterThroughputInstructions, alignment: 0))
        var startY = 0
        while startY < rasterThroughputStripDots {
            let stripeHeight = min(
                EscPosRasterEmitter.stripeHeightDots,
                rasterThroughputStripDots - startY
            )
            var packed = [UInt8](repeating: 0, count: widthBytes * stripeHeight)
            for row in 0..<stripeHeight {
                let value = rasterThroughputRowByte(startY + row)
                for byte in 0..<widthBytes { packed[row * widthBytes + byte] = value }
            }
            data.append(contentsOf: [0x1d, 0x76, 0x30, 0x00])
            data.append(contentsOf: [
                UInt8(widthBytes & 0xff), UInt8(widthBytes >> 8 & 0xff),
                UInt8(stripeHeight & 0xff), UInt8(stripeHeight >> 8 & 0xff),
            ])
            data.append(contentsOf: packed)
            packed.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
            startY += stripeHeight
        }
        data.append(EscPos.advance(lines: probeTearFeedLines))
        return data
    }

    /// Traço cheio nas duas pontas; xadrez de um dot no meio, alternando a fase por linha.
    ///
    /// Deixou de ser `private` em 04/09/2026: a régua tem de medir a **mesma** coisa nas duas
    /// famílias para os fatores serem comparáveis, e a série Procomp monta a trama daqui.
    static func rasterThroughputRowByte(_ y: Int) -> UInt8 {
        if y < rasterThroughputRuleDots || y >= rasterThroughputStripDots - rasterThroughputRuleDots {
            return 0xff
        }
        return y.isMultiple(of: 2) ? 0xaa : 0x55
    }

    /**
     O conteúdo dos dois códigos da sonda, e a palavra que a tira ensina a procurar.

     **Não é dado sensível, e essa é a exigência de projeto.** O caso de falha desta sonda é o
     payload sair impresso como texto legível — é exatamente isso que a pergunta distingue —, então
     aqui não entra assinatura, identificador de perfil, endereço, URL nem nada real.

     **É a mesma palavra nos dois blocos, e é a mesma que o rodapé cita.** Quem lê o papel não
     precisa julgar "isso é um código?": precisa reconhecer uma palavra que a própria tira acabou de
     ensinar. Os blocos já se distinguem pelos rótulos `1)` e `2)`.

     **Cinco caracteres, e o número tem conta.** No Code 128 um conteúdo de `n` caracteres ocupa
     `11n + 35` módulos, mais as duas zonas de silêncio de 10 módulos que a norma exige: `SONDA` dá
     `90 + 20 = 110`. Na geometria mais estreita que este kit homologa — 256 pontos — isso cabe com
     a largura de módulo mínima confiável, 2 pontos: `220 <= 256`. Um conteúdo mais comprido não
     caberia lá, e "não coube" sairia truncado, indistinguível de "a firmware não entendeu", que é a
     única coisa que esta tira existe para medir. Espelha o Android.
     */
    public static let nativeCodePayload = "SONDA"

    /**
     Correção de erro do QR da sonda, a mesma que o layout pede ao comando nativo no cupom.

     A tira mede se a firmware desenha, e tem de medir o comando que o app vai mesmo mandar: outro
     nível aqui produziria um símbolo de outro tamanho e mediria um `GS ( k` que ninguém emite. É Q
     porque o gerador deste lado é fixo em Q — a divergência de nível entre as plataformas é dívida
     antiga de QR, e esta sonda a herda em vez de escondê-la.
     */
    private static let nativeCodeQRErrorCorrection = 3

    /// Instrução da tira de código nativo. ASCII e sem código técnico, como as outras.
    ///
    /// A pergunta que a tela faz é "saiu um código ou saíram letras?", e o papel precisa preparar
    /// essa leitura sem usar vocabulário nosso: nada de `GS ( k`, nada de "nativo" antes da hora.
    public static let nativeCodeInstructions = """
        Duas figuras saem abaixo. Diga o
        que voce viu em cada uma.


        """

    /// O rodapé, que nomeia o defeito antes de ele acontecer.
    ///
    /// Sem ele, "saiu um código?" pede um julgamento estético de quem talvez nunca tenha visto um
    /// QR de perto. Com ele, a pergunta vira reconhecimento: ou saiu figura, ou saiu a palavra que
    /// está escrita aqui. "Não saiu nada" vai junto de "saiu texto" porque as duas significam a
    /// mesma coisa para o perfil — o comando não produziu código.
    public static let nativeCodeFooter = """

        Se no lugar da figura sair a
        palavra \(nativeCodePayload) em letras, ou nao
        sair nada, a impressora nao
        entende o comando.

        """

    /**
     A tira que mede se a firmware honra `GS ( k` e `GS k`.

     **O que ela mede, e o que não mede.** Ela mede se a firmware **desenha**. Não mede
     legibilidade: ninguém lê o código com câmera, o app não pede câmera e não vai pedir.

     **Dois blocos, dois comandos, duas respostas.** `GS ( k` e `GS k` são comandos de gerações
     diferentes e nada obriga uma firmware a atender os dois; medir junto e gravar um número só
     seria decidir por medição que não existe.

     **HRI desligada.** Com a legenda ligada, um código de barras correto sai com letras embaixo — e
     a pergunta é justamente "saiu figura ou saíram letras". A legenda destruiria a única coisa que
     a sonda mede.

     **As larguras são medidas, não escolhidas.** A largura de módulo sai da área imprimível pela
     mesma régua do cupom: é essa dependência que põe este passo depois da geometria. Um símbolo
     mais largo que o papel sairia truncado, e truncamento é indistinguível de "a firmware não
     entendeu".

     **Nada aqui grava memória não volátil.** É `GS k` e `GS ( k`, não `GS ( E` nem `FS q`. E
     `ESC @` sai uma vez só, no começo: o nativo é estado, e estado deixado ligado desalinharia a
     tira seguinte — por isso os dois emissores devolvem o alinhamento à esquerda no fim.
     */
    public static func nativeCode(printableDots: Int) -> Data? {
        guard printableDots > 0, printableDots % 8 == 0,
              let moduleWidthDots = ThermalBarcode.moduleWidthDots(
                  nativeCodePayload,
                  symbology: .code128,
                  printableDots: printableDots
              ),
              let qrModuleSide = EscPos.qrModuleSide(payload: nativeCodePayload),
              let qr = EscPos.qrNative(
                  payload: nativeCodePayload,
                  moduleSizeDots: nativeQRModuleSizeDots(
                      printableDots: printableDots,
                      moduleSide: qrModuleSide
                  ),
                  errorCorrection: nativeCodeQRErrorCorrection
              ),
              let barcode = EscPos.barcodeNative(
                  value: nativeCodePayload,
                  symbology: .code128,
                  moduleWidthDots: moduleWidthDots,
                  heightDots: ThermalBarcode.defaultHeightDots,
                  // A legenda sairia como letras embaixo de um código correto, e a pergunta desta
                  // sonda é exatamente "saiu figura ou saíram letras".
                  humanReadable: false
              )
        else { return nil }
        var data = EscPos.initialize()
        data.append(text("SONDA DE CODIGO NATIVO\n", alignment: 1, bold: true))
        data.append(text(nativeCodeInstructions, alignment: 0))
        data.append(text("1)\n", alignment: 0, bold: true))
        data.append(qr)
        data.append(Data([0x0a]))
        data.append(text("2)\n", alignment: 0, bold: true))
        data.append(barcode)
        data.append(Data([0x0a]))
        data.append(text(nativeCodeFooter, alignment: 0))
        data.append(EscPos.advance(lines: probeTearFeedLines))
        return data
    }

    /// Tamanho de módulo do QR da sonda: a área dividida pelos módulos, como no cupom.
    ///
    /// O teto é o mesmo 320 pontos que `PrinterCapabilities.preferredQRWidthDots` já usa como
    /// largura preferida de QR. Sem ele, um símbolo de versão 1 em papel de 80 mm ocuparia oito
    /// centímetros de bobina para responder "sim" ou "não". A contagem de colunas não entra na conta
    /// porque a sonda recebe só a largura raster — e é a largura raster que decide se o símbolo cabe.
    private static func nativeQRModuleSizeDots(printableDots: Int, moduleSide: Int) -> Int {
        let total = moduleSide + 2 * ThermalBarcode.qrQuietZoneModules
        let area = min(printableDots, PrinterCapabilities.preferredQRWidthDots)
        return min(
            max(area / total, ThermalBarcode.qrNativeModuleSizeDotsRange.lowerBound),
            ThermalBarcode.qrNativeModuleSizeDotsRange.upperBound
        )
    }

    public static func geometry(paperWidth: PrinterPaperWidth) -> Data {
        var data = EscPos.initialize()
        data.append(text("REGUA TEXTUAL\n", alignment: 1, bold: true))
        data.append(text("A ultima linha inteira manda.\n", alignment: 0))
        // Uma barra por contagem de colunas, em vez de uma régua só na largura máxima.
        //
        // A régua única quebrava de linha em toda impressora mais estreita que o maior candidato —
        // visto na bancada com a GoldenSky 80 mm, cuja fonte dá 48 colunas contra os 64 do
        // candidato: a régua saiu em duas linhas e "ultima coluna inteira" ficou sem resposta
        // possível. Com uma barra por largura, quem não coube quebra à vista e o operador escolhe
        // a última que coube. O Android já media assim; a divergência é que era o defeito.
        for columns in 24...paperWidth.geometryProbeColumns {
            data.append(Data((textRuler(columns: columns) + "\n").utf8))
        }
        data.append(text("\nREGUAS RASTER\n", alignment: 1, bold: true))
        for dots in paperWidth.geometryProbeDots {
            data.append(text("\(dots) DOTS\n", alignment: 0, bold: true))
            data.append(rasterRuler(widthDots: dots))
            data.append(text("\n", alignment: 0))
        }
        data.append(EscPos.advance(lines: probeTearFeedLines))
        return data
    }

    /// Imprime as duas opções antes de pedir que a pessoa identifique a bobina no papel.
    ///
    /// Usa os mesmos gabaritos exatos da geometria. As antigas sequências de `-` e `=` eram apenas
    /// aproximações: a barra anunciada como 32 tinha 24 caracteres, e a de 48 tinha 40.
    public static func paperWidthRulers() -> Data {
        var data = EscPos.initialize()
        for paperWidth in [PrinterPaperWidth.mm58, .mm80] {
            data.append(Data("\(paperWidth.rawValue)mm\n".utf8))
            data.append(Data((textRuler(columns: paperWidth.defaultPrintableColumns) + "\n").utf8))
            data.append(Data("\(paperWidth.defaultPrintableDots) Dots\n".utf8))
            data.append(rasterRuler(widthDots: paperWidth.defaultPrintableDots))
            data.append(Data("\n\n".utf8))
        }
        data.append(EscPos.advance(lines: probeTearFeedLines))
        return data
    }

    public static func fullGeometry() -> Data {
        var data = EscPos.initialize()
        data.append(text("REGUA TEXTUAL 24 A 64\n", alignment: 1, bold: true))
        for columns in 24...64 { data.append(Data((textRuler(columns: columns) + "\n").utf8)) }
        data.append(text("\nREGUA RASTER 256 A 640 DOTS\n", alignment: 1, bold: true))
        for dots in stride(from: 256, through: 640, by: 32) {
            data.append(text("\(dots) DOTS\n", alignment: 0, bold: true))
            data.append(rasterRuler(widthDots: dots))
            data.append(text("\n", alignment: 0))
        }
        data.append(EscPos.advance(lines: probeTearFeedLines))
        return data
    }

    /// Uma tira, duas linhas com a mesma frase. A primeira usa bytes comuns às páginas DOS sem
    /// emitir `ESC t`, pois o endereço ainda será medido; a segunda usa UTF-8. Se nenhuma funcionar,
    /// a homologação registra a dobra ASCII conservadora. Quando há guilhotina sem avanço
    /// embutido, `cutFeedLines` precisa ser a medida obtida na etapa anterior.
    public static func textEncoding() -> Data {
        textEncoding(cutProtocol: .none, cutFeedLines: 0)
    }

    public static func textEncoding(cutProtocol: CutProtocol, cutFeedLines: Int) -> Data {
        var data = EscPos.initialize()
        data.append(text("CODIFICACAO DO TEXTO\n", alignment: 1, bold: true))
        data.append(text("Devem sair A-TIL C-CEDILHA O-TIL A-AGUDO E-CIRCUNFLEXO\n", alignment: 0))
        data.append(text("PAGINA: [", alignment: 0))
        data.append(textEncodingSingleByteSample)
        data.append(text("]\n", alignment: 0))
        data.append(
            EscPos.text(
                "UTF-8: \(textEncodingSample)\n",
                alignment: 0,
                bold: false,
                size: 0,
                codePage: nil,
                textEncoding: .utf8
            )
        )
        // Esta tira decide **página ou UTF-8**, e só. Que ela não diga qual página é limitação
        // conhecida — os bytes daqui (82 87 A3 88) valem igual em CP437, CP850, CP858 e CP860, de
        // propósito, para a linha funcionar seja qual for a página que a firmware ligou. Explicar
        // isso no papel foi tentado em 2026-08-12 e piorou: três linhas de ressalva no meio de uma
        // sonda confundem mais que a ambiguidade que elas removem. Quem precisa da ressalva é quem
        // está lendo a tela, e é lá que ela deve estar.
        data.append(probeEnding(cutProtocol: cutProtocol, cutFeedLines: cutFeedLines))
        return data
    }

    public static func codePage() -> Data {
        codePage(cutProtocol: .none, cutFeedLines: 0)
    }

    /// A página ainda é desconhecida, mas o avanço já foi medido e entrega esta tira sem palpite.
    public static func codePage(cutProtocol: CutProtocol, cutFeedLines: Int) -> Data {
        // `ESC @` volta a impressora para a página que ela liga sozinha. É o que torna a primeira
        // linha honesta: nenhum `ESC t` foi emitido antes dela nesta tira.
        var data = EscPos.initialize()
        data.append(text(codePageInstructions, alignment: 0))
        for candidate in codePageCandidates {
            data.append(codePageRow(candidate))
        }
        data.append(probeEnding(cutProtocol: cutProtocol, cutFeedLines: cutFeedLines))
        return data
    }

    /// Uma linha da tira, montada pelo **mesmo encoder da venda**.
    ///
    /// Não há bytes crus aqui de propósito: a linha é literalmente o que sairia numa comanda com o
    /// perfil daquela candidata. Se a linha saiu legível no papel, a venda sai legível — e a
    /// pessoa não precisa acreditar em nenhuma tradução nossa entre a sonda e o uso.
    static func codePageRow(_ candidate: CodePageProbeCandidate) -> Data {
        EscPos.text(
            "\(candidate.letter)) \(codePageSample)\n",
            alignment: 0,
            bold: false,
            size: 0,
            codePage: candidate.codePage,
            // O seletor só acompanha quem seleciona: as demais linhas não podem emitir `ESC t`, e
            // o encoder recusa a combinação em vez de deixar passar.
            codePageSelector: candidate.textEncoding == .singleByteCodePage ? candidate.selector : nil,
            textEncoding: candidate.textEncoding
        )
    }

    /// Quantas linhas de papel a tira de página ocupa nesta impressora.
    ///
    /// A frase não cabe em 32 colunas: cada candidata gasta duas linhas em 58 mm e uma em 80 mm. A
    /// tela precisa anunciar o número desta impressora, não a contagem de candidatas — foi por
    /// isso que "26 linhas" deixou de ser verdade quando a frase entrou.
    public static func codePageProbeLineCount(printableColumns: Int) -> Int {
        precondition(printableColumns > 0, "Largura textual inválida para contar a tira.")
        func wrapped(_ line: String) -> Int {
            line.isEmpty ? 1 : (line.count + printableColumns - 1) / printableColumns
        }
        // O último `\n` termina a linha anterior em vez de abrir outra; o `\n\n` do fim é que deixa
        // a linha em branco antes da lista, e ela ocupa papel como qualquer outra.
        let instructions = codePageInstructions.components(separatedBy: "\n").dropLast().map(wrapped).reduce(0, +)
        let rows = codePageCandidates.map { wrapped("\($0.letter)) \(codePageSample)") }.reduce(0, +)
        return instructions + rows
    }

    /// Um comando de corte sozinho, com o payload terminando nele.
    ///
    /// A tira única de `cutProtocol()` não distingue firmware que ignora o parcial de aba que
    /// rasgou no manuseio: os seis blocos saem juntos e tudo que é impresso depois de um parcial
    /// empurra a tira presa. Aqui não há nada depois do corte, então o papel responde só pela
    /// guilhotina.
    /// **O papel mostra o número, não o dialeto.** `GS V 1` é vocabulário nosso; quem está com as
    /// tiras na mão compara "corte 1, corte 2" e escolhe. O nome do comando aparece no comprovante
    /// final, onde serve ao catálogo.
    public static func isolatedCut(_ cutProtocol: CutProtocol) -> Data? {
        guard cutProtocol.hasCutter else { return nil }
        let number = (cutProtocolCandidates.firstIndex { $0.cutProtocol == cutProtocol } ?? 0) + 1
        var data = EscPos.initialize()
        data.append(text("CORTE \(number)\n", alignment: 0, bold: true))
        // O avanço tira o rótulo de baixo da lâmina; o corte é a última coisa do payload.
        if !cutProtocol.hasEmbeddedFeed {
            data.append(EscPos.advance(lines: probeTearFeedLines))
        }
        data.append(cutProtocol.command)
        return data
    }

    public static func cutProtocol() -> Data {
        var data = EscPos.initialize()
        data.append(text("SONDA DE CORTE\n", alignment: 1, bold: true))
        data.append(text(cutProbeInstructions, alignment: 0))
        for (index, candidate) in cutProtocolCandidates.enumerated() {
            data.append(text("\(index + 1)  \(candidate.cutProtocol.label)\n", alignment: 0, bold: true))
            data.append(EscPos.advance(lines: 4))
            data.append(candidate.commandBytes)
            // Nada de avanço depois do corte: o rótulo do bloco seguinte já começa em linha nova, e
            // cada linha a mais empurra a tira pendurada pela aba do corte parcial. A aba é a única
            // prova de que o comando parcial foi obedecido.
        }
        data.append(text("\nFIM. Rolo inteiro = Nenhum.\n", alignment: 1))
        data.append(EscPos.advance(lines: probeTearFeedLines))
        return data
    }

    public static func cutFeed(cutProtocol: CutProtocol) -> Data? {
        guard cutProtocol.hasCutter, !cutProtocol.hasEmbeddedFeed else { return nil }
        var data = EscPos.initialize()
        for lines in cutFeedCandidates {
            data.append(cutFeedBlock(cutProtocol: cutProtocol, lines: lines))
        }
        return data
    }

    /// Uma tira isolada da régua. A homologação usa a régua inteira — nenhum avanço chega
    /// pré-escolhido —, e este acessório existe para reimprimir um único valor na bancada.
    public static func cutFeed(cutProtocol: CutProtocol, lines: Int) -> Data? {
        guard cutProtocol.hasCutter, !cutProtocol.hasEmbeddedFeed,
              cutFeedCandidates.contains(lines)
        else { return nil }
        var data = EscPos.initialize()
        data.append(cutFeedBlock(cutProtocol: cutProtocol, lines: lines))
        return data
    }

    private static func cutFeedBlock(cutProtocol: CutProtocol, lines: Int) -> Data {
        var data = Data()
        // O número vai em tamanho normal, emoldurado. `GS !` era o que dobrava a altura, e a
        // MP-4200 TH não implementa esse comando: ela engole só o `GS` e imprime o `!` como texto.
        data.append(text(">>> \(lines) <<<\n", alignment: 0, bold: true))
        data.append(text("AVANCO \(lines)\n", alignment: 0))
        data.append(text(">>> \(lines) <<<\n", alignment: 0, bold: true))
        data.append(text("LINHA DE REFERENCIA \(lines)\n", alignment: 0, bold: true))
        // Há exatamente uma fonte de avanço: a régua numerada anda como as mesmas quebras em
        // branco e deixa visível se a lâmina alcançou texto.
        data.append(text(feedRuler(lines: lines), alignment: 0))
        data.append(cutProtocol.command)
        return data
    }

    static let finalReceiptQR = "THERMAL-PRINTER-KIT-HOMOLOGATION"

    /// A linha que diz se o **modo** do corte sai como o comando pede. Termina em quebra de linha.
    ///
    /// **Por que ela é separada da linha `Corte:`.** Aquela diz qual comando a firmware atende;
    /// esta diz se o papel sai do jeito que o comando promete. São coisas diferentes, e a bancada
    /// mediu a diferença em 10/08: a GoldenSky 80 mm obedeceu aos sete comandos e cortou **sempre
    /// parcial**, inclusive nos que pedem total. Comando atendido, modo não. É `cutModeHonored` que
    /// impede `withCutMode` de prometer papel solto que nunca vem, e até 20/08 nada disso aparecia
    /// no papel — quem transcreve o comprovante para um cadastro um mês depois não tinha como saber
    /// que aquela impressora não escolhe modo.
    ///
    /// **Sem guilhotina o campo existe e não tem sentido**, e é isso que a terceira redação diz. O
    /// perfil guarda `true` por padrão mesmo em `.none`, e imprimir "sai como pedido" ali seria
    /// afirmar sobre um corte que não acontece. A linha continua saindo porque o comprovante virou
    /// fonte de transcrição: campo que some da folha vira campo esquecido no cadastro.
    ///
    /// O Android emite esta mesma linha em `PrinterHomologationProbes.cutModeLine`.
    public static func cutModeLine(cutProtocol: CutProtocol, cutModeHonored: Bool) -> String {
        let state: String
        if cutProtocol == .none {
            state = "sem guilhotina"
        } else {
            state = cutModeHonored ? "sai como pedido" : "sai diferente"
        }
        return "\(cutModeLabel): \(state)\n"
    }

    /// "Modo do corte", e não "Corte": o rótulo precisa não colidir com a linha do dialeto, que
    /// está logo acima e começa com a mesma palavra.
    private static let cutModeLabel = "Modo do corte"

    /// A linha da sonda de vazão nos comprovantes: o que a régua leu, contra o que a tira mede, e o
    /// fator que essa leitura gravou. Termina em quebra de linha, como as vizinhas.
    ///
    /// **Por que ela existe.** `verticalRasterScale` muda os bytes de toda imagem daquela
    /// impressora, e até 20/08 nenhum papel dizia isso. O comprovante documentava colunas, dots,
    /// página e corte — e não a única medição que alterou o comportamento da máquina. Quem pegasse
    /// a bobina um mês depois não tinha como saber que aquela impressora imprime compensada, nem
    /// por quê. É o mesmo motivo pelo qual a letra da página está no comprovante: capacidade que
    /// muda a saída precisa estar escrita no papel que a certifica.
    ///
    /// **O milímetro é reconstruído do fator, e não guardado à parte.** A máquina grava exatamente
    /// `lido / `\ ``rasterThroughputStripMillimetres``, então `fator × 48` devolve o número que a
    /// pessoa respondeu — em `Double`, e arredondado, porque a resposta era inteira. Um campo novo
    /// só para o milímetro custaria versão de store, chave de `Codable` e migração nas duas
    /// plataformas para carregar um número que o fator já carrega. O único caso em que a conta mente
    /// é a leitura abaixo do piso do campo — 24 mm de 48 —, onde a máquina já apagou o excedente
    /// antes de qualquer gravação; ali o comprovante relata o fator que a impressora vai mesmo usar,
    /// que é o que interessa a quem lê o papel depois.
    ///
    /// **Sem fator a linha continua saindo, e não há milímetro a relatar.** "Usar padrão" e tira na
    /// medida gravam `nil`, indistinguível de nunca ter medido — e `nil` não guarda leitura nenhuma
    /// para citar. O que não pode acontecer é a linha sumir: ausência de informação no papel é
    /// exatamente a lacuna que ela existe para fechar.
    ///
    /// **Cabe em 32 colunas** nos dois casos — 28 e 22 caracteres —, que é a largura da 58 mm. O
    /// milímetro tem sempre dois dígitos porque o piso do campo é 0,5, ou seja, 24 mm.
    ///
    /// O Android emite esta mesma linha em `PrinterHomologationProbes.verticalRasterScaleLine`, e
    /// as duas suítes fixam os mesmos literais.
    public static func verticalRasterScaleLine(_ verticalRasterScale: Double?) -> String {
        guard let factor = verticalRasterScale else {
            return "\(verticalRasterScaleLabel): sem compensação\n"
        }
        let readMm = Int((factor * Double(rasterThroughputStripMillimetres)).rounded())
        return "\(verticalRasterScaleLabel): \(readMm)/\(rasterThroughputStripMillimetres) mm"
            + " | fator \(twoDecimals(factor))\n"
    }

    /// A linha que diz como esta impressora aceita configuração de rede, e **de onde isso veio**.
    /// Termina em quebra de linha, como as vizinhas.
    ///
    /// **Por que ela existe.** `AGENTS.md` obriga: o comprovante final é certidão transcrita para
    /// cadastro, e por isso lista toda capacidade medida. Esta custou uma tira de papel própria, e
    /// sem ela quem pegar a bobina um mês depois não tem como saber que a pergunta já foi
    /// respondida — e vai gastar a tira de novo.
    ///
    /// **As quatro redações separam medido de declarado**, que é a razão de o campo existir. "Não
    /// determinado" é o perfil que nunca viu a tela de rede, indistinguível de um perfil anterior ao
    /// campo; "escolha manual" é a família que nenhuma tira confirma, e dizer "medido" ali seria
    /// escrever no papel uma medição que não houve.
    ///
    /// **A linha continua saindo quando o valor é ausente**, como as duas de cima: a ausência é a
    /// informação, e campo que some da folha vira campo esquecido no cadastro.
    ///
    /// **As quatro redações têm 32 caracteres exatos**, que é a largura da 58 mm — a mais estreita
    /// que este kit suporta. Não é coincidência: `medida, recusada` estourava por um caractere e
    /// `layout.wrap` a partiria em duas linhas, deslocando tudo o que vem depois no papel que serve
    /// de fonte de transcrição. A suíte fixa o comprimento junto com o texto, para a próxima
    /// palavra escolhida aqui não caber "quase".
    ///
    /// Nenhuma nomeia marca, modelo ou byte: o papel vai para quem cadastra, não para quem leu a
    /// reversão.
    ///
    /// O Android emite esta mesma linha em `PrinterHomologationProbes.wifiConfigurationFamilyLine`,
    /// e as duas suítes fixam os mesmos literais.
    public static func wifiConfigurationFamilyLine(
        _ family: PrinterWifiConfigurationFamily?
    ) -> String {
        let state: String
        switch family {
        case nil: state = "não determinada"
        // Passado nos dois desfechos medidos, e o mesmo tempo verbal: o papel relata o que a
        // impressora fez com a tira, e dois tempos diferentes sugeririam duas naturezas de medição.
        case .measuredUsWHonored: state = "medida, aceitou"
        case .measuredUsWAbsent: state = "medida, recusou"
        case .chosenUsEscUs: state = "escolhida à mão"
        }
        return "\(wifiConfigurationFamilyLabel): \(state)\n"
    }

    /// "Config. de rede", e não "Rede": o comprovante já tem `Conexão:`, que é por onde os cupons
    /// saem, e as duas linhas ficam a três de distância. Rótulo que se confunde com o vizinho vira
    /// campo transcrito no lugar errado.
    private static let wifiConfigurationFamilyLabel = "Config. de rede"

    /// O rótulo é o nome da tira — "SONDA DE VAZAO" —, e não o do que ela conclui hoje.
    ///
    /// Quem confere uma pilha de comprovantes contra uma pilha de tiras precisa achar o par pelo
    /// nome, do mesmo jeito que a letra da página liga o comprovante à linha respondida. "Vazão"
    /// deixou de ser a conclusão em 20/08, mas continua sendo o que está impresso na tira que gerou
    /// este número.
    private static let verticalRasterScaleLabel = "Vazão"

    /**
     A linha do `GS ( k` nos comprovantes. Termina em quebra de linha, como as vizinhas.

     **Duas linhas, e não uma com dois valores.** São duas capacidades, medidas por dois comandos
     diferentes; uma linha só daria nove combinações num literal, e o comprovante é certidão para
     transcrever num cadastro.

     **Linha nenhuma some quando o valor é ausente.** `não medido` é a terceira redação, como
     `sem guilhotina` é a terceira do ``cutModeLine(cutProtocol:cutModeHonored:)``: o perfil anterior
     à sonda existe, e o papel precisa dizer que ali não houve medição em vez de calar.

     **A voz descreve o papel, não a flag** — `sai como código` / `sai como texto`.

     **Cabe em 32 colunas** nos três casos: 26, 25 e 20 caracteres aqui; 31, 30 e 26 na irmã.

     O Android emite estas mesmas linhas em `PrinterHomologationProbes.nativeQrLine` e
     `nativeBarcodeLine`, e as duas suítes fixam os mesmos literais.
     */
    public static func nativeQRLine(_ honored: Bool?) -> String {
        "\(nativeQRLabel): \(nativeCodeState(honored))\n"
    }

    /// A mesma linha para o `GS k`. Ver ``nativeQRLine(_:)``.
    public static func nativeBarcodeLine(_ honored: Bool?) -> String {
        "\(nativeBarcodeLabel): \(nativeCodeState(honored))\n"
    }

    private static func nativeCodeState(_ honored: Bool?) -> String {
        guard let honored else { return "não medido" }
        return honored ? "sai como código" : "sai como texto"
    }

    private static let nativeQRLabel = "QR nativo"
    private static let nativeBarcodeLabel = "Barras nativas"

    /// Duas casas com vírgula, em aritmética inteira e sem `Locale`.
    ///
    /// Um `NumberFormatter` traria a vírgula ou o ponto conforme o aparelho, e o papel de um celular
    /// em inglês deixaria de ser comparável ao de outro. Centésimos inteiros também garantem que o
    /// Android escreva o mesmo texto para o mesmo fator, que é o contrato desta linha.
    private static func twoDecimals(_ value: Double) -> String {
        let hundredths = Int((value * 100).rounded())
        let cents = hundredths % 100
        return "\(hundredths / 100)," + (cents < 10 ? "0\(cents)" : "\(cents)")
    }

    /// Data e hora do aparelho, sem segundos: serve para identificar a tira, não para auditar.
    static func localTimestamp(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "dd/MM/yyyy HH:mm"
        return formatter.string(from: date)
    }

    /// - Parameter decoration: cabeçalho e rodapé do hospedeiro. O comprovante final é o único
    ///   papel desta série que os recebe — ele não mede nada, é o recibo da instalação. As tiras
    ///   acima não têm parâmetro para isso, e essa ausência é a isenção. Ver ``ReceiptDecoration``.
    public static func finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity? = nil,
        transport: PrinterTransport? = nil,
        decoration: (any ReceiptDecoration)? = nil
    ) -> Data {
        var data = EscPos.initialize()
        // Ao contrário das sondas, que são ASCII para não depender do que ainda estão medindo, o
        // comprovante **relata** a medição: os rótulos saem na página medida, e a linha de acentos
        // logo abaixo é a prova de que ela funciona. Sem página, o modelo decide UTF-8 ou ASCII.
        // **Toda linha passa pela quebra do perfil.** Medido no papel da T210 em 12/08, já com 58 mm
        // e 32 colunas certos: "Codificação: Padrão da impressora" tem 33 caracteres, a firmware
        // quebrou na coluna exata e saiu "impressor / a". Palavra partida é a assinatura que a tela
        // ensina a procurar para largura errada, então um rótulo comprido virava alarme falso
        // justamente no papel que prova a medição certa.
        let layout = ReceiptLayout(profile: PrinterProfile(profile), decoration: decoration)
        if let cabecalho = decoration?.header(layout: layout) { data.append(cabecalho) }
        func measured(_ value: String, alignment: UInt8, bold: Bool = false) -> Data {
            EscPos.text(
                layout.wrap(value),
                alignment: alignment,
                bold: bold,
                size: 0,
                codePage: profile.codePage,
                codePageSelector: profile.codePageSelector,
                textEncoding: profile.textEncoding
            )
        }
        // **Sem maiúscula acentuada em lugar nenhum deste comprovante.** A tira mede só minúsculas
        // — `cão, ações, avô` —, então a metade alta da tabela onde moram `Ç Í Ã Á` nunca foi
        // medida. Medido no papel da T210 em 12/08, quando o título ainda era "homologação": em
        // caixa alta e com a página aprovada por ela, saiu "HOMOLOGACÃO CONCLUrDA". Caixa alta era
        // só estilo; legibilidade não é, e `Instalação` tem o mesmo `ç ã` no lugar errado.
        data.append(measured("Instalação concluída\n", alignment: 1, bold: true))
        data.append(measured("\(profile.displayName)\n\n", alignment: 1))
        data.append(measured("Papel: \(profile.paperWidthMm) mm\n", alignment: 0))
        data.append(measured("Colunas: \(profile.printableColumns)\n", alignment: 0))
        data.append(measured("Dots: \(profile.printableDots)\n", alignment: 0))
        if let transport { data.append(measured("Conexão: \(transport.label)\n", alignment: 0)) }
        // A letra é como a escolha foi feita: quem estava com a tira na mão respondeu `d`, não
        // "CP850". E em `Nenhuma` o código não distingue a linha `a`, que é ASCII, da `c`, que é
        // UTF-8.
        let pageLetter = codePageLetter(
            textEncoding: profile.textEncoding,
            codePage: profile.codePage,
            codePageSelector: profile.codePageSelector
        )
        let pageSuffix = pageLetter.map { " (letra \($0))" } ?? ""
        data.append(
            measured("Página: \(profile.codePage?.label ?? "Nenhuma")\(pageSuffix)\n", alignment: 0)
        )
        data.append(measured("Codificação: \(profile.textEncoding.receiptLabel)\n", alignment: 0))
        data.append(measured("Corte: \(profile.cutProtocol.label)\n", alignment: 0))
        data.append(measured("Avanço: \(profile.cutFeedLines)\n", alignment: 0))
        // Colada nas linhas do dialeto e do avanço porque é a outra metade da mesma medição: qual
        // comando a firmware atende, e se o modo dele sai no papel.
        data.append(
            measured(
                cutModeLine(cutProtocol: profile.cutProtocol, cutModeHonored: profile.cutModeHonored),
                alignment: 0
            )
        )
        // A régua da sonda entra aqui, junto das outras capacidades medidas e antes do carimbo de
        // data: é uma delas, e a única que mudou o comportamento da impressora sem aparecer no
        // papel até 20/08. Mesma posição relativa no Android.
        data.append(measured(verticalRasterScaleLine(profile.verticalRasterScale), alignment: 0))
        // As duas capacidades da sonda de código nativo entram logo depois, e antes do carimbo de
        // data, pelo mesmo motivo: são capacidade medida, e o comprovante lista toda capacidade
        // medida. Mesma posição relativa no Android.
        data.append(measured(nativeQRLine(profile.nativeQrHonored), alignment: 0))
        data.append(measured(nativeBarcodeLine(profile.nativeBarcodeHonored), alignment: 0))
        // A família de configuração de rede fecha o bloco das capacidades medidas, logo antes do
        // carimbo de data: é a única que não sai da série de tiras da homologação, e por isso a
        // última — quem lê o papel de cima para baixo encontra primeiro o que esta bobina mediu.
        // Mesma posição relativa no Android.
        data.append(
            measured(wifiConfigurationFamilyLine(profile.wifiConfigurationFamily), alignment: 0)
        )
        // Com pilha de tira na mesa, o papel precisa dizer quando saiu: sem isso, duas medições da
        // mesma impressora em dias diferentes são indistinguíveis.
        data.append(measured("Medida em: \(localTimestamp(profile.measuredAt))\n\n", alignment: 0))
        if let identity {
            if let manufacturer = identity.manufacturer {
                data.append(text(layout.wrap("Fabricante: \(manufacturer)\n"), alignment: 0))
            }
            if let model = identity.model {
                data.append(text(layout.wrap("Modelo: \(model)\n"), alignment: 0))
            }
            if let firmware = identity.firmwareVersion {
                data.append(text(layout.wrap("Firmware: \(firmware)\n"), alignment: 0))
            }
        } else {
            data.append(measured("Identidade GS I: não respondeu\n", alignment: 0))
        }
        // Única linha do comprovante que sai na página medida, e com acento de verdade: as outras
        // são ASCII de propósito, mas se nenhuma exercitar a página, o comprovante final não prova
        // a medição que acabou de ser feita.
        data.append(
            EscPos.text(
                // A segunda linha é a amostra inteira, a mesma da tira: o comprovante prova
                // exatamente o que foi medido, maiúscula inclusive.
                layout.wrap("Acentos: ação, opção, São João\n\(codePageSample)") + "\n\n",
                alignment: 0,
                bold: false,
                size: 0,
                codePage: profile.codePage,
                // Sem o seletor medido, esta linha sai pelo `n` canônico e desmente o próprio
                // comprovante: medido na T210, que registrou CP860 no endereço 8 e imprimiu os
                // acentos errados aqui porque o comando saiu como `ESC t 3`.
                codePageSelector: profile.codePageSelector,
                textEncoding: profile.textEncoding
            )
        )
        // Quebrado nas colunas medidas, e não pela firmware: sem isto a impressora corta onde a
        // linha acaba, e o papel da P80 saiu com "este comprovan / te saiu correto".
        data.append(
            measured(
                ReceiptLayout(
                    columns: profile.printableColumns,
                    qrWidthDots: profile.capabilities.qrWidthDots,
                    hasCutter: profile.cutProtocol.hasCutter,
                    codePage: profile.codePage,
                    codePageSelector: profile.codePageSelector,
                    textEncoding: profile.textEncoding,
                    cutProtocol: profile.cutProtocol,
                    cutFeedLines: profile.cutFeedLines,
                    printableDots: profile.printableDots
                ).wrap("Confirme no aplicativo somente se este comprovante saiu correto.") + "\n",
                alignment: 1
            )
        )
        // O QR fecha o comprovante porque é a única peça que prova o caminho raster na largura
        // medida: texto sai em qualquer firmware, faixa `GS v 0` não. O Android já o imprimia, e a
        // ausência aqui só apareceu na bancada — com a GoldenSky terminando sem QR nenhum.
        if let qr = EscPos.qrRaster(
            payload: finalReceiptQR,
            widthDots: profile.capabilities.qrWidthDots,
            // O comprovante final é o primeiro papel que sai já compensado: se a régua desta
            // homologação achou fator, o QR aqui precisa sair **quadrado**. O Android já passava o
            // fator; aqui ele ficava de fora, e o papel que agora declara `fator 0,79` sairia
            // desmentindo a própria linha.
            verticalRasterScale: profile.verticalRasterScale
        ) {
            data.append(qr)
            data.append(Data([0x0a]))
        }
        // Fecha pelo layout medido, não por uma cópia local da mesma regra: é dentro de `finish()`
        // que o rodapé do hospedeiro entra, imediatamente antes da lâmina. Byte a byte é o mesmo
        // avanço e o mesmo corte que a cópia anterior emitia — ela derivava das mesmas
        // capacidades — e agora há um lugar só onde essa decisão mora.
        data.append(layout.finish())
        return data
    }

    /// Régua do avanço: uma linha numerada por linha de avanço pedida.
    ///
    /// Avança o mesmo que o mesmo número de quebras em branco e ainda deixa a medida legível. Sem
    /// ela o operador só via papel em branco depois da linha de referência e não tinha como
    /// comparar uma tira com a outra.
    static func feedRuler(lines: Int) -> String {
        guard lines > 0 else { return "" }
        return (1...lines).map { "\($0) ---- DESPERDICIO\n" }.joined()
    }

    /// Barra de largura exata, terminada pelo próprio número. Espelha o Android byte a byte.
    static func textRuler(columns: Int) -> String {
        let suffix = String(columns)
        guard columns > suffix.count + 2 else { return "" }
        return "|" + String(repeating: "-", count: columns - suffix.count - 2) + "|" + suffix
    }

    /// Altura da moldura da régua raster, em dotlines. As duas séries usam a mesma.
    static let rasterRulerHeightDots = 24

    /**
     Os pixels da moldura da régua, **sem envelope nenhum** — MSB primeiro, byte da esquerda para a
     direita.

     Separado do `GS v 0` em 04/09/2026 porque a série Procomp precisa exatamente destes pixels
     dentro de um `ESC n`. Duas cópias da mesma régua mediriam coisas diferentes com o mesmo nome, e
     o diff estaria no papel, onde ninguém o lê. O Kotlin já separava os dois; aqui o envelope estava
     colado nos pixels e era isso que impedia a segunda série de existir.
     */
    static func rasterRulerPixels(widthDots: Int) -> [UInt8] {
        guard widthDots >= 8, widthDots % 8 == 0 else { return [] }
        let height = rasterRulerHeightDots
        let widthBytes = widthDots / 8
        var pixels = [UInt8](repeating: 0, count: widthBytes * height)
        for y in 0..<height {
            if y == 0 || y == height - 1 {
                for byte in 0..<widthBytes { pixels[y * widthBytes + byte] = 0xff }
            } else {
                pixels[y * widthBytes] |= 0x80
                pixels[y * widthBytes + widthBytes - 1] |= 0x01
            }
        }
        return pixels
    }

    static func rasterRuler(widthDots: Int) -> Data {
        guard widthDots >= 8, widthDots % 8 == 0 else { return Data() }
        let height = rasterRulerHeightDots
        let widthBytes = widthDots / 8
        let pixels = rasterRulerPixels(widthDots: widthDots)
        var data = Data([0x1d, 0x76, 0x30, 0x00])
        data.append(contentsOf: [
            UInt8(widthBytes & 0xff), UInt8(widthBytes >> 8),
            UInt8(height & 0xff), UInt8(height >> 8),
        ])
        data.append(contentsOf: pixels)
        return data
    }

    private static func text(
        _ value: String,
        alignment: UInt8,
        bold: Bool = false,
        size: UInt8 = 0
    ) -> Data {
        // As instruções das sondas são ASCII para não depender justamente da capacidade medida.
        EscPos.text(value, alignment: alignment, bold: bold, size: size, codePage: nil)
    }

    private static func probeEnding(cutProtocol: CutProtocol, cutFeedLines: Int) -> Data {
        guard cutProtocol.hasCutter else {
            return EscPos.advance(lines: probeTearFeedLines)
        }
        if cutProtocol.hasEmbeddedFeed {
            return cutProtocol.command
        }
        precondition(
            cutFeedCandidates.contains(cutFeedLines),
            "A sonda só pode cortar depois de receber o avanço medido."
        )
        var data = EscPos.advance(lines: UInt8(cutFeedLines))
        data.append(cutProtocol.command)
        return data
    }
}
