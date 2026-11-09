import Foundation

/// Multiplicadores seguros do comando `GS !`: cada eixo aceita de uma a oito vezes o tamanho base.
public struct ThermalTextSize: Equatable, Sendable {
    public static let normal = ThermalTextSize(uncheckedWidth: 1, height: 1)

    public let widthMultiplier: Int
    public let heightMultiplier: Int

    public init?(widthMultiplier: Int, heightMultiplier: Int) {
        guard Self.validMultipliers.contains(widthMultiplier),
              Self.validMultipliers.contains(heightMultiplier)
        else { return nil }
        self.init(uncheckedWidth: widthMultiplier, height: heightMultiplier)
    }

    var commandByte: UInt8 {
        UInt8((widthMultiplier - 1) << 4 | (heightMultiplier - 1))
    }

    private init(uncheckedWidth widthMultiplier: Int, height heightMultiplier: Int) {
        self.widthMultiplier = widthMultiplier
        self.heightMultiplier = heightMultiplier
    }

    private static let validMultipliers = 1...8
}

/**
 O que o hospedeiro prefere para os códigos de um cupom, por impressora.

 Atravessa o ponto de injeção neutro e para no inicializador de ``ReceiptLayout`` que recebe o
 perfil, o qual a confronta com a capacidade medida. **O kit não lê preferência nenhuma**: quem
 guarda isto é o app, chaveado pelo `profileId`, e a superfície do kit não sabe que existe tela de
 ajustes.

 São dois campos porque são duas decisões independentes: uma firmware pode atender ao `GS k` do
 código de barras e ignorar o `GS ( k` do QR — em impressora térmica nada implica nada. Espelha o
 `ThermalCodeEmissionPreferences` do Android.
 */
public struct ThermalCodeEmissionPreferences: Equatable, Sendable {
    /// O que sai quando ninguém pede outra coisa: os dois rasterizados, como sempre foi.
    public static let `default` = ThermalCodeEmissionPreferences()

    public let qrEmission: ThermalCodeEmission
    public let barcodeEmission: ThermalCodeEmission

    public init(
        qrEmission: ThermalCodeEmission = .default,
        barcodeEmission: ThermalCodeEmission = .default
    ) {
        self.qrEmission = qrEmission
        self.barcodeEmission = barcodeEmission
    }

    /**
     A preferência que **esta medição sustenta** — a trava, num lugar só.

     Vive aqui, e não copiada em cada ponto de uso, porque ela precisa valer igual na construção do
     layout a partir do perfil e na hora do cupom, quando o controlador iOS aplica a preferência que
     pode ter mudado desde a adoção. Duas cópias seriam duas respostas sobre a mesma pergunta.

     Capacidade ausente (`nil`, ninguém mediu) trava igual à medida-não: o modo nativo só sai depois
     que uma pessoa viu o código sair no papel.
     */
    func honored(by profile: PrinterProfile) -> ThermalCodeEmissionPreferences {
        ThermalCodeEmissionPreferences(
            qrEmission: profile.nativeQrHonored == true ? qrEmission : .default,
            barcodeEmission: profile.nativeBarcodeHonored == true ? barcodeEmission : .default
        )
    }
}

/// Traduz o perfil da impressora em decisões de papel. Uma portátil de 58mm tem 32 colunas e não
/// tem guilhotina; a de balcão tem 48 e corta. O cupom precisa sair legível nas duas.
///
/// Espelha o `ReceiptLayout` do Android — é o que evita o cupom ter dois formatos por plataforma.
public struct ReceiptLayout: Equatable {
    /**
     Altura de banda `GS v 0` de sempre, e o que ela significa em papel.

     Vinte e quatro linhas é o que toda foto de venda usa desde o M1, e é o número que continua
     saindo quando ninguém pede outro. Ele **não** é neutro: uma banda de 24 linhas em largura cheia
     de 58 mm tem 1.152 bytes, e a 0,6 KB/s — a vazão medida na Inico T210 em 2026-08-20 — leva
     perto de dois segundos pingando de vinte em vinte bytes. Firmware que abandona a banda quando a
     recepção demora demais perde linha inteira; banda menor termina antes.

     Por isso o parâmetro existe, e por isso o padrão não muda: descobrir se a inanição é a causa
     exige poder emitir a mesma imagem em bandas menores, e provar não é decidir. Espelha o Android.
     */
    public static let defaultRasterStripeHeightDots = 24

    /// O que o emissor aceita como altura de banda. Acima do padrão não há pergunta a fazer.
    public static let allowedRasterStripeHeightDots = 1...defaultRasterStripeHeightDots

