import XCTest
@testable import ThermalPrinterKit

/**
 A régua de módulos e os dois emissores de código.

 **O bloco de paridade é o que mais importa aqui.** Os vetores de `ThermalBarcodeParityVectors` são
 literais idênticos, caractere a caractere, aos de
 `android/src/test/java/br/com/thermalprinterkit/ThermalBarcodeTest.kt`. Não são a saída da
 implementação gravada de volta: saíram de uma referência escrita à parte, a partir da especificação
 de cada simbologia, e o Code 128 de cada um foi **decodificado de volta** ao conteúdo de origem
 antes de virar literal. Quem mudar a régua de um lado só faz esta suíte falhar alto nos dois.

 As seis que chegaram depois — EAN-8, UPC-A, UPC-E, Code 39, Codabar e Code 93 — saíram do mesmo
 método: referência escrita da especificação, decodificador que volta dos módulos ao conteúdo
 conferindo verificador, e cruzamento valor a valor com uma implementação alheia. O UPC-E ganhou
 ainda uma varredura dos 2.000.000 de seis-dígitos, que é de onde vem a regra de canonicidade.

 O que estes testes **não** provam: que um leitor lê o papel, e que alguma firmware aceita `GS k` ou
 `GS ( k`. Isso é bancada, e nada aqui autoriza chamar de verificado.
 */
final class ThermalBarcodeTests: XCTestCase {
    // MARK: - paridade entre plataformas

    func testOsModulosDeCadaVetorSaoOsMesmosDasDuasPlataformas() {
        for vector in ThermalBarcodeParityVectors.all {
            let modules = ThermalBarcode.modules(vector.value, symbology: vector.symbology)
            XCTAssertNotNil(modules, "\(vector.symbology) \(vector.value) não codificou")
            XCTAssertEqual(
                modules.map { $0.map { $0 ? "1" : "0" }.joined() },
                vector.modules,
                "\(vector.symbology) \(vector.value)"
            )
        }
    }

    func testODadoNativoDeCadaVetorEOMesmoDasDuasPlataformas() {
        for vector in ThermalBarcodeParityVectors.all {
            XCTAssertEqual(
                ThermalBarcode.nativeData(vector.value, symbology: vector.symbology),
                vector.nativeData,
                "\(vector.symbology) \(vector.value)"
            )
        }
    }

    func testOComandoNativoDoCode128SaiByteAByteIgualAoDoAndroid() {
        XCTAssertEqual(
            EscPos.barcodeNative(
                value: "PRINTHER",
                symbology: .code128,
                moduleWidthDots: 2,
                heightDots: 80,
                humanReadable: true
            ),
            ThermalBarcodeParityVectors.nativeCode128
        )
    }

    func testOComandoNativoDoEAN13SaiByteAByteIgualAoDoAndroid() {
        XCTAssertEqual(
            EscPos.barcodeNative(
                value: "789100031595",
                symbology: .ean13,
                moduleWidthDots: 3,
                heightDots: 96,
                humanReadable: false
            ),
            ThermalBarcodeParityVectors.nativeEAN13
        )
    }

    func testOComandoNativoDoITFSaiByteAByteIgualAoDoAndroid() {
        XCTAssertEqual(
            EscPos.barcodeNative(
                value: "1234567890",
                symbology: .itf,
                moduleWidthDots: 2,
                heightDots: 24,
                humanReadable: false
            ),
            ThermalBarcodeParityVectors.nativeITF
        )
    }

    func testOQRNativoSaiByteAByteIgualAoDoAndroid() {
        XCTAssertEqual(
            EscPos.qrNative(payload: "PRINTHER", moduleSizeDots: 4, errorCorrection: 3),
            ThermalBarcodeParityVectors.qrNative
        )
    }

    func testORasterDoCodigoDeBarrasSaiByteAByteIgualAoDoAndroid() {
        XCTAssertEqual(
            EscPos.barcodeRaster(
                value: "00",
                symbology: .itf,
                moduleWidthDots: 2,
                heightDots: 24,
                printableDots: 384
            ),
            ThermalBarcodeParityVectors.rasterITF00()
        )
    }

    func testOComandoNativoDoCodabarSaiByteAByteIgualAoDoAndroid() {
        XCTAssertEqual(
            EscPos.barcodeNative(
                value: "a123456789b",
                symbology: .codabar,
                moduleWidthDots: 2,
                heightDots: 48,
                humanReadable: true
            ),
            ThermalBarcodeParityVectors.nativeCodabar
        )
    }

    func testOComandoNativoDoUPCELevaOUPCAExpandido() {
        XCTAssertEqual(
            EscPos.barcodeNative(
                value: "01234565",
                symbology: .upcE,
                moduleWidthDots: 3,
                heightDots: 80,
                humanReadable: false
            ),
            ThermalBarcodeParityVectors.nativeUPCE
        )
    }

    func testORasterDoUPCESaiByteAByteIgualAoDoAndroid() {
        XCTAssertEqual(
            EscPos.barcodeRaster(
                value: "01234565",
                symbology: .upcE,
                moduleWidthDots: 2,
                heightDots: 24,
                printableDots: 384
            ),
            ThermalBarcodeParityVectors.rasterUPCE()
        )
    }

