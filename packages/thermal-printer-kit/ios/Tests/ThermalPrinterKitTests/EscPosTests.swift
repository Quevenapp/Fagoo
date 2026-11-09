import CoreImage
import XCTest
@testable import ThermalPrinterKit

final class EscPosTests: XCTestCase {
    func testConsultasGSIIncluemSomenteFirmwareFabricanteEModeloESaneiamResposta() {
        XCTAssertEqual(EscPos.firmwareVersionQuery, Data([0x1d, 0x49, 65]))
        XCTAssertEqual(EscPos.manufacturerQuery, Data([0x1d, 0x49, 66]))
        XCTAssertEqual(EscPos.modelQuery, Data([0x1d, 0x49, 67]))
        XCTAssertEqual(PrinterDeclaredIdentity.sanitizeField(Data("58E_BT".utf8)), "58E_BT")
        XCTAssertNil(PrinterDeclaredIdentity.sanitizeField(Data([0x41, 0x0a, 0x42])))
        XCTAssertNil(PrinterDeclaredIdentity.sanitizeField(Data(repeating: 0x41, count: 65)))
        XCTAssertNil(PrinterDeclaredIdentity.sanitizeField(Data("AA:BB:CC:DD:EE:FF".utf8)))
    }

    func testDrawerKickPulseMatchesAndroidByteForByte() {
        XCTAssertEqual(
            EscPos.drawerKickPulse(pin: 2, onTime: 50, offTime: 250),
            Data([0x1b, 0x70, 0x00, 0x32, 0xfa])
        )
        XCTAssertEqual(
            EscPos.drawerKickPulse(pin: 5, onTime: 0, offTime: 255),
            Data([0x1b, 0x70, 0x01, 0x00, 0xff])
        )
    }

    func testDrawerKickPulseRejectsParametersBeforeByteConversion() {
        for pin in [0, 1, 3, 4, 6, 255] {
            XCTAssertNil(EscPos.drawerKickPulse(pin: pin, onTime: 50, offTime: 250))
        }
        for time in [Int.min, -1, 256, Int.max] {
            XCTAssertNil(EscPos.drawerKickPulse(pin: 2, onTime: time, offTime: 250))
            XCTAssertNil(EscPos.drawerKickPulse(pin: 2, onTime: 50, offTime: time))
        }
    }

    /**
     O QR sai rasterizado e o payload nunca aparece como texto no fluxo ESC/POS.

     Esta é a propriedade que sustenta o cupom: o comando QR nativo (`GS ( k`) é ignorado por parte
     das firmwares baratas, que então imprimem o payload como texto legível — a assinatura Ed25519
     no papel, à vista de quem quiser copiar.
     */
    func testProtectedQRIsRasterAndNeverCarriesItsTokenAsText() throws {
        let qr = try XCTUnwrap(EscPos.qrRaster(payload: protectedQRVector, widthDots: 320))

        // ESC a 1 (centro) · GS v 0 0 · largura 0x28 bytes · faixa de 0x18 linhas.
        XCTAssertEqual(
            Array(qr.prefix(11)),
            [0x1b, 0x61, 0x01, 0x1d, 0x76, 0x30, 0x00, 0x28, 0x00, 0x18, 0x00]
        )
        XCTAssertFalse(contains(qr, Array(protectedQRVector.utf8)))
        XCTAssertFalse(contains(qr, Array("QF1.".utf8)))
        XCTAssertFalse(contains(qr, [0x1d, 0x28, 0x6b]), "o comando QR nativo é proibido")
    }

    /// O raster precisa ser um QR de verdade, não uma mancha: o consumidor lê o papel com a câmera.
    func testRasterQRDecodesBackToTheProtectedPayload() throws {
        let qr = try XCTUnwrap(EscPos.qrRaster(payload: protectedQRVector, widthDots: 320))

        XCTAssertEqual(try decodeRasterQR(qr, widthDots: 320), protectedQRVector)
    }

