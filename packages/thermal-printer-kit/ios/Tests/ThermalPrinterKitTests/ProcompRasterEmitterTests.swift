import Foundation
import XCTest
@testable import ThermalPrinterKit

/**
 O `ESC n` da Diebold IM453H, byte a byte — e a conta da margem, que é conta e por isso tem prova.

 **O que sustenta cada literal daqui** está medido em papel em 23/08/2026 e escrito em
 `docs/handover-diebold-im453h.md`: `ESC n <marg> <larg> <n1> <n2>` é obedecido com `larg` bytes por
 dotline, a ordem dos bytes é da esquerda para a direita e a dos bits é MSB primeiro, e um comando
 diferente de gráfico — um `LF` basta — encerra o bloco. **Nada deste arquivo saiu em papel por este
 lote**: o que ele mede são os bytes que o kit monta.

 Espelha `ProcompRasterEmitter.kt` e a metade Procomp de `ThermalMonochromeRasterTest.kt`.
 */
final class ProcompRasterEmitterTests: XCTestCase {

    // MARK: - Os literais do cabeçalho

    /**
     A matriz mínima que o `ESC n` aceita, com os bytes escritos à mão.

     Oito pontos por dois: um comando de seis bytes, dois de conteúdo, e o `LF` que dispara a
     impressão. É o mesmo caso que o `GS v 0` fixa em `ThermalMonochromeRasterTests`, e os dois
     literais lado a lado são o que mostra que só o envelope muda.
     */
    func testAMatrizMinimaTodaPretaFixaOsBytesPorLiteral() throws {
        var fonte = OneBitRasterMatrix(
            widthDots: 8,
            heightDots: 2,
            pixels: [Bool](repeating: true, count: 16)
        )

        let bytes = try XCTUnwrap(ProcompRasterEmitter.emit(source: &fonte))

        XCTAssertEqual(
            [UInt8](bytes),
            [0x1B, 0x6E, 0x00, 0x01, 0x02, 0x00] + [0xFF, 0xFF] + [0x0A]
        )
    }

    /**
     Uma matriz assimétrica, porque `ff` não prova ordem de bit nenhuma.

     Linha 0 tem só o ponto 0, linha 1 tem só o ponto 15 e linha 2 tem o primeiro byte cheio. Se o
     empacotamento fosse LSB primeiro, se as linhas viessem trocadas ou se a largura fosse contada em
     pontos em vez de bytes, este literal mudaria; com a matriz toda preta, nenhuma das três
     apareceria.
     */
    func testUmaMatrizAssimetricaFixaAOrdemDosBitsEDosBytes() throws {
        var pontos = [Bool](repeating: false, count: 16 * 3)
        pontos[0] = true
        pontos[16 + 15] = true
        for x in 0..<8 { pontos[32 + x] = true }
        var fonte = OneBitRasterMatrix(widthDots: 16, heightDots: 3, pixels: pontos)

        let bytes = try XCTUnwrap(ProcompRasterEmitter.emit(source: &fonte))

        XCTAssertEqual(
            [UInt8](bytes),
            [0x1B, 0x6E, 0x00, 0x02, 0x03, 0x00] + [0x80, 0x00, 0x00, 0x01, 0xFF, 0x00] + [0x0A]
        )
    }

    /**
     **`n2` sai zero em toda banda**, e isso não é elegância: é a faixa onde há prova em papel.

     Toda sonda que funcionou em 23/08/2026 tinha altura ≤ 180 dotlines, isto é `n2 = 0`. O QR que
     falhou tinha 320, `n1 = 0x40` e `n2 = 0x01` — coerente com a firmware ler só o `n1`, imprimir 64
     dotlines e tratar o resto como texto, que é o que o papel mostrou. Separar essa causa da outra
     (tamanho ou fatiamento do transporte) exigiria uma sonda com `n2 ≠ 0`. **Não medido.**
     */
    func testTodaBandaSaiComN2Zero() throws {
        var fonte = OneBitRasterMatrix(
            widthDots: 16,
            heightDots: 100,
            pixels: [Bool](repeating: true, count: 16 * 100)
        )

        let bytes = [UInt8](try XCTUnwrap(ProcompRasterEmitter.emit(source: &fonte)))

        for cabecalho in cabecalhos(em: bytes, widthBytes: 2) {
            XCTAssertEqual(bytes[cabecalho + 5], 0, "o `n2` da banda em \(cabecalho) não é zero")
            XCTAssertLessThanOrEqual(Int(bytes[cabecalho + 4]), ProcompRasterEmitter.maxBandDotlines)
        }
    }