    func testOsRawValueDosEnumsSaoOsMesmosDasDuasPlataformas() {
        XCTAssertEqual(ThermalCodeEmission.allCases.map(\.rawValue), ["RASTERIZED", "NATIVE"])
        XCTAssertEqual(ThermalCodeEmission.default, .rasterized)
        XCTAssertEqual(
            ThermalBarcodeSymbology.allCases.map(\.rawValue),
            [
                "CODE_128", "EAN_13", "ITF", "EAN_8", "UPC_A", "UPC_E",
                "CODE_39", "CODABAR", "CODE_93",
            ]
        )
        // Os mesmos `m` que o interpretador ESC/POS da fachada de Mac já mapeia. Divergir aqui
        // criaria duas verdades sobre o mesmo comando.
        XCTAssertEqual(
            ThermalBarcodeSymbology.allCases.map(\.nativeSelector),
            [73, 67, 70, 68, 65, 66, 69, 71, 72]
        )
        XCTAssertEqual(
            ThermalBarcodeSymbology.allCases.map { [$0.quietZoneModulesStart, $0.quietZoneModulesEnd] },
            [
                [10, 10], [11, 7], [10, 10], [7, 7], [9, 9], [9, 7],
                [10, 10], [10, 10], [10, 10],
            ]
        )
    }

    func testOsLimitesPublicadosSaoOsMesmosDasDuasPlataformas() {
        XCTAssertEqual(ThermalBarcode.moduleWidthDotsRange, 2...6)
        XCTAssertEqual(ThermalBarcode.heightDotsRange, 24...255)
        XCTAssertEqual(ThermalBarcode.defaultHeightDots, 80)
        XCTAssertEqual(ThermalBarcode.code128LengthRange, 1...128)
        XCTAssertEqual(ThermalBarcode.ean13LengthRange, 12...13)
        XCTAssertEqual(ThermalBarcode.itfLengthRange, 2...64)
        XCTAssertEqual(ThermalBarcode.ean8LengthRange, 7...8)
        XCTAssertEqual(ThermalBarcode.upcALengthRange, 11...12)
        XCTAssertEqual(ThermalBarcode.upcELengthRange, 6...8)
        XCTAssertEqual(ThermalBarcode.upcEExpandedLengthRange, 11...12)
        XCTAssertEqual(ThermalBarcode.code39LengthRange, 1...64)
        XCTAssertEqual(ThermalBarcode.codabarLengthRange, 3...64)
        XCTAssertEqual(ThermalBarcode.code93LengthRange, 1...64)
        XCTAssertEqual(
            ThermalBarcode.code39Alphabet,
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%"
        )
        XCTAssertEqual(ThermalBarcode.code93Alphabet, ThermalBarcode.code39Alphabet)
        XCTAssertEqual(ThermalBarcode.codabarDataAlphabet, "0123456789-$:/.+")
        XCTAssertEqual(ThermalBarcode.codabarDelimiters, "ABCD")
        XCTAssertEqual(ThermalBarcode.printableDotsRange, 8...640)
        XCTAssertEqual(ThermalBarcode.qrNativeModuleSizeDotsRange, 1...16)
        XCTAssertEqual(ThermalBarcode.qrNativeErrorCorrectionRange, 1...4)
        XCTAssertEqual(ThermalBarcode.qrNativeMaxBytes, 512)
        XCTAssertEqual(ThermalBarcode.maxNativeDataBytes, 255)
    }

    // MARK: - estrutura de cada simbologia, conferível na régua

    func testOCode128TemOnzeModulosPorValorETrezeNaParada() {
        // Início + dados + verificador = 11 módulos cada; a parada soma 13 pela barra dupla.
        // "PRINTHER" são oito valores de dado no conjunto B: 10 valores de 11 mais 13 = 123.
        XCTAssertEqual(ThermalBarcode.moduleCount("PRINTHER", symbology: .code128), 123)
        // "12345678" entra no conjunto C e vira quatro pares: 6 valores de 11 mais 13 = 79.
        XCTAssertEqual(ThermalBarcode.moduleCount("12345678", symbology: .code128), 79)
    }

    func testOEAN13TemSempreNoventaECincoModulosEAsTresGuardasNoLugar() throws {
        let modules = try XCTUnwrap(ThermalBarcode.modules("5901234123457", symbology: .ean13))
        XCTAssertEqual(modules.count, 95)
        XCTAssertEqual(Array(modules[0..<3]), [true, false, true])
        XCTAssertEqual(Array(modules[45..<50]), [false, true, false, true, false])
        XCTAssertEqual(Array(modules[92..<95]), [true, false, true])
    }

    func testOITFCresceNoveModulosPorDigitoSobreOsNoveDoQuadro() {
        for length in [2, 4, 10, 64] {
            let value = String(repeating: "1", count: length)
            XCTAssertEqual(ThermalBarcode.moduleCount(value, symbology: .itf), 9 + 9 * length)
        }
    }

    func testOEAN8TemSessentaESeteModulosENaoEscondeDigitoNaParidade() throws {
        let modules = try XCTUnwrap(ThermalBarcode.modules("96385074", symbology: .ean8))
        XCTAssertEqual(modules.count, 67)
        XCTAssertEqual(Array(modules[0..<3]), [true, false, true])
        XCTAssertEqual(Array(modules[31..<36]), [false, true, false, true, false])
        XCTAssertEqual(Array(modules[64..<67]), [true, false, true])
    }