    func testQRBoundsRejectInvalidDataBeforeItReachesTheWire() {
        XCTAssertNil(EscPos.qrRaster(payload: protectedQRVector, widthDots: 321))
        XCTAssertNil(EscPos.qrRaster(payload: "", widthDots: 320))
        XCTAssertNil(EscPos.qrRaster(payload: protectedQRVector, widthDots: 32))
        XCTAssertNil(EscPos.qrRaster(payload: protectedQRVector, widthDots: 640))
        // Byte fora do ASCII imprimível no payload: o QR carregaria algo que o consumidor não
        // reconstrói igual, e a assinatura falharia na conferência.
        XCTAssertNil(EscPos.qrRaster(payload: "QF1.ção", widthDots: 320))
    }

    func testTextKeepsPortugueseAccentsThroughTheCodePage() {
        let bytes = EscPos.text("OPÇÃO\u{1b}[0m\n", alignment: 0, bold: false, size: 0)

        // `ESC t 2` seleciona CP850 antes do texto: `ESC @` zera a página, então ela precisa ser
        // reafirmada a cada bloco.
        XCTAssertEqual(Array(bytes.prefix(3)), [0x1b, 0x74, 0x02])

        // Ç é 0x80 e Ã é 0xC7 na CP850 — bytes da página, não dobramento para ASCII.
        XCTAssertTrue(contains(bytes, [0x80]), "o C-cedilha precisa virar o byte 0x80 da CP850")
        XCTAssertTrue(contains(bytes, [0xc7]), "o A-til precisa virar o byte 0xC7 da CP850")

        // Caractere de controle continua virando `?`.
        XCTAssertTrue(contains(bytes, Array("?[0m\n".utf8)))
        // E o comportamento antigo, que jogava o acento fora, não pode voltar.
        XCTAssertFalse(contains(bytes, Array("OPCAO".utf8)), "o acento não pode mais ser descartado")
    }

    /// "ção" saía "??o" antes da página de código: dois bytes UTF-8 viravam dois `?` cada acento.
    func testAccentedWordSurvivesEndToEnd() {
        let bytes = EscPos.text("Impressão\n", alignment: 1, bold: false, size: 0)

        XCTAssertTrue(contains(bytes, [0x73, 0xc6, 0x6f]), "\"são\" precisa sair com o ã em 0xC6")
        XCTAssertFalse(contains(bytes, Array("??".utf8)))
    }

    /// Mandar a página errada imprime outra letra; por isso a página vai declarada no cupom.
    func testEachCodePageMapsTheSameLetterToItsOwnByte() {
        let cp850 = EscPos.text("Ã", alignment: 0, bold: false, size: 0, codePage: .cp850)
        let cp860 = EscPos.text("Ã", alignment: 0, bold: false, size: 0, codePage: .cp860)

        XCTAssertEqual(Array(cp850.prefix(3)), [0x1b, 0x74, 0x02])
        XCTAssertEqual(Array(cp860.prefix(3)), [0x1b, 0x74, 0x03])
        XCTAssertTrue(contains(cp850, [0xc7]))
        XCTAssertTrue(contains(cp860, [0x8e]))
    }

    /// O texto acentuado tem que sair byte a byte igual ao do Android, senão o mesmo cupom sai
    /// diferente nas duas plataformas.
    func testCodePageBytesMatchTheAndroidTable() {
        let table: [(Character, UInt8)] = [
            ("Ç", 0x80), ("é", 0x82), ("ç", 0x87), ("ê", 0x88), ("É", 0x90), ("ô", 0x93),
            ("á", 0xa0), ("í", 0xa1), ("ó", 0xa2), ("ú", 0xa3), ("Á", 0xb5), ("Â", 0xb6),
            ("À", 0xb7), ("ã", 0xc6), ("Ã", 0xc7), ("Ê", 0xd2), ("Í", 0xd6), ("Ó", 0xe0),
            ("Ô", 0xe2), ("õ", 0xe4), ("Õ", 0xe5), ("Ú", 0xe9), ("º", 0xa7), ("ª", 0xa6),
        ]

        for (character, expected) in table {
            let bytes = EscPos.text(String(character), alignment: 0, bold: false, size: 0)
            XCTAssertTrue(contains(bytes, [expected]), "\(character) deveria virar 0x\(String(expected, radix: 16))")
        }
    }

    /// Caractere fora da página não pode virar byte aleatório: derruba o acento ou vira `?`.
    func testUnmappedCharacterFallsBackToASCII() {
        let bytes = EscPos.text("Ǎ—Z\u{0007}\n", alignment: 0, bold: false, size: 0)

        // Ǎ não está na CP850: sobra o A. O travessão vira hífen. O BEL vira `?`.
        XCTAssertTrue(contains(bytes, Array("A-Z?\n".utf8)))
    }