    /**
     Faixa aceita para o fator de compensação vertical de raster.

     O fator é **o que sai do papel dividido pelo que foi declarado**: a Inico T210 medida em 20/08
     imprime 0,80 de toda altura de raster largo que recebe. O teto é 1,0 porque acima disso não há
     defeito a compensar — firmware que imprime mais alto do que se pediu nunca apareceu na bancada,
     e aceitar esse número faria a compensação **encolher** a imagem de propósito. O piso de 0,5 é o
     limite do absurdo: abaixo dele a imagem dobraria de altura, e o que está errado é a medida.

     Espelha `VERTICAL_RASTER_SCALE_RANGE` do Android.
     */
    public static let allowedVerticalRasterScale = 0.5...1.0

    public let columns: Int
    public let qrWidthDots: Int
    /// Largura raster medida no perfil; imagem nunca usa a constante limitada do QR.
    public let printableDots: Int
    public let hasCutter: Bool
    public let cutProtocol: CutProtocol
    public let cutFeedLines: Int

    /**
     Página de código desta impressora, presente somente em `.singleByteCodePage`.

     Não é preferência, é firmware — e é por isso que ela mora aqui, ao lado das colunas e da
     guilhotina, em vez de ser constante do `EscPos`. A de balcão aceita CP850 e imprime "São João";
     `textEncoding` distingue as duas formas sem página: UTF-8 preserva acentos e ASCII os dobra.
     Mesma decisão do `PrinterDriverProfile` do Android, e pelo mesmo motivo de bancada.
     */
    public let codePage: ThermalCodePage?
    /// Endereço medido da página em `ESC t`, quando não é o canônico. Ver `MeasuredProfile`.
    public let codePageSelector: UInt8?
    public let textEncoding: ThermalTextEncoding

    /**
     Cabeçalho e rodapé do app hospedeiro. `nil` é o comportamento histórico: nada acrescentado.

     Fica no layout, e não no payload, porque o rodapé precisa entrar antes do corte de
     ``finish()`` — e o corte é a última coisa que o payload emite. Ver ``ReceiptDecoration``.
     */
    public let decoration: (any ReceiptDecoration)?

    /**
     Altura de cada banda `GS v 0` da imagem deste cupom.

     O padrão é o de sempre, e é ele que sai quando ninguém pede outro: um cupom montado hoje tem
     byte a byte os mesmos bytes de antes deste campo existir. Outro valor é medição de bancada —
     ver ``defaultRasterStripeHeightDots``. Altura fora da faixa cai no padrão em vez de sumir com a
     imagem: `nil` aqui seria a foto desaparecendo do cupom sem erro nenhum.
     */
    public let rasterStripeHeightDots: Int

    /**
     Fator de compensação vertical desta impressora; `nil` é não compensar nada.

     Vem do perfil, medido em papel, e nunca de preferência. Ver ``allowedVerticalRasterScale``:
     com fator, todo raster deste cupom — foto, logotipo e QR — sai reamostrado na vertical para o
     papel ter a altura pretendida. Sem fator, o cupom tem byte a byte os bytes de sempre. Fator
     fora da faixa cai em `nil`, pela mesma razão de ``rasterStripeHeightDots``: recusar aqui seria
     a imagem sumindo do cupom sem erro nenhum.
     */
    public let verticalRasterScale: Double?

    /**
     Quem desenha o QR deste cupom. Padrão: o app, em pontos — o caminho já homologado.

     Entra **no fim da lista** dos dois inicializadores de propósito: no meio, quebraria todo
     chamador; aqui, todo layout montado antes deste campo existir continua compilando e continua
     rasterizando. Ver ``qr(payload:)``; ``qrRaster(payload:)`` não olha para este campo e continua
     sempre rasterizando.
     */
    public let qrEmission: ThermalCodeEmission

    /// Quem desenha o código de barras deste cupom. Mesmo padrão, comando diferente. Ver
    /// ``barcode(_:symbology:humanReadable:heightDots:)``.
    public let barcodeEmission: ThermalCodeEmission

    /**
     Qual conjunto de comandos este cupom fala.

     Nasce Epson para que todo layout já construído continue byte a byte igual. O valor vem do
     perfil, e é ele que decide texto, raster e corte — as três coisas que o dialeto muda.

     **Entra no fim da lista dos inicializadores, e no Kotlin ele está no meio.** A divergência é de
     linguagem: em Swift os argumentos são passados na ordem em que foram declarados, então um campo
     no meio quebraria todo chamador que já passa os campos seguintes. No Kotlin, com argumentos
     nomeados, a posição não muda chamada nenhuma.
     */
    public let dialect: EscPosDialect