    func testOUPCAEOEAN13DeZeroMaisOsDozeENaoOsDozeComoCorpo() throws {
        // A armadilha clássica desta simbologia, fixada em teste: o símbolo do UPC-A é o do EAN-13
        // com um zero na frente — e o verificador é o mesmo dígito, não um recalculado.
        let upcA = try XCTUnwrap(ThermalBarcode.modules("036000291452", symbology: .upcA))
        let ean13 = try XCTUnwrap(ThermalBarcode.modules("0036000291452", symbology: .ean13))
        XCTAssertEqual(upcA.count, 95)
        XCTAssertEqual(upcA, ean13)
        // E tratar os doze do UPC-A como corpo de EAN-13 dá outro número: a prova de que não é a
        // mesma conta.
        XCTAssertEqual(
            ThermalBarcode.validate("036000291452", symbology: .ean13),
            .accepted(normalized: "0360002914522")
        )
    }

    func testOUPCETemCinquentaEUmModulosEAGuardaDeFimDeSeis() throws {
        let modules = try XCTUnwrap(ThermalBarcode.modules("01234565", symbology: .upcE))
        XCTAssertEqual(modules.count, 51)
        XCTAssertEqual(Array(modules[0..<3]), [true, false, true])
        XCTAssertEqual(Array(modules[45..<51]), [false, true, false, true, false, true])
    }

    func testOCode39CresceDezesseisModulosPorCaractereSobreOsTrintaEUmDoQuadro() {
        for value in ["A", "PRINTHER", String(repeating: "A", count: 64)] {
            XCTAssertEqual(
                ThermalBarcode.moduleCount(value, symbology: .code39),
                16 * value.count + 31
            )
        }
    }

    func testOCode93CresceNoveModulosPorCaractereSobreOsTrintaESeteDoQuadro() {
        // Trinta e sete = quatro caracteres de quadro (início, C, K e fim) mais a barra final.
        for value in ["A", "PRINTHER", String(repeating: "A", count: 64)] {
            XCTAssertEqual(
                ThermalBarcode.moduleCount(value, symbology: .code93),
                9 * value.count + 37
            )
        }
    }

    func testOCodabarLevaAsMarcasDeInicioEFimComoDado() {
        // Marca minúscula é a mesma marca, e vira maiúscula no conteúdo normalizado — que é o que
        // vai para o `GS k` e para a legenda.
        XCTAssertEqual(
            ThermalBarcode.validate("a0a", symbology: .codabar),
            .accepted(normalized: "A0A")
        )
        XCTAssertEqual(
            ThermalBarcode.modules("a0a", symbology: .codabar),
            ThermalBarcode.modules("A0A", symbology: .codabar)
        )
        // Marcas diferentes dão símbolos diferentes: elas **são** dado.
        XCTAssertNotEqual(
            ThermalBarcode.modules("A0A", symbology: .codabar),
            ThermalBarcode.modules("A0B", symbology: .codabar)
        )
    }

    func testOSimboloComecaETerminaEmBarraNasNoveSimbologias() throws {
        for vector in ThermalBarcodeParityVectors.all {
            let modules = try XCTUnwrap(
                ThermalBarcode.modules(vector.value, symbology: vector.symbology)
            )
            XCTAssertTrue(modules.first == true, "\(vector.symbology) \(vector.value)")
            XCTAssertTrue(modules.last == true, "\(vector.symbology) \(vector.value)")
        }
    }

    // MARK: - validação e frases

    func testConteudoVazioERecusadoEmQualquerSimbologia() {
        for symbology in ThermalBarcodeSymbology.allCases {
            XCTAssertEqual(ThermalBarcode.validate("", symbology: symbology), .rejected(reason: .empty))
        }
        XCTAssertEqual(ThermalBarcodeRejection.empty.message, "Digite o conteúdo do código.")
    }

    func testOCode128RecusaAcentoERecusaAcimaDeCentoEVinteEOitoCaracteres() {
        XCTAssertEqual(
            ThermalBarcode.validate("ação", symbology: .code128),
            .rejected(reason: .nonASCII)
        )
        XCTAssertEqual(
            ThermalBarcodeRejection.nonASCII.message,
            "O código aceita apenas letras e números sem acento."
        )
        XCTAssertEqual(
            ThermalBarcode.validate(String(repeating: "A", count: 128), symbology: .code128),
            .accepted(normalized: String(repeating: "A", count: 128))
        )
        XCTAssertEqual(
            ThermalBarcode.validate(String(repeating: "A", count: 129), symbology: .code128),
            .rejected(reason: .tooLong(max: 128))
        )
        XCTAssertEqual(
            ThermalBarcodeRejection.tooLong(max: 128).message,
            "O código aceita no máximo 128 caracteres."
        )
    }

    func testOEAN13CalculaOVerificadorDeDozeDigitosEConfereODeTreze() {
        XCTAssertEqual(
            ThermalBarcode.validate("789100031595", symbology: .ean13),
            .accepted(normalized: "7891000315958")
        )
        XCTAssertEqual(
            ThermalBarcode.validate("7891000315958", symbology: .ean13),
            .accepted(normalized: "7891000315958")
        )
        XCTAssertEqual(
            ThermalBarcode.validate("7891000315957", symbology: .ean13),
            .rejected(reason: .badCheckDigit)
        )
        XCTAssertEqual(
            ThermalBarcodeRejection.badCheckDigit.message,
            "O dígito verificador não confere."
        )
    }

    func testOEAN13RecusaComprimentoForaDeDozeOuTrezeERecusaLetra() {
        for value in ["1", "12345678901", "12345678901234"] {
            XCTAssertEqual(
                ThermalBarcode.validate(value, symbology: .ean13),
                .rejected(reason: .wrongLength(expected: "12 ou 13 dígitos")),
                value
            )
        }
        XCTAssertEqual(
            ThermalBarcodeRejection.wrongLength(expected: "12 ou 13 dígitos").message,
            "Este código precisa de 12 ou 13 dígitos."
        )
        XCTAssertEqual(
            ThermalBarcode.validate("78910003159A", symbology: .ean13),
            .rejected(reason: .nonDigit)
        )
        XCTAssertEqual(
            ThermalBarcodeRejection.nonDigit.message,
            "Este código aceita apenas dígitos."
        )
    }