    /// A portátil fecha em avanço; a de balcão corta. Trocar isso trava papel numa e desperdiça
    /// meio cupom na outra.
    func testLayoutFinishMatchesThePaper() {
        // Avanço em quebras de linha: a MP-4200 ignora `ESC d` e as oito tiras da sonda de avanço
        // saíam do mesmo tamanho, de zero a doze.
        XCTAssertEqual(Array(ReceiptLayout.portable58mm.finish()), Array(repeating: 0x0a, count: 4))
        XCTAssertEqual(
            Array(ReceiptLayout.counter.finish()),
            Array(repeating: 0x0a, count: 5) + [0x1d, 0x56, 0x00]
        )
        XCTAssertEqual(ReceiptLayout.portable58mm.columns, 32)
        XCTAssertEqual(ReceiptLayout.counter.columns, 48)
    }

    func testCatalogProfileConversionUsesOnlyConservativeDiscoveryBytes() {
        let epson = testReceipt().receiptBytes(
            layout: ReceiptLayout(profile: BundledPrinterProfiles.epsonTmT20xII)
        )
        let elgin = testReceipt().receiptBytes(
            layout: ReceiptLayout(profile: BundledPrinterProfiles.elginI9Full2)
        )

        XCTAssertEqual(epson, elgin)
        XCTAssertEqual(
            Array(ReceiptLayout(profile: BundledPrinterProfiles.elginI9Full2).finish()),
            Array(repeating: 0x0a, count: 4)
        )
        XCTAssertEqual(
            Array(ReceiptLayout(profile: BundledPrinterProfiles.bematechMp4200Th).finish()),
            Array(repeating: 0x0a, count: 4)
        )
    }

    /// A firmware quebra na coluna exata e parte a palavra no meio; o wrap acontece antes.
    func testWrapBreaksOnWordsWithinThePaperWidth() {
        let layout = ReceiptLayout.portable58mm

        XCTAssertEqual(layout.wrap("Quermesse São João"), "Quermesse São João")
        XCTAssertEqual(
            layout.wrap("Refrigerante de guarana lata gelada"),
            "Refrigerante de guarana lata\ngelada"
        )
        XCTAssertTrue(layout.wrap(String(repeating: "A", count: 70)).contains("\n"))
    }

    /// O comprovante de teste é o primeiro papel que sai de cada impressora: ele também respeita a
    /// página de cada uma, senão o teste de hardware acusaria defeito onde não há.
    @MainActor
    func testEachTestReceiptSpeaksItsOwnPrinterCodePage() {
        let bluetooth = BluetoothThermalPrinterController.testReceipt()
        let wifi = LocalWifiThermalPrinterController.testReceipt()

        XCTAssertFalse(contains(bluetooth, [0x1b, 0x74]))
        // Byte alto volta como lixo **no texto** dela; o raster é outro caminho e funciona — o
        // papel da MTP-II sai com QR. A regra vale até onde o `GS v 0` começa.
        XCTAssertNil(textPrefix(bluetooth).first(where: { $0 > 0x7e }))
        XCTAssertTrue(contains(bluetooth, Array("Acentos: acao, opcao, Sao Joao".utf8)))

        XCTAssertTrue(contains(wifi, [0x1b, 0x74, 0x02]))
        XCTAssertTrue(contains(wifi, Array("COMPROVANTE DE TESTE".utf8)))
        XCTAssertFalse(contains(wifi, Array("QRFesta".utf8)))
        // O comprovante passou a repetir o perfil medido em vez de dizer "BALCÃO": "ação" com o ç
        // em 0x87 e o ã em 0xC6 da CP850 é a prova de que ele sai na página da impressora.
        XCTAssertTrue(contains(wifi, [0x61, 0x87, 0xc6, 0x6f]))
    }

    /// Sem página, `EscPos.text` não emite `ESC t` e não deixa passar byte alto nenhum.
    func testTextWithoutACodePageStaysWithinPrintableASCII() {
        let bytes = EscPos.text("OPÇÃO São João º\n", alignment: 0, bold: false, size: 0, codePage: nil)

        XCTAssertFalse(contains(bytes, [0x1b, 0x74]))
        XCTAssertNil(bytes.first(where: { $0 > 0x7e }))
        XCTAssertTrue(contains(bytes, Array("OPCAO Sao Joao".utf8)))
    }

