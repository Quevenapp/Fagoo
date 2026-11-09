import CoreGraphics
import CryptoKit
import XCTest
@testable import ThermalPrinterKit

final class ThermalRasterTests: XCTestCase {
    func testEmissorTransformaXadrezOitoPorOitoNosBytesExatos() throws {
        let pixels = (0..<8).flatMap { y in
            (0..<8).map { x in (x + y).isMultiple(of: 2) }
        }
        var matrix = OneBitRasterMatrix(widthDots: 8, heightDots: 8, pixels: pixels)

        let command = try XCTUnwrap(
            EscPosRasterEmitter.emit(source: &matrix, alignment: nil)
        )

        XCTAssertEqual(
            [UInt8](command),
            [0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x08, 0x00] +
                [0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55]
        )
    }

    func testFalhaNaSegundaFaixaLimpaOScratchDaFonte() {
        let tracker = RasterCleanupTracker()
        var source = FailingSecondStripeSource(tracker: tracker)

        XCTAssertNil(EscPosRasterEmitter.emit(source: &source, alignment: 1))
        XCTAssertEqual(tracker.requestedStarts, [0, 24])
        XCTAssertTrue(tracker.didClearScratch)
    }

    func testFaixaComTamanhoErradoTambemPercorreALimpeza() {
        let tracker = RasterCleanupTracker()
        var source = WrongSizedSecondStripeSource(tracker: tracker)

        XCTAssertNil(EscPosRasterEmitter.emit(source: &source, alignment: 1))
        XCTAssertEqual(tracker.requestedStarts, [0, 24])
        XCTAssertTrue(tracker.didClearScratch)
    }

    /**
     O fio do M1 continua intacto, e o que mudou é só o alinhamento voltar depois do raster.

     O digest histórico é conferido no fio **sem os três bytes finais**, e é essa separação que dá
     valor ao teste: ela distingue "o raster mudou" — que seria papel diferente e precisaria de
     bancada — de "o emissor devolveu o estado que tomou", que é o que aconteceu.
     */
    func testExtracaoDoEmissorPreservaOQRByteAByte() throws {
        let qr = try XCTUnwrap(EscPos.qrRaster(payload: protectedQRVector, widthDots: 320))

        XCTAssertEqual(Array(qr.suffix(3)), [0x1b, 0x61, 0x00])
        let historico = SHA256.hash(data: qr.dropLast(3)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(historico, "93f3949c73d499ed2de9127d0ae65d23e8a28ca8d56518826e14df8cc0583639")

        let digest = SHA256.hash(data: qr).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(digest, "e79a32d70566cfbfaf75717c7c0c2684b91e5c36c4b0b55c1bdcd0083822a094")
    }

    func testImagemEstreitaNaoEAmpliadaELimiarFicaFixoEm128() throws {
        let cgImage = try grayscaleImage(width: 2, height: 1, pixels: [127, 128])
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))
        let command = try XCTUnwrap(
            ReceiptLayout.portable58mm.imageRaster(image: image, mode: .threshold)
        )
        let stripes = try rasterStripes(command)

