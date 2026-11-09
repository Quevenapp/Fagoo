import CoreGraphics
import Foundation

/// Como os tons intermediários viram pontos pretos ou brancos no papel térmico.
public enum ThermalImageMode: Equatable, Sendable {
    /// Limiar fixo, indicado para logotipo, texto e desenho de linha.
    case threshold

    /// Difusão de erro Floyd–Steinberg, indicada para foto.
    case floydSteinberg
}

/**
 Imagem cuja memória passa a pertencer ao cupom térmico.

 `CGImage` é imutável e pode compartilhar um provider que o kit não consegue zerar. Por isso a
 entrada pública faz uma cópia grayscale própria: o consumidor pode soltar o `CGImage` logo após
 `takeOwnership` e guardar somente este objeto no seu `ThermalReceiptPayload`. O `clear()` do
 payload chama o `clear()` daqui e zera byte a byte a cópia antes de liberá-la.
 */
public final class ThermalImage {
    public let width: Int
    public let height: Int

    private var grayscalePixels: [UInt8]?

    private init(width: Int, height: Int, grayscalePixels: [UInt8]) {
        self.width = width
        self.height = height
        self.grayscalePixels = grayscalePixels
    }

    /// Copia o bitmap para memória própria e zerável. Transparência é composta sobre branco.
    public static func takeOwnership(_ cgImage: CGImage) -> ThermalImage? {
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return nil }
        let (pixelCount, overflow) = width.multipliedReportingOverflow(by: height)
        guard !overflow else { return nil }

        var pixels = [UInt8](repeating: 0xff, count: pixelCount)
        let colorSpace = CGColorSpaceCreateDeviceGray()
        let copied = pixels.withUnsafeMutableBytes { storage -> Bool in
            guard let baseAddress = storage.baseAddress,
                  let context = CGContext(
                      data: baseAddress,
                      width: width,
                      height: height,
                      bitsPerComponent: 8,
                      bytesPerRow: width,
                      space: colorSpace,
                      bitmapInfo: CGImageAlphaInfo.none.rawValue
                  )
            else { return false }
            context.setFillColor(gray: 1, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.interpolationQuality = .none
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard copied else {
            pixels.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
            return nil
        }
        return ThermalImage(width: width, height: height, grayscalePixels: pixels)
    }

    /// Zera a cópia própria; é seguro chamar mais de uma vez.
    public func clear() {
        grayscalePixels?.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
        grayscalePixels = nil
    }

    deinit {
        clear()
    }

    fileprivate func withGrayscalePixels<Result>(
        _ body: (UnsafeBufferPointer<UInt8>) -> Result
    ) -> Result? {
        guard let grayscalePixels else { return nil }
        return grayscalePixels.withUnsafeBufferPointer(body)
    }
}

/**
 Quantas linhas precisam ser enviadas para `heightDots` saírem no papel, com `scale` medido.

 Fator 0,80 e 800 linhas pretendidas dão 1.000 enviadas: a impressora imprime 80% delas, e o que
 sai do papel é a altura que se queria. A conta é arredondada, nunca truncada, e nunca devolve
 menos que a altura pretendida — fator 1,0 devolve exatamente ela, e é assim que "sem compensação"
 e "compensação neutra" coincidem byte a byte. Espelha o Android.
 */
func compensatedRasterHeightDots(_ heightDots: Int, scale: Double) -> Int {
    max(heightDots, Int((Double(heightDots) / scale).rounded()))
}

/// Fronteira entre conversão e emissão: uma fonte entrega somente uma faixa de pontos de 1 bit.
protocol OneBitRasterSource {
    var widthDots: Int { get }
    var heightDots: Int { get }

    mutating func blackPixels(startY: Int, height: Int) -> [Bool]?
    mutating func clearScratch()
}

/// Fonte simples usada pelo QR e por testes sintéticos; o emissor continua alheio à origem dos bits.
struct OneBitRasterMatrix: OneBitRasterSource {
    let widthDots: Int
    let heightDots: Int
    private var pixels: [Bool]

    init(widthDots: Int, heightDots: Int, pixels: [Bool]) {
        self.widthDots = widthDots
        self.heightDots = heightDots
        self.pixels = pixels
    }

    mutating func blackPixels(startY: Int, height: Int) -> [Bool]? {
        let (expectedCount, overflow) = widthDots.multipliedReportingOverflow(by: heightDots)
        guard !overflow, pixels.count == expectedCount,
              startY >= 0, height > 0, startY + height <= heightDots
        else { return nil }
        let start = startY * widthDots
        let end = start + height * widthDots
        return Array(pixels[start..<end])
    }

