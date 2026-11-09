import Foundation

/**
 A sequência de homologação no dialeto da Diebold Procomp — a família da IM453H.

 **Por que existe um segundo conjunto, e não uma tradução do primeiro.** ``PrinterProbePayloads``
 monta bytes crus, sem passar por ``ReceiptLayout``: são onze `ESC @` e um `GS v 0` escritos no
 código, e as sondas são todas ESC/POS. Não há por onde o dialeto entrar. Numa firmware que não tem
 **nenhum** comando `GS`, a régua raster do passo de geometria sai como dois metros de código e o
 aparelho para de responder — medido na IM453H em 24/08/2026, gastando a bobina de verdade.

 Este arquivo é o que fecha essa lacuna no lado Swift. Ele não traduz comando por comando: **reemite
 o mesmo instrumento por outro envelope.** A régua textual, a moldura da régua raster, a trama de
 meio tom e a régua de avanço vêm, byte a byte, das mesmas funções que a sequência ESC/POS usa — por
 isso ``PrinterProbePayloads/rasterRulerPixels(widthDots:)`` e
 ``PrinterProbePayloads/rasterThroughputRowByte(_:)`` deixaram de ser privadas lá em vez de nascerem
 de novo aqui. Duas cópias da mesma régua mediriam coisas diferentes com o mesmo nome, e o diff
 estaria no papel, onde ninguém o lê. É o mesmo argumento que fez o raster ter ``RasterEmission`` em
 vez de duas composições.

 **Só emite o que saiu em papel nesta impressora.** Cada byte daqui vem de ``ProcompEscP`` ou de
 ``ProcompRasterEmitter``, e os dois só carregam comando visto impresso na bancada de 23 e
 24/08/2026: atributos por `ESC E/F`, `ESC SO/DC4`, `ESC SI/DC2`, `ESC ]`; avanço por `LF`; corte por
 `ESC w`; raster por `ESC n` em bandas de 24 dotlines. Não há `ESC @`, porque `ESC @` não é comando
 desta firmware e sai como um `@` no papel — foi assim que se descobriu que o prólogo era nosso.

 ## Duas etapas da sequência ESC/POS **não** têm tira aqui, e a ausência é a medição

 * **Código nativo.** `ESC ( k` (QR) e `ESC | 0` (barras) existem no manual da linha e **nunca
   saíram em papel**. `ReceiptLayout.nativeCodeAllowed` responde `false` para este dialeto pelo mesmo
   motivo, e nesta impressora comando não medido não custa uma tira torta: custa o aparelho travado,
   com a tecla de avanço morta e recuperação só no desligar e ligar. A máquina pula a etapa e grava
   os dois campos **ausentes**, que é exatamente o que
   ``PrinterHomologationMachine/skipNativeCodeMeasurement()`` já significa: ninguém mediu.
 * **Página de código.** `procompText` codifica em ``ProcompCodeTable/abicomp``, a tabela de fábrica
   desta firmware, e **não consulta a página do perfil**. Uma tira de páginas aqui produziria uma
   resposta que o emissor descarta — papel gasto para decidir o que ninguém emite.

 ## O corte, que é o que fecha toda tira que corta

 `ESC w` e `ESC US` cortaram os dois na bancada, e os dois cortaram **parcial**: a guilhotina desta
 unidade está configurada "Somente Parcial". `procompFinish` escolhe `ESC w` — o corte simples,
 porque o `ESC US` embute avanço próprio, que brigaria com o avanço do perfil — e é ele que sai no
 comprovante final e no fim de todo cupom de venda.

 **Por isso a sonda de corte daqui não oferece escolha de comando.** A sequência ESC/POS manda seis
 dialetos porque a firmware escolhe qual atende; aqui os dois medidos cortam igual, e o emissor manda
 `ESC w` de qualquer jeito.

 Espelha `android/src/main/java/br/com/thermalprinterkit/ProcompHomologationProbes.kt`.
 */