    func testOITFRecusaComprimentoImparEmVezDeCompletarComZero() {
        XCTAssertEqual(
            ThermalBarcode.validate("12345", symbology: .itf),
            .rejected(reason: .wrongLength(expected: "um número par de dígitos, de 2 a 64"))
        )
        XCTAssertEqual(
            ThermalBarcodeRejection.wrongLength(
                expected: "um número par de dígitos, de 2 a 64"
            ).message,
            "Este código precisa de um número par de dígitos, de 2 a 64."
        )
        XCTAssertEqual(
            ThermalBarcode.validate("12AB", symbology: .itf),
            .rejected(reason: .nonDigit)
        )
        XCTAssertNil(ThermalBarcode.modules("12345", symbology: .itf))
    }

    func testOEAN8EOUPCACalculamOVerificadorEConferemOQueVeio() {
        XCTAssertEqual(
            ThermalBarcode.validate("9638507", symbology: .ean8),
            .accepted(normalized: "96385074")
        )
        XCTAssertEqual(
            ThermalBarcode.validate("96385075", symbology: .ean8),
            .rejected(reason: .badCheckDigit)
        )
        XCTAssertEqual(
            ThermalBarcode.validate("963850", symbology: .ean8),
            .rejected(reason: .wrongLength(expected: "7 ou 8 dígitos"))
        )
        XCTAssertEqual(
            ThermalBarcode.validate("03600029145", symbology: .upcA),
            .accepted(normalized: "036000291452")
        )
        XCTAssertEqual(
            ThermalBarcode.validate("036000291453", symbology: .upcA),
            .rejected(reason: .badCheckDigit)
        )
        XCTAssertEqual(
            ThermalBarcode.validate("0360002914", symbology: .upcA),
            .rejected(reason: .wrongLength(expected: "11 ou 12 dígitos"))
        )
    }

    func testOUPCEAceitaAsDuasFormasERecusaOQueNaoTemForma() {
        // Seis dígitos, sistema numérico assumido 0.
        XCTAssertEqual(
            ThermalBarcode.validate("042526", symbology: .upcE),
            .accepted(normalized: "00425261")
        )
        // O UPC-A equivalente diz o mesmo número.
        XCTAssertEqual(
            ThermalBarcode.validate("042100005264", symbology: .upcE),
            .accepted(normalized: "04252614")
        )
        XCTAssertEqual(
            ThermalBarcode.validate("04210000526", symbology: .upcE),
            .accepted(normalized: "04252614")
        )
        // UPC-A cujos zeros não estão onde a compressão exige não tem forma UPC-E.
        XCTAssertEqual(
            ThermalBarcode.validate("036000291452", symbology: .upcE),
            .rejected(reason: .notCompressible)
        )
        // Sistema numérico fora de 0 e 1 também não.
        XCTAssertEqual(
            ThermalBarcode.validate("2425261", symbology: .upcE),
            .rejected(reason: .notCompressible)
        )
        // **Não canônico**: `000003` e `000000` expandem para o mesmo UPC-A, e a firmware que
        // recebe o `GS k m=66` desenharia o segundo. Recusar é o que mantém raster e nativo iguais.
        XCTAssertEqual(
            ThermalBarcode.validate("000003", symbology: .upcE),
            .rejected(reason: .notCompressible)
        )
        XCTAssertEqual(
            ThermalBarcode.validate("000000", symbology: .upcE),
            .accepted(normalized: "00000000")
        )
        XCTAssertEqual(
            ThermalBarcodeRejection.notCompressible.message,
            "Este número não tem forma UPC-E."
        )
        XCTAssertEqual(
            ThermalBarcode.validate("0123456789", symbology: .upcE),
            .rejected(
                reason: .wrongLength(expected: "6, 7 ou 8 dígitos, ou 11 ou 12 dígitos na forma UPC-A")
            )
        )
    }

    func testOCode39EOCode93RecusamMinusculaERecusamOAsterisco() {
        let allowed = "dígitos, letras maiúsculas e os sinais - . espaço $ / + %"
        for symbology in [ThermalBarcodeSymbology.code39, .code93] {
            XCTAssertEqual(
                ThermalBarcode.validate("abc", symbology: symbology),
                .rejected(reason: .unsupportedContent(allowed: allowed)),
                symbology.rawValue
            )
            // O `*` é marca de quadro, não conteúdo — e o `GS k m=69` também não o aceita.
            XCTAssertEqual(
                ThermalBarcode.validate("A*B", symbology: symbology),
                .rejected(reason: .unsupportedContent(allowed: allowed)),
                symbology.rawValue
            )
            XCTAssertEqual(
                ThermalBarcode.validate("AB-12. $/+%", symbology: symbology),
                .accepted(normalized: "AB-12. $/+%"),
                symbology.rawValue
            )
        }
        XCTAssertEqual(
            ThermalBarcodeRejection.unsupportedContent(allowed: allowed).message,
            "Este código aceita apenas dígitos, letras maiúsculas e os sinais - . espaço $ / + %."
        )
    }