    mutating func clearScratch() {
        pixels.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
    }
}

/**
 Fonte reamostrada na vertical por **repetição de linha**, para compensar firmware que encolhe.

 **O defeito que ela existe para pagar.** Medido em 20/08 no A07, por BLE: a mesma imagem de
 384x800 — 45,7 KB confirmados na telemetria dos dois lados — sai com 97 mm na GoldenSky MTP-II e
 com 80 mm na Inico T210. Cobertura de tinta, vazão, altura de banda, MTU, modo de escrita e emenda
 entre bandas foram eliminados por medição, um a um; o que sobra é a firmware da T210 imprimindo
 raster largo por um fator constante. Constante quer dizer compensável: mandar `1/fator` linhas
 devolve ao papel a altura pretendida.

 **Por que repetição de linha, e não interpolação.** Uma linha repetida é previsível: o mesmo par
 (imagem, fator) dá os mesmos bytes em Android e iOS, e o mapeamento é aritmética inteira que a
 suíte confere sem depender de arredondamento de ponto flutuante das duas plataformas. Interpolar
 daria uma imagem visualmente mais suave e um resultado que só se confere olhando — e o que importa
 aqui é altura, não suavidade. Em papel térmico de 8 dots/mm, uma linha duplicada a cada quatro é um
 degrau de 0,125 mm.

 **A ordem é preservada.** As fontes de imagem convertem por faixa e exigem leitura sequencial — o
 Floyd–Steinberg carrega o erro de uma linha para a seguinte. Esta fonte lê a de baixo em blocos do
 tamanho da banda, na ordem, e repete linhas do bloco corrente; nenhuma linha de origem é lida duas
 vezes. Espelha o Android, byte a byte.
 */
struct VerticallyStretchedRasterSource<Source: OneBitRasterSource>: OneBitRasterSource {
    let heightDots: Int
    var widthDots: Int { source.widthDots }

    private var source: Source
    private let readChunkDots: Int
    private var chunk: [Bool] = []
    private var chunkStartY = 0
    private var nextSourceY = 0
    private var failed = false

    init(source: Source, heightDots: Int, readChunkDots: Int) {
        self.source = source
        self.heightDots = max(heightDots, source.heightDots)
        self.readChunkDots = max(1, readChunkDots)
    }

    mutating func blackPixels(startY: Int, height: Int) -> [Bool]? {
        guard !failed, height > 0, startY >= 0, startY + height <= heightDots else { return nil }
        let width = source.widthDots
        var output = [Bool](repeating: false, count: width * height)
        for row in 0..<height {
            let sourceY = sourceRow(of: startY + row)
            while sourceY >= chunkStartY + chunk.count / max(1, width) {
                guard readNextChunk() else {
                    output.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
                    return nil
                }
            }
            let offset = (sourceY - chunkStartY) * width
            for x in 0..<width {
                output[row * width + x] = chunk[offset + x]
            }
        }
        return output
    }

    mutating func clearScratch() {
        chunk.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
        chunk = []
        source.clearScratch()
    }

    /**
     Qual linha de origem sai nesta linha do papel.

     Aritmética inteira de propósito: é o que faz as duas plataformas emitirem os mesmos bytes para
     a mesma imagem e o mesmo fator. Monotônica e sobrejetora enquanto a altura só cresce, então
     nenhuma linha da origem é pulada e nenhuma é lida fora de ordem.
     */
    private func sourceRow(of outputY: Int) -> Int {
        min(source.heightDots - 1, max(0, outputY * source.heightDots / heightDots))
    }

    private mutating func readNextChunk() -> Bool {
        let height = min(readChunkDots, source.heightDots - nextSourceY)
        guard height > 0, let next = source.blackPixels(startY: nextSourceY, height: height) else {
            failed = true
            return false
        }
        chunk.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
        chunk = next
        chunkStartY = nextSourceY
        nextSourceY += height
        return true
    }
}

/// Converte a cópia grayscale em faixas de 1 bit; não guarda uma matriz do tamanho da imagem.
struct ThermalImageOneBitRasterSource: OneBitRasterSource {
    let widthDots: Int
    let heightDots: Int

    private let image: ThermalImage
    private let mode: ThermalImageMode
    private let contentWidth: Int
    private let leftPadding: Int
    private var nextY = 0
    private var currentErrors: [Double]
    private var nextErrors: [Double]

    init?(image: ThermalImage, printableDots: Int, mode: ThermalImageMode) {
        guard image.width > 0, image.height > 0,
              (8...Self.maximumPrintableDots).contains(printableDots),
              printableDots % 8 == 0
        else { return nil }
        let usableWidth = printableDots

        let contentWidth = min(image.width, usableWidth)
        let paddedWidth = min(usableWidth, (contentWidth + 7) / 8 * 8)
        let scale = Double(contentWidth) / Double(image.width)
        let scaledHeight = max(1, Int((Double(image.height) * scale).rounded()))

        self.image = image
        self.mode = mode
        self.contentWidth = contentWidth
        self.widthDots = paddedWidth
        self.heightDots = scaledHeight
        self.leftPadding = (paddedWidth - contentWidth) / 2
        if mode == .floydSteinberg {
            currentErrors = [Double](repeating: 0, count: contentWidth + 2)
            nextErrors = [Double](repeating: 0, count: contentWidth + 2)
        } else {
            currentErrors = []
            nextErrors = []
        }
    }

