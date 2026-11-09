import Foundation

/**
 Raster da Diebold Procomp, por `ESC n`.

 **Por que `ESC n` e não `ESC k`.** O `ESC k` calcula os bytes de cada dotline a partir da largura da
 **cabeça de impressão**, que é um número que não foi medido. Errar essa contagem deixa a firmware
 esperando bytes que nunca chegam — e nesta impressora esperar bytes é como ela trava. O `ESC n`
 recebe a largura como parâmetro, então a contagem é nossa e é exata.

 **O que foi medido em 23/08/2026, e sustenta cada linha daqui:**

 * `ESC n <marg> <larg> <n1> <n2>` é obedecido, com `larg` bytes por dotline, exatamente;
 * a ordem dos bytes na linha é da **esquerda para a direita**, e a dos bits é **MSB primeiro** — as
   duas iguais às do ESC/POS, então ``OneBitRasterSource`` serve sem tradução e o empacotamento é
   literalmente o mesmo `0x80 >> (x % 8)` do ``EscPosRasterEmitter``;
 * a densidade horizontal é 8 dots/mm. A vertical foi contada em foto como ~8,4 dotlines/mm, o que
   daria o fator 0,95 de ``PrinterCapabilities/verticalRasterScale`` — e a **régua desmentiu**: a
   tira de vazão da homologação, 384 dotlines, mediu 47 mm em 26/08/2026, ou seja ~8,17 dotlines/mm.
   Isso cai dentro do ±1 mm de uma régua comum, então esta impressora fica **sem compensação**;
 * um comando diferente de gráfico — um `LF` basta — encerra o bloco.

 **Em bandas, e isto é uma correção.** O primeiro desenho emitia a altura inteira num cabeçalho só. O
 papel de 23/08/2026 mediu o contrário: um QR de **320 dotlines num único `ESC n` de 12.807 bytes**
 saiu como rio de caracteres, e uma sonda de 240 bytes com a **mesma largura** saiu como barra
 sólida — então não é a largura. Duas causas continuam sem separação, e a banda cobre as duas:
 `n2` ignorado pela firmware (toda sonda que funcionou tinha altura ≤ 180, isto é `n2 = 0`) e
 tamanho ou fatiamento do transporte. Enquanto não houver medição que as separe,
 ``maxBandDotlines`` mantém toda banda com `n2 = 0` — não por elegância, mas porque é a faixa onde
 há prova em papel.

 Espelha `android/src/main/java/br/com/thermalprinterkit/ProcompRasterEmitter.kt`.
 */
enum ProcompRasterEmitter {
    /**
     Teto de uma banda: 255 dotlines, o maior valor que cabe em `n1` **sem usar `n2`**.

     Não é limitação do comando — é a fronteira do que foi medido. Ver a nota de causas acima.
     */
    static let maxBandDotlines = 0xFF

    /**
     Margem e largura são múltiplos de 8 dots, e cabem num byte **cada**.

     É este número que separa este envelope do `GS v 0`, que endereça a largura em dois bytes. Ver
     ``RasterEmission``: o teto é do comando que carrega o raster, e não do raster.
     */
    static let maxEightDotUnits = 0xFF

    /**
     Vinte e quatro dotlines por banda — 960 bytes na largura de 40 que a bancada mediu.

     É o mesmo número que o caminho ESC/POS usa desde o M1, e fica **uma ordem de grandeza abaixo**
     dos 12.807 bytes que falharam e **quatro vezes acima** dos 240 que funcionaram. O número exato
     onde a firmware desiste não foi medido; este é o lado seguro do que se sabe.
     */
    static let defaultBandDotlines = ReceiptLayout.defaultRasterStripeHeightDots

    /// Oito pontos por byte, como no `GS v 0`: o empacotamento é o mesmo, só o envelope muda.
    static let bitsPerByte = 8

