package br.com.thermalprinterkit

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF

/**
 * Conteúdo de imagem cujo ciclo de vida pode acompanhar [ThermalReceiptPayload.clear].
 *
 * [takeOwnership] transfere a posse: o chamador não pode voltar a usar o `Bitmap` entregue. Quando
 * ele é imutável (inclusive `HARDWARE`), uma cópia mutável é criada e o original é reciclado já na
 * entrada. [clear] sobrescreve a cópia mutável, recicla-a e é idempotente. Assim o payload futuro
 * tem uma operação concreta para remover a foto também quando a origem não aceitava `eraseColor`.
 */
class ThermalImage private constructor(
    private var ownedBitmap: Bitmap?,
) {
    /** Zera e invalida o conteúdo; rasterizações posteriores devolvem `null`. */
    fun clear() {
        synchronized(lock) {
            ownedBitmap?.let { bitmap ->
                if (!bitmap.isRecycled) {
                    bitmap.eraseColor(Color.TRANSPARENT)
                    bitmap.recycle()
                }
            }
            ownedBitmap = null
        }
    }

    internal fun <T> withBitmap(block: (Bitmap) -> T): T? =
        synchronized(lock) {
            ownedBitmap
                ?.takeUnless(Bitmap::isRecycled)
                ?.let(block)
        }

    override fun toString(): String = "ThermalImage(content=[REDACTED])"

    companion object {
        /**
         * Assume a posse de [bitmap]. A referência entregue fica inválida para o chamador mesmo
         * quando o objeto mutável só será reciclado no [clear].
         */
        fun takeOwnership(bitmap: Bitmap): ThermalImage {
            require(!bitmap.isRecycled) { "Imagem já foi descartada." }
            val owned =
                if (bitmap.isMutable) {
                    bitmap
                } else {
                    requireNotNull(bitmap.copy(Bitmap.Config.ARGB_8888, true)) {
                        "Não foi possível preparar a imagem para impressão."
                    }.also { bitmap.recycle() }
                }
            return ThermalImage(owned)
        }
    }

    private val lock = Any()
}

/**
 * O acesso a pixel do Android: **só** desenha a faixa e devolve os pixels dela.
 *
 * A conversão em si — luminância, limiar, Floyd–Steinberg e empacotamento — subiu para
 * `OneBitRasterConversion.kt`, que atravessa para a JVM de mesa. O que ficou aqui é o que não
 * atravessa e o que **não pode mudar**: o `Canvas.drawBitmap` com `FILTER_BITMAP_FLAG`.
 *
 * **Por que a reamostragem não subiu junto.** Quem escolhe a amostra é o Skia, e o caminho de
 * imagem deste kit está homologado em papel — a foto e o logotipo de venda passam por ele todo
 * dia. Reescrever a interpolação em Kotlin exigiria provar, pixel a pixel, que o resultado é o
 * mesmo do Skia; nada disso foi medido, e um pixel diferente na entrada vira uma linha inteira
 * diferente na saída depois da difusão de erro. Então a reamostragem fica onde está, e a
 * contraparte de mesa faz a dela com AWT: as duas convergem no pixel, não no filtro.
 *
 * O branco também é decisão desta camada, e é antiga: a faixa nasce BRANCA e o bitmap é composto
 * por cima, então pixel transparente sai branco. Papel térmico não tem alfa; o que não é marcado
 * é a cor da bobina.
 */
private class BitmapRasterStripePixelReader(
    private val bitmap: Bitmap,
    private val geometry: OneBitRasterGeometry,
    stripeHeightDots: Int,
) : RasterStripePixelReader {
    private val contentWidth = geometry.contentWidth
    private val stripeBitmap =
        Bitmap.createBitmap(contentWidth, stripeHeightDots, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(stripeBitmap)
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)

    override fun readPixels(
        startY: Int,
        stripeHeight: Int,
        destination: IntArray,
    ) {
        try {
            stripeBitmap.eraseColor(Color.WHITE)
            canvas.drawBitmap(
                bitmap,
                null,
                RectF(
                    0f,
                    -startY.toFloat(),
                    contentWidth.toFloat(),
                    geometry.heightDots.toFloat() - startY,
                ),
                paint,
            )
            stripeBitmap.getPixels(
                destination,
                0,
                contentWidth,
                0,
                0,
                contentWidth,
                stripeHeight,
            )
        } finally {
            // A faixa desenhada é foto de usuário; ela não fica pendurada num bitmap vivo depois
            // de os pixels terem sido copiados.
            stripeBitmap.eraseColor(Color.TRANSPARENT)
        }
    }

    override fun clear() {
        stripeBitmap.eraseColor(Color.TRANSPARENT)
        stripeBitmap.recycle()
    }
}

/**
 * Converte [image] por faixas e delega ao mesmo emissor `GS v 0` usado pelo QR.
 *
 * A largura máxima é [printableDots], vinda do perfil. Imagem estreita mantém o tamanho original;
 * só recebe pontos brancos até o próximo byte. Foto usa Floyd–Steinberg por padrão; logotipo deve
 * pedir [ThermalImageMode.THRESHOLD] explicitamente. Depois da montagem, o payload ainda precisa
 * chamar [ThermalImage.clear] no próprio `clear()`.
 *
 * @param verticalRasterScale fator medido do perfil, ou `null` para não compensar nada. Ver
 *   [VERTICAL_RASTER_SCALE_RANGE]: com fator, a imagem é reamostrada na vertical antes de virar
 *   raster, para o que sai do papel ter a altura pretendida.
 */
fun EscPosThermalCommands.imageRaster(
    image: ThermalImage,
    printableDots: Int,
    mode: ThermalImageMode = ThermalImageMode.FLOYD_STEINBERG,
    stripeHeightDots: Int = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
    verticalRasterScale: Double? = null,
): ByteArray? =
    imageRaster(image, printableDots, mode, stripeHeightDots, verticalRasterScale, EscPosRasterEmission)

/** A mesma imagem, com o envelope de raster do dialeto. Interna pela razão de [EscPosThermalCommands.qrRaster]. */
internal fun EscPosThermalCommands.imageRaster(
    image: ThermalImage,
    printableDots: Int,
    mode: ThermalImageMode,
    stripeHeightDots: Int,
    verticalRasterScale: Double?,
    emission: RasterEmission,
): ByteArray? {
    if (!isPrintableWidthSupported(printableDots)) return null
    require(stripeHeightDots in RASTER_STRIPE_HEIGHT_RANGE) { "Altura de banda raster inválida." }
    return image.withBitmap { bitmap ->
        val geometry = OneBitRasterGeometry.of(bitmap.width, bitmap.height, printableDots)
        val source =
            PixelOneBitRasterSource(
                geometry,
                BitmapRasterStripePixelReader(bitmap, geometry, stripeHeightDots),
                mode,
                stripeHeightDots,
            )
        try {
            emission.emit(source, stripeHeightDots, verticalRasterScale)
        } finally {
            source.clear()
        }
    }
}