        XCTAssertEqual(stripes.count, 1)
        XCTAssertEqual(stripes[0].widthBytes, 1)
        XCTAssertEqual(stripes[0].height, 1)
        // Dois pontos permanecem dois pontos, centralizados nos oito bits exigidos por GS v 0.
        // 127 é preto e 128 é branco: o limiar não depende de imagem nem de perfil.
        XCTAssertEqual(stripes[0].pixels, [0x10])
    }

    func testImagemLargaReduzSemCortarEMantemProporcaoAte640Dots() throws {
        let sourceWidth = 800
        let sourceHeight = 80
        let cgImage = try grayscaleImage(
            width: sourceWidth,
            height: sourceHeight,
            pixels: [UInt8](repeating: 0, count: sourceWidth * sourceHeight)
        )
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))
        let layout = ReceiptLayout(
            columns: 64,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: 640
        )
        let command = try XCTUnwrap(layout.imageRaster(image: image, mode: .threshold))
        let stripes = try rasterStripes(command)

        XCTAssertEqual(stripes.map(\.widthBytes), [80, 80, 80])
        XCTAssertEqual(stripes.map(\.height), [24, 24, 16])
        XCTAssertEqual(stripes.reduce(0) { $0 + $1.height }, 64)
        XCTAssertTrue(stripes.flatMap(\.pixels).allSatisfy { $0 == 0xff })
    }

    func testDifusaoEOPadraoParaFotoELimiarContinuaDisponivelParaLogo() throws {
        let cgImage = try grayscaleImage(
            width: 8,
            height: 8,
            pixels: [UInt8](repeating: 128, count: 64)
        )
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))
        let defaultCommand = try XCTUnwrap(
            ReceiptLayout.portable58mm.imageRaster(image: image)
        )
        let diffused = try XCTUnwrap(
            ReceiptLayout.portable58mm.imageRaster(image: image, mode: .floydSteinberg)
        )
        let threshold = try XCTUnwrap(
            ReceiptLayout.portable58mm.imageRaster(image: image, mode: .threshold)
        )

        XCTAssertEqual(defaultCommand, diffused)
        XCTAssertNotEqual(diffused, threshold)
        XCTAssertTrue(try rasterStripes(diffused).flatMap(\.pixels).contains { $0 != 0 })
        XCTAssertTrue(try rasterStripes(threshold).flatMap(\.pixels).allSatisfy { $0 == 0 })
    }

    func testFloydSteinbergCarregaOErroEntreFaixas() throws {
        let cgImage = try grayscaleImage(
            width: 8,
            height: 25,
            pixels: [UInt8](repeating: 96, count: 8 * 25)
        )
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))
        let command = try XCTUnwrap(
            EscPos.imageRaster(image: image, printableDots: 8, mode: .floydSteinberg)
        )
        let bytes = [UInt8](command)

        // Mesmo vetor Android: se o erro fosse zerado na fronteira de 24 linhas, a linha 24
        // repetiria 0xb6 da primeira em vez de continuar a difusão com 0xa5.
        XCTAssertEqual(bytes[11], 0xb6)
        XCTAssertEqual(
            Array(bytes[35..<43]),
            [0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00]
        )
        XCTAssertEqual(bytes[43], 0xa5)
    }

    func testClearZeraAImagemPossuidaEEIdempotente() throws {
        let cgImage = try grayscaleImage(
            width: 8,
            height: 8,
            pixels: [UInt8](repeating: 0, count: 64)
        )
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))

        XCTAssertNotNil(ReceiptLayout.portable58mm.imageRaster(image: image, mode: .threshold))
        image.clear()
        image.clear()

        XCTAssertNil(ReceiptLayout.portable58mm.imageRaster(image: image, mode: .threshold))
    }

    func testConversaoPreservaOrientacaoECompoeTransparenciaSobreBranco() throws {
        let white: [UInt8] = [255, 255, 255, 255]
        let black: [UInt8] = [0, 0, 0, 255]
        let transparentBlack: [UInt8] = [0, 0, 0, 0]
        var pixels = [UInt8]()
        pixels += black
        pixels += transparentBlack
        pixels += Array(repeating: white, count: 6).flatMap { $0 }
        pixels += Array(repeating: white, count: 7).flatMap { $0 }
        pixels += black
        let cgImage = try rgbaImage(width: 8, height: 2, pixels: pixels)
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))
        let command = try XCTUnwrap(
            EscPos.imageRaster(image: image, printableDots: 384, mode: .threshold)
        )

        let raster = try XCTUnwrap(rasterStripes(command).first)
        XCTAssertEqual(raster.pixels, [0x80, 0x01])
    }

    func testLarguraDoPerfilPrecisaSerMultiploDeOitoENaoPassaDe640() throws {
        let cgImage = try grayscaleImage(
            width: 8,
            height: 8,
            pixels: [UInt8](repeating: 0, count: 64)
        )
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))

        XCTAssertNil(EscPos.imageRaster(image: image, printableDots: 639, mode: .threshold))
        XCTAssertNil(EscPos.imageRaster(image: image, printableDots: 648, mode: .threshold))
        XCTAssertNotNil(EscPos.imageRaster(image: image, printableDots: 640, mode: .threshold))
    }

    /**
     Largura fora do contrato encolhe para a que cabe, em vez de a imagem sumir do cupom.

     O emissor recusa o que não é múltiplo de 8 e o que passa de 640, e a recusa é um `nil` — que
     no caminho do layout significa cabeçalho ausente no papel, sem erro em lugar nenhum. Meio
     milímetro a menos numa portátil e uma imagem mais estreita numa medição de 700 são
     funcionamento correto; sumir é o silêncio que a régua da casa proíbe.

     A largura crua continua sendo recusada — este teste cobra as duas coisas lado a lado, porque é
     o par que explica onde o ajuste mora: quem passa número à mão precisa ouvir "não".
     */
    func testLarguraForaDoContratoEncolheEmVezDeFazerAImagemSumir() throws {
        let cgImage = try grayscaleImage(
            width: 800,
            height: 8,
            pixels: [UInt8](repeating: 0, count: 800 * 8)
        )
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))

        // 380 não é múltiplo de 8: desce como 376, e o papel recebe 47 bytes de largura.
        let medida380 = try rasterStripes(
            try XCTUnwrap(layout(printableDots: 380).imageRaster(image: image, mode: .threshold))
        )
        XCTAssertEqual(medida380.map(\.widthBytes), [47])
        XCTAssertTrue(medida380.flatMap(\.pixels).allSatisfy { $0 == 0xff })

        // 700 passa do teto: desce travada em 640, que são 80 bytes.
        let medida700 = try rasterStripes(
            try XCTUnwrap(layout(printableDots: 700).imageRaster(image: image, mode: .threshold))
        )
        XCTAssertEqual(medida700.map(\.widthBytes), [80])

        // E o caminho cru, que é onde o número vem à mão, continua dizendo não.
        XCTAssertNil(EscPos.imageRaster(image: image, printableDots: 380, mode: .threshold))
        XCTAssertNil(EscPos.imageRaster(image: image, printableDots: 700, mode: .threshold))
    }

    /// A largura já dentro do contrato não é tocada: 384 continua 384, e 640 continua 640.
    func testLarguraDentroDoContratoAtravessaIntacta() {
        XCTAssertEqual(layout(printableDots: 384).rasterWidthDots, 384)
        XCTAssertEqual(layout(printableDots: 576).rasterWidthDots, 576)
        XCTAssertEqual(layout(printableDots: 640).rasterWidthDots, 640)
        XCTAssertEqual(ReceiptLayout.portable58mm.rasterWidthDots, 384)
        XCTAssertEqual(ReceiptLayout.counter.rasterWidthDots, 576)
    }

    private func layout(printableDots: Int) -> ReceiptLayout {
        ReceiptLayout(
            columns: 32,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: printableDots
        )
    }

    /**
     O alinhamento não vaza do raster para o que vier depois dele.

     `ESC a 1` é estado da impressora e vale até alguém trocar: sem devolvê-lo, a primeira coisa
     que o hospedeiro imprimir depois de um cabeçalho de imagem sai centralizada sem ter pedido.
     O defeito não aparece em teste de conteúdo nenhum — o cupom tem exatamente os mesmos
     caracteres —, só no papel, e o app publicado vinha contornando com uma quebra de linha
     alinhada à esquerda logo depois do raster.

     Vale para os dois rasters do kit, porque o `ESC a` sai dos dois pelo mesmo emissor.
     */
    func testRasterDevolveOAlinhamentoEmVezDeDeixarOEstadoLigado() throws {
        let cgImage = try grayscaleImage(
            width: 8,
            height: 8,
            pixels: [UInt8](repeating: 0, count: 64)
        )
        let image = try XCTUnwrap(ThermalImage.takeOwnership(cgImage))

        let imagem = try XCTUnwrap(ReceiptLayout.portable58mm.imageRaster(image: image, mode: .threshold))
        let qr = try XCTUnwrap(EscPos.qrRaster(payload: protectedQRVector, widthDots: 320))

        XCTAssertEqual(Array(imagem.suffix(3)), [0x1b, 0x61, 0x00])
        XCTAssertEqual(Array(qr.suffix(3)), [0x1b, 0x61, 0x00])
        // Uma centralização e uma devolução, nunca duas: o par tem que ficar equilibrado, senão o
        // próximo raster já começaria de um estado que este deixou.
        XCTAssertEqual(ocorrencias(of: [0x1b, 0x61], in: imagem), 2)
    }

    /// Quem não pede alinhamento não recebe devolução: `ESC a` continua fora do fio, como o vetor
    /// byte a byte do xadrez oito por oito prova, e este par de asserções deixa explícito.
    func testSemAlinhamentoOEmissorNaoEmiteNemDevolveNada() throws {
        var matrix = OneBitRasterMatrix(
            widthDots: 8,
            heightDots: 8,
            pixels: [Bool](repeating: true, count: 64)
        )

        let command = try XCTUnwrap(EscPosRasterEmitter.emit(source: &matrix, alignment: nil))

        XCTAssertEqual(ocorrencias(of: [0x1b, 0x61], in: command), 0)
        XCTAssertNotEqual(Array(command.suffix(3)), [0x1b, 0x61, 0x00])
    }

    /**
     A altura de banda é parâmetro, e o padrão continua sendo o de sempre.

     Teste de neutralidade do controle de bancada: sem ninguém pedir altura, os bytes são **os
     mesmos** de quando o número era constante. Se um dia alguém mudar o padrão, é aqui que a suíte
     grita.
     */
    func testSemPedirAlturaOEmissorDevolveExatamenteOsBytesDeVinteEQuatro() throws {
        XCTAssertEqual(ReceiptLayout.defaultRasterStripeHeightDots, 24)
        var padrao = listras(heightDots: 100)
        var explicita = listras(heightDots: 100)

        XCTAssertEqual(
            try XCTUnwrap(EscPosRasterEmitter.emit(source: &padrao, alignment: 1)),
            try XCTUnwrap(
                EscPosRasterEmitter.emit(source: &explicita, alignment: 1, stripeHeightDots: 24)
            )
        )
    }

    func testBandaMenorEmiteMaisComandosComOsMesmosPontosPretos() throws {
        var padrao = listras(heightDots: 96)
        var curta = listras(heightDots: 96)

        let comPadrao = try XCTUnwrap(EscPosRasterEmitter.emit(source: &padrao, alignment: 1))
        let comCurta = try XCTUnwrap(
            EscPosRasterEmitter.emit(source: &curta, alignment: 1, stripeHeightDots: 8)
        )

        // Doze bandas de oito no lugar de quatro de vinte e quatro: oito cabeçalhos a mais, e nem um
        // ponto preto a mais. É isto que a bancada troca ao encurtar a banda.
        XCTAssertEqual(comCurta.count, comPadrao.count + 8 * 8)
        XCTAssertEqual(pontos(of: comPadrao), pontos(of: comCurta))
    }

    func testAlturaDeBandaForaDaFaixaNaoEmiteByteNenhum() {
        XCTAssertEqual(ReceiptLayout.allowedRasterStripeHeightDots, 1...24)
        for invalida in [0, -1, 25] {
            var source = listras(heightDots: 48)
            XCTAssertNil(
                EscPosRasterEmitter.emit(source: &source, alignment: 1, stripeHeightDots: invalida)
            )
        }
    }

    func testLayoutNasceNoPadraoEACercaDeBancadaNaoSomeComAImagem() {
        XCTAssertEqual(ReceiptLayout.portable58mm.rasterStripeHeightDots, 24)

        let curto = ReceiptLayout(
            columns: 32,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: 384,
            rasterStripeHeightDots: 4
        )
        // Altura impossível cai no padrão: `nil` aqui seria a foto sumindo do cupom sem erro nenhum.
        let impossivel = ReceiptLayout(
            columns: 32,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: 384,
            rasterStripeHeightDots: 99
        )

        XCTAssertEqual(curto.rasterStripeHeightDots, 4)
        XCTAssertEqual(impossivel.rasterStripeHeightDots, 24)
        XCTAssertNotEqual(curto, impossivel)
    }

    /**
     Neutralidade do fator: sem fator, byte a byte o que já saía.

     É o teste que protege a impressora que nunca teve defeito. A compensação existe para a firmware
     que encolhe raster largo — medida em 20/08 na Inico T210 —, e ligar isso para todo mundo
     esticaria a foto de quem imprime certo.
     */
    func testSemFatorOEmissorDevolveExatamenteOsBytesDeSempre() throws {
        var padrao = listras(heightDots: 100)
        var semFator = listras(heightDots: 100)
        var neutro = listras(heightDots: 100)

        let esperado = try XCTUnwrap(EscPosRasterEmitter.emit(source: &padrao, alignment: 1))
        XCTAssertEqual(
            esperado,
            try XCTUnwrap(
                EscPosRasterEmitter.emit(source: &semFator, alignment: 1, verticalRasterScale: nil)
            )
        )
        // Fator 1,0 é "medi e não encolhe": a conta devolve a mesma altura, e nada é reamostrado.
        XCTAssertEqual(
            esperado,
            try XCTUnwrap(
                EscPosRasterEmitter.emit(source: &neutro, alignment: 1, verticalRasterScale: 1.0)
            )
        )
    }

    /**
     Fator 0,80 manda 1,25x linhas, repetindo linha — e a impressora devolve a altura pretendida.

     Oito linhas viram dez, e o mapeamento é `outY * 8 / 10`: a primeira e a quinta linhas saem duas
     vezes, as outras uma. É o mesmo mapeamento do Android, com a mesma aritmética inteira, e é isso
     que faz as duas plataformas emitirem os mesmos bytes para a mesma imagem.
     */
    func testFator08EsticaAAlturaEm125xRepetindoLinha() throws {
        var original = listras(heightDots: 8)
        var compensada = listras(heightDots: 8)

        let semFator = try XCTUnwrap(EscPosRasterEmitter.emit(source: &original, alignment: 1))
        let comFator = try XCTUnwrap(
            EscPosRasterEmitter.emit(source: &compensada, alignment: 1, verticalRasterScale: 0.8)
        )

        XCTAssertEqual(alturaDeclarada(comFator), 10)
        let origem = pontos(of: semFator)
        let esperado = [0, 0, 1, 2, 3, 4, 4, 5, 6, 7].flatMap { linha in
            Array(origem[(linha * 2)..<(linha * 2 + 2)])
        }
        XCTAssertEqual(pontos(of: comFator), esperado)
    }

    /// A conta é a mesma dos dois lados: 800 linhas com fator 0,80 são 1.000 enviadas.
    func testAAlturaCompensadaEhArredondadaENuncaEncolhe() {
        XCTAssertEqual(compensatedRasterHeightDots(800, scale: 0.8), 1_000)
        XCTAssertEqual(compensatedRasterHeightDots(800, scale: 1.0), 800)
        // 97/100 de 100 linhas dão 103,09; arredondar para baixo devolveria papel curto de novo.
        XCTAssertEqual(compensatedRasterHeightDots(100, scale: 0.97), 103)
        XCTAssertEqual(compensatedRasterHeightDots(1, scale: 0.5), 2)
    }

    /// A banda continua sendo a banda: compensar não muda a altura de cada `GS v 0`.
    func testOFatorConviveComAAlturaDeBandaPedida() throws {
        var source = listras(heightDots: 96)
        let comFator = try XCTUnwrap(
            EscPosRasterEmitter.emit(
                source: &source,
                alignment: 1,
                stripeHeightDots: 8,
                verticalRasterScale: 0.5
            )
        )

        XCTAssertEqual(alturaDeclarada(comFator), 192)
        XCTAssertEqual(try rasterStripes(comFator).map(\.height), Array(repeating: 8, count: 24))
    }

    func testFatorForaDaFaixaNaoEmiteByteNenhum() {
        XCTAssertEqual(ReceiptLayout.allowedVerticalRasterScale, 0.5...1.0)
        for invalido in [0.0, 0.49, 1.01, -0.8] {
            var source = listras(heightDots: 48)
            XCTAssertNil(
                EscPosRasterEmitter.emit(
                    source: &source,
                    alignment: 1,
                    verticalRasterScale: invalido
                )
            )
        }
    }

    /// Fator impossível cai em `nil` no layout, pela mesma razão da altura de banda.
    func testLayoutSaneiaOFatorEmVezDeSumirComAImagem() {
        let comFator = ReceiptLayout(
            columns: 32,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: 384,
            verticalRasterScale: 0.8
        )
        let impossivel = ReceiptLayout(
            columns: 32,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: 384,
            verticalRasterScale: 0.1
        )

        XCTAssertEqual(comFator.verticalRasterScale, 0.8)
        XCTAssertNil(impossivel.verticalRasterScale)
        XCTAssertNil(ReceiptLayout.portable58mm.verticalRasterScale)
        XCTAssertNotEqual(comFator, impossivel)
    }

    /// Altura total declarada nos cabeçalhos `GS v 0`, somando as bandas.
    private func alturaDeclarada(_ command: Data) -> Int {
        let bytes = [UInt8](command)
        var offset = 3
        var altura = 0
        while offset + 8 <= bytes.count - 3 {
            let bandaAltura = Int(bytes[offset + 6])
            altura += bandaAltura
            offset += 8 + 2 * bandaAltura
        }
        return altura
    }

    /// Fonte de listras horizontais: o conteúdo depende de `y`, então emenda errada apareceria.
    private func listras(heightDots: Int) -> OneBitRasterMatrix {
        OneBitRasterMatrix(
            widthDots: 16,
            heightDots: heightDots,
            pixels: (0..<heightDots).flatMap { y in
                (0..<16).map { x in (x + y * 3).isMultiple(of: 5) }
            }
        )
    }

    /// Só os pontos pretos, sem alinhamento e sem cabeçalho de banda.
    private func pontos(of command: Data) -> [UInt8] {
        let bytes = [UInt8](command)
        var saida: [UInt8] = []
        var offset = 3
        while offset + 8 <= bytes.count - 3 {
            let altura = Int(bytes[offset + 6])
            offset += 8
            saida += bytes[offset..<(offset + 2 * altura)]
            offset += 2 * altura
        }
        return saida
    }

    private func ocorrencias(of pattern: [UInt8], in data: Data) -> Int {
        let bytes = [UInt8](data)
        guard bytes.count >= pattern.count else { return 0 }
        return (0...(bytes.count - pattern.count)).filter { start in
            Array(bytes[start..<(start + pattern.count)]) == pattern
        }.count
    }

    private func grayscaleImage(width: Int, height: Int, pixels: [UInt8]) throws -> CGImage {
        XCTAssertEqual(pixels.count, width * height)
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        return try XCTUnwrap(
            CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 8,
                bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
            )
        )
    }

    private func rgbaImage(width: Int, height: Int, pixels: [UInt8]) throws -> CGImage {
        XCTAssertEqual(pixels.count, width * height * 4)
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        return try XCTUnwrap(
            CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
            )
        )
    }

    /// O fio inteiro: centraliza, emite as faixas e **devolve** o alinhamento. Os três bytes do
    /// fim entram na conta aqui, e não como asserção solta, para que nenhum caminho de raster
    /// possa perdê-los sem esta suíte inteira reclamar.
    private func rasterStripes(_ command: Data) throws -> [RasterStripe] {
        let bytes = [UInt8](command)
        XCTAssertEqual(Array(bytes.prefix(3)), [0x1b, 0x61, 0x01])
        XCTAssertEqual(Array(bytes.suffix(3)), [0x1b, 0x61, 0x00])
        let fimDasFaixas = bytes.count - 3
        var offset = 3
        var stripes: [RasterStripe] = []
        while offset < fimDasFaixas {
            XCTAssertGreaterThanOrEqual(fimDasFaixas - offset, 8)
            XCTAssertEqual(Array(bytes[offset..<(offset + 4)]), [0x1d, 0x76, 0x30, 0x00])
            let widthBytes = Int(bytes[offset + 4]) | Int(bytes[offset + 5]) << 8
            let height = Int(bytes[offset + 6]) | Int(bytes[offset + 7]) << 8
            let pixelStart = offset + 8
            let pixelEnd = pixelStart + widthBytes * height
            XCTAssertLessThanOrEqual(pixelEnd, fimDasFaixas)
            stripes.append(
                RasterStripe(
                    widthBytes: widthBytes,
                    height: height,
                    pixels: Array(bytes[pixelStart..<pixelEnd])
                )
            )
            offset = pixelEnd
        }
        XCTAssertEqual(offset, fimDasFaixas)
        return stripes
    }
}

private struct RasterStripe {
    let widthBytes: Int
    let height: Int
    let pixels: [UInt8]
}

private final class RasterCleanupTracker {
    var requestedStarts: [Int] = []
    var didClearScratch = false
}

private struct FailingSecondStripeSource: OneBitRasterSource {
    let widthDots = 8
    let heightDots = 25
    let tracker: RasterCleanupTracker

    mutating func blackPixels(startY: Int, height: Int) -> [Bool]? {
        tracker.requestedStarts.append(startY)
        guard startY == 0 else { return nil }
        return [Bool](repeating: true, count: widthDots * height)
    }

    mutating func clearScratch() {
        tracker.didClearScratch = true
    }
}

private struct WrongSizedSecondStripeSource: OneBitRasterSource {
    let widthDots = 8
    let heightDots = 25
    let tracker: RasterCleanupTracker

    mutating func blackPixels(startY: Int, height: Int) -> [Bool]? {
        tracker.requestedStarts.append(startY)
        if startY == 0 {
            return [Bool](repeating: true, count: widthDots * height)
        }
        return [true]
    }

    mutating func clearScratch() {
        tracker.didClearScratch = true
    }
}
