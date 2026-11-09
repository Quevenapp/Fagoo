package br.com.thermalprinterkit

// O MODO de meio-tom é decisão de cupom, não de plataforma: `ReceiptLayout.imageRaster` o recebe e
// a JVM de mesa precisa do mesmo enum, com os mesmos dois casos, para não haver duas verdades
// sobre o que é "logotipo" e o que é "fotografia". Quem LÊ este enum também é compartilhado, desde
// a Frente C: `PixelOneBitRasterSource`, em `OneBitRasterConversion.kt`. O que continua sendo de
// cada plataforma é só o acesso a pixel.

/** Como tons intermediários viram os pontos pretos ou brancos do papel térmico. */
enum class ThermalImageMode {
    /** Limiar fixo em 128: bordas limpas para logotipo, texto e desenho de linha. */
    THRESHOLD,

    /** Difusão de erro Floyd–Steinberg: preserva a sensação de tons numa fotografia. */
    FLOYD_STEINBERG,
}
