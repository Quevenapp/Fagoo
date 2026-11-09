package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RawHexCommandTest {
    @Test
    fun `o comando só é enviado depois da confirmação explícita`() = runTest {
        var received: ByteArray? = null
        val controller = RawCommandController { bytes -> received = bytes }

        val confirmation = controller.prepare("1b 40 0A")

        assertEquals(3, confirmation.byteCount)
        assertEquals(RAW_COMMAND_RISK_WARNING, confirmation.warning)
        assertTrue(confirmation.warning.contains("configuração não volátil"))
        assertTrue(received == null)

        controller.confirmAndSend()

        // A falsa implementação guarda a mesma referência para provar que o bloco foi zerado
        // depois que o transporte concluiu, e não apenas que uma cópia local foi descartada.
        assertTrue(received!!.all { it == 0.toByte() })
    }

    @Test
    fun `cancelar zera o pendente e impede um envio posterior`() {
        var sends = 0
        val controller = RawCommandController { sends += 1 }

        controller.prepare("1B40")
        controller.cancel()

        assertThrows(IllegalStateException::class.java) {
            runTest { controller.confirmAndSend() }
        }
        assertEquals(0, sends)
    }

    @Test
    fun `o parser limita o buffer a 256 bytes e não repete o conteúdo em erro`() {
        val tooLarge = "AA".repeat(257)
        val error = assertThrows(IllegalArgumentException::class.java) { RawHexCommand.parse(tooLarge) }

        assertTrue(error.message.orEmpty().contains("256"))
        assertFalse(error.message.orEmpty().contains(tooLarge))
    }

    @Test
    fun `a descrição sempre oculta os bytes`() {
        val command = RawHexCommand.parse("1B 40")

        assertFalse(command.toString().contains("1B", ignoreCase = true))
        assertTrue(command.toString().contains("[REDACTED]"))
        command.clear()
    }
}