    /**
     O envelope de raster deste dialeto. Ver ``RasterEmission``.

     Todo caminho de raster do layout — foto, QR, código de barras e bitmap já composto — desce por
     aqui. Enquanto um deles não descia, o cupom saía com o corpo num dialeto e o fecho no outro:
     foi o defeito medido no lado Kotlin em 27/08/2026, e é a razão de este acessório existir num
     lugar só em vez de cada função escolher o seu emissor.
     */
    var rasterEmission: RasterEmission {
        switch dialect {
        case .epsonCompatible:
            return .escPos
        // A área imprimível é capturada aqui porque é aqui que ela é conhecida: sem `ESC a`, quem
        // centraliza o gráfico é a margem dele.
        case .procompEscP:
            return .procomp(printableDots: printableDots)
        }
    }

    /**
     O comando nativo deste dialeto pode sair, e foi medido?

     A IM453H **tem** QR nativo (`ESC ( k`) e código de barras nativo (`ESC | 0`, `ESC | 1`), e
     nenhum dos dois saiu em papel até hoje. Emitir comando não medido nesta impressora não custa uma
     tira torta: custa o aparelho travado, com a tecla de avanço morta e recuperação só no desligar e
     ligar. Enquanto não houver sonda que os prove, o dialeto Procomp **rasteriza**, que é o caminho
     medido — e é também o que a regra de QR protegido já manda fazer.
     */
    private var nativeCodeAllowed: Bool {
        switch dialect {
        case .epsonCompatible: return true
        case .procompEscP: return false
        }
    }

    public init(
        columns: Int,
        qrWidthDots: Int,
        hasCutter: Bool,
        codePage: ThermalCodePage?,
        codePageSelector: UInt8? = nil,
        textEncoding: ThermalTextEncoding? = nil,
        cutProtocol: CutProtocol? = nil,
        cutFeedLines: Int? = nil,
        printableDots: Int? = nil,
        decoration: (any ReceiptDecoration)? = nil,
        rasterStripeHeightDots: Int = defaultRasterStripeHeightDots,
        verticalRasterScale: Double? = nil,
        // O inicializador cru continua **permissivo**: quem monta layout à mão não tem perfil para
        // consultar, exatamente como já vale para `qrWidthDots` e para a compensação vertical. A
        // trava mora no inicializador que recebe o perfil, que é o único que tem a medição.
        qrEmission: ThermalCodeEmission = .default,
        barcodeEmission: ThermalCodeEmission = .default,
        // Ver a nota do campo: em Swift a ordem dos argumentos é a da declaração, então campo novo
        // entra no fim ou quebra todo chamador que já passa os de baixo.
        dialect: EscPosDialect = .epsonCompatible
    ) {
        self.dialect = dialect
        self.qrEmission = qrEmission
        self.barcodeEmission = barcodeEmission
        self.rasterStripeHeightDots =
            Self.allowedRasterStripeHeightDots.contains(rasterStripeHeightDots)
                ? rasterStripeHeightDots
                : Self.defaultRasterStripeHeightDots
        self.verticalRasterScale =
            verticalRasterScale.flatMap { Self.allowedVerticalRasterScale.contains($0) ? $0 : nil }
        self.decoration = decoration
        self.columns = columns
        self.qrWidthDots = qrWidthDots
        // Mantém compatibilidade de fonte com layouts construídos antes de este campo existir. Os
        // caminhos produtivos e os estáticos passam a largura medida explicitamente abaixo.
        self.printableDots = printableDots ?? qrWidthDots
        self.hasCutter = hasCutter
        self.codePage = codePage
        self.codePageSelector = codePageSelector
        self.textEncoding = textEncoding ?? (codePage == nil ? .ascii : .singleByteCodePage)
        self.cutProtocol = cutProtocol ?? (hasCutter ? .gsV0 : .none)
        self.cutFeedLines = cutFeedLines ?? (hasCutter ? Self.defaultCutFeedLines : 0)
    }