    func testOCodabarExigeMarcaNasDuasPontasEAlfabetoProprioNoMiolo() {
        let allowed = "dígitos e os sinais - $ : / . + entre as marcas A, B, C ou D"
        XCTAssertEqual(
            ThermalBarcode.validate("123456", symbology: .codabar),
            .rejected(reason: .unsupportedContent(allowed: allowed))
        )
        XCTAssertEqual(
            ThermalBarcode.validate("A12E", symbology: .codabar),
            .rejected(reason: .unsupportedContent(allowed: allowed))
        )
        // Marca no meio também não: ela só existe nas pontas.
        XCTAssertEqual(
            ThermalBarcode.validate("A1B2C", symbology: .codabar),
            .rejected(reason: .unsupportedContent(allowed: allowed))
        )
        XCTAssertEqual(
            ThermalBarcode.validate("AB", symbology: .codabar),
            .rejected(
                reason: .wrongLength(
                    expected: "de 3 a 64 caracteres, contando as marcas de início e fim"
                )
            )
        )
        XCTAssertEqual(
            ThermalBarcode.validate("A-$:/.+0B", symbology: .codabar),
            .accepted(normalized: "A-$:/.+0B")
        )
    }

    func testARecusaPorLarguraTemFrasePropriaPorqueQuemSabeALarguraEOLayout() {
        XCTAssertEqual(
            ThermalBarcodeRejection.doesNotFit.message,
            "O código não cabe na largura desta impressora."
        )
    }

    // MARK: - codificar para medir

    func testALarguraDeModuloSaiDaDivisaoDaAreaImprimivelPelaContagem() {
        // "12345678" tem 79 módulos e 20 de zona: 99 no total. 384 / 99 = 3.
        XCTAssertEqual(
            ThermalBarcode.moduleWidthDots("12345678", symbology: .code128, printableDots: 384),
            3
        )
        // O teto de seis vale mesmo em papel largo: 640 / 47 seriam 13.
        XCTAssertEqual(
            ThermalBarcode.moduleWidthDots("00", symbology: .itf, printableDots: 640),
            6
        )
    }

    func testCodigoQueNaoCabeNemNoModuloMinimoDevolveNulo() {
        // 64 dígitos de ITF são 585 módulos e 605 com zona: nem dois pontos por módulo cabem em 640.
        XCTAssertNil(
            ThermalBarcode.moduleWidthDots(
                String(repeating: "12", count: 32), symbology: .itf, printableDots: 640
            )
        )
        // "00" com zona são 47 módulos; a dois pontos são 94, e 88 não os comporta.
        XCTAssertNil(ThermalBarcode.moduleWidthDots("00", symbology: .itf, printableDots: 88))
        // Largura que não é múltiplo de oito não empacota, mesmo com folga de sobra.
        XCTAssertNil(ThermalBarcode.moduleWidthDots("00", symbology: .itf, printableDots: 380))
    }

    // MARK: - emissores crus dizem não

    func testORasterRecusaNumeroForaDaFaixaEmVezDeEmitirBarraTorta() {
        XCTAssertNotNil(
            EscPos.barcodeRaster(
                value: "PRINTHER",
                symbology: .code128,
                moduleWidthDots: 2,
                heightDots: 80,
                printableDots: 384
            )
        )
        for width in [1, 7] {
            XCTAssertNil(
                EscPos.barcodeRaster(
                    value: "PRINTHER", symbology: .code128,
                    moduleWidthDots: width, heightDots: 80, printableDots: 384
                )
            )
        }
        for height in [23, 256] {
            XCTAssertNil(
                EscPos.barcodeRaster(
                    value: "PRINTHER", symbology: .code128,
                    moduleWidthDots: 2, heightDots: height, printableDots: 384
                )
            )
        }
        // Largura que não é múltiplo de oito não empacota, e 648 passa do papel homologável.
        for printable in [380, 648] {
            XCTAssertNil(
                EscPos.barcodeRaster(
                    value: "PRINTHER", symbology: .code128,
                    moduleWidthDots: 2, heightDots: 80, printableDots: printable
                )
            )
        }
        // Conteúdo recusado pela simbologia nunca vira bytes.
        XCTAssertNil(
            EscPos.barcodeRaster(
                value: "12345", symbology: .itf,
                moduleWidthDots: 2, heightDots: 80, printableDots: 384
            )
        )
        // Símbolo que não cabe na largura também não.
        XCTAssertNil(
            EscPos.barcodeRaster(
                value: "PRINTHER", symbology: .code128,
                moduleWidthDots: 6, heightDots: 80, printableDots: 384
            )
        )
    }

    func testONativoRecusaNumeroForaDaFaixaEmVezDeMontarComandoTorto() {
        XCTAssertNil(
            EscPos.barcodeNative(
                value: "PRINTHER", symbology: .code128,
                moduleWidthDots: 1, heightDots: 80, humanReadable: false
            )
        )
        XCTAssertNil(
            EscPos.barcodeNative(
                value: "PRINTHER", symbology: .code128,
                moduleWidthDots: 2, heightDots: 256, humanReadable: false
            )
        )
        // Verificador errado não vira comando: o `GS k` sairia com um número que nenhum leitor
        // aceita, e a firmware não confere nada por nós.
        XCTAssertNil(
            EscPos.barcodeNative(
                value: "7891000315957", symbology: .ean13,
                moduleWidthDots: 2, heightDots: 80, humanReadable: false
            )
        )
    }

