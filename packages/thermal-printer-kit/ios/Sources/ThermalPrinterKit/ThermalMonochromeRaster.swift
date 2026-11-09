import Foundation

/**
 Bitmap 1-bit já composto por quem monta o cupom.

 `blackPixels[y * widthDots + x] == true` significa ponto preto, com a linha 0 no topo — a mesma
 convenção de ``OneBitRasterMatrix``, que é para onde estes bits vão.

 **Por que este tipo existe.** Um interpretador de ESC/POS compõe o cupom inteiro em pontos —
 texto, código de barras, QR e imagem já viraram bits — e precisa emitir isso como faixas
 `GS v 0`. Sem uma entrada assim, ele reimplementaria o empacotamento de bits por fora do kit, e
 com ele reimplementaria a compensação de ``ReceiptLayout/verticalRasterScale``: passariam a
 existir duas verdades sobre o único campo medido tardio que muda os bytes emitidos. Este tipo é a
 porta que faz o cupom já rasterizado atravessar **o mesmo** emissor de sempre.

 **O que ele não faz.** Não converte cinza, não aplica meio-tom e não redimensiona: quem compôs os
 pontos já decidiu tudo isso. A largura precisa ser a que o perfil aceita — ver
 ``ReceiptLayout/rasterWidthDots`` —, porque aqui não há imagem para reamostrar na horizontal.

 **Memória.** Sendo tipo de valor, o kit não tem como zerar a cópia de quem chamou; a que ele cria
 para emitir é zerada pelo emissor, como em qualquer outro raster. Quando os pontos vierem de um
 payload protegido, zerar o bitmap de origem continua sendo de quem o compôs — é a mesma divisão
 que ``ThermalImage/clear()`` já expressa para foto.
 */
public struct ThermalMonochromeBitmap: Equatable, Sendable {
    public let widthDots: Int
    public let heightDots: Int
    /// Interno de propósito: o consumidor entrega os pontos, não os lê de volta. Publicar o vetor
    /// só aumentaria a superfície e daria uma segunda forma de sair com os bits na mão.
    let blackPixels: [Bool]

    /**
     Falha quando as dimensões e o vetor não descrevem o mesmo bitmap.

     É a única regra que este tipo guarda, porque é a única que **ele** promete: sem
     `blackPixels.count == widthDots * heightDots` o índice `y * widthDots + x` não significa nada.
     O que é contrato do `GS v 0` — largura múltipla de 8, mínimo de 8 pontos — continua sendo
     cobrado pelo emissor, e não é repetido aqui: dois lugares decidindo a mesma largura é como um
     deles envelhece sozinho.
     */
    public init?(widthDots: Int, heightDots: Int, blackPixels: [Bool]) {
        guard widthDots > 0, heightDots > 0 else { return nil }
        let (expectedCount, overflow) = widthDots.multipliedReportingOverflow(by: heightDots)
        guard !overflow, blackPixels.count == expectedCount else { return nil }
        self.widthDots = widthDots
        self.heightDots = heightDots
        self.blackPixels = blackPixels
    }
}

public extension ReceiptLayout {
    /**
     Emite o bitmap já composto no envelope de raster **deste** dialeto, com os parâmetros deste
     perfil.

     É ``imageRaster(image:mode:)`` sem a etapa de meio-tom: mesmo emissor, mesma altura de banda de
     ``rasterStripeHeightDots`` e mesmo ``verticalRasterScale``. Para o mesmo conteúdo em pontos, os
     bytes são byte a byte os de sempre — este caminho não inventa nenhum.

     Existe pelo mesmo motivo de ``qrRaster(payload:)``: o caminho compensado é o do layout. Quem
     tiver o bitmap e emitir por fora fica sem a compensação do perfil, e um cupom inteiro 20% mais
     curto na Inico T210 é papel errado que nenhuma suíte pega.

     **Ele pergunta ao dialeto, e isso é o conserto de 30/08/2026.** Até aqui chamava
     ``EscPosRasterEmitter`` direto, ao contrário de ``imageRaster(image:mode:)`` e
     ``qrRaster(payload:)``. Enquanto houve um dialeto só, isso não podia estar errado; com o segundo
     caso, seria um cupom de IM453H com o **corpo** em `GS v 0` — o comando que, em 23/08/2026, fez
     aquela impressora cuspir dois metros de código e travar com a tecla de avanço morta. O lado
     Kotlin mediu exatamente esse defeito em 27/08/2026, com os sete primeiros bytes
     `1B 61 01 1D 76 30 00`.

     - Returns: `nil` quando a largura do bitmap não é a que **este envelope** endereça. O `GS v 0`
       conta a largura em dois bytes e vai até 65535; o `ESC n` conta em um e para em 255. O teto
       mora com o envelope, e não aqui: ver ``RasterEmission``. Componha em ``rasterWidthDots`` e a
       largura nunca chega a ser recusada.
     */
    func monochromeRaster(_ bitmap: ThermalMonochromeBitmap) -> Data? {
        var source = OneBitRasterMatrix(
            widthDots: bitmap.widthDots,
            heightDots: bitmap.heightDots,
            pixels: bitmap.blackPixels
        )
        return rasterEmission.emit(
            source: &source,
            stripeHeightDots: rasterStripeHeightDots,
            verticalRasterScale: verticalRasterScale
        )
    }
}