    // MARK: - A margem, que é conta

    /**
     A conta da centragem, com os casos que a definem.

     Arredonda **para baixo**, ao múltiplo de 8 dots que a margem aceita: sobrar meio milímetro à
     direita é melhor que estourar a área imprimível à esquerda. Gráfico que ocupa a área inteira, ou
     mais que ela, não recua nada — recuar o que já não cabe empurraria pontos para fora do papel.
     */
    func testAContaDaMargemDeCentragem() {
        // O caso do cupom real: o QR de 320 pontos na área de 80 mm. A bancada anotou margem 16
        // unidades de oito pontos para exatamente este par.
        XCTAssertEqual(ProcompRasterEmitter.centeringMarginDots(widthDots: 320, printableDots: 576), 128)
        XCTAssertEqual(128 / 8, 16)

        XCTAssertEqual(ProcompRasterEmitter.centeringMarginDots(widthDots: 16, printableDots: 576), 280)
        // Arredondamento para baixo: a folga de 11 pontos vira recuo de 8.
        XCTAssertEqual(ProcompRasterEmitter.centeringMarginDots(widthDots: 8, printableDots: 30), 8)
        // Largura igual ou maior que a área não recua nada.
        XCTAssertEqual(ProcompRasterEmitter.centeringMarginDots(widthDots: 576, printableDots: 576), 0)
        XCTAssertEqual(ProcompRasterEmitter.centeringMarginDots(widthDots: 640, printableDots: 576), 0)
    }