    /// Equivalência operacional do perfil medido. Os controllers M1 continuam usando os dois
    /// layouts estáticos; consumidores novos podem interpretar capacidades sem redesenhar a venda.
    /// - Parameter codeEmission: o que o hospedeiro prefere para os códigos deste cupom. Aqui é
    ///   onde a preferência encontra a medição — ver a trava abaixo.
    public init(
        profile: PrinterProfile,
        decoration: (any ReceiptDecoration)? = nil,
        rasterStripeHeightDots: Int = defaultRasterStripeHeightDots,
        codeEmission: ThermalCodeEmissionPreferences = .default
    ) {
        // A trava. Preferência que a medição não sustenta cai no padrão e não vira comando: é a
        // mesma recusa de `withCutMode` quando `cutModeHonored` é falso. Preferência guardada no
        // app pode estar velha — a impressora pode ter sido remedida —, e quem sabe o que a
        // firmware faz é o perfil, não o ajuste.
        let honored = codeEmission.honored(by: profile)
        self.init(
            columns: profile.printableColumns,
            qrWidthDots: profile.capabilities.qrWidthDots,
            hasCutter: profile.cutProtocol.hasCutter,
            codePage: profile.codePage,
            codePageSelector: profile.codePageSelector,
            textEncoding: profile.textEncoding,
            cutProtocol: profile.cutProtocol,
            cutFeedLines: profile.cutFeedLines,
            printableDots: profile.printableDots,
            decoration: decoration,
            rasterStripeHeightDots: rasterStripeHeightDots,
            // Sem isto o fator morre na conversão e a foto volta a sair encolhida na firmware que
            // encolhe — que é exatamente o defeito que ele existe para compensar.
            verticalRasterScale: profile.verticalRasterScale,
            qrEmission: honored.qrEmission,
            barcodeEmission: honored.barcodeEmission,
            // Sem isto a impressora homologada voltaria a falar ESC/POS no primeiro cupom depois de
            // adotada, e só o papel mostraria — longe da causa. É o mesmo campo que o Kotlin leva
            // do perfil ao layout desde 26/08/2026.
            dialect: profile.dialect
        )
    }

    /// O mesmo papel com o gancho do hospedeiro instalado — ou removido, quando o argumento é
    /// `nil`. Existe para os layouts estáticos, que nascem sem decoração e são justamente o
    /// caminho por onde um cupom escaparia dela.
    public func decorated(by decoration: (any ReceiptDecoration)?) -> ReceiptLayout {
        ReceiptLayout(
            columns: columns,
            qrWidthDots: qrWidthDots,
            hasCutter: hasCutter,
            codePage: codePage,
            codePageSelector: codePageSelector,
            textEncoding: textEncoding,
            cutProtocol: cutProtocol,
            cutFeedLines: cutFeedLines,
            printableDots: printableDots,
            decoration: decoration,
            rasterStripeHeightDots: rasterStripeHeightDots,
            verticalRasterScale: verticalRasterScale,
            // Este método reconstrói o layout campo a campo, e campo esquecido aqui **some em
            // silêncio**: o cupom voltaria ao modo padrão só por ter passado pela decoração. É o
            // mesmo erro que já custou uma homologação inteira quando um campo não atravessou o
            // `Codable`. O dialeto é o campo em que esse esquecimento manda `GS v 0` a uma firmware
            // que trava com ele.
            qrEmission: qrEmission,
            barcodeEmission: barcodeEmission,
            dialect: dialect
        )
    }

    /**
     O mesmo papel com outro modo de emissão.

     Existe pela mesma razão de ``decorated(by:)``: os controladores guardam o layout adotado, e a
     preferência precisa ser aplicada **na hora do cupom** — quem trocasse o ajuste em Ajustes e
     mandasse imprimir em seguida não veria diferença nenhuma até readotar a impressora.

     Não é a trava, e não pretende ser: quem chama precisa ter passado a preferência por
     ``ThermalCodeEmissionPreferences/honored(by:)`` antes, porque a autorização vem da capacidade
     medida do perfil e não sobrevive dentro do layout — `rasterized` é ao mesmo tempo "o padrão" e
     "o que a medição permitiu", e os dois são indistinguíveis depois de construídos.
     */
    public func emitting(qr: ThermalCodeEmission, barcode: ThermalCodeEmission) -> ReceiptLayout {
        ReceiptLayout(
            columns: columns,
            qrWidthDots: qrWidthDots,
            hasCutter: hasCutter,
            codePage: codePage,
            codePageSelector: codePageSelector,
            textEncoding: textEncoding,
            cutProtocol: cutProtocol,
            cutFeedLines: cutFeedLines,
            printableDots: printableDots,
            decoration: decoration,
            rasterStripeHeightDots: rasterStripeHeightDots,
            verticalRasterScale: verticalRasterScale,
            qrEmission: qr,
            barcodeEmission: barcode,
            dialect: dialect
        )
    }