public enum ProcompHomologationProbes {
    /**
     O aviso da tira de corte, sem a lista de blocos.

     O texto da sequência ESC/POS ensina a comparar seis blocos numerados e a anotar o número. Aqui
     há um bloco só, e mandar anotar número de bloco numa tira que tem um seria ensinar a procurar o
     que não existe.
     */
    public static let cutProbeInstructions = """
        Nao puxe a tira antes de ver o
        que ela fez.
        Cortou: a tira se separa (aqui o
        corte e parcial, entao ela fica
        presa por um pedaco no meio).
        Nao cortou: sai rolo inteiro.


        """

    /// `GS I` é comando `GS`, e este dialeto não recebe nenhum. A folha diz **não perguntada**, e
    /// não "não respondeu": "não respondeu" afirmaria uma pergunta que ninguém fez.
    public static let identityUnasked = "Identidade GS I: não perguntada"

    /**
     As duas réguas que abrem a medição, e a única tira que sai antes de qualquer largura escolhida.

     Mesma tira da sequência ESC/POS: 58 e 80 mm, cada uma com a régua textual e a moldura raster da
     geometria padrão daquela largura. O que muda é o envelope do raster — `ESC n` com margem zero no
     lugar do `GS v 0`.
     */
    public static func paperWidthRulers() -> PrinterProbe {
        var data = prologue()
        for paperWidth in [PrinterPaperWidth.mm58, .mm80] {
            data.append(ascii("\(paperWidth.rawValue)mm\n"))
            data.append(ascii(PrinterProbePayloads.textRuler(columns: paperWidth.defaultPrintableColumns) + "\n"))
            data.append(ascii("\(paperWidth.defaultPrintableDots) Dots\n"))
            data.append(rasterRuler(widthDots: paperWidth.defaultPrintableDots))
            data.append(ascii("\n"))
        }
        data.append(tearFeed())
        return probe(data)
    }

    /**
     A régua da largura escolhida: colunas de 24 ao teto daquela bobina, e as réguas raster dela.

     Espelha ``PrinterProbePayloads/geometry(paperWidth:)``, que é a tira que o lado Swift tem e o
     Kotlin não. As faixas acima da área imprimível saem truncadas de propósito: **é o truncamento
     que responde**.
     */
    public static func geometry(paperWidth: PrinterPaperWidth) -> PrinterProbe {
        var data = prologue()
        data.append(centeredBold("REGUA TEXTUAL\n"))
        data.append(text("A ultima linha inteira manda.\n"))
        for columns in 24...paperWidth.geometryProbeColumns {
            data.append(ascii(PrinterProbePayloads.textRuler(columns: columns) + "\n"))
        }
        data.append(centeredBold("\nREGUAS RASTER\n"))
        for dots in paperWidth.geometryProbeDots {
            data.append(ascii("\(dots) DOTS\n"))
            data.append(rasterRuler(widthDots: dots))
            data.append(ascii("\n"))
        }
        data.append(tearFeed())
        return probe(data)
    }

    /**
     A régua completa: 24 a 64 colunas e 256 a 640 dots.

     **É esta tira que resolve a pendência mais antiga desta impressora.** Os 576 dots do card são
     convenção de 80 mm, não medição — está escrito assim em `docs/diebold-im453h.md` desde 23/08 — e
     as 48 colunas foram confirmadas por uma régua de bancada que vive fora do produto. Aqui as duas
     passam pela mesma tira que toda outra impressora do kit atravessa.

     As faixas raster acima da área imprimível saem truncadas de propósito: **é o truncamento que
     responde**. A largura que a impressora tem é a última que sai com as quatro bordas fechadas.
     */
    public static func fullGeometry() -> PrinterProbe {
        var data = prologue()
        data.append(centeredBold("REGUA TEXTUAL 24 A 64\n"))
        for columns in 24...64 {
            data.append(ascii(PrinterProbePayloads.textRuler(columns: columns) + "\n"))
        }
        data.append(centeredBold("\nREGUA RASTER 256 A 640 DOTS\n"))
        for dots in stride(from: 256, through: 640, by: 32) {
            data.append(ascii("\(dots) DOTS\n"))
            data.append(rasterRuler(widthDots: dots))
            data.append(ascii("\n"))
        }
        data.append(tearFeed())
        return probe(data)
    }

