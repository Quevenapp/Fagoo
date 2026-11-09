import XCTest
@testable import ThermalPrinterKit

final class ReceiptLayoutTests: XCTestCase {

    /**
     O nome do produto sai em corpo dobrado, e cada caractere come duas colunas.

     Contar 32 numa linha onde cabem 16 devolve ao papel algo que a firmware parte sozinha, no meio
     da palavra: "PASTELÃO DE CARNE" saiu do laboratório como `PASTELAO DE CARN` e um `E` órfão
     embaixo. O nome do produto é a única coisa que diz ao cliente o que ele comprou.
     */
    func testDoubleSizeTextWrapsAtHalfTheColumns() {
        let wrapped = ReceiptLayout.portable58mm.wrap("PASTELAO DE CARNE", scale: 2)

        XCTAssertTrue(wrapped.split(separator: "\n").allSatisfy { $0.count <= 16 }, wrapped)
        XCTAssertEqual(["PASTELAO DE", "CARNE"], wrapped.split(separator: "\n").map(String.init))
    }

    /// Sem escala, a conta continua sendo a largura cheia da impressora.
    func testNormalSizeTextUsesEveryColumn() {
        let wrapped = ReceiptLayout.portable58mm.wrap("PASTELAO DE CARNE")

        XCTAssertEqual("PASTELAO DE CARNE", wrapped)
    }

    func testLayoutCarregaALarguraRasterDoPerfilSemConfundirComOQR() {
        let counter = ReceiptLayout(profile: BundledPrinterProfiles.elginI9Full2)
        let portable = ReceiptLayout(profile: BundledPrinterProfiles.portable58mm)

        XCTAssertEqual(counter.printableDots, 576)
        XCTAssertEqual(counter.qrWidthDots, 320)
        XCTAssertEqual(portable.printableDots, 384)
        XCTAssertEqual(portable.qrWidthDots, 320)
    }

    func testLayoutLegadoAssumeSomenteALarguraRasterJaComprovadaPeloQR() {
        let legacy = ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil
        )