    /// Igualdade pelas medidas do papel. A decoração é comparada por identidade — ela é um gancho
    /// do hospedeiro, não uma capacidade da impressora, e não tem como se comparar por valor.
    public static func == (lhs: ReceiptLayout, rhs: ReceiptLayout) -> Bool {
        lhs.columns == rhs.columns
            && lhs.qrWidthDots == rhs.qrWidthDots
            && lhs.printableDots == rhs.printableDots
            && lhs.hasCutter == rhs.hasCutter
            && lhs.cutProtocol == rhs.cutProtocol
            && lhs.cutFeedLines == rhs.cutFeedLines
            && lhs.codePage == rhs.codePage
            && lhs.codePageSelector == rhs.codePageSelector
            && lhs.textEncoding == rhs.textEncoding
            && lhs.rasterStripeHeightDots == rhs.rasterStripeHeightDots
            && lhs.verticalRasterScale == rhs.verticalRasterScale
            && lhs.qrEmission == rhs.qrEmission
            && lhs.barcodeEmission == rhs.barcodeEmission
            // Dois layouts com as mesmas medidas e dialetos diferentes emitem bytes diferentes para
            // o mesmo cupom: são impressoras diferentes, e a igualdade tem de dizer isso.
            && lhs.dialect == rhs.dialect
            && lhs.decoration === rhs.decoration
    }

    /// Portátil 58mm Bluetooth: 384 pontos imprimíveis, 32 colunas, serrilha manual, sem página.
    public static let portable58mm = ReceiptLayout(
        columns: BluetoothPrinterProfile.columns,
        qrWidthDots: min(EscPos.preferredQRWidthDots, BluetoothPrinterProfile.printableDots) / 8 * 8,
        hasCutter: BluetoothPrinterProfile.hasCutter,
        codePage: BluetoothPrinterProfile.codePage,
        cutProtocol: CutProtocol.none,
        cutFeedLines: 0,
        printableDots: BluetoothPrinterProfile.printableDots
    )

    /// Impressora de balcão na Wi-Fi (Elgin i9FULL 2): 576 pontos, 48 colunas, guilhotina, CP850.
    public static let counter = ReceiptLayout(
        columns: 48,
        qrWidthDots: min(EscPos.preferredQRWidthDots, 576) / 8 * 8,
        hasCutter: true,
        codePage: .cp850,
        cutProtocol: .gsV0,
        cutFeedLines: defaultCutFeedLines,
        printableDots: 576
    )

    /**
     Um bloco de texto já na página desta impressora.

     Todo cupom passa por aqui e nenhum chama `EscPos.text` direto: é o que garante que a mesma
     impressão saia com o acento em CP850 na de balcão e dobrado para ASCII na portátil, sem o cupom
     precisar saber em qual das duas está imprimindo.
     */
    public func text(_ value: String, alignment: UInt8, bold: Bool = false, size: UInt8 = 0) -> Data {
        // O byte cru do `GS !` é a mesma coisa que o par de multiplicadores, e o dialeto Procomp
        // precisa do par: lá tamanho é liga/desliga, não multiplicador. Desempacotar aqui evita um
        // segundo caminho de texto que pudesse divergir do de baixo.
        text(
            value,
            alignment: alignment,
            bold: bold,
            size: ThermalTextSize(
                widthMultiplier: Int(size >> 4) + 1,
                heightMultiplier: Int(size & 0x0F) + 1
            ) ?? .normal,
            rawSize: size
        )
    }

    /// Variante recomendada: converte multiplicadores validados para o byte de `GS !`.
    public func text(
        _ value: String,
        alignment: UInt8,
        bold: Bool = false,
        size: ThermalTextSize
    ) -> Data {
        text(value, alignment: alignment, bold: bold, size: size, rawSize: size.commandByte)
    }

    /// O texto deste cupom no dialeto deste perfil. `rawSize` preserva byte a byte o que a
    /// sobrecarga crua recebeu: no caminho ESC/POS o `GS !` continua sendo exatamente o que o
    /// chamador pediu, inclusive um byte que os multiplicadores validados não descreveriam.
    ///
    /// Um `GS !` com multiplicador acima de oito — que ``ThermalTextSize`` recusa — sai como veio no
    /// ESC/POS e cai em corpo normal no ramo Procomp. Não há como fazer melhor sem inventar: aquele
    /// dialeto tem expandido e dupla altura, e não multiplicador.
    private func text(
        _ value: String,
        alignment: UInt8,
        bold: Bool,
        size: ThermalTextSize,
        rawSize: UInt8
    ) -> Data {
        switch dialect {
        case .epsonCompatible:
            return EscPos.text(
                value,
                alignment: alignment,
                bold: bold,
                size: rawSize,
                codePage: codePage,
                codePageSelector: codePageSelector,
                textEncoding: textEncoding
            )
        // ABICOMP direto, sem `ESC t`: é a tabela de fábrica desta firmware, e o papel de 23/08/2026
        // provou que acento sai certo sem seletor nenhum. Selecionar seria trocar por outra tabela
        // sem motivo.
        case .procompEscP:
            return procompText(
                value,
                alignment: alignment,
                bold: bold,
                size: size,
                columns: columns
            )
        }
    }