    mutating func blackPixels(startY: Int, height: Int) -> [Bool]? {
        guard startY == nextY, height > 0, startY + height <= heightDots else { return nil }
        let sourceWidth = image.width
        let sourceHeight = image.height
        let targetWidth = contentWidth
        let targetHeight = heightDots
        let padding = leftPadding
        let conversion = mode
        var rowErrors = currentErrors
        var followingRowErrors = nextErrors

        guard let stripe = image.withGrayscalePixels({ source -> [Bool] in
            var output = [Bool](repeating: false, count: widthDots * height)
            for stripeY in 0..<height {
                let targetY = startY + stripeY
                for targetX in 0..<targetWidth {
                    let sampled = Self.sample(
                        source,
                        sourceWidth: sourceWidth,
                        sourceHeight: sourceHeight,
                        targetX: targetX,
                        targetY: targetY,
                        targetWidth: targetWidth,
                        targetHeight: targetHeight
                    )
                    let black: Bool
                    switch conversion {
                    case .threshold:
                        black = sampled < Self.threshold
                    case .floydSteinberg:
                        let adjusted = min(255, max(0, sampled + rowErrors[targetX + 1]))
                        black = adjusted < Self.threshold
                        let quantizationError = adjusted - (black ? 0 : 255)
                        rowErrors[targetX + 2] += quantizationError * 7 / 16
                        followingRowErrors[targetX] += quantizationError * 3 / 16
                        followingRowErrors[targetX + 1] += quantizationError * 5 / 16
                        followingRowErrors[targetX + 2] += quantizationError / 16
                    }
                    output[stripeY * widthDots + padding + targetX] = black
                }
                if conversion == .floydSteinberg {
                    rowErrors = followingRowErrors
                    followingRowErrors.withUnsafeMutableBufferPointer {
                        $0.initialize(repeating: 0)
                    }
                }
            }
            return output
        }) else { return nil }

        currentErrors = rowErrors
        nextErrors = followingRowErrors
        nextY += height
        return stripe
    }

    mutating func clearScratch() {
        currentErrors.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
        nextErrors.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
    }

    /// Amostragem bilinear mantém a proporção sem cortar. A escala nunca é maior que um.
    private static func sample(
        _ source: UnsafeBufferPointer<UInt8>,
        sourceWidth: Int,
        sourceHeight: Int,
        targetX: Int,
        targetY: Int,
        targetWidth: Int,
        targetHeight: Int
    ) -> Double {
        let sourceX = (Double(targetX) + 0.5) * Double(sourceWidth) / Double(targetWidth) - 0.5
        let sourceY = (Double(targetY) + 0.5) * Double(sourceHeight) / Double(targetHeight) - 0.5
        let x0 = min(sourceWidth - 1, max(0, Int(floor(sourceX))))
        let y0 = min(sourceHeight - 1, max(0, Int(floor(sourceY))))
        let x1 = min(sourceWidth - 1, x0 + 1)
        let y1 = min(sourceHeight - 1, y0 + 1)
        let fractionX = min(1, max(0, sourceX - Double(x0)))
        let fractionY = min(1, max(0, sourceY - Double(y0)))
        let top = Double(source[y0 * sourceWidth + x0]) * (1 - fractionX) +
            Double(source[y0 * sourceWidth + x1]) * fractionX
        let bottom = Double(source[y1 * sourceWidth + x0]) * (1 - fractionX) +
            Double(source[y1 * sourceWidth + x1]) * fractionX
        return top * (1 - fractionY) + bottom * fractionY
    }

    private static let threshold = 128.0
    /// Teto do `GS v 0` neste kit. Interno, e não privado, porque o caminho do layout precisa
    /// travar a largura **antes** de chegar aqui — dois números 640 em arquivos diferentes é como
    /// um deles envelhece sozinho.
    static let maximumPrintableDots = 640
}

/**
 Emissor de `GS v 0` compartilhado por QR e imagem arbitrária: empacota bits e escreve faixas.

 Quando recebe alinhamento, ele o **devolve** ao normal depois da última faixa. `ESC a` é estado da
 impressora, não enfeite do bloco: vale até alguém trocar, e o que vier depois do raster sairia
 centralizado sem ter pedido. É a mesma regra que `EscPos.text` já segue com negrito e tamanho —
 quem liga, desliga —, e ela mora aqui porque aqui é o único lugar do kit que liga o alinhamento
 para rasterizar. Com `alignment: nil` nada é emitido e nada é devolvido.
 */
enum EscPosRasterEmitter {
    /// O padrão publicado, republicado aqui porque é por este nome que o kit já o chamava.
    static let stripeHeightDots = ReceiptLayout.defaultRasterStripeHeightDots

