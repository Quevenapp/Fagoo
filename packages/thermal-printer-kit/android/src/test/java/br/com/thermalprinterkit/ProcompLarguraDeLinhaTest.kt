package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Nenhum bloco de texto Procomp deixa o cursor no meio da linha, e nenhuma linha estoura a largura.
 *
 * **O defeito que isto prende, medido em papel na IM453H em 24/08/2026.** `split('\n')` de um texto
 * terminado em quebra devolve um segmento vazio no fim, e o centralizador **preenchia esse vazio**:
 * o bloco saia com 24 espacos soltos, sem LF depois. A linha seguinte comecava na coluna 24 e uma
 * linha de 35 colunas — que cabe de sobra nas 48 desta impressora — estourava a largura, partindo
 * "Item ... Valor" em duas no cupom com logotipo.
 *
 * **O que torna este defeito caro é o disfarce.** Ele parece largura errada do perfil, que é um
 * defeito conhecido e documentado deste card. Eu cheguei a concluir que a impressora tinha 34
 * colunas, contando caracteres numa foto. A regua de colunas respondeu 48, e o erro estava no
 * emissor. Contar coluna em foto foi o que me enganou; contar coluna nos bytes é o que prende.
 *
 * Por isso o teste mede o **efeito** — largura de cada linha logica — e nao a ausencia do
 * preenchimento. Outra causa que deixe o cursor solto cai aqui do mesmo jeito.
 */
class ProcompLarguraDeLinhaTest {
    private val perfil = BundledPrinterDrivers.dieboldIm453h

    /** Colunas de cada linha logica, como a firmware as conta. Negativo = linha sem LF no fim. */
    private fun larguras(bytes: ByteArray): List<Int> {
        val saida = mutableListOf<Int>()
        var coluna = 0
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i].toInt() and 0xFF
            when {
                // Comando: consome o ESC e o byte seguinte, que nao ocupa coluna.
                b == 0x1B -> i += 1
                b == 0x0A -> { saida += coluna; coluna = 0 }
                b >= 0x20 -> coluna += 1
            }
            i += 1
        }
        if (coluna > 0) saida += -coluna
        return saida
    }

    @Test
    fun `bloco terminado em quebra nao deixa preenchimento solto`() {
        val layout = ReceiptLayout.from(perfil)

        val bytes =
            layout.text(
                "\nCupom de exemplo\n",
                ThermalTextAlignment.CENTER,
                ThermalTextStyle.BOLD,
                ThermalTextSize.NORMAL,
            )

        assertTrue(
            "O bloco deixou o cursor no meio da linha: ${larguras(bytes)}",
            larguras(bytes).none { it < 0 },
        )
    }

    @Test
    fun `um cupom com bloco centrado antes nao parte a linha seguinte`() {
        val layout = ReceiptLayout.from(perfil)
        val colunas = perfil.printableColumns
        assertEquals("A régua de colunas de 24/08/2026 mediu 48 nesta impressora.", 48, colunas)

        val cupom =
            receiptBytes(
                listOf(
                    layout.text(
                        "\nCupom de exemplo\n",
                        ThermalTextAlignment.CENTER,
                        ThermalTextStyle.BOLD,
                        ThermalTextSize.NORMAL,
                    ),
                    layout.text(
                        // 35 colunas: cabe nas 48, e era exatamente a linha que o papel partiu.
                        "Item                          Valor\n",
                        ThermalTextAlignment.LEFT,
                        ThermalTextStyle.NORMAL,
                        ThermalTextSize.NORMAL,
                    ),
                ),
            )

        val medidas = larguras(cupom)
        assertTrue("Alguma linha ficou sem quebra: $medidas", medidas.none { it < 0 })
        assertTrue("Alguma linha estourou $colunas colunas: $medidas", medidas.all { it <= colunas })
    }

    @Test
    fun `linha centrada continua centralizada, porque o conserto nao mexe em linha com conteudo`() {
        val layout = ReceiptLayout.from(perfil)

        val bytes = layout.text("oi\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)

        // (48 - 2) / 2 = 23 espacos antes de "oi".
        val texto = bytes.filter { it >= 0x20 }.map { (it.toInt() and 0xFF).toChar() }.joinToString("")
        assertEquals(" ".repeat(23) + "oi", texto)
    }
}