    /**
     A tira que mede a compensação vertical: largura cheia, altura declarada, trama de meio tom.

     A trama, a altura de 384 dotlines e os dois traços de borda são os mesmos da sequência ESC/POS —
     ``PrinterProbePayloads/rasterThroughputRowByte(_:)`` e
     ``PrinterProbePayloads/rasterThroughputStripDots`` —, porque a régua tem de medir a mesma coisa
     nas duas famílias para os fatores serem comparáveis.

     **Nesta impressora ela tem alvo conhecido, e mesmo assim é medição.** A densidade de 23/08 deu
     ~8,4 dotlines/mm na vertical contra 8 na horizontal, o que apontava para um fator perto de 0,95
     — anotado e **nunca aplicado**, porque veio de contar dotline em foto e não de régua em papel.
     Em 26/08/2026 a tira saiu inteira em largura cheia de 80 mm, ~28 KB de raster, e mediu 47 mm de
     48: a densidade vertical é ~8,17 dotlines/mm, o perfil fica **sem compensação**, e o fator ~0,95
     nunca precisou existir.

     A leitura ficou a um milímetro do piso do "saiu inteira" (46,6 mm). Se um dia o QR desta
     impressora sair visivelmente mais alto que largo, remeça: 46 mm gravariam 0,96, e a diferença
     entre as duas leituras é a espessura do traço da régua.

     - Returns: `nil` quando a largura não é múltiplo de 8 — o mesmo contrato da sonda ESC/POS.
     */
    public static func rasterThroughput(printableDots: Int) -> PrinterProbe? {
        guard printableDots >= 8, printableDots % 8 == 0 else { return nil }
        let alturaDots = PrinterProbePayloads.rasterThroughputStripDots
        let larguraBytes = printableDots / 8
        var pixels = [UInt8](repeating: 0, count: larguraBytes * alturaDots)
        for y in 0..<alturaDots {
            let value = PrinterProbePayloads.rasterThroughputRowByte(y)
            for byte in 0..<larguraBytes { pixels[y * larguraBytes + byte] = value }
        }
        var data = prologue()
        data.append(centeredBold("SONDA DE VAZAO\n"))
        data.append(text(PrinterProbePayloads.rasterThroughputInstructions))
        guard let raster = raster(widthDots: printableDots, heightDots: alturaDots, packed: pixels)
        else { return nil }
        data.append(raster)
        data.append(tearFeed())
        return probe(data)
    }

    /**
     A tira do corte: o rótulo, o avanço que tira o rótulo de baixo da lâmina, e `ESC w`.

     **O comando é o mesmo que o cupom de venda usa**, e essa identidade é o ponto. Uma sonda que
     medisse um corte e o produto emitisse outro mediria a impressora errada — foi assim que o
     dialeto inteiro se perdeu em 23/08, com a sonda falando Procomp e o produto falando ESC/POS.

     Nada é impresso depois do corte, pelo mesmo motivo da tira isolada da sequência ESC/POS: um
     corte parcial deixa a tira pendurada pela aba, e qualquer linha depois dela a empurra até
     parecer corte total.
     */
    public static func isolatedCut() -> PrinterProbe {
        var data = prologue()
        data.append(boldLine("SONDA DE CORTE\n"))
        data.append(text(cutProbeInstructions))
        data.append(tearFeed())
        data.append(cutCommand())
        return probe(data)
    }

    /// Uma tira da régua de avanço, com o número que ela mede. Ver ``cutFeedStrips()``.
    public struct CutFeedStrip: Equatable, Sendable {
        public let feedLines: Int
        public let bytes: Data
    }