    func testUTF8PreservaAcentosSemEmitirESCT() {
        let sample = "ação, opção, São João"
        let bytes = EscPos.text(
            sample,
            alignment: 0,
            bold: false,
            size: 0,
            codePage: nil,
            textEncoding: .utf8
        )

        XCTAssertFalse(bytes.contains(Data([0x1b, 0x74])))
        XCTAssertTrue(bytes.contains(Data(sample.utf8)))
        XCTAssertTrue(bytes.contains(0xc3))
    }

    /// Reconstrói a imagem a partir das faixas `GS v 0` e lê o QR de volta, como a câmera da
    /// câmera do consumidor faria com o papel.
    private func decodeRasterQR(_ command: Data, widthDots: Int) throws -> String {
        let widthBytes = widthDots / 8
        let quietZone = 32
        let side = widthDots + quietZone * 2
        var pixels = [UInt8](repeating: 0xff, count: side * side)
        let bytes = Array(command)
        var offset = 3
        var outputY = 0
        while outputY < widthDots {
            XCTAssertEqual(Array(bytes[offset..<(offset + 4)]), [0x1d, 0x76, 0x30, 0x00])
            let encodedWidthBytes = Int(bytes[offset + 4]) | (Int(bytes[offset + 5]) << 8)
            let stripeHeight = Int(bytes[offset + 6]) | (Int(bytes[offset + 7]) << 8)
            XCTAssertEqual(encodedWidthBytes, widthBytes)
            let dataOffset = offset + 8
            for stripeY in 0..<stripeHeight {
                for x in 0..<widthDots {
                    let packed = Int(bytes[dataOffset + stripeY * widthBytes + x / 8])
                    let black = packed & (0x80 >> (x % 8)) != 0
                    pixels[(outputY + stripeY + quietZone) * side + x + quietZone] = black ? 0 : 0xff
                }
            }
            outputY += stripeHeight
            offset = dataOffset + widthBytes * stripeHeight
        }

        let gray = try XCTUnwrap(CGColorSpace(name: CGColorSpace.linearGray))
        let context = try XCTUnwrap(
            CGContext(
                data: &pixels,
                width: side,
                height: side,
                bitsPerComponent: 8,
                bytesPerRow: side,
                space: gray,
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            )
        )
        let image = try XCTUnwrap(context.makeImage())
        let detector = try XCTUnwrap(
            CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        )
        let features = detector.features(in: CIImage(cgImage: image)).compactMap { $0 as? CIQRCodeFeature }
        return try XCTUnwrap(features.first?.messageString)
    }

    /// Medido na bancada com a impressora de 80 mm que se apresenta como J-SPEED P80: o `GS I`
    /// dela responde com o rótulo colado no valor. O filtro de identificador técnico roda antes e
    /// depois de tirar o rótulo — `AA:` parece rótulo, e `BB:CC:DD:EE:FF` não parece mais um MAC.
    func testRotuloColadoAoValorNaoEntraNaIdentidade() {
        let identidade = PrinterDeclaredIdentity.fromResponses(
            firmware: Data("_8.00 ESC/POS".utf8),
            manufacturer: Data("_Manufacturer:J-SPEED".utf8),
            model: Data("_Print Name:P80-Serials".utf8)
        )

        XCTAssertEqual(identidade?.manufacturer, "J-SPEED")
        XCTAssertEqual(identidade?.model, "P80-Serials")
        XCTAssertEqual(identidade?.firmwareVersion, "8.00 ESC/POS")

        for bruto in ["AA:BB:CC:DD:EE:FF", "Endereco:192.168.1.150", "MAC:AA:BB:CC:DD:EE:FF"] {
            XCTAssertNil(PrinterDeclaredIdentity.sanitizeField(Data(bruto.utf8)), bruto)
        }
    }

    /// Tudo antes do primeiro `GS v 0`: a parte do cupom que é texto.
    private func textPrefix(_ data: Data) -> Data {
        let raster: [UInt8] = [0x1d, 0x76, 0x30]
        guard let range = data.range(of: Data(raster)) else { return data }
        return data[..<range.lowerBound]
    }
}