    func testOQRNativoRecusaPayloadVazioAcentuadoOuForaDosLimites() {
        XCTAssertNil(EscPos.qrNative(payload: "", moduleSizeDots: 4, errorCorrection: 3))
        XCTAssertNil(EscPos.qrNative(payload: "ação", moduleSizeDots: 4, errorCorrection: 3))
        XCTAssertNil(
            EscPos.qrNative(
                payload: String(repeating: "A", count: 513), moduleSizeDots: 4, errorCorrection: 3
            )
        )
        XCTAssertNil(EscPos.qrNative(payload: "PRINTHER", moduleSizeDots: 0, errorCorrection: 3))
        XCTAssertNil(EscPos.qrNative(payload: "PRINTHER", moduleSizeDots: 17, errorCorrection: 3))
        XCTAssertNil(EscPos.qrNative(payload: "PRINTHER", moduleSizeDots: 4, errorCorrection: 0))
        XCTAssertNil(EscPos.qrNative(payload: "PRINTHER", moduleSizeDots: 4, errorCorrection: 5))
    }

    func testONivelDeCorrecaoDoQRNativoVaiComoQuarentaEOitoMaisONivel() throws {
        for (level, byte) in [(1, 0x30), (2, 0x31), (3, 0x32), (4, 0x33)] {
            let command = try XCTUnwrap(
                EscPos.qrNative(payload: "PRINTHER", moduleSizeDots: 4, errorCorrection: level)
            )
            // O byte da função 169 é o último do segundo bloco: 3 do `ESC a 1` mais os 8 da 167.
            XCTAssertEqual(Int(command[3 + 8 + 7]), byte, "\(level)")
        }
    }

    /**
     O lado do QR **não** é vetor de paridade, e não pode virar um.

     O Android consulta o ZXing no nível pedido; este lado consulta o `CIFilter`, fixo em Q. A
     dívida do QR é antiga, está registrada e não é desta frente — a paridade que esta suíte
     garante é a das barras. O que se confere aqui é só que o número devolvido é o lado de um
     símbolo real, sem a zona de silêncio que o gerador acrescenta.
     */
    func testOLadoDoQRSemZonaDeSilencioEODoSimbolo() throws {
        // Versão 1 tem 21 módulos de lado, e um payload de um byte cabe nela.
        XCTAssertEqual(EscPos.qrModuleSide(payload: "A"), 21)
        XCTAssertNil(EscPos.qrModuleSide(payload: ""))
        XCTAssertNil(EscPos.qrModuleSide(payload: "ação"))
        // Payload maior obriga versão maior, e o lado cresce de quatro em quatro.
        let bigger = try XCTUnwrap(EscPos.qrModuleSide(payload: String(repeating: "A", count: 200)))
        XCTAssertGreaterThan(bigger, 21)
        XCTAssertEqual(bigger % 4, 1)
    }

    // MARK: - o mesmo símbolo nos dois modos

    func testOConjuntoCEscolhidoPeloDesenhoEOMesmoQueViajaNoEscapeNativo() {
        // Quatro dígitos ou mais em corrida par entram em C; a régua e o `GS k` têm de concordar,
        // senão o mesmo texto sairia com dois símbolos conforme o ajuste de emissão.
        XCTAssertEqual(
            ThermalBarcode.nativeData("12345678", symbology: .code128),
            [0x7b, 0x43, 12, 34, 56, 78]
        )
        // Corrida ímpar sai com o primeiro dígito em B e o resto em C, sem sobra.
        XCTAssertEqual(
            ThermalBarcode.nativeData("123456789", symbology: .code128),
            [0x7b, 0x42, 0x31, 0x7b, 0x43, 23, 45, 67, 89]
        )
        // Menos de quatro dígitos não compensa trocar de conjunto, exceto o par sozinho.
        XCTAssertEqual(
            ThermalBarcode.nativeData("123", symbology: .code128),
            [0x7b, 0x42, 0x31, 0x32, 0x33]
        )
        XCTAssertEqual(
            ThermalBarcode.nativeData("12", symbology: .code128),
            [0x7b, 0x43, 12]
        )
    }

    func testAChaveDoConteudoSaiDobradaPorqueElaEOEscapeDoProtocolo() {
        XCTAssertEqual(
            ThermalBarcode.nativeData("{q}", symbology: .code128),
            [0x7b, 0x42, 0x7b, 0x7b, 0x71, 0x7d]
        )
    }

    func testOEAN13NativoViajaComOsTrezeDigitosQueODesenhoUsou() {
        XCTAssertEqual(
            ThermalBarcode.nativeData("789100031595", symbology: .ean13),
            Array("7891000315958".utf8)
        )
    }

    func testORasterDoMesmoConteudoTemALarguraQueAContagemDeModulosPreviu() throws {
        // 27 módulos de "00" mais 20 de zona, a dois pontos, são 94 pontos — e 96 empacotados.
        let command = try XCTUnwrap(
            EscPos.barcodeRaster(
                value: "00", symbology: .itf,
                moduleWidthDots: 2, heightDots: 24, printableDots: 384
            )
        )
        // `ESC a 1` e então `GS v 0 0 xL xH yL yH`.
        XCTAssertEqual(Int(command[3 + 4]), 96 / 8)
        XCTAssertEqual(Int(command[3 + 5]), 0)
        XCTAssertEqual(Int(command[3 + 6]), 24)
    }
}

/**
 Os vetores fixos da paridade Android–iOS.

 **Estes literais são idênticos aos de `ThermalBarcodeTest.kt`.** Quem alterar um altera o outro no
 mesmo commit, ou as duas suítes discordam — que é exatamente o que se quer que aconteça quando as
 réguas divergirem.
 */
enum ThermalBarcodeParityVectors {
    struct Vector {
        let symbology: ThermalBarcodeSymbology
        let value: String
        let modules: String
        let nativeData: [UInt8]