    /**
     A régua do avanço: uma tira por valor medido, cada uma terminando na lâmina.

     É a distância entre a cabeça e a guilhotina desta unidade, e ela é física — não sai de catálogo
     nem do avanço 4 que a configuração manual gravou em 24/08 sem medir. As linhas de desperdício
     vão numeradas e impressas: papel andado em branco não se conta depois, papel andado com número
     se conta.
     */
    public static func cutFeedStrips() -> [CutFeedStrip] {
        PrinterProbePayloads.cutFeedCandidates.map { feedLines in
            var data = prologue()
            data.append(centeredBold(">>> \(feedLines) <<<\n"))
            data.append(text("Escolha o menor avanco que nao cortar texto.\n"))
            data.append(centeredBold(">>> \(feedLines) <<<\n"))
            data.append(ascii("---- LINHA DE REFERENCIA ----\n"))
            data.append(ascii(PrinterProbePayloads.feedRuler(lines: feedLines)))
            data.append(cutCommand())
            return CutFeedStrip(feedLines: feedLines, bytes: data)
        }
    }

    /// As oito tiras num envio só, como a etapa de avanço pede.
    public static func cutFeed() -> PrinterProbe {
        var data = Data()
        for strip in cutFeedStrips() { data.append(strip.bytes) }
        return probe(data)
    }