    /**
     Caminho recomendado ao payload: a largura sempre vem do perfil que criou este layout.

     A largura é ajustada ao que o `GS v 0` aceita antes de descer — ver ``rasterWidthDots``.
     */
    public func imageRaster(
        image: ThermalImage,
        mode: ThermalImageMode = .floydSteinberg
    ) -> Data? {
        EscPos.imageRaster(
            image: image,
            printableDots: rasterWidthDots,
            mode: mode,
            stripeHeightDots: rasterStripeHeightDots,
            verticalRasterScale: verticalRasterScale,
            emission: rasterEmission
        )
    }

    /**
     QR pela largura e pelo fator desta impressora — o caminho recomendado ao payload.

     Existe pela mesma razão de ``imageRaster(image:mode:)``: o QR atravessa o emissor de raster,
     então ele encolhe junto na firmware que encolhe, e quem monta cupom não tem como saber disso.
     Um quadrado que sai 20% mais baixo é um QR achatado, e leitor nenhum promete ler isso. Chamar
     ``EscPos/qrRaster(payload:widthDots:)`` direto continua válido e continua sem compensação — é o
     caminho de quem passa os números à mão.
     */
    public func qrRaster(payload: String) -> Data? {
        EscPos.qrRaster(
            payload: payload,
            widthDots: qrWidthDots,
            verticalRasterScale: verticalRasterScale,
            emission: rasterEmission
        )
    }

    /**
     O QR deste cupom pelo modo que a impressora autorizou — o caminho para quem monta cupom.

     **No modo padrão isto é literalmente ``qrRaster(payload:)``**, chamado com o mesmo argumento:
     não há um segundo caminho que possa divergir, e é assim que o cupom de sempre continua saindo
     byte a byte igual. Só o ramo ``ThermalCodeEmission/native`` muda de comando.

     **Carga protegida não passa por aqui.** Sonda, comprovante de homologação e qualquer payload
     que carregue assinatura chamam ``EscPos/qrRaster(payload:widthDots:verticalRasterScale:)``
     direto, porque firmware que não entende `GS ( k` imprime o payload como texto legível — e
     assinatura impressa é assinatura copiável. Isso não é escolha de quem usa.

     O nível de correção pedido ao comando nativo é o **mesmo** que o gerador deste lado usa no
     raster, e é por isso que ele é um literal e não um parâmetro: o contrato desta frente é que
     trocar o modo não troca o símbolo.
     */
    public func qr(payload: String) -> Data? {
        // Dialeto sem comando nativo medido rasteriza, escolha nenhuma: ver `nativeCodeAllowed`.
        switch nativeCodeAllowed ? qrEmission : .rasterized {
        case .rasterized:
            return qrRaster(payload: payload)
        case .native:
            guard let side = EscPos.qrModuleSide(payload: payload) else { return nil }
            return EscPos.qrNative(
                payload: payload,
                moduleSizeDots: qrModuleSizeDots(moduleSide: side),
                errorCorrection: Self.qrRasterErrorCorrection
            )
        }
    }

    /**
     O código de barras deste cupom pelo modo que a impressora autorizou.

     A largura de módulo é **medida**, não escolhida: o kit codifica o símbolo — que já precisa
     codificar para desenhá-lo — e divide a área imprimível pela contagem de módulos. É a mesma
     conta nos dois modos, e é o que faz o mesmo conteúdo ocupar a mesma pegada física escolha-se o
     que se escolher. Ver ``ThermalBarcode/moduleWidthDots(_:symbology:printableDots:)``.

     **A legenda é emitida aqui, e não pelo emissor cru.** No modo nativo ela é `GS H 2`, papel da
     firmware; no rasterizado é uma linha de texto centrada, que é o único jeito de ela sair na
     página de código medida daquela impressora — o emissor cru não tem perfil para consultar. O
     texto é o conteúdo **normalizado**: um EAN-13 digitado com doze dígitos sai com o verificador
     que o kit calculou, e a legenda mostra o mesmo número que as barras carregam.

     Devolve `nil` quando o conteúdo não vira símbolo ou quando o símbolo não cabe na largura desta
     impressora — as duas recusas que ``ThermalBarcode/validate(_:symbology:)`` e
     ``ThermalBarcodeRejection/doesNotFit`` descrevem em pt-BR para quem oferece o campo.
     */
    public func barcode(
        _ value: String,
        symbology: ThermalBarcodeSymbology = .code128,
        humanReadable: Bool = true,
        heightDots: Int = ThermalBarcode.defaultHeightDots
    ) -> Data? {
        guard let normalized = ThermalBarcode.validate(value, symbology: symbology).normalized,
              let moduleWidthDots = ThermalBarcode.moduleWidthDots(
                  normalized,
                  symbology: symbology,
                  printableDots: printableDots
              )
        else { return nil }
        switch nativeCodeAllowed ? barcodeEmission : .rasterized {
        case .rasterized:
            guard var barras = EscPos.barcodeRaster(
                value: normalized,
                symbology: symbology,
                moduleWidthDots: moduleWidthDots,
                heightDots: heightDots,
                printableDots: printableDots,
                verticalRasterScale: verticalRasterScale,
                emission: rasterEmission
            ) else { return nil }
            guard humanReadable else { return barras }
            // A quebra é do bloco, e não decoração: sem ela a legenda fica no buffer da linha e o
            // que vier depois sai grudado nela.
            barras.append(text(normalized + "\n", alignment: Self.centerAlignment))
            return barras
        case .native:
            return EscPos.barcodeNative(
                value: normalized,
                symbology: symbology,
                moduleWidthDots: moduleWidthDots,
                heightDots: heightDots,
                humanReadable: humanReadable
            )
        }
    }