    /**
     - Parameter stripeHeightDots: quantas linhas cabem em cada comando `GS v 0`. O padrão é o de
       sempre, e passar outro valor é medição de bancada, nunca configuração de produto. Ver
       ``ReceiptLayout/defaultRasterStripeHeightDots``.
     - Parameter verticalRasterScale: fator medido desta impressora, ou `nil` para não compensar
       nada. Com fator, a fonte é reamostrada na vertical **antes** de virar raster; ver
       ``VerticallyStretchedRasterSource``. Sem fator, os bytes são exatamente os de sempre.
     */
    static func emit<Source: OneBitRasterSource>(
        source: inout Source,
        alignment: UInt8?,
        stripeHeightDots: Int = ReceiptLayout.defaultRasterStripeHeightDots,
        verticalRasterScale: Double? = nil
    ) -> Data? {
        guard let scale = verticalRasterScale else {
            return emitStripes(source: &source, alignment: alignment, stripeHeightDots: stripeHeightDots)
        }
        guard ReceiptLayout.allowedVerticalRasterScale.contains(scale) else { return nil }
        let stretchedHeight = compensatedRasterHeightDots(source.heightDots, scale: scale)
        guard stretchedHeight > source.heightDots else {
            return emitStripes(source: &source, alignment: alignment, stripeHeightDots: stripeHeightDots)
        }
        // A fonte de baixo passa a ser propriedade da esticada, que a lê em ordem e devolve o
        // `clearScratch` para dentro dela. A cópia daqui é zerada pelo `defer`, e a que importa —
        // a que realmente converteu pixel — é a de lá.
        var stretched = VerticallyStretchedRasterSource(
            source: source,
            heightDots: stretchedHeight,
            readChunkDots: stripeHeightDots
        )
        defer { source.clearScratch() }
        return emitStripes(
            source: &stretched,
            alignment: alignment,
            stripeHeightDots: stripeHeightDots
        )
    }

    private static func emitStripes<Source: OneBitRasterSource>(
        source: inout Source,
        alignment: UInt8?,
        stripeHeightDots: Int
    ) -> Data? {
        defer { source.clearScratch() }
        guard source.widthDots >= 8,
              source.widthDots % 8 == 0,
              source.heightDots > 0,
              source.widthDots / 8 <= Int(UInt16.max),
              ReceiptLayout.allowedRasterStripeHeightDots.contains(stripeHeightDots),
              alignment == nil || alignment! <= 2
        else { return nil }

        let widthBytes = source.widthDots / 8
        var data = Data()
        if let alignment {
            data.append(contentsOf: [0x1b, 0x61, alignment])
        }

        var startY = 0
        while startY < source.heightDots {
            let stripeHeight = min(stripeHeightDots, source.heightDots - startY)
            guard var blackPixels = source.blackPixels(startY: startY, height: stripeHeight) else {
                // Uma faixa anterior já pode carregar conteúdo do usuário. Falha de conversão não
                // devolve os bytes, mas também não os deixa vivos no backing storage de `Data`.
                clear(&data)
                return nil
            }
            guard blackPixels.count == source.widthDots * stripeHeight else {
                // A fonte entregou conteúdo, portanto ele também precisa ser zerado mesmo sem ter
                // tamanho suficiente para chegar ao empacotamento.
                blackPixels.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
                clear(&data)
                return nil
            }
            defer {
                blackPixels.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
            }

            var packed = [UInt8](repeating: 0, count: widthBytes * stripeHeight)
            for y in 0..<stripeHeight {
                for x in 0..<source.widthDots where blackPixels[y * source.widthDots + x] {
                    packed[y * widthBytes + x / 8] |= UInt8(0x80 >> (x % 8))
                }
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
        // Só devolve quem tomou. Nos caminhos de falha acima nada disto importa: eles zeram o
        // buffer e não devolvem byte nenhum, então não há estado deixado na impressora.
        if alignment != nil {
            data.append(contentsOf: [0x1b, 0x61, leftAlignment])
        }
        return data
    }

    /// `ESC a 0` — a esquerda, que é o estado em que `ESC @` deixa a impressora.
    private static let leftAlignment: UInt8 = 0

    private static func clear(_ data: inout Data) {
        data.resetBytes(in: 0..<data.count)
        data.removeAll(keepingCapacity: false)
    }
}
