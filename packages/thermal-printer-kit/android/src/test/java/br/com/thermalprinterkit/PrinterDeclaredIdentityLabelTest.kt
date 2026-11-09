package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Medido na bancada com a impressora de 80 mm que se apresenta como J-SPEED P80: o `GS I` dela
 * responde com o rótulo colado no valor. Guardar isso inteiro fazia o comprovante sair com
 * `Fabricante: _Manufacturer:J-SPEED` e batizava o perfil de
 * `_Manufacturer:J-SPEED _Print Name:P80-Serials` — o nome que iria para o perfil.
 */
class PrinterDeclaredIdentityLabelTest {
    @Test
    fun `rótulo colado ao valor não entra na identidade`() {
        val identidade =
            PrinterDeclaredIdentity.fromResponses(
                firmwareVersion = ascii("_8.00 ESC/POS"),
                manufacturer = ascii("_Manufacturer:J-SPEED"),
                model = ascii("_Print Name:P80-Serials"),
            )

        assertEquals("J-SPEED", identidade?.manufacturer)
        assertEquals("P80-Serials", identidade?.model)
        assertEquals("8.00 ESC/POS", identidade?.firmwareVersion)
        assertEquals("J-SPEED P80-Serials", identidade?.displayNameOr("Impressora"))
    }

    @Test
    fun `firmware que já vem limpo atravessa igual, e dois pontos no meio do nome sobrevivem`() {
        val identidade =
            PrinterDeclaredIdentity.fromResponses(
                firmwareVersion = ascii("1.2.3"),
                manufacturer = ascii("Elgin"),
                model = ascii("i9 FULL: edicao 2"),
            )

        assertEquals("Elgin", identidade?.manufacturer)
        assertEquals("i9 FULL: edicao 2", identidade?.model)
        assertEquals("1.2.3", identidade?.firmwareVersion)
    }

    /**
     * O `AA:` de um MAC parece rótulo. Tirar primeiro e filtrar depois deixaria
     * `BB:CC:DD:EE:FF` passar, porque o que sobra não parece mais um MAC.
     */
    @Test
    fun `tirar rótulo não abre caminho para identificador técnico`() {
        listOf(
            "AA:BB:CC:DD:EE:FF",
            "Endereco:192.168.1.150",
            "MAC:AA:BB:CC:DD:EE:FF",
        ).forEach { bruto ->
            assertEquals(null, PrinterDeclaredIdentity.sanitizeField(ascii(bruto)))
        }
    }

    private fun ascii(value: String) = value.toByteArray(StandardCharsets.US_ASCII)
}
