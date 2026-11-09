import CoreGraphics
import XCTest
@testable import ThermalPrinterKit

/**
 O caminho do bitmap já composto não pode inventar byte nenhum.

 Toda a suíte é comparação byte a byte contra os emissores que já existem: se `monochromeRaster`
 divergir de `EscPos.qrRaster` ou de `EscPos.imageRaster` para o mesmo conteúdo em pontos, quem
 está errado é a adição, não o emissor. É essa amarração que impede uma segunda verdade sobre
 `verticalRasterScale` de nascer no caminho do interpretador.
 */
final class ThermalMonochromeRasterTests: XCTestCase {
    // MARK: - Igualdade com o QR

    /**
     Para a mesma matriz de módulos, o bitmap e o QR do kit dão exatamente os mesmos bytes.

     A matriz vem de decodificar o próprio `EscPos.qrRaster` sem fator — é a única forma de obter
     os módulos, porque quem os gera é privado — e é justamente por isso que a comparação que
     importa é a **com** fator: os dois lados atravessam a compensação por caminhos diferentes e
     precisam sair idênticos.
     */
    func testMonochromeRasterIgualaOQRDoKitByteAByte() throws {
        let payload = "PRINTHER-MONO-RASTER-0001"
        let semFator = try XCTUnwrap(EscPos.qrRaster(payload: payload, widthDots: 320))
        let modulos = try linhas(semFator, widthDots: 320)
        XCTAssertEqual(modulos.count, 320)
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 320,
                heightDots: modulos.count,
                blackPixels: modulos.flatMap { $0 }
            )
        )

        let neutro = layout(printableDots: 320, qrWidthDots: 320)
        XCTAssertEqual(neutro.monochromeRaster(bitmap), semFator)

        let comFator = layout(printableDots: 320, qrWidthDots: 320, verticalRasterScale: 0.8)
        let qrCompensado = try XCTUnwrap(
            EscPos.qrRaster(payload: payload, widthDots: 320, verticalRasterScale: 0.8)
        )
        XCTAssertNotEqual(qrCompensado, semFator)
        XCTAssertEqual(comFator.monochromeRaster(bitmap), qrCompensado)
        // E o caminho recomendado ao payload é o mesmo destino: o layout não tem dois emissores.
        XCTAssertEqual(
            comFator.monochromeRaster(bitmap),
            try XCTUnwrap(comFator.qrRaster(payload: payload))
        )
    }

    // MARK: - Igualdade com a imagem

    /// Mesmos pontos pretos que a conversão por limiar produz, mesmos bytes — com e sem fator.
    func testMonochromeRasterIgualaAImagemPorLimiarByteAByte() throws {
        let largura = 64
        let altura = 40
        let cinza = (0..<(largura * altura)).map { indice -> UInt8 in
            let x = indice % largura
            let y = indice / largura
            return (x * 3 + y * 5) % 7 < 3 ? 0 : 255
        }
        let imagem = try XCTUnwrap(
            ThermalImage.takeOwnership(
                try grayscaleImage(width: largura, height: altura, pixels: cinza)
            )
        )
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: largura,
                heightDots: altura,
                blackPixels: cinza.map { $0 < 128 }
            )
        )

        // Os dois lados são desembrulhados antes de comparar: `nil == nil` passaria sem provar nada.
        let semFator = try XCTUnwrap(
            EscPos.imageRaster(image: imagem, printableDots: largura, mode: .threshold)
        )
        XCTAssertEqual(layout(printableDots: largura).monochromeRaster(bitmap), semFator)

        let comFator = layout(printableDots: largura, verticalRasterScale: 0.8)
        let imagemCompensada = try XCTUnwrap(
            EscPos.imageRaster(
                image: imagem,
                printableDots: largura,
                mode: .threshold,
                verticalRasterScale: 0.8
            )
        )
        XCTAssertNotEqual(imagemCompensada, semFator)
        XCTAssertEqual(comFator.monochromeRaster(bitmap), imagemCompensada)
        // A mesma imagem pelo caminho do layout: o fator já está lá dentro, ninguém o repassa.
        XCTAssertEqual(
            comFator.monochromeRaster(bitmap),
            try XCTUnwrap(comFator.imageRaster(image: imagem, mode: .threshold))
        )
    }

    // MARK: - O fator do layout realmente entra

    /**
     Com fator e sem fator os bytes diferem, e a diferença é **repetição de linha**, não outra coisa.

     O bitmap tem o índice da linha codificado nos 16 bits, então nenhuma linha se repete na
     origem. Assim, apagar duplicatas consecutivas do resultado compensado precisa devolver a
     sequência original inteira, na ordem: nada foi interpolado, nada foi pulado, nada foi lido
     duas vezes.
     */
    func testFatorDoLayoutEstiraPorRepeticaoDeLinhaEMaisNada() throws {
        let altura = 25
        let bitmap = try XCTUnwrap(indiceCodificado(heightDots: altura))

        let semFator = try XCTUnwrap(layout(printableDots: 16).monochromeRaster(bitmap))
        let comFator = try XCTUnwrap(
            layout(printableDots: 16, verticalRasterScale: 0.8).monochromeRaster(bitmap)
        )
        XCTAssertNotEqual(comFator, semFator)

        let originais = try linhas(semFator, widthDots: 16)
        let esticadas = try linhas(comFator, widthDots: 16)
        XCTAssertEqual(originais.count, altura)
        XCTAssertEqual(esticadas.count, compensatedRasterHeightDots(altura, scale: 0.8))
        XCTAssertGreaterThan(esticadas.count, originais.count)
        XCTAssertEqual(semDuplicatasConsecutivas(esticadas), originais)
    }

    /// Fator neutro é indistinguível de "sem compensação": 1,0 não muda um byte.
    func testFatorNeutroSaiIgualASemCompensacao() throws {
        let bitmap = try XCTUnwrap(indiceCodificado(heightDots: 25))

        XCTAssertEqual(
            layout(printableDots: 16, verticalRasterScale: 1.0).monochromeRaster(bitmap),
            layout(printableDots: 16).monochromeRaster(bitmap)
        )
    }

    /// A altura de banda do layout atravessa: mais comandos `GS v 0`, os mesmos pontos pretos.
    func testAlturaDeBandaDoLayoutAtravessaSemMudarOsPontos() throws {
        let bitmap = try XCTUnwrap(indiceCodificado(heightDots: 25))

        let padrao = try XCTUnwrap(layout(printableDots: 16).monochromeRaster(bitmap))
        let curta = try XCTUnwrap(
            layout(printableDots: 16, rasterStripeHeightDots: 8).monochromeRaster(bitmap)
        )

        XCTAssertEqual(ocorrencias(of: [0x1d, 0x76, 0x30, 0x00], in: padrao), 2)
        XCTAssertEqual(ocorrencias(of: [0x1d, 0x76, 0x30, 0x00], in: curta), 4)
        XCTAssertEqual(try linhas(curta, widthDots: 16), try linhas(padrao, widthDots: 16))
    }

    // MARK: - Fronteiras

    /**
     O bitmap só guarda a regra que ele mesmo promete: dimensões que descrevem o vetor entregue.

     Sem isso, `y * widthDots + x` não endereça nada — e é por endereço que o emissor lê.
     */
    func testBitmapRecusaDimensoesQueNaoDescrevemOVetor() {
        XCTAssertNil(ThermalMonochromeBitmap(widthDots: 8, heightDots: 2, blackPixels: []))
        XCTAssertNil(
            ThermalMonochromeBitmap(
                widthDots: 8,
                heightDots: 2,
                blackPixels: [Bool](repeating: false, count: 15)
            )
        )
        XCTAssertNil(
            ThermalMonochromeBitmap(
                widthDots: 8,
                heightDots: 2,
                blackPixels: [Bool](repeating: false, count: 17)
            )
        )
        XCTAssertNil(ThermalMonochromeBitmap(widthDots: 0, heightDots: 2, blackPixels: []))
        XCTAssertNil(ThermalMonochromeBitmap(widthDots: 8, heightDots: 0, blackPixels: []))
        XCTAssertNil(ThermalMonochromeBitmap(widthDots: -8, heightDots: 2, blackPixels: []))
        XCTAssertNotNil(
            ThermalMonochromeBitmap(
                widthDots: 8,
                heightDots: 2,
                blackPixels: [Bool](repeating: false, count: 16)
            )
        )
    }

    /// Dois bitmaps são iguais quando os pontos são iguais — o vetor entra na comparação.
    func testIgualdadeComparaOsPontosENaoSoAsDimensoes() {
        let branco = ThermalMonochromeBitmap(
            widthDots: 8,
            heightDots: 1,
            blackPixels: [Bool](repeating: false, count: 8)
        )
        let umPonto = ThermalMonochromeBitmap(
            widthDots: 8,
            heightDots: 1,
            blackPixels: [true] + [Bool](repeating: false, count: 7)
        )

        XCTAssertEqual(branco, branco)
        XCTAssertNotEqual(branco, umPonto)
    }

    /**
     Largura fora do contrato do `GS v 0` não emite byte nenhum, e a recusa continua no emissor.

     Aqui o `nil` é a resposta certa: não há imagem para reamostrar na horizontal, então ajustar a
     largura significaria cortar ou deslocar pontos que alguém já posicionou. Quem compõe compõe em
     `rasterWidthDots`.
     */
    func testLarguraForaDoContratoDoGSv0NaoEmiteByteNenhum() throws {
        let perfil = layout(printableDots: 384)

        let doze = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 12,
                heightDots: 2,
                blackPixels: [Bool](repeating: true, count: 24)
            )
        )
        XCTAssertNil(perfil.monochromeRaster(doze))

        let quatro = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 4,
                heightDots: 2,
                blackPixels: [Bool](repeating: true, count: 8)
            )
        )
        XCTAssertNil(perfil.monochromeRaster(quatro))

        let oito = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 8,
                heightDots: 2,
                blackPixels: [Bool](repeating: true, count: 16)
            )
        )
        XCTAssertEqual(
            [UInt8](try XCTUnwrap(perfil.monochromeRaster(oito))),
            [0x1b, 0x61, 0x01] +
                [0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x02, 0x00, 0xff, 0xff] +
                [0x1b, 0x61, 0x00]
        )
    }

    /// O bitmap de quem chamou sobrevive à emissão: o kit zera a cópia dele, não a do consumidor.
    func testEmitirDuasVezesDaOsMesmosBytes() throws {
        let bitmap = try XCTUnwrap(indiceCodificado(heightDots: 25))
        let perfil = layout(printableDots: 16, verticalRasterScale: 0.8)

        XCTAssertEqual(perfil.monochromeRaster(bitmap), perfil.monochromeRaster(bitmap))
    }

    // MARK: - O dialeto: este caminho era o único do layout que o perdia

    /**
     **Numa firmware sem `GS`, este caminho não pode emitir um byte `GS`.**

     A Diebold IM453H não tem um único comando `GS`. Mandar-lhe a régua raster ESC/POS, em
     24/08/2026, fez sair dois metros de código e o aparelho parar de responder — medido na bancada,
     e é o motivo de o dialeto existir.

     `imageRaster` e `qrRaster` já passavam pelo envelope escolhido pelo dialeto; este caminho
     chamava `EscPosRasterEmitter.emit` **direto**. Enquanto o kit Swift teve um dialeto só, isso não
     podia estar errado — e é por isso que o conserto e o segundo caso do enum são o mesmo lote.
     */
    func testNumaFirmwareSemGsOBitmapCompostoNaoEmiteUmByteGs() throws {
        let bitmap = try XCTUnwrap(indiceCodificado(heightDots: 8))

        let bytes = try XCTUnwrap(procomp().monochromeRaster(bitmap))

        XCTAssertFalse(
            bytes.contains(0x1D),
            "nenhum 0x1D pode sair para a IM453H, e `GS v 0` começa com ele"
        )
    }

    /**
     O mesmo bitmap sai pelos **dois** emissores, e a diferença é o envelope inteiro.

     Não basta o `GS` sumir: o que sai tem de ser o `ESC n` do dialeto. Sem esta metade, um conserto
     que devolvesse `Data()` passaria na prova de cima — que é exatamente o formato de mentira que
     este repositório persegue. A comparação é byte a byte contra o emissor chamado à mão, com a
     mesma margem de centragem que o layout calcula.
     */
    func testOBitmapCompostoSaiPeloEmissorDoDialetoENaoPorUmCaminhoProprio() throws {
        let bitmap = try XCTUnwrap(indiceCodificado(heightDots: 8))

        var fonteProcomp = OneBitRasterMatrix(
            widthDots: bitmap.widthDots,
            heightDots: bitmap.heightDots,
            pixels: bitmap.blackPixels
        )
        XCTAssertEqual(
            procomp().monochromeRaster(bitmap),
            ProcompRasterEmitter.emit(
                source: &fonteProcomp,
                leftMarginDots: ProcompRasterEmitter.centeringMarginDots(
                    widthDots: bitmap.widthDots,
                    printableDots: Self.procompDots
                )
            ),
            "Procomp: o mesmo `ESC n` que o envelope do dialeto monta"
        )

        var fonteEscPos = OneBitRasterMatrix(
            widthDots: bitmap.widthDots,
            heightDots: bitmap.heightDots,
            pixels: bitmap.blackPixels
        )
        XCTAssertEqual(
            layout(printableDots: Self.procompDots).monochromeRaster(bitmap),
            EscPosRasterEmitter.emit(source: &fonteEscPos, alignment: 1),
            "ESC/POS: byte a byte o de sempre, e este é o guarda de regressão do conserto"
        )
    }

    /**
     A recusa por largura também é do dialeto, e os dois tetos são **diferentes**.

     O `GS v 0` carrega a largura em dois bytes (até 65535 bytes de largura); o `ESC n` carrega em um
     (até 255). Manter o teto do ESC/POS depois de rotear pelo dialeto emitiria um cabeçalho `ESC n`
     truncado, em silêncio, para uma firmware que trava esperando bytes.

     A margem entra na mesma conta porque ela viaja no mesmo cabeçalho e no mesmo byte: uma área
     imprimível absurda recusa antes de a largura ter chance, e é a segunda metade da prova.
     */
    func testALarguraRecusadaEADoDialetoENaoADoEscPos() throws {
        // 2048 pontos = 256 bytes: um a mais do que o `ESC n` endereça, e muito abaixo do `GS v 0`.
        let largo = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 2_048,
                heightDots: 1,
                blackPixels: [Bool](repeating: true, count: 2_048)
            )
        )

        XCTAssertNil(
            procomp(printableDots: 2_048).monochromeRaster(largo),
            "o `ESC n` não endereça 256 bytes de largura"
        )
        XCTAssertNotNil(
            layout(printableDots: 2_048).monochromeRaster(largo),
            "e o `GS v 0` endereça 256 bytes sem esforço: o teto é do envelope, não do raster"
        )

        // Um a menos passa: a fronteira é 255 bytes, e não um número redondo qualquer.
        let noLimite = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 2_040,
                heightDots: 1,
                blackPixels: [Bool](repeating: true, count: 2_040)
            )
        )
        XCTAssertNotNil(procomp(printableDots: 2_040).monochromeRaster(noLimite))

        // E a margem tem o mesmo teto, no mesmo byte: 8 pontos centrados em 8192 recuariam 511
        // unidades de oito pontos.
        let estreito = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 8,
                heightDots: 1,
                blackPixels: [Bool](repeating: true, count: 8)
            )
        )
        XCTAssertNil(
            procomp(printableDots: 8_192).monochromeRaster(estreito),
            "margem que não cabe no byte recusa igual — e o mesmo bitmap sai numa área sã"
        )
        XCTAssertNotNil(procomp().monochromeRaster(estreito))
    }

    // MARK: - Apoio

    /// O layout da IM453H: mesmo bitmap, dialeto Procomp.
    private func procomp(printableDots: Int = procompDots) -> ReceiptLayout {
        ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: printableDots,
            dialect: .procompEscP
        )
    }

    /// Área imprimível da IM453H em pontos, na largura de 80 mm do cartão de catálogo. Ela é
    /// **convenção de 80 mm e não medição** — ver `docs/handover-diebold-im453h.md`.
    private static let procompDots = 576

    private func layout(
        printableDots: Int,
        qrWidthDots: Int = 320,
        rasterStripeHeightDots: Int = ReceiptLayout.defaultRasterStripeHeightDots,
        verticalRasterScale: Double? = nil
    ) -> ReceiptLayout {
        ReceiptLayout(
            columns: 32,
            qrWidthDots: qrWidthDots,
            hasCutter: false,
            codePage: nil,
            printableDots: printableDots,
            rasterStripeHeightDots: rasterStripeHeightDots,
            verticalRasterScale: verticalRasterScale
        )
    }

    /// Bitmap de 16 pontos cujo conteúdo é o índice da linha: nenhuma linha se repete na origem.
    private func indiceCodificado(heightDots: Int) -> ThermalMonochromeBitmap? {
        let pontos = (0..<heightDots).flatMap { y in
            (0..<16).map { x in (y >> x) & 1 == 1 }
        }
        return ThermalMonochromeBitmap(
            widthDots: 16,
            heightDots: heightDots,
            blackPixels: pontos
        )
    }

    /// Desempacota o comando inteiro de volta em linhas de pontos, conferindo a moldura `ESC a`.
    private func linhas(_ command: Data, widthDots: Int) throws -> [[Bool]] {
        let bytes = [UInt8](command)
        XCTAssertEqual(Array(bytes.prefix(3)), [0x1b, 0x61, 0x01])
        XCTAssertEqual(Array(bytes.suffix(3)), [0x1b, 0x61, 0x00])
        let fimDasFaixas = bytes.count - 3
        var offset = 3
        var saida: [[Bool]] = []
        while offset < fimDasFaixas {
            XCTAssertGreaterThanOrEqual(fimDasFaixas - offset, 8)
            XCTAssertEqual(Array(bytes[offset..<(offset + 4)]), [0x1d, 0x76, 0x30, 0x00])
            let widthBytes = Int(bytes[offset + 4]) | Int(bytes[offset + 5]) << 8
            let altura = Int(bytes[offset + 6]) | Int(bytes[offset + 7]) << 8
            XCTAssertEqual(widthBytes * 8, widthDots)
            var cursor = offset + 8
            XCTAssertLessThanOrEqual(cursor + widthBytes * altura, fimDasFaixas)
            for _ in 0..<altura {
                saida.append(
                    (0..<widthDots).map { x in
                        bytes[cursor + x / 8] & UInt8(0x80 >> (x % 8)) != 0
                    }
                )
                cursor += widthBytes
            }
            offset = cursor
        }
        XCTAssertEqual(offset, fimDasFaixas)
        return saida
    }

    private func semDuplicatasConsecutivas(_ linhas: [[Bool]]) -> [[Bool]] {
        linhas.reduce(into: [[Bool]]()) { acumulado, linha in
            if acumulado.last != linha { acumulado.append(linha) }
        }
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
}