    /**
     Tamanho de módulo do QR nativo, pela mesma régua do código de barras: área dividida por
     módulos.

     O `GS ( k` não recebe largura em pontos, então sem esta conta o tamanho seria chute — e um
     chute faria o mesmo payload ocupar papel diferente conforme o ajuste, que é justamente o que
     esta frente promete que não acontece.
     */
    private func qrModuleSizeDots(moduleSide: Int) -> Int {
        let total = moduleSide + 2 * ThermalBarcode.qrQuietZoneModules
        return min(
            max(qrWidthDots / total, ThermalBarcode.qrNativeModuleSizeDotsRange.lowerBound),
            ThermalBarcode.qrNativeModuleSizeDotsRange.upperBound
        )
    }

    /**
     A largura do perfil ajustada ao que o raster aceita: múltiplo de 8 para baixo, travada no teto.

     O emissor exige múltiplo de 8 porque `GS v 0` conta a faixa em bytes, e recusa o que passa do
     teto. A recusa é um `nil`, e `nil` aqui **é a imagem sumindo do cupom sem erro nenhum** — o
     texto sai, o cabeçalho não, e ninguém descobre a não ser olhando o papel. Uma largura fora do
     contrato precisa dar falha barulhenta ou funcionamento correto, e aqui dá para ter o correto:
     376 em vez de 380 é meio milímetro de papel que ninguém enxerga, e 640 numa medição de 700 é
     uma imagem um pouco mais estreita — as duas saem centradas e proporcionais, que é o que a
     pessoa esperava ver.

     O ajuste mora aqui, e não no emissor: quem recebe a largura crua continua recusando, porque
     quem passa número à mão precisa ouvir "não". Nenhum perfil validado produz uma largura assim
     hoje — a geometria medida só aceita a lista de `geometryProbeDots` —, mas o inicializador
     público deste layout aceita qualquer inteiro, e é por ele que a largura de um hospedeiro entra.
     */
    var rasterWidthDots: Int {
        min(printableDots, ThermalImageOneBitRasterSource.maximumPrintableDots) / 8 * 8
    }

    /**
     Quebra em palavras dentro da largura da impressora. Sem isso a firmware quebra sozinha na
     coluna exata e parte a última palavra no meio.
     */
    /// - Parameter scale: multiplicador de largura do texto, o mesmo de `GS !`. **Texto em corpo
    ///   dobrado ocupa duas colunas por caractere**, então numa portátil de 32 cabem 16 — e quem
    ///   esquecer isto entrega ao papel uma linha que a firmware parte sozinha. Foi assim que
    ///   "PASTELÃO DE CARNE" saiu do laboratório como `PASTELAO DE CARN` e um `E` órfão embaixo.
    public func wrap(_ text: String, scale: Int = 1) -> String {
        let width = max(1, columns / max(1, scale))
        return text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { wrapParagraph(String($0), width: width) }
            .joined(separator: "\n")
    }

    /// Quebra texto pela largura ocupada pelo multiplicador validado de `GS !`.
    public func wrap(_ text: String, size: ThermalTextSize) -> String {
        wrap(text, scale: size.widthMultiplier)
    }