    /**
     O comprovante final, e a **única** sonda desta série montada pelo ``ReceiptLayout``.

     As tiras acima medem, então elas emitem cru: um raster de hospedeiro no meio de uma régua
     desloca justamente o que ela mede. O comprovante não mede nada — é o recibo da instalação
     concluída —, e por isso ele sai **pelo mesmo caminho do cupom de venda**: o texto por
     `procompText` em ABICOMP, o QR pelo `ESC n` centralizado com a compensação que a régua acabou de
     medir, e o fecho por ``ReceiptLayout/finish()``, que no dialeto Procomp é `procompFinish` — o
     avanço medido e o `ESC w`.

     **É por isso que o corte deste papel prova o corte de toda venda.** Não há um segundo caminho
     que possa divergir: se este comprovante saiu cortado, o cupom de amanhã sai cortado pelos mesmos
     bytes.

     **A recusa por dialeto devolve `nil`, e não derruba o processo.** Todo byte daqui desce pelo
     `layout`, então um perfil ESC/POS produziria bytes ESC/POS **com o carimbo Procomp na sonda** —
     que é exatamente o carimbo que o portão do envio lê para deixar passar; a folha precisa recusar.
     Aqui esteve uma `precondition`, que continua ativa em release (só `-Ounchecked` a remove), numa
     função pública do caminho de impressão. Medido por mutação em 04/09/2026: trocando o dialeto
     que ``PrinterHomologationMachine/measuredProfile()`` passa, o processo de teste morria com
     signal 5 — "ProcompHomologationProbes.swift:265: Precondition failed" — antes de a asserção da
     prova rodar, e em produção seria o app do balcão fechando no lugar de uma tela de "tentar de
     novo". O Kotlin usa `require`, que lança; `nil` é o equivalente recuperável aqui, e quem o
     recebe é ``PrinterHomologationSession``, que já tem o estado `.finalReceiptFailed`.
     */
    public static func finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity? = nil,
        transport: PrinterTransport? = nil,
        decoration: (any ReceiptDecoration)? = nil
    ) -> PrinterProbe? {
        guard profile.dialect == .procompEscP else { return nil }
        let layout = ReceiptLayout(profile: PrinterProfile(profile), decoration: decoration)
        var data = EscPosDialectGate.prologue(for: layout.dialect)
        if let cabecalho = decoration?.header(layout: layout) { data.append(cabecalho) }
        data.append(layout.text("Instalação concluída\n", alignment: 1, bold: true))
        data.append(
            layout.text(
                layout.wrap(profileLines(profile: profile, identity: identity, transport: transport)) + "\n\n",
                alignment: 0
            )
        )
        if let qr = layout.qrRaster(payload: PrinterProbePayloads.finalReceiptQR) {
            data.append(qr)
            data.append(Data([0x0a]))
        }
        // O corte. Ver o cabeçalho desta função.
        data.append(layout.finish())
        return probe(data)
    }

    /**
     O corpo da certidão. Três linhas divergem da folha ESC/POS, e as três dizem a mesma coisa: **o
     campo existe no formato comum e não foi medido nesta impressora.**

     * **`Corte:`** não sai como `GS V 1`. O perfil guarda esse valor porque `hasCutter` exige um
       protocolo diferente de `.none` e o enum inteiro é ESC/POS — mas **nenhum byte `GS` chega a
       esta impressora**, e `procompFinish` emite `ESC w` sem consultar o campo. Imprimir o nome do
       enum aqui faria alguém transcrever para um cadastro, um mês depois, uma medição que nunca
       houve. A folha diz o comando que saiu.
     * **`Tabela:`** no lugar de `Página:` e `Codificação:`. Não há `ESC t` neste caminho: o texto sai
       em ABICOMP, tabela de fábrica desta firmware, provada em papel em 23/08/2026. As duas linhas
       da folha ESC/POS descrevem uma escolha que este dialeto não faz.
     * **`Identidade GS I:`** diz **não perguntada**, e não "não respondeu". Ver ``identityUnasked``.

     O resto — largura, conexão, compensação, códigos nativos, família de Wi-Fi, carimbo de data e a
     linha de acentos — sai pelas mesmas funções da folha ESC/POS, para as duas certidões continuarem
     transcritíveis pelo mesmo par de olhos.
     */
    static func profileLines(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?
    ) -> String {
        var linhas = profile.displayName + "\n"
        linhas += "\(profile.paperWidthMm) mm | \(profile.printableColumns) colunas | "
        linhas += "\(profile.printableDots) dots\n"
        if let transport { linhas += "Conexão: \(transport.label)\n" }
        linhas += "Tabela: ABICOMP (fábrica)\n"
        linhas += cutLine(profile)
        linhas += PrinterProbePayloads.verticalRasterScaleLine(profile.verticalRasterScale)
        linhas += PrinterProbePayloads.nativeQRLine(profile.nativeQrHonored)
        linhas += PrinterProbePayloads.nativeBarcodeLine(profile.nativeBarcodeHonored)
        linhas += PrinterProbePayloads.wifiConfigurationFamilyLine(profile.wifiConfigurationFamily)
        linhas += "Medida em: \(PrinterProbePayloads.localTimestamp(profile.measuredAt))\n"
        if let identity {
            if let manufacturer = identity.manufacturer { linhas += "Fabricante: \(manufacturer)\n" }
            if let model = identity.model { linhas += "Modelo: \(model)\n" }
            if let firmware = identity.firmwareVersion { linhas += "Firmware: \(firmware)\n" }
        } else {
            linhas += identityUnasked + "\n"
        }
        linhas += "Acentos: ação, opção, São João\n"
        linhas += PrinterProbePayloads.codePageSample
        return linhas
    }

    /// O comando que sai, e o avanço que a régua mediu. Ver ``profileLines(profile:identity:transport:)``.
    private static func cutLine(_ profile: MeasuredProfile) -> String {
        profile.cutProtocol.hasCutter
            ? "Corte: ESC w (parcial) | avanço \(profile.cutFeedLines)\n"
            : "Corte: sem guilhotina\n"
    }

    /**
     A moldura da régua, com os mesmos pixels da sequência ESC/POS e o envelope desta firmware.

     Margem zero: a régua mede onde o papel acaba, então ela precisa começar na primeira coluna
     imprimível. Centralizar aqui moveria a borda esquerda e a régua mediria a margem.
     */
    private static func rasterRuler(widthDots: Int) -> Data {
        raster(
            widthDots: widthDots,
            heightDots: PrinterProbePayloads.rasterRulerHeightDots,
            packed: PrinterProbePayloads.rasterRulerPixels(widthDots: widthDots)
        ) ?? Data()
    }

    /// Sem compensação vertical: a tira **é** o instrumento que a mede. Compensar aqui esticaria a
    /// régua pelo fator que ela deveria descobrir, e ela sempre confirmaria o fator já gravado.
    private static func raster(widthDots: Int, heightDots: Int, packed: [UInt8]) -> Data? {
        guard widthDots >= 8, widthDots % 8 == 0,
              packed.count == (widthDots / 8) * heightDots
        else { return nil }
        var source = PackedRasterSource(widthDots: widthDots, heightDots: heightDots, rows: packed)
        defer { source.clearScratch() }
        return ProcompRasterEmitter.emit(
            source: &source,
            leftMarginDots: 0,
            verticalRasterScale: nil
        )
    }

    private static func prologue() -> Data { EscPosDialectGate.prologue(for: .procompEscP) }

    private static func cutCommand() -> Data { ProcompEscP.cut(.escW) }

    /**
     O avanço que entrega a tira do lado de fora da serrilha.

     Mesmo número da sequência ESC/POS — 12 linhas —, e pela mesma razão: é a distância entre a
     cabeça e a barra em toda impressora que o kit já suportou. Nesta ele ainda não foi medido, e
     quem o mede é a régua de avanço; até lá vale o lado seguro, que é papel a mais.
     */
    private static func tearFeed() -> Data {
        ProcompEscP.feed(lines: Int(PrinterProbePayloads.probeTearFeedLines)) ?? Data()
    }

    /// Texto corrido, à esquerda e sem atributo: o corpo das instruções de toda tira.
    private static func text(_ value: String) -> Data {
        procompText(
            value,
            alignment: 0,
            bold: false,
            size: .normal,
            columns: ProcompEscP.measuredReceiptColumns
        )
    }

    private static func boldLine(_ value: String) -> Data {
        procompText(
            value,
            alignment: 0,
            bold: true,
            size: .normal,
            columns: ProcompEscP.measuredReceiptColumns
        )
    }

    private static func centeredBold(_ value: String) -> Data {
        procompText(
            value,
            alignment: 1,
            bold: true,
            size: .normal,
            columns: ProcompEscP.measuredReceiptColumns
        )
    }

    /**
     Régua e rótulo de régua saem **sem preenchimento**, e isso não é economia.

     `procompText` centraliza por espaços, porque não existe `ESC a` nesta firmware. Numa régua isso
     seria fatal: o espaço à esquerda desloca a barra e ela passa a medir a margem em vez da largura.
     Aqui o texto vai pelo encoder da tabela e mais nada.
     */
    private static func ascii(_ value: String) -> Data {
        ProcompEscP.encode(value, table: .abicomp)
    }

    private static func probe(_ bytes: Data) -> PrinterProbe {
        PrinterProbe(bytes: bytes, dialect: .procompEscP)
    }
}

