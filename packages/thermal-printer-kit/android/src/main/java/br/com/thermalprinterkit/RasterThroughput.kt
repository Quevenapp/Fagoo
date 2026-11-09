package br.com.thermalprinterkit

/**
 * O freio de mão do raster: nunca deixa sair mais que `bytesPerSecond` bytes por segundo.
 *
 * **Por que existe**, medido na bancada em 20/08 com a Inico T210 por BLE: os mesmos 120 dots saem
 * com 15,0 mm tanto numa banda única quanto em quinze bandas de oito, e um logotipo de 2 KB no topo
 * de um cupom sai correto — mas a foto de 28 KB em largura cheia sai 22% mais curta, coerente,
 * apenas encolhida. O que separa o caso bom do ruim é vazão, não geometria nem número de bandas: a
 * firmware descarta **linhas inteiras** quando os bytes chegam mais rápido do que a cabeça térmica
 * imprime. O ACK do ATT prova recepção no rádio, nunca impressão — é por isso que a escrita
 * confirmada, que já dita o ritmo do enlace, não protege deste defeito.
 *
 * Não há heurística por modelo aqui: o número vem do perfil medido, e perfil sem medição continua
 * `null`, que é byte a byte como sempre foi.
 *
 * O relógio e a espera são injetáveis para a suíte exercer o ritmo sem dormir de verdade. Em
 * produção quem chama já está fora da thread principal — a mesma thread que hoje dorme os 20 ms
 * entre blocos do SPP e do BLE sem confirmação.
 */
internal class RasterThroughputPacer(
    private val bytesPerSecond: Int?,
    private val nowMicros: () -> Long = { System.nanoTime() / 1_000 },
    private val sleepMillis: (Long) -> Unit = { millis -> Thread.sleep(millis) },
) {
    init {
        require(bytesPerSecond == null || bytesPerSecond in RASTER_BYTES_PER_SECOND_RANGE) {
            "Teto de vazão de raster inválido."
        }
    }

    /** Quando o próximo bloco pode sair. `null` enquanto nenhum bloco saiu. */
    private var nextChunkAllowedAtMicros: Long? = null

    /**
     * Espera a vez do bloco e cobra o tempo dele.
     *
     * O primeiro bloco sai na hora: o teto limita a **taxa**, e segurar o começo só atrasaria o
     * cupom sem tirar byte nenhum da fila da impressora.
     */
    fun pace(chunkBytes: Int) {
        val ceiling = bytesPerSecond ?: return
        if (chunkBytes <= 0) return
        var agora = nowMicros()
        val liberadoEm = nextChunkAllowedAtMicros
        if (liberadoEm != null && liberadoEm > agora) {
            // Arredonda a espera para cima: dormir de menos devolveria justamente a rajada que o
            // teto existe para evitar. O agendamento continua absoluto, então um milissegundo a
            // mais aqui não vira atraso acumulado no cupom inteiro.
            sleepMillis((liberadoEm - agora + MICROS_PER_MILLI - 1) / MICROS_PER_MILLI)
            agora = nowMicros()
        }
        // `maxOf` reabre a janela quando o transporte já anda mais devagar que o teto: sem isso, o
        // atraso viraria crédito, e o crédito viraria rajada no bloco seguinte.
        val base = maxOf(agora, liberadoEm ?: agora)
        nextChunkAllowedAtMicros = base + custoMicros(chunkBytes, ceiling)
    }

    /** Para cima, de novo pelo mesmo motivo: o erro precisa cair do lado de esperar demais. */
    private fun custoMicros(
        chunkBytes: Int,
        ceiling: Int,
    ): Long = (chunkBytes.toLong() * MICROS_PER_SECOND + ceiling - 1) / ceiling

    private companion object {
        const val MICROS_PER_MILLI = 1_000L
        const val MICROS_PER_SECOND = 1_000_000L
    }
}