    /**
     - Parameter leftMarginDots: recuo à esquerda, em dots, múltiplo de 8. É **assim que se
       centraliza** nesta impressora: não existe `ESC a`, então quem posiciona é a margem do próprio
       gráfico. Ver ``centeringMarginDots(widthDots:printableDots:)``.
     - Parameter verticalRasterScale: fator medido, ou `nil` para não compensar. Com fator, a fonte é
       reamostrada na vertical pela **mesma** ``VerticallyStretchedRasterSource`` do caminho ESC/POS;
       duas implementações da mesma conta divergiriam no papel, que é onde ninguém vê o diff.
     - Returns: `nil` quando largura, margem ou altura de banda não cabem no `ESC n`. O emissor
       ESC/POS deste kit já recusa por `nil` pelo mesmo motivo, e é o contrato que
       ``ReceiptLayout/monochromeRaster(_:)`` repassa a quem chama.
     */
    static func emit<Source: OneBitRasterSource>(
        source: inout Source,
        leftMarginDots: Int = 0,
        verticalRasterScale: Double? = nil,
        bandHeightDots: Int = defaultBandDotlines
    ) -> Data? {
        guard let scale = verticalRasterScale else {
            return emitBands(
                source: &source,
                leftMarginDots: leftMarginDots,
                bandHeightDots: bandHeightDots
            )
        }
        guard ReceiptLayout.allowedVerticalRasterScale.contains(scale) else { return nil }
        let stretchedHeight = compensatedRasterHeightDots(source.heightDots, scale: scale)
        guard stretchedHeight > source.heightDots else {
            return emitBands(
                source: &source,
                leftMarginDots: leftMarginDots,
                bandHeightDots: bandHeightDots
            )
        }
        var stretched = VerticallyStretchedRasterSource(
            source: source,
            heightDots: stretchedHeight,
            readChunkDots: bandHeightDots
        )
        defer { source.clearScratch() }
        return emitBands(
            source: &stretched,
            leftMarginDots: leftMarginDots,
            bandHeightDots: bandHeightDots
        )
    }

    /**
     Quanta margem centraliza `widthDots` numa área imprimível de `printableDots`.

     Arredonda **para baixo**, ao múltiplo de 8 dots que a margem aceita: sobrar meio milímetro à
     direita é melhor que estourar a área imprimível à esquerda. Gráfico que ocupa a área inteira, ou
     mais que ela, não recua nada — recuar o que já não cabe empurraria pontos para fora do papel.
     */
    static func centeringMarginDots(widthDots: Int, printableDots: Int) -> Int {
        guard widthDots < printableDots else { return 0 }
        let folga = (printableDots - widthDots) / 2
        return folga - folga % bitsPerByte
    }

    /**
     Bandas coladas, e **um único `LF` no fim**.

     Nada de `LF` entre bandas: `ESC n` seguido de `ESC n` continua sendo gráfico raster, e o manual
     só dispara a impressão quando chega comando **diferente** de gráfico. Um `LF` no meio seria
     comando diferente — encerraria a imagem e ainda avançaria uma linha de texto, abrindo um vão
     branco entre as bandas.
     */
    private static func emitBands<Source: OneBitRasterSource>(
        source: inout Source,
        leftMarginDots: Int,
        bandHeightDots: Int
    ) -> Data? {
        defer { source.clearScratch() }
        guard source.widthDots >= bitsPerByte,
              source.widthDots % bitsPerByte == 0,
              source.heightDots > 0,
              leftMarginDots >= 0,
              leftMarginDots % bitsPerByte == 0,
              (1...maxBandDotlines).contains(bandHeightDots)
        else { return nil }
        let widthBytes = source.widthDots / bitsPerByte
        let marginUnits = leftMarginDots / bitsPerByte
        // O teto é **deste** envelope: um byte para a largura e um para a margem. Herdar o teto de
        // dois bytes do `GS v 0` emitiria um cabeçalho truncado, em silêncio.
        guard (1...maxEightDotUnits).contains(widthBytes),
              marginUnits <= maxEightDotUnits
        else { return nil }

        var data = Data()
        var startY = 0
        while startY < source.heightDots {
            let height = min(bandHeightDots, source.heightDots - startY)
            guard var blackPixels = source.blackPixels(startY: startY, height: height) else {
                // Uma banda anterior já pode carregar conteúdo do usuário. Falha de conversão não
                // devolve os bytes, mas também não os deixa vivos no backing storage de `Data`.
                clear(&data)
                return nil
            }
            guard blackPixels.count == source.widthDots * height else {
                blackPixels.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
                clear(&data)
                return nil
            }
            defer {
                blackPixels.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
            }

            var packed = [UInt8](repeating: 0, count: widthBytes * height)
            for y in 0..<height {
                for x in 0..<source.widthDots where blackPixels[y * source.widthDots + x] {
                    packed[y * widthBytes + x / bitsPerByte] |= UInt8(0x80 >> (x % bitsPerByte))
                }
            }

            data.append(contentsOf: [
                esc, rasterWithMargin,
                UInt8(marginUnits), UInt8(widthBytes),
                UInt8(height),
                // `n2` sai sempre zero: a banda cabe em `n1`, e é essa a faixa com prova em papel.
                0,
            ])
            data.append(contentsOf: packed)
            packed.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
            startY += height
        }
        data.append(ProcompEscP.lineFeed)
        return data
    }

    private static func clear(_ data: inout Data) {
        data.resetBytes(in: 0..<data.count)
        data.removeAll(keepingCapacity: false)
    }

    private static let esc: UInt8 = 0x1B

    /// `ESC n` — gráfico raster com margem e largura declaradas.
    private static let rasterWithMargin: UInt8 = 0x6E
}