        init(_ symbology: ThermalBarcodeSymbology, _ value: String, _ modules: String, _ native: [UInt8]) {
            self.symbology = symbology
            self.value = value
            self.modules = modules
            self.nativeData = native
        }
    }

    static let all: [Vector] = [
        Vector(
            .code128,
            "PRINTHER",
            "110100100001110111011011000101110110001000101011100011011011100010110001010001"
                + "000110100011000101110101100001001100011101011",
            [123, 66, 80, 82, 73, 78, 84, 72, 69, 82]
        ),
        Vector(
            .code128,
            "12345678",
            "110100111001011001110010001011000111000101101100001010010001110110110001110"
                + "1011",
            [123, 67, 12, 34, 56, 78]
        ),
        Vector(
            .code128,
            "A1",
            "110100100001010001100010011100110100001001101100011101011",
            [123, 66, 65, 49]
        ),
        Vector(
            .code128,
            "{q}",
            "11010010000111101101101001011110010100011110110011100101100011101011",
            [123, 66, 123, 123, 113, 125]
        ),
        Vector(
            .code128,
            "AB1234567CD",
            "110100100001010001100010001011000100111001101011101111011101101110101110110"
                + "0010000101100101111011101000100011010110001000111101010001100011101011",
            [123, 66, 65, 66, 49, 123, 67, 23, 45, 67, 123, 66, 67, 68]
        ),
        Vector(
            .ean13,
            "789100031595",
            "10101101110010111001100101001110001101010011101010100001011001101001110111010"
                + "010011101001000101",
            [55, 56, 57, 49, 48, 48, 48, 51, 49, 53, 57, 53, 56]
        ),
        Vector(
            .ean13,
            "5901234123457",
            "10100010110100111011001100100110111101001110101010110011011011001000010101110"
                + "010011101000100101",
            [53, 57, 48, 49, 50, 51, 52, 49, 50, 51, 52, 53, 55]
        ),
        Vector(
            .itf,
            "1234567890",
            "101011101000101011100011101110100010100011101000111000101010001010111000111010"
                + "111010001110001011101",
            [49, 50, 51, 52, 53, 54, 55, 56, 57, 48]
        ),
        Vector(
            .itf,
            "00",
            "101010101110001110001011101",
            [48, 48]
        ),
        Vector(
            .ean8,
            "9638507",
            "1010001011010111101111010110111010101001110111001010001001011100101",
            [57, 54, 51, 56, 53, 48, 55, 52]
        ),
        Vector(
            .ean8,
            "12345670",
            "1010011001001001101111010100011010101001110101000010001001110010101",
            [49, 50, 51, 52, 53, 54, 55, 48]
        ),
        Vector(
            .upcA,
            "03600029145",
            "1010001101011110101011110001101000110100011010101011011001110100110011010111"
                + "0010011101101100101",
            [48, 51, 54, 48, 48, 48, 50, 57, 49, 52, 53, 50]
        ),
        Vector(
            .upcA,
            "012345678905",
            "1010001101001100100100110111101010001101100010101010100001000100100100011101"
                + "0011100101001110101",
            [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 53]
        ),
        Vector(
            .upcE,
            "01234565",
            "101011001100100110111101001110101110010101111010101",
            [48, 49, 50, 51, 52, 53, 48, 48, 48, 48, 54, 53]
        ),
        Vector(
            .upcE,
            "042526",
            "101010011100111010010011011100100100110101111010101",
            [48, 48, 52, 50, 53, 50, 48, 48, 48, 48, 54, 49]
        ),
        Vector(
            .upcE,
            "042100005264",
            "101001110100100110111001001101101011110011001010101",
            [48, 52, 50, 49, 48, 48, 48, 48, 53, 50, 54, 52]
        ),
        // Sistema numérico 1: a tabela de paridade inverte inteira, e é a única diferença.
        Vector(
            .upcE,
            "1425261",
            "101010001100100110111001001001100001010110011010101",
            [49, 52, 50, 49, 48, 48, 48, 48, 53, 50, 54, 49]
        ),
        Vector(
            .code39,
            "PRINTHER",
            "1000101110111010101110111010001011101010111000101011101000111010101011101000"
                + "1110101011101110001011101010001110101110101110001010111010101110001010001011"
                + "1011101",
            [80, 82, 73, 78, 84, 72, 69, 82]
        ),
        Vector(
            .code39,
            "ABC-123",
            "1000101110111010111010100010111010111010001011101110111010001010100010101110"
                + "1110111010001010111010111000101011101110111000101010100010111011101",
            [65, 66, 67, 45, 49, 50, 51]
        ),
        Vector(
            .code39,
            "A",
            "10001011101110101110101000101110100010111011101",
            [65]
        ),
        Vector(
            .codabar,
            "A123456789B",
            "1011100010001010101110001010100010111011100010101010111010001011101010001010"
                + "00101011101000101110101000111010101110100010101000100010111",
            [65, 49, 50, 51, 52, 53, 54, 55, 56, 57, 66]
        ),
        Vector(
            .codabar,
            "C40156B",
            "1010001000111010111010001010101000111010101110001011101010001010001010111010"
                + "00100010111",
            [67, 52, 48, 49, 53, 54, 66]
        ),
        Vector(
            .code93,
            "PRINTHER",
            "1010111101000101101101100101011000101010001101101001101011001001100100101101"
                + "100101001110101100010101010111101",
            [80, 82, 73, 78, 84, 72, 69, 82]
        ),
        Vector(
            .code93,
            "TEST93",
            "1010111101101001101100100101101011001101001101000010101010000101011101101001"
                + "000101010111101",
            [84, 69, 83, 84, 57, 51]
        ),
        Vector(
            .code93,
            "A",
            "1010111101101010001101010001100101101010111101",
            [65]
        ),
    ]