/**
 Pixels já empacotados vistos como fonte de faixas.

 As réguas e a trama de meio tom nascem empacotadas — MSB primeiro, byte da esquerda para a direita
 —, que é a mesma convenção que ``OneBitRasterSource`` pede e a mesma que a IM453H mediu em
 23/08/2026. Aqui só há o desempacotamento da faixa que o emissor pede por vez.
 */
private struct PackedRasterSource: OneBitRasterSource {
    let widthDots: Int
    let heightDots: Int
    private var rows: [UInt8]

    init(widthDots: Int, heightDots: Int, rows: [UInt8]) {
        self.widthDots = widthDots
        self.heightDots = heightDots
        self.rows = rows
    }

    mutating func blackPixels(startY: Int, height: Int) -> [Bool]? {
        let widthBytes = widthDots / 8
        guard widthDots > 0, widthDots % 8 == 0, heightDots > 0,
              rows.count == widthBytes * heightDots,
              startY >= 0, height > 0, startY + height <= heightDots
        else { return nil }
        var pixels = [Bool](repeating: false, count: widthDots * height)
        for row in 0..<height {
            let base = (startY + row) * widthBytes
            for byte in 0..<widthBytes {
                let value = rows[base + byte]
                for bit in 0..<8 {
                    pixels[row * widthDots + byte * 8 + bit] = (value >> (7 - bit)) & 1 == 1
                }
            }
        }
        return pixels
    }

    mutating func clearScratch() {
        rows.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
    }
}