    /**
     A margem calculada é a que sai no cabeçalho — em unidades de oito pontos, não em pontos.

     É a única centragem que existe nesta impressora: não há `ESC a`. Trocar os dois números seria um
     gráfico oito vezes mais à esquerda, e nenhuma suíte que só conte bytes veria isso.
     */
    func testAMargemCalculadaEAQueSaiNoCabecalho() throws {
        let layout = layoutProcomp(printableDots: 576)
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 320,
                heightDots: 2,
                blackPixels: [Bool](repeating: true, count: 320 * 2)
            )
        )

        let bytes = [UInt8](try XCTUnwrap(layout.monochromeRaster(bitmap)))

        XCTAssertEqual(Array(bytes.prefix(6)), [0x1B, 0x6E, 16, 40, 2, 0])
    }

    /// Margem que não é múltipla de oito pontos não vira cabeçalho aproximado: não vira cabeçalho.
    func testMargemForaDoContratoNaoEmiteByteNenhum() {
        var fonte = OneBitRasterMatrix(
            widthDots: 8,
            heightDots: 1,
            pixels: [Bool](repeating: true, count: 8)
        )

        XCTAssertNil(ProcompRasterEmitter.emit(source: &fonte, leftMarginDots: 4))
        XCTAssertNil(ProcompRasterEmitter.emit(source: &fonte, leftMarginDots: -8))
        XCTAssertNotNil(ProcompRasterEmitter.emit(source: &fonte, leftMarginDots: 8))
    }

    // MARK: - As bandas

    /**
     Bandas coladas, e **um único `LF` no fim**.

     Nada de `LF` entre bandas: `ESC n` seguido de `ESC n` continua sendo gráfico raster, e a firmware
     só dispara a impressão quando chega comando diferente de gráfico. Um `LF` no meio encerraria a
     imagem e ainda avançaria uma linha de texto, abrindo um vão branco entre as bandas.

     A matriz é toda preta de propósito: assim nenhum byte de conteúdo pode ser `0x0A` e a contagem
     mede o que diz medir.
     */
    func testAsBandasSaoColadasEHaUmSoLineFeedNoFim() throws {
        var fonte = OneBitRasterMatrix(
            widthDots: 16,
            heightDots: 30,
            pixels: [Bool](repeating: true, count: 16 * 30)
        )

        let bytes = [UInt8](try XCTUnwrap(ProcompRasterEmitter.emit(source: &fonte)))

        let alturas = cabecalhos(em: bytes, widthBytes: 2).map { Int(bytes[$0 + 4]) }
        XCTAssertEqual(alturas, [24, 6], "24 dotlines por banda, e o resto na última")
        XCTAssertEqual(bytes.filter { $0 == 0x0A }.count, 1)
        XCTAssertEqual(bytes.last, 0x0A)
        XCTAssertEqual(bytes.count, 2 * 6 + 16 / 8 * 30 + 1)
    }

    /**
     **A altura de banda do layout não atravessa este envelope**, e isso espelha o Kotlin.

     O campo do perfil descreve a banda do `GS v 0`; a banda do `ESC n` é a de 24 dotlines que a
     bancada mediu — uma ordem de grandeza abaixo dos 12.807 bytes que falharam e quatro vezes acima
     dos 240 que funcionaram. Duas plataformas com bandas diferentes emitiriam papéis diferentes para
     o mesmo cupom.
     */
    func testAAlturaDeBandaDoLayoutNaoAtravessaOEnvelopeProcomp() throws {
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 16,
                heightDots: 30,
                blackPixels: (0..<(16 * 30)).map { $0 % 5 == 0 }
            )
        )

        XCTAssertEqual(
            layoutProcomp(rasterStripeHeightDots: 8).monochromeRaster(bitmap),
            layoutProcomp().monochromeRaster(bitmap)
        )
        // O mutante: no dialeto que usa o campo, mudar a banda muda os bytes.
        XCTAssertNotEqual(
            layoutEscPos(rasterStripeHeightDots: 8).monochromeRaster(bitmap),
            layoutEscPos().monochromeRaster(bitmap)
        )
    }

    // MARK: - A compensação vertical é a mesma dos dois lados

    /**
     Com fator, a fonte é reamostrada pela **mesma** ``VerticallyStretchedRasterSource`` do ESC/POS.

     Duas implementações da mesma conta divergiriam no papel, que é onde ninguém vê o diff. O bitmap
     tem o índice da linha codificado nos 16 bits, então nenhuma linha se repete na origem: apagar
     duplicatas consecutivas do resultado compensado precisa devolver a sequência original inteira.
     */
    func testOFatorEstiraPorRepeticaoDeLinhaNoEnvelopeProcomp() throws {
        let altura = 25
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 16,
                heightDots: altura,
                blackPixels: (0..<altura).flatMap { y in (0..<16).map { x in (y >> x) & 1 == 1 } }
            )
        )

        let semFator = try XCTUnwrap(layoutProcomp().monochromeRaster(bitmap))
        let comFator = try XCTUnwrap(
            layoutProcomp(verticalRasterScale: 0.8).monochromeRaster(bitmap)
        )
        XCTAssertNotEqual(comFator, semFator)

        let originais = try linhas(semFator, widthDots: 16)
        let esticadas = try linhas(comFator, widthDots: 16)
        XCTAssertEqual(originais.count, altura)
        XCTAssertEqual(esticadas.count, compensatedRasterHeightDots(altura, scale: 0.8))
        XCTAssertEqual(semDuplicatasConsecutivas(esticadas), originais)
    }

    /// Fator neutro é indistinguível de "sem compensação": 1,0 não muda um byte.
    func testFatorNeutroSaiIgualASemCompensacaoNoProcomp() throws {
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 16,
                heightDots: 9,
                blackPixels: (0..<(16 * 9)).map { $0 % 3 == 0 }
            )
        )

        XCTAssertEqual(
            layoutProcomp(verticalRasterScale: 1.0).monochromeRaster(bitmap),
            layoutProcomp().monochromeRaster(bitmap)
        )
    }

    // MARK: - Fronteiras do comando

    /// Largura que não fecha em byte não vira comando: o `ESC n` conta a linha em bytes inteiros.
    func testLarguraForaDoContratoNaoEmiteByteNenhum() {
        for largura in [4, 12, 20] {
            var fonte = OneBitRasterMatrix(
                widthDots: largura,
                heightDots: 2,
                pixels: [Bool](repeating: true, count: largura * 2)
            )
            XCTAssertNil(
                ProcompRasterEmitter.emit(source: &fonte),
                "largura \(largura) não fecha em byte"
            )
        }
    }

    /// Altura de banda fora da faixa medida é recusa, não aproximação.
    func testAlturaDeBandaForaDaFaixaNaoEmiteByteNenhum() {
        var fonte = OneBitRasterMatrix(
            widthDots: 8,
            heightDots: 2,
            pixels: [Bool](repeating: true, count: 16)
        )

        XCTAssertNil(ProcompRasterEmitter.emit(source: &fonte, bandHeightDots: 0))
        XCTAssertNil(
            ProcompRasterEmitter.emit(
                source: &fonte,
                bandHeightDots: ProcompRasterEmitter.maxBandDotlines + 1
            )
        )
        XCTAssertNotNil(
            ProcompRasterEmitter.emit(
                source: &fonte,
                bandHeightDots: ProcompRasterEmitter.maxBandDotlines
            )
        )
    }

    // MARK: - Apoio

    private func layoutProcomp(
        printableDots: Int = 576,
        rasterStripeHeightDots: Int = ReceiptLayout.defaultRasterStripeHeightDots,
        verticalRasterScale: Double? = nil
    ) -> ReceiptLayout {
        ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: printableDots,
            rasterStripeHeightDots: rasterStripeHeightDots,
            verticalRasterScale: verticalRasterScale,
            dialect: .procompEscP
        )
    }

    private func layoutEscPos(
        rasterStripeHeightDots: Int = ReceiptLayout.defaultRasterStripeHeightDots
    ) -> ReceiptLayout {
        ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: 576,
            rasterStripeHeightDots: rasterStripeHeightDots
        )
    }

    /// Os deslocamentos de cada cabeçalho `ESC n` do comando, andando pelo tamanho declarado.
    private func cabecalhos(em bytes: [UInt8], widthBytes: Int) -> [Int] {
        var saida: [Int] = []
        var offset = 0
        while offset + 6 <= bytes.count, bytes[offset] == 0x1B, bytes[offset + 1] == 0x6E {
            saida.append(offset)
            let altura = Int(bytes[offset + 4]) | Int(bytes[offset + 5]) << 8
            offset += 6 + Int(bytes[offset + 3]) * altura
        }
        XCTAssertEqual(offset, bytes.count - 1, "sobrou byte fora de banda")
        XCTAssertEqual(bytes.last, 0x0A)
        XCTAssertTrue(saida.allSatisfy { Int(bytes[$0 + 3]) == widthBytes })
        return saida
    }

    /// Desempacota o comando inteiro de volta em linhas de pontos.
    private func linhas(_ command: Data, widthDots: Int) throws -> [[Bool]] {
        let bytes = [UInt8](command)
        var saida: [[Bool]] = []
        for cabecalho in cabecalhos(em: bytes, widthBytes: widthDots / 8) {
            let widthBytes = Int(bytes[cabecalho + 3])
            let altura = Int(bytes[cabecalho + 4]) | Int(bytes[cabecalho + 5]) << 8
            var cursor = cabecalho + 6
            for _ in 0..<altura {
                saida.append(
                    (0..<widthDots).map { x in bytes[cursor + x / 8] & UInt8(0x80 >> (x % 8)) != 0 }
                )
                cursor += widthBytes
            }
        }
        return saida
    }

    private func semDuplicatasConsecutivas(_ linhas: [[Bool]]) -> [[Bool]] {
        linhas.reduce(into: [[Bool]]()) { acumulado, linha in
            if acumulado.last != linha { acumulado.append(linha) }
        }
    }
}