    static let nativeCode128 = Data([
        0x1b, 0x61, 0x01, 0x1d, 0x68, 0x50, 0x1d, 0x77, 0x02, 0x1d, 0x48, 0x02, 0x1d, 0x66,
        0x00, 0x1d, 0x6b, 0x49, 0x0a, 0x7b, 0x42, 0x50, 0x52, 0x49, 0x4e, 0x54, 0x48, 0x45,
        0x52, 0x1b, 0x61, 0x00,
    ])

    static let nativeEAN13 = Data([
        0x1b, 0x61, 0x01, 0x1d, 0x68, 0x60, 0x1d, 0x77, 0x03, 0x1d, 0x48, 0x00, 0x1d, 0x66,
        0x00, 0x1d, 0x6b, 0x43, 0x0d, 0x37, 0x38, 0x39, 0x31, 0x30, 0x30, 0x30, 0x33, 0x31,
        0x35, 0x39, 0x35, 0x38, 0x1b, 0x61, 0x00,
    ])

    static let nativeITF = Data([
        0x1b, 0x61, 0x01, 0x1d, 0x68, 0x18, 0x1d, 0x77, 0x02, 0x1d, 0x48, 0x00, 0x1d, 0x66,
        0x00, 0x1d, 0x6b, 0x46, 0x0a, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
        0x30, 0x1b, 0x61, 0x00,
    ])

    static let qrNative = Data([
        0x1b, 0x61, 0x01, 0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x04, 0x1d, 0x28, 0x6b,
        0x03, 0x00, 0x31, 0x45, 0x32, 0x1d, 0x28, 0x6b, 0x0b, 0x00, 0x31, 0x50, 0x30, 0x50,
        0x52, 0x49, 0x4e, 0x54, 0x48, 0x45, 0x52, 0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51,
        0x30, 0x1b, 0x61, 0x00,
    ])

    static let nativeCodabar = Data([
        0x1b, 0x61, 0x01, 0x1d, 0x68, 0x30, 0x1d, 0x77, 0x02, 0x1d, 0x48, 0x02, 0x1d, 0x66,
        0x00, 0x1d, 0x6b, 0x47, 0x0b, 0x41, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
        0x39, 0x42, 0x1b, 0x61, 0x00,
    ])

    /**
     O `GS k m=66` leva o **UPC-A expandido**, e não os oito comprimidos.

     `01234565` vira `012345000065`, doze bytes: é a especificação do comando que pede assim, e é a
     firmware que comprime. Este vetor é o que prova que o kit não mandou o número errado.
     */
    static let nativeUPCE = Data([
        0x1b, 0x61, 0x01, 0x1d, 0x68, 0x50, 0x1d, 0x77, 0x03, 0x1d, 0x48, 0x00, 0x1d, 0x66,
        0x00, 0x1d, 0x6b, 0x42, 0x0c, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x30, 0x30, 0x30,
        0x30, 0x36, 0x35, 0x1b, 0x61, 0x00,
    ])

    /**
     A linha empacotada do UPC-E `01234565` a dois pontos por módulo, em papel de 384 pontos.

     Dezessete bytes. As zonas de silêncio do UPC-E são **assimétricas** — nove módulos à esquerda e
     sete à direita —, e é isso que este vetor fixa: 51 módulos mais 16 de zona dão 134 pontos, que
     sobem para 136 no múltiplo de oito, com o ponto de sobra dividido entre os dois lados.
     */
    private static let rasterUPCERow: [UInt8] = [
        0x00, 0x00, 0x19, 0x9e, 0x1e, 0x18, 0x79, 0xfe, 0x61, 0xf9, 0x9f, 0x86,
        0x67, 0xf9, 0x99, 0x80, 0x00,
    ]

    /// `ESC a 1`, uma banda `GS v 0` de 24 linhas iguais, e o `ESC a 0` que devolve o estado.
    static func rasterUPCE() -> Data {
        var command = Data([0x1b, 0x61, 0x01, 0x1d, 0x76, 0x30, 0x00, 0x11, 0x00, 0x18, 0x00])
        for _ in 0..<24 { command.append(contentsOf: rasterUPCERow) }
        command.append(contentsOf: [0x1b, 0x61, 0x00])
        return command
    }

    /**
     A linha empacotada do ITF "00" a dois pontos por módulo, em papel de 384 pontos.

     Doze bytes: dois zerados à esquerda e dois à direita são a zona de silêncio de dez módulos mais
     o ponto de sobra do arredondamento para múltiplo de oito.
     */
    private static let rasterITF00Row: [UInt8] = [
        0x00, 0x00, 0x06, 0x66, 0x67, 0xe0, 0x7e, 0x06, 0x7e, 0x60, 0x00, 0x00,
    ]

    /// `ESC a 1`, uma banda `GS v 0` de 24 linhas iguais, e o `ESC a 0` que devolve o estado.
    static func rasterITF00() -> Data {
        var command = Data([0x1b, 0x61, 0x01, 0x1d, 0x76, 0x30, 0x00, 0x0c, 0x00, 0x18, 0x00])
        for _ in 0..<24 { command.append(contentsOf: rasterITF00Row) }
        command.append(contentsOf: [0x1b, 0x61, 0x00])
        return command
    }
}