    /**
     Descrição à esquerda, valor **encostado na margem direita**, na mesma linha:

         Cerveja ....................... 12x  R$ 60,00

     Alinhamento à direita do ESC/POS não resolve isto, porque ele vale para a linha inteira e aqui
     descrição e valor dividem a linha. Então o espaço é calculado em caracteres, que é a única
     medida que a impressora térmica respeita — e é por isso que o resultado precisa estar certo
     tanto nas 32 colunas da portátil quanto nas 48 da de balcão.

     O pontilhado existe para o olho não perder a linha no meio do caminho: quem confere o
     recibo lê de baixo para cima procurando um número entre várias linhas.

     Descrição que não cabe é quebrada como em `wrap`, e o valor acompanha a última linha. Quando
     nem aí ele cabe, desce sozinho encostado na direita — nunca é truncado: valor cortado no papel
     é pior que uma linha a mais.
     */
    public func valueLine(_ description: String, value: String, filler: Character = ".") -> String {
        let value = value.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return wrap(description) }
        var lines = wrap(description)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        let last = lines.popLast() ?? ""
        let gap = columns - last.count - value.count
        if last.isEmpty {
            // Sem descrição não há o que ligar: o valor só encosta na direita.
            lines.append(String(repeating: " ", count: max(0, columns - value.count)) + value)
        } else if gap >= 1 {
            // O pontilhado é cercado de espaço para não colar em letra nem em cifrão; com folga de
            // um ou dois caracteres não sobra pontilhado nenhum e a linha vira só espaço.
            let bridge = gap >= 3
                ? " " + String(repeating: filler, count: gap - 2) + " "
                : String(repeating: " ", count: gap)
            lines.append(last + bridge + value)
        } else {
            lines.append(last)
            lines.append(String(repeating: " ", count: max(0, columns - value.count)) + value)
        }
        return lines.joined(separator: "\n")
    }

    /**
     Fecha o cupom, avanço incluído: quem monta o recibo não soma avanço próprio, senão sobra papel
     em branco. Sem guilhotina o corte é serrilha manual, e o papel precisa avançar só o bastante
     para a última linha passar da barra.
     */
    public func finish() -> Data {
        let corte: Data
        switch dialect {
        // O enum de corte é inteiro ESC/POS, e nesta firmware nenhum daqueles comandos existe: o
        // corte medido é `ESC w`, e o que o perfil guarda em `cutProtocol` só responde "tem
        // guilhotina?". Ver `procompFinish`.
        case .procompEscP:
            corte = procompFinish(
                hasCutter: hasCutter,
                cutFeedLines: cutFeedLines,
                tearFeedLines: Int(Self.tearFeedLines)
            )
        case .epsonCompatible:
            switch cutProtocol {
            case .none:
                corte = EscPos.advance(lines: Self.tearFeedLines)
            case .gsV65, .gsV66:
                corte = cutProtocol.command
            default:
                var data = EscPos.advance(lines: UInt8(cutFeedLines))
                data.append(cutProtocol.command)
                corte = data
            }
        }
        // O rodapé entra aqui, e não no chamador, porque este é o último ponto antes da lâmina.
        // Quem concatenasse depois de `finish()` imprimiria do outro lado do corte, no cupom
        // seguinte — e o teste que prova a ordem existe justamente porque isso compila.
        guard var rodape = decoration?.footer(layout: self) else { return corte }
        rodape.append(corte)
        return rodape
    }

    private func wrapParagraph(_ paragraph: String, width: Int) -> String {
        guard paragraph.count > width else { return paragraph }
        var lines: [String] = []
        var current = ""
        for word in paragraph.split(separator: " ").map(String.init) where !word.isEmpty {
            if current.isEmpty {
                current = chunked(word, into: &lines, width: width)
            } else if current.count + 1 + word.count <= width {
                current += " " + word
            } else {
                lines.append(current)
                current = chunked(word, into: &lines, width: width)
            }
        }
        if !current.isEmpty { lines.append(current) }
        return lines.joined(separator: "\n")
    }

    /// Palavra maior que a linha inteira é partida; devolve o resto que ainda cabe.
    private func chunked(_ word: String, into lines: inout [String], width: Int) -> String {
        var rest = word
        while rest.count > width {
            lines.append(String(rest.prefix(width)))
            rest = String(rest.dropFirst(width))
        }
        return rest
    }

    private static let defaultCutFeedLines = 5
    private static let tearFeedLines: UInt8 = 4

    /// `ESC a 1`, o mesmo byte que os cupons já passam à mão.
    private static let centerAlignment: UInt8 = 1

    /**
     O nível que o gerador de QR deste lado usa no raster: `Q`, o terceiro dos quatro.

     O comando nativo carrega o nível explicitamente e o `CIFilter` não recebe parâmetro nenhum, e é
     por isso que este número é fixo aqui: pedir outro à firmware faria o mesmo payload virar um
     símbolo diferente conforme o ajuste. A divergência com o Android, que rasteriza em `M`, é
     dívida antiga do kit e não é desta frente — mas ela para dentro de cada plataforma.
     */
    private static let qrRasterErrorCorrection = 3
}
