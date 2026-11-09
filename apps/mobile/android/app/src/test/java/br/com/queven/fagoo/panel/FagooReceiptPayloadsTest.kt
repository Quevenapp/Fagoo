package br.com.queven.fagoo.panel

import br.com.thermalprinterkit.ReceiptLayout
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O cupom da senha no V4, montado pelo ThermalPrinterKit como no V2. O texto
 * sai em ESC/POS; o teste lê os bytes como Latin-1 para achar o que foi escrito.
 */
class FagooReceiptPayloadsTest {
    private val portable58mm = ReceiptLayout(columns = 32, qrWidthDots = 240, hasCutter = false)

    @Test
    fun `o cupom da senha leva a loja, o numero e o convite para acompanhar`() {
        val payload = FagooTicketReceipt.create("A012", "https://loja.example/s/tok123", header = "Padaria Central")
        val text = String(payload.receiptBytes(portable58mm), Charsets.ISO_8859_1)
        assertTrue(text.contains("Padaria Central"))
        assertTrue(text.contains("SENHA"))
        assertTrue(text.contains("A012"))
        assertTrue(text.contains("acompanhar"))
        // O QR leva só o token público; o texto do endereço não vai no papel.
        assertFalse(text.contains("tok123"))
    }

    @Test
    fun `sem pagina publica da loja o cupom sai so com o numero`() {
        val payload = FagooTicketReceipt.create("A012", null)
        val text = String(payload.receiptBytes(portable58mm), Charsets.ISO_8859_1)
        assertTrue(text.contains("A012"))
        assertFalse(text.contains("acompanhar"))
    }

    @Test
    fun `depois de impresso o cupom esquece o endereco e nao aparece em log`() {
        val payload = FagooTicketReceipt.create("A012", "https://loja.example/s/tok123")
        payload.clear()
        assertFalse(payload.toString().contains("tok123"))
        assertFalse(payload.toString().contains("A012"))
    }
}
