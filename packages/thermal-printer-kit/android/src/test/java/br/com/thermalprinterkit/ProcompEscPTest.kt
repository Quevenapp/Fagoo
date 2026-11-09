package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Os bytes do emissor Diebold, fixados contra o que saiu no papel em 23/08/2026.
 *
 * Cada `assertArrayEquals` aqui corresponde a uma linha que foi **lida numa tira**, e nao a uma
 * linha do manual — o manual e da linha `PD1`, a impressora e `PD2`, e as duas ja divergiram.
 */
class ProcompEscPTest {
    @Test
    fun `enfase sai sem parametro, ao contrario do ESC POS`() {
        // Medido: `ESC E` seguido de "ENFASE" imprimiu "ENFASE" inteiro. Se levasse parametro, o
        // `E` teria virado parametro e o papel diria "NFASE".
        assertArrayEquals(byteArrayOf(0x1B, 0x45), ProcompEscP.emphasisOn())
        assertArrayEquals(byteArrayOf(0x1B, 0x46), ProcompEscP.emphasisOff())
    }

    @Test
    fun `expandido, condensado e dupla altura`() {
        assertArrayEquals(byteArrayOf(0x1B, 0x0E), ProcompEscP.expandedOn())
        assertArrayEquals(byteArrayOf(0x1B, 0x14), ProcompEscP.expandedOff())
        assertArrayEquals(byteArrayOf(0x1B, 0x0F), ProcompEscP.condensedOn())
        assertArrayEquals(byteArrayOf(0x1B, 0x12), ProcompEscP.condensedOff())
        assertArrayEquals(byteArrayOf(0x1B, 0x5D, 0x01), ProcompEscP.doubleHeight(true))
        assertArrayEquals(byteArrayOf(0x1B, 0x5D, 0x00), ProcompEscP.doubleHeight(false))
    }

    @Test
    fun `o reset desliga atributo por atributo, sem confiar num reset unico`() {
        assertArrayEquals(
            byteArrayOf(0x1B, 0x46, 0x1B, 0x14, 0x1B, 0x12, 0x1B, 0x5D, 0x00),
            ProcompEscP.reset(),
        )
    }

    @Test
    fun `os dois cortes medidos`() {
        assertArrayEquals(byteArrayOf(0x1B, 0x77), ProcompEscP.cut(ProcompCutCommand.ESC_W))
        assertArrayEquals(byteArrayOf(0x1B, 0x1F), ProcompEscP.cut(ProcompCutCommand.ESC_US))
    }

    @Test
    fun `o seletor de tabela e o que o papel confirmou`() {
        assertArrayEquals(
            byteArrayOf(0x1B, 0x74, 0x01),
            ProcompEscP.selectCodeTable(ProcompCodeTable.ABICOMP),
        )
        assertArrayEquals(
            byteArrayOf(0x1B, 0x74, 0x02),
            ProcompEscP.selectCodeTable(ProcompCodeTable.CP850),
        )
    }

    /** Os glifos que sairam acentuados nas tiras M2 e M3, e nao so na tabela do manual. */
    @Test
    fun `os acentos provados em papel`() {
        assertArrayEquals(
            byteArrayOf(0x61, 0xC6.toByte(), 0xC4.toByte(), 0x6F),
            ProcompEscP.encode("acao", ProcompCodeTable.ABICOMP).let {
                ProcompEscP.encode("a\u00E7\u00E3o", ProcompCodeTable.ABICOMP)
            },
        )
        assertArrayEquals(
            byteArrayOf(0x74, 0x72, 0xC9.toByte(), 0x73),
            ProcompEscP.encode("tr\u00EAs", ProcompCodeTable.ABICOMP),
        )
        assertArrayEquals(
            byteArrayOf(0xC2.toByte()),
            ProcompEscP.encode("\u00E1", ProcompCodeTable.ABICOMP),
        )
        assertArrayEquals(
            byteArrayOf(0xD3.toByte()),
            ProcompEscP.encode("\u00F5", ProcompCodeTable.ABICOMP),
        )
    }

    /** A mesma palavra na outra tabela sai com outros bytes — e e por isso que o seletor importa. */
    @Test
    fun `a mesma palavra muda de bytes conforme a tabela`() {
        assertArrayEquals(
            byteArrayOf(0x61, 0x87.toByte(), 0xC6.toByte(), 0x6F),
            ProcompEscP.encode("a\u00E7\u00E3o", ProcompCodeTable.CP850),
        )
    }

