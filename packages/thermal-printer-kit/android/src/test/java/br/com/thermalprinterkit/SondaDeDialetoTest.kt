package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A tira de dialeto, lida pelos dois lados.
 *
 * O teste que vale aqui não é o dos bytes: é o das **duas leituras**. Dois decodificadores
 * minúsculos simulam a única diferença medida entre as famílias — o ESC/POS consome o byte depois
 * de `ESC E`, a Diebold não — e a tira só serve se as duas leituras saírem diferentes e legíveis.
 *
 * Eles não provam firmware nenhuma. Provam que a tira **pergunta** o que diz perguntar; se ela
 * responde é o papel que decide, e do lado ESC/POS isso nunca foi medido. Ver [SondaDeDialeto].
 */
class SondaDeDialetoTest {

    /** Como uma firmware ESC/POS lê: `ESC E n` consome o `n`. */
    private fun lidaComoEscPos(bytes: ByteArray): String {
        val saida = StringBuilder()
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i]
            if (b == ESC && i + 2 < bytes.size && bytes[i + 1] == ENFASE) {
                i += 3 // ESC, E e o parâmetro
                continue
            }
            saida.append(b.toInt().toChar())
            i += 1
        }
        return saida.toString()
    }

    /** Como a Diebold Procomp lê: `ESC E` não consome nada. Medido no M2, 23/08/2026. */
    private fun lidaComoProcomp(bytes: ByteArray): String {
        val saida = StringBuilder()
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i]
            if (b == ESC && i + 1 < bytes.size && bytes[i + 1] == ENFASE) {
                i += 2 // só ESC e E
                continue
            }
            saida.append(b.toInt().toChar())
            i += 1
        }
        return saida.toString()
    }

    private fun linhaMarcada(texto: String): String =
        texto.lines().first { it.startsWith("> ") }.removePrefix("> ")

    @Test
    fun `as duas leituras saem diferentes, e nenhuma delas sai vazia`() {
        val tira = SondaDeDialeto.tira()

        val epson = linhaMarcada(lidaComoEscPos(tira))
        val procomp = linhaMarcada(lidaComoProcomp(tira))

        assertEquals(SondaDeDialeto.LEITURA_ESC_POS, epson)
        assertEquals(SondaDeDialeto.LEITURA_PROCOMP, procomp)
        // O ponto inteiro do desenho: nenhum lado responde com ausência. Em 21/08 duas sondas
        // deram papel em branco idêntico e quase sustentaram a conclusão errada — branco não
        // separa "engoliu o comando" de "não recebeu byte nenhum".
        assertTrue("o lado ESC/POS precisa imprimir algo", epson.isNotEmpty())
        assertTrue("o lado Procomp precisa imprimir algo", procomp.isNotEmpty())
        assertTrue("as duas leituras têm de ser distinguíveis", epson != procomp)
    }

    @Test
    fun `a tira nao carrega nenhum byte da familia que trava a Diebold`() {
        val tira = SondaDeDialeto.tira()

        // `GS` é a família que a IM453H não tem, e é ela que travou o aparelho em 23/08/2026.
        assertFalse("nenhum GS na tira", tira.any { it == GS })
        // `ESC @` não é comando dela: o `40h` foi ao papel como "@" nas duas tiras daquele dia.
        (0 until tira.size - 1).forEach { i ->
            assertFalse(
                "nenhum ESC @ na tira",
                tira[i] == ESC && tira[i + 1] == INIT,
            )
        }
    }

    @Test
    fun `fora dos pares ESC E, a tira e so ASCII imprimivel e LF`() {
        val tira = SondaDeDialeto.tira()
        var i = 0
        while (i < tira.size) {
            if (tira[i] == ESC) {
                // Todo ESC desta tira é um par `ESC E`, e nada mais. Um ESC solto no lugar errado
                // nesta impressora não erra um caractere: trava o aparelho.
                assertTrue("ESC solto na tira", i + 1 < tira.size && tira[i + 1] == ENFASE)
                i += 2
                continue
            }
            val code = tira[i].toInt() and 0xFF
            assertTrue(
                "byte fora da faixa medida como segura nas duas: $code",
                code == 0x0A || code in 0x20..0x7E,
            )
            i += 1
        }
    }

    @Test
    fun `o parametro e par, para o ESC POS terminar sem negrito ligado`() {
        val tira = SondaDeDialeto.tira()
        var pares = 0
        (0 until tira.size - 2).forEach { i ->
            if (tira[i] == ESC && tira[i + 1] == ENFASE) {
                val parametro = tira[i + 2].toInt() and 0xFF
                // No ESC/POS só o bit 0 do parâmetro decide o negrito. Ímpar ligaria, e a tira
                // terminaria sujando o estado da impressora seguinte.
                assertEquals("o parâmetro precisa ser par", 0, parametro and 0x01)
                pares += 1
            }
        }
        assertEquals("um par por letra da palavra marcada", SondaDeDialeto.LEITURA_ESC_POS.length, pares)
    }

    @Test
    fun `a tira cabe no teto do comando cru`() {
        // 256 bytes é o teto do caminho de bytes crus, e foi ele que impediu a sonda de `n2` em
        // 23/08. Uma sonda que não cabe no comando cru não é disparável na bancada.
        assertTrue(
            "a tira tem ${SondaDeDialeto.tira().size} bytes",
            SondaDeDialeto.tira().size <= 256,
        )
    }

    private companion object {
        const val ESC: Byte = 0x1B
        const val ENFASE: Byte = 0x45
        const val INIT: Byte = 0x40
        const val GS: Byte = 0x1D
    }
}