        XCTAssertEqual(legacy.printableDots, 320)
    }

    func testTamanhoSemanticoValidaMultiplicadoresEEmpacotaGSExclamacao() throws {
        let size = try XCTUnwrap(ThermalTextSize(widthMultiplier: 3, heightMultiplier: 2))
        let bytes = ReceiptLayout.portable58mm.text(
            "ABC",
            alignment: 0,
            size: size
        )

        XCTAssertTrue(bytes.contains(Data([0x1d, 0x21, 0x21])))
        XCTAssertEqual(bytes.suffix(3), Data([0x1d, 0x21, 0x00]))
        XCTAssertNil(ThermalTextSize(widthMultiplier: 0, heightMultiplier: 1))
        XCTAssertNil(ThermalTextSize(widthMultiplier: 1, heightMultiplier: 9))
    }

    /// O comprovante de teste repete o fator do layout que o imprime.
    ///
    /// Sem esta linha, o papel que a pessoa manda imprimir um mês depois da homologação mostra
    /// colunas, dots, página e corte e esconde a única capacidade que alterou o comportamento da
    /// impressora — enquanto o QR ali embaixo já sai compensado por ela. O Android emite a mesma
    /// linha no comprovante de teste dele.
    func testComprovanteDeTesteRegistraACompensacaoDoLayout() throws {
        func papel(verticalRasterScale: Double?) -> String {
            let layout = ReceiptLayout(
                columns: 32,
                qrWidthDots: 320,
                hasCutter: false,
                // Sem página medida o encoder dobra os acentos, e a linha continua legível: é a
                // regra de nunca usar caractere que a página não tenha.
                codePage: nil,
                cutProtocol: CutProtocol.none,
                cutFeedLines: 0,
                printableDots: 384,
                verticalRasterScale: verticalRasterScale
            )
            return String(decoding: PrinterTestReceipt.bytes(layout: layout), as: UTF8.self)
        }

        let medido = papel(
            verticalRasterScale: 38.0 / Double(PrinterProbePayloads.rasterThroughputStripMillimetres)
        )
        XCTAssertTrue(medido.contains("Vazao: 38/48 mm | fator 0,79"), medido)

        // Perfil sem fator: a linha continua saindo, e diz a ausência.
        let semFator = papel(verticalRasterScale: nil)
        XCTAssertTrue(semFator.contains("Vazao: sem compensacao"), semFator)
        XCTAssertFalse(semFator.contains("fator"))
    }

    func testWrapSemanticoUsaSomenteOMultiplicadorDeLargura() throws {
        let size = try XCTUnwrap(ThermalTextSize(widthMultiplier: 2, heightMultiplier: 8))

        let wrapped = ReceiptLayout.portable58mm.wrap("PASTELAO DE CARNE", size: size)

        XCTAssertEqual(["PASTELAO DE", "CARNE"], wrapped.split(separator: "\n").map(String.init))
    }

    // MARK: - Modo de emissão de código

    private func perfil(
        paperWidth: PrinterPaperWidth = .mm80,
        codePage: ThermalCodePage? = nil,
        verticalRasterScale: Double? = nil,
        nativeQrHonored: Bool? = nil,
        nativeBarcodeHonored: Bool? = nil
    ) throws -> PrinterProfile {
        let estreita = paperWidth == .mm58
        let capabilities = try PrinterCapabilities(
            transports: [.localWifi],
            paperWidth: paperWidth,
            printableColumns: estreita ? 32 : 48,
            printableDots: estreita ? 384 : 576,
            codePage: codePage,
            textEncoding: codePage == nil ? .ascii : .singleByteCodePage,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: 9_100,
            verticalRasterScale: verticalRasterScale,
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored
        )
        return PrinterProfile(
            id: "teste.emissao.escpos",
            displayName: "Impressora de teste",
            source: .measured,
            measuredAt: Date(timeIntervalSince1970: 1),
            capabilities: capabilities
        )
    }

    /// Layouts de todas as combinações que mudam bytes de raster: largura, compensação vertical,
    /// altura de banda e página. É a matriz do teste de byte-identidade.
    private func matrizDeLayouts() throws -> [ReceiptLayout] {
        var layouts: [ReceiptLayout] = []
        for largura in PrinterPaperWidth.allCases {
            for pagina: ThermalCodePage? in [nil, .cp850] {
                for fator: Double? in [nil, 0.80, 0.5] {
                    for banda in [ReceiptLayout.defaultRasterStripeHeightDots, 8] {
                        layouts.append(
                            ReceiptLayout(
                                profile: try perfil(
                                    paperWidth: largura,
                                    codePage: pagina,
                                    verticalRasterScale: fator
                                ),
                                rasterStripeHeightDots: banda
                            )
                        )
                    }
                }
            }
        }
        return layouts
    }

    /**
     **A prova de que o modo padrão não mudou um byte.**

     `qr(payload:)` no padrão não é "equivalente" a `qrRaster(payload:)`: é a mesma chamada, e este
     teste fixa isso para toda combinação que mexe em raster. Se um dia alguém acrescentar um
     caminho paralelo no ramo padrão, é aqui que a divergência aparece — e não no papel. Espelha o
     `o modo padrao emite exatamente os bytes de qrRaster` do Android.
     */
    func testModoPadraoEmiteOsMesmosBytesDeQrRaster() throws {
        // Dois payloads bastam: no ramo padrão o caminho é o mesmo para qualquer conteúdo, e cada
        // renderização de QR do `CIFilter` custa tempo de suíte.
        let payloads = ["https://queven.app/p/1", "A"]
        for layout in try matrizDeLayouts() {
            XCTAssertEqual(layout.qrEmission, .rasterized)
            XCTAssertEqual(layout.barcodeEmission, .rasterized)
            for payload in payloads {
                XCTAssertEqual(
                    layout.qrRaster(payload: payload),
                    layout.qr(payload: payload),
                    "largura \(layout.printableDots), fator \(String(describing: layout.verticalRasterScale))"
                )
            }
        }
    }

    /// O mesmo para o código de barras: o ramo padrão passa pelo emissor raster de sempre.
    func testModoPadraoDoCodigoDeBarrasEOEmissorRasterMaisALegenda() throws {
        let layout = ReceiptLayout(profile: try perfil())
        let valor = "QUEVEN-123"
        let modulo = try XCTUnwrap(
            ThermalBarcode.moduleWidthDots(
                valor,
                symbology: .code128,
                printableDots: layout.printableDots
            )
        )
        let barras = try XCTUnwrap(
            EscPos.barcodeRaster(
                value: valor,
                symbology: .code128,
                moduleWidthDots: modulo,
                heightDots: ThermalBarcode.defaultHeightDots,
                printableDots: layout.printableDots,
                verticalRasterScale: nil
            )
        )

        XCTAssertEqual(barras, layout.barcode(valor, humanReadable: false))
        var comLegenda = barras
        comLegenda.append(layout.text(valor + "\n", alignment: 1))
        XCTAssertEqual(comLegenda, layout.barcode(valor))
    }

    /**
     A trava: preferência que a medição não sustenta cai no padrão antes de virar byte.

     Capacidade ausente é `nil` — ninguém mediu —, e ausente trava igual à medida-não. Preferência
     guardada no app pode estar velha; quem sabe o que a firmware faz é o perfil.
     */
    func testPreferenciaNativaNaoSobreviveACapacidadeAusente() throws {
        let tudoNativo = ThermalCodeEmissionPreferences(qrEmission: .native, barcodeEmission: .native)
        let semMedicao = try perfil()
        XCTAssertNil(semMedicao.nativeQrHonored)
        XCTAssertNil(semMedicao.nativeBarcodeHonored)

        let travado = ReceiptLayout(profile: semMedicao, codeEmission: tudoNativo)
        XCTAssertEqual(travado.qrEmission, .rasterized)
        XCTAssertEqual(travado.barcodeEmission, .rasterized)
        XCTAssertEqual(travado.qrRaster(payload: "abc"), travado.qr(payload: "abc"))

        let recusado = ReceiptLayout(
            profile: try perfil(nativeQrHonored: false, nativeBarcodeHonored: false),
            codeEmission: tudoNativo
        )
        XCTAssertEqual(recusado.qrEmission, .rasterized)
        XCTAssertEqual(recusado.barcodeEmission, .rasterized)
    }

    /// As duas capacidades são independentes: firmware que atende ao `GS k` pode ignorar o
    /// `GS ( k`. Medir as duas juntas seria decidir por medição que não existe.
    func testCapacidadeMedidaDeUmComandoNaoLiberaOOutro() throws {
        let tudoNativo = ThermalCodeEmissionPreferences(qrEmission: .native, barcodeEmission: .native)

        let soQr = ReceiptLayout(profile: try perfil(nativeQrHonored: true), codeEmission: tudoNativo)
        XCTAssertEqual(soQr.qrEmission, .native)
        XCTAssertEqual(soQr.barcodeEmission, .rasterized)

        let soBarras = ReceiptLayout(
            profile: try perfil(nativeBarcodeHonored: true),
            codeEmission: tudoNativo
        )
        XCTAssertEqual(soBarras.qrEmission, .rasterized)
        XCTAssertEqual(soBarras.barcodeEmission, .native)
    }

    /// Capacidade medida sozinha não muda o cupom: quem pede o modo nativo é o hospedeiro.
    func testCapacidadeMedidaSozinhaNaoMudaOCupom() throws {
        let layout = ReceiptLayout(
            profile: try perfil(nativeQrHonored: true, nativeBarcodeHonored: true)
        )

        XCTAssertEqual(layout.qrEmission, .rasterized)
        XCTAssertEqual(layout.barcodeEmission, .rasterized)
    }

    /// No modo nativo o cupom vira comando, e o tamanho de módulo vem da conta, não de chute.
    func testModoNativoPedeOCodigoAFirmware() throws {
        let layout = ReceiptLayout(
            profile: try perfil(nativeQrHonored: true, nativeBarcodeHonored: true),
            codeEmission: ThermalCodeEmissionPreferences(qrEmission: .native, barcodeEmission: .native)
        )
        let payload = "https://queven.app/p/1"
        let lado = try XCTUnwrap(EscPos.qrModuleSide(payload: payload))
        let moduloQr = layout.qrWidthDots / (lado + 2 * ThermalBarcode.qrQuietZoneModules)

        XCTAssertEqual(
            EscPos.qrNative(payload: payload, moduleSizeDots: moduloQr, errorCorrection: 3),
            layout.qr(payload: payload)
        )

        let valor = "QUEVEN-123"
        let moduloBarras = try XCTUnwrap(
            ThermalBarcode.moduleWidthDots(
                valor,
                symbology: .code128,
                printableDots: layout.printableDots
            )
        )
        XCTAssertEqual(
            EscPos.barcodeNative(
                value: valor,
                symbology: .code128,
                moduleWidthDots: moduloBarras,
                heightDots: ThermalBarcode.defaultHeightDots,
                humanReadable: true
            ),
            layout.barcode(valor)
        )
    }

    /// A legenda leva o conteúdo **normalizado**: EAN-13 digitado com doze dígitos sai com o
    /// verificador que o kit calculou, e barras e legenda carregam o mesmo número.
    func testLegendaDoCodigoSaiComOConteudoNormalizado() throws {
        let layout = ReceiptLayout(profile: try perfil())
        let doze = "789100031234"
        let treze = try XCTUnwrap(ThermalBarcode.validate(doze, symbology: .ean13).normalized)

        let cupom = try XCTUnwrap(layout.barcode(doze, symbology: .ean13))
        let legenda = layout.text(treze + "\n", alignment: 1)

        XCTAssertEqual(treze.count, 13)
        XCTAssertTrue(cupom.range(of: legenda) != nil)
    }

    /// Conteúdo que não vira símbolo, e símbolo que não cabe, não viram cupom pela metade.
    func testCodigoInvalidoOuQueNaoCabeDevolveNada() throws {
        let layout = ReceiptLayout(profile: try perfil(paperWidth: .mm58))

        XCTAssertNil(layout.barcode("", symbology: .code128))
        XCTAssertNil(layout.barcode("12345", symbology: .ean13))
        // Cento e vinte e oito caracteres cabem no Code 128 e não cabem em 384 dots.
        XCTAssertNil(layout.barcode(String(repeating: "A", count: 128), symbology: .code128))
    }

    /// O inicializador cru continua permissivo: quem monta layout à mão não tem perfil para
    /// consultar, como já vale para `qrWidthDots` e para a compensação vertical.
    func testLayoutCruAceitaOModoQueOChamadorPedir() {
        let cru = ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: 576,
            qrEmission: .native,
            barcodeEmission: .native
        )

        XCTAssertEqual(cru.qrEmission, .native)
        XCTAssertEqual(cru.barcodeEmission, .native)
    }

    /**
     Campo novo que não entra na igualdade é campo que some numa comparação de layouts — e
     ``ReceiptLayout/decorated(by:)`` e ``ReceiptLayout/emitting(qr:barcode:)`` reconstroem o layout
     campo a campo, que é justamente onde um esquecimento sumiria em silêncio.
     */
    func testModoDeEmissaoEntraNaIgualdadeESobreviveAsReconstrucoes() throws {
        let base = ReceiptLayout(profile: try perfil())
        let nativo = base.emitting(qr: .native, barcode: .native)

        XCTAssertNotEqual(base, nativo)
        XCTAssertEqual(nativo.qrEmission, .native)
        XCTAssertEqual(nativo.barcodeEmission, .native)
        // A decoração não pode devolver o layout ao modo padrão pelo caminho da reconstrução.
        XCTAssertEqual(nativo.decorated(by: nil).qrEmission, .native)
        XCTAssertEqual(nativo.decorated(by: nil).barcodeEmission, .native)
        XCTAssertEqual(base, base.emitting(qr: .rasterized, barcode: .rasterized))
    }
}