    /**
     * **A invariante que protege a impressora.** Nenhuma saida deste emissor pode conter `GS`
     * (`1Dh`) nem o par `ESC @` (`1B 40`).
     *
     * `GS` nao existe nesta firmware, e `ESC @` sai como arroba no papel. Foi o fluxo ESC/POS que
     * travou a IM453H na bancada — a tecla fisica de avanco parou de responder e so desligar e
     * ligar recuperou. Se alguem um dia colar um byte ESC/POS aqui, este teste cai.
     */
    @Test
    fun `nenhuma saida carrega GS nem ESC arroba`() {
        val frase = "Comprovante: a\u00E7\u00E3o, op\u00E7\u00E3o, S\u00E3o Jo\u00E3o"
        val saidas =
            listOf(
                ProcompEscP.reset(),
                ProcompEscP.emphasisOn(), ProcompEscP.emphasisOff(),
                ProcompEscP.expandedOn(), ProcompEscP.expandedOff(),
                ProcompEscP.condensedOn(), ProcompEscP.condensedOff(),
                ProcompEscP.doubleHeight(true), ProcompEscP.doubleHeight(false),
                ProcompEscP.cut(ProcompCutCommand.ESC_W),
                ProcompEscP.cut(ProcompCutCommand.ESC_US),
                ProcompEscP.selectCodeTable(ProcompCodeTable.ABICOMP),
                ProcompEscP.selectCodeTable(ProcompCodeTable.CP850),
                ProcompEscP.feed(3),
                ProcompEscP.encode(frase, ProcompCodeTable.ABICOMP),
                ProcompEscP.encode(frase, ProcompCodeTable.CP850),
            )

        saidas.forEach { saida ->
            assertFalse(
                "Saiu um GS (1Dh), que nao existe nesta firmware.",
                saida.contains(0x1D.toByte()),
            )
            saida.toList().windowed(2).forEach { par ->
                assertFalse(
                    "Saiu ESC arroba (1B 40), que nesta impressora vira arroba no papel.",
                    par[0] == 0x1B.toByte() && par[1] == 0x40.toByte(),
                )
            }
        }
    }

    /**
     * Texto de quem usa o app **nao pode virar comando**.
     *
     * Nesta impressora um byte de controle no lugar errado nao erra um caractere: trava o aparelho.
     * O `ESC` digitado por alguem precisa sumir ou sair como caractere, nunca como escape.
     */
    @Test
    fun `byte de controle vindo do texto nao vira escape`() {
        val saida = ProcompEscP.encode("\u001B@\u001DV nome", ProcompCodeTable.ABICOMP)

        assertFalse("O ESC do texto sobreviveu como escape.", saida.contains(0x1B.toByte()))
        assertFalse("O GS do texto sobreviveu.", saida.contains(0x1D.toByte()))
        assertTrue(
            "O texto legivel se perdeu junto.",
            String(saida, Charsets.ISO_8859_1).contains("nome"),
        )
    }

    /** Sem lugar na tabela, dobra para ASCII: "acao" e legivel, "a?ao" nao e. */
    @Test
    fun `caractere fora da tabela dobra para ASCII antes de virar interrogacao`() {
        // Guarda-chuva nao esta em tabela alta nenhuma nem na dobra.
        assertArrayEquals(
            byteArrayOf(0x3F),
            ProcompEscP.encode("\u2602", ProcompCodeTable.ABICOMP),
        )
        // O eszett NAO cai na dobra: ele existe na ABICOMP, em DBh. A dobra e ultimo recurso,
        // nao primeiro — quem tem lugar na tabela vai para a tabela.
        assertArrayEquals(
            byteArrayOf(0xDB.toByte()),
            ProcompEscP.encode("\u00DF", ProcompCodeTable.ABICOMP),
        )
        // Ja o I com crase nao tem lugar na CP850 deste emissor, entao dobra para "I" legivel
        // em vez de virar interrogacao.
        assertEquals(
            "I",
            String(ProcompEscP.encode("\u00CC", ProcompCodeTable.CP850), Charsets.ISO_8859_1),
        )
    }

    /** Nao existe `ESC a`: o alinhamento e preenchimento, e o que nao cabe volta inteiro. */
    @Test
    fun `alinhamento por preenchimento, sem cortar o que nao cabe`() {
        assertEquals(
            " ".repeat(21) + "TESTE",
            ProcompEscP.padded("TESTE", 48, ProcompAlignment.CENTER),
        )
        val longa = "x".repeat(60)
        assertEquals(longa, ProcompEscP.padded(longa, 48, ProcompAlignment.CENTER))
    }

    @Test
    fun `o avanco recusa numero fora da faixa medida`() {
        assertArrayEquals(byteArrayOf(0x0A, 0x0A), ProcompEscP.feed(2))
        runCatching { ProcompEscP.feed(-1) }.onSuccess { error("Avanco negativo passou.") }
        runCatching { ProcompEscP.feed(1_000) }.onSuccess { error("Avanco absurdo passou.") }
    }
}
