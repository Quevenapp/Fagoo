package br.com.thermalprinterkit

import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EscPosThermalCommandsTest {
    @Test
    fun `GS I consulta somente firmware fabricante e modelo e saneia a resposta`() {
        assertArrayEquals(byteArrayOf(0x1d, 0x49, 65), EscPosPrinterIdentity.FIRMWARE_VERSION_QUERY)
        assertArrayEquals(byteArrayOf(0x1d, 0x49, 66), EscPosPrinterIdentity.MANUFACTURER_QUERY)
        assertArrayEquals(byteArrayOf(0x1d, 0x49, 67), EscPosPrinterIdentity.MODEL_QUERY)

        assertEquals("58E_BT", PrinterDeclaredIdentity.sanitizeField("58E_BT".toByteArray()))
        assertNull(PrinterDeclaredIdentity.sanitizeField(byteArrayOf(0x41, 0x0a, 0x42)))
        assertNull(PrinterDeclaredIdentity.sanitizeField(ByteArray(65) { 0x41 }))
        assertNull(PrinterDeclaredIdentity.sanitizeField("AA:BB:CC:DD:EE:FF".toByteArray()))
    }

    @Test
    fun `pulso de gaveta espelha pinos físicos nos bytes ESC POS`() {
        assertArrayEquals(
            byteArrayOf(0x1b, 0x70, 0x00, 0x32, 0xfa.toByte()),
            EscPosThermalCommands.drawerKickPulse(pin = 2, onTime = 50, offTime = 250),
        )
        assertArrayEquals(
            byteArrayOf(0x1b, 0x70, 0x01, 0x00, 0xff.toByte()),
            EscPosThermalCommands.drawerKickPulse(pin = 5, onTime = 0, offTime = 255),
        )
    }

    @Test
    fun `pulso de gaveta recusa parâmetros antes de converter para byte`() {
        listOf(0, 1, 3, 4, 6, 255).forEach { pin ->
            assertNull(EscPosThermalCommands.drawerKickPulse(pin, onTime = 50, offTime = 250))
        }
        listOf(-1, 256, Int.MIN_VALUE, Int.MAX_VALUE).forEach { time ->
            assertNull(EscPosThermalCommands.drawerKickPulse(pin = 2, onTime = time, offTime = 250))
            assertNull(EscPosThermalCommands.drawerKickPulse(pin = 2, onTime = 50, offTime = time))
        }
    }

    @Test
    fun `GS ! só sai quando o bloco pede tamanho, porque a MP-4200 imprime o !`() {
        val normal =
            EscPosThermalCommands.text(
                "AVANCO 5",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
            )
        val doubled =
            EscPosThermalCommands.text(
                "5",
                ThermalTextAlignment.CENTER,
                ThermalTextStyle.BOLD,
                0x11,
            )
        val sizeCommand = byteArrayOf(0x1D, 0x21)

        // A MP-4200 TH engole só o `GS` e manda o `!` para o papel: saiu "!0" no número e
        // "!!Escolha" na instrução da sonda de avanço.
        assertFalse(String(normal, StandardCharsets.ISO_8859_1).contains(String(sizeCommand, StandardCharsets.ISO_8859_1)))
        // Quem amplia continua pedindo o tamanho e devolvendo a zero no fim, senão vaza para o
        // bloco seguinte, que não emite mais o comando.
        val text = String(doubled, StandardCharsets.ISO_8859_1)
        assertTrue(text.contains(String(byteArrayOf(0x1D, 0x21, 0x11), StandardCharsets.ISO_8859_1)))
        assertTrue(text.endsWith(String(byteArrayOf(0x1D, 0x21, 0x00), StandardCharsets.ISO_8859_1)))
    }

    @Test
    fun `byte cru legado também recusa bits de multiplicador reservados`() {
        assertThrows(IllegalArgumentException::class.java) {
            EscPosThermalCommands.text(
                "inválido",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0x88,
            )
        }
    }

    @Test
    fun `protected QR is raster ESC POS and never contains its token as text`() {
        val secretQr = "https://vinki.me/ABCD-2345#access=${"a".repeat(43)}"

        val text = EscPosThermalCommands.text("Senha A025\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, 17)
        val qr = requireNotNull(EscPosThermalCommands.qrRaster(secretQr, 320, 2))
        val advance = requireNotNull(EscPosThermalCommands.advance(5))
        val cut = requireNotNull(EscPosThermalCommands.cut(1, CutProtocol.GS_V))

        // ESC t 2 (página CP850) · ESC a 1 (centro) · ESC E 1 (negrito) · GS ! 0x11 (dobro)
        assertArrayEquals(
            byteArrayOf(0x1b, 0x74, 0x02, 0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01, 0x1d, 0x21, 0x11),
            text.copyOfRange(0, 12),
        )
        assertArrayEquals(
            byteArrayOf(
                0x1b,
                0x61,
                0x01,
                0x1d,
                0x76,
                0x30,
                0x00,
                0x28,
                0x00,
                0x18,
                0x00,
            ),
            qr.copyOfRange(0, 11),
        )
        assertFalse(String(qr, StandardCharsets.ISO_8859_1).contains(secretQr))
        assertFalse(String(qr, StandardCharsets.ISO_8859_1).contains("https://"))
        assertEquals(secretQr, decodeRasterQr(qr, 320))
        // Capturado antes de extrair o emissor comum de `GS v 0`: fixa todos os bytes, não só o
        // cabeçalho, para a imagem arbitrária não mudar silenciosamente o QR protegido.
        assertEquals(12_915, qr.size)
        assertEquals(
            "3cb9db672e03710c4570bfe49bbefae93702845d34619bc392ab7029dbaabe99",
            MessageDigest.getInstance("SHA-256")
                .digest(qr)
                .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) },
        )
        // Avanço em quebras de linha: a MP-4200 ignora `ESC d` e as oito tiras da sonda saíam
        // do mesmo tamanho, de zero a doze.
        assertArrayEquals(byteArrayOf(0x0a, 0x0a, 0x0a, 0x0a, 0x0a), advance)
        // `GS V 1`, parcial: cinco cupons saem presos por um filete em vez de soltos
        // na bancada, onde encavalam e alguém perde uma. Ver `ReceiptLayoutTest`.
        assertArrayEquals(byteArrayOf(0x0a, 0x1d, 0x56, 0x01), cut)
    }

    @Test
    fun `text keeps Portuguese accents through the code page`() {
        val bytes =
            EscPosThermalCommands.text(
                "OPÇÃO[0m\n",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
            )

        // `ESC t 2` seleciona CP850 antes do texto: `ESC @` zera a pagina, entao ela precisa ser
        // reafirmada a cada bloco.
        assertArrayEquals(byteArrayOf(0x1b, 0x74, 0x02), bytes.copyOfRange(0, 3))

        // Ç é 0x80 e Ã é 0xC7 na CP850 — bytes da pagina, nao dobramento para ASCII.
        assertTrue("o C-cedilha precisa virar o byte 0x80 da CP850", bytes.contains(0x80.toByte()))
        assertTrue("o A-til precisa virar o byte 0xC7 da CP850", bytes.contains(0xc7.toByte()))

        val ascii = String(bytes, StandardCharsets.US_ASCII)
        // Caractere de controle continua virando `?`.
        assertTrue(ascii.contains("?[0m\n"))
        // E o comportamento antigo, que jogava o acento fora, nao pode voltar.
        assertFalse("o acento nao pode mais ser descartado", ascii.contains("OPCAO"))
    }

    @Test
    fun `each code page maps the same letter to its own byte`() {
        val cp850 =
            EscPosThermalCommands.text(
                "Ã",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                ThermalCodePage.CP850,
            )
        val cp860 =
            EscPosThermalCommands.text(
                "Ã",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                ThermalCodePage.CP860,
            )

        assertArrayEquals(byteArrayOf(0x1b, 0x74, 0x02), cp850.copyOfRange(0, 3))
        assertArrayEquals(byteArrayOf(0x1b, 0x74, 0x03), cp860.copyOfRange(0, 3))
        // A-til e 0xC7 na CP850 e 0x8E na CP860: mandar a pagina errada imprime outra letra.
        assertTrue(cp850.contains(0xc7.toByte()))
        assertTrue(cp860.contains(0x8e.toByte()))
    }

    @Test
    fun `QR bounds reject invalid data before it reaches TCP`() {
        assertNull(EscPosThermalCommands.qrRaster("https://vinki.me/A", widthDots = 321, errorCorrection = 2))
        assertNull(EscPosThermalCommands.qrRaster("https://vinki.me/A", widthDots = 320, errorCorrection = 0))
        assertNull(EscPosThermalCommands.qrRaster("https://vinki.me/A", widthDots = 320, errorCorrection = 5))
    }

    @Test
    fun `status only diagnoses cover or paper after a valid response`() {
        assertEquals(ThermalCoverStatus.UNKNOWN, EscPosStatus.cover(null))
        assertEquals(ThermalCoverStatus.CLOSED, EscPosStatus.cover(0x12))
        assertEquals(ThermalCoverStatus.OPEN, EscPosStatus.cover(0x16))
        assertEquals(ThermalPaperStatus.UNKNOWN, EscPosStatus.paper(null))
        assertEquals(ThermalPaperStatus.PRESENT, EscPosStatus.paper(0x12))
        assertEquals(ThermalPaperStatus.LOW, EscPosStatus.paper(0x1e))
        assertEquals(ThermalPaperStatus.OUT, EscPosStatus.paper(0x72))
    }

    @Test
    fun `a response without the fixed Epson layout is unknown and never blocks printing`() {
        // 0x14 é o primeiro byte do bloco ASB; sem o layout fixo ele já foi lido como tampa aberta.
        listOf(0x14, 0x00, 0x04, 0x60, 0xff, 0x92, 0x10, 0x13, 0x100, -1).forEach { response ->
            assertFalse("byte $response", EscPosStatus.isStatusResponse(response))
            assertEquals(ThermalCoverStatus.UNKNOWN, EscPosStatus.cover(response))
            assertEquals(ThermalPaperStatus.UNKNOWN, EscPosStatus.paper(response))
        }
        assertTrue(EscPosStatus.isStatusResponse(0x12))
    }

    /**
     * A portatil 58mm foi sondada com CP850, CP860, CP437, CP1252, CP866 e CP858 e nao imprimiu
     * nenhuma delas de forma legivel — engoliu os bytes altos e comeu quebra de linha. Para ela o
     * perfil traz `codePage = null`, e entao nem o `ESC t` sai nem byte acima de 0x7E.
     */
    @Test
    fun `printer without a code page gets folded ascii and no ESC t`() {
        val bytes =
            EscPosThermalCommands.text(
                "OPÇÃO",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                null,
            )

        assertFalse(
            "sem pagina de codigo o comando ESC t nao pode sair",
            bytes.toList().windowed(2).any { it[0] == 0x1b.toByte() && it[1] == 0x74.toByte() },
        )
        bytes.forEach { b ->
            assertTrue("byte alto vira simbolo nessa impressora: $b", b.toInt() and 0xff <= 0x7e)
        }
        assertTrue(String(bytes, StandardCharsets.US_ASCII).contains("OPCAO"))
    }

    @Test
    fun `UTF-8 preserva acentos e não emite ESC t`() {
        val sample = "ação, opção, São João"
        val bytes =
            EscPosThermalCommands.text(
                sample,
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                codePage = null,
                textEncoding = ThermalTextEncoding.UTF_8,
            )

        assertFalse(bytes.toList().windowed(2).any { it == listOf(0x1b.toByte(), 0x74.toByte()) })
        assertTrue(bytes.toList().windowed(sample.toByteArray().size).any { window ->
            window.toByteArray().contentEquals(sample.toByteArray(StandardCharsets.UTF_8))
        })
        assertTrue(bytes.contains(0xc3.toByte()))
    }

    /** Cards não podem ressuscitar as páginas antigas antes de uma nova homologação. */
    @Test
    fun `catalog cards carry no trusted code page`() {
        BundledPrinterDrivers.all.forEach { assertNull(it.codePage) }
    }
}


private fun decodeRasterQr(command: ByteArray, widthDots: Int): String {
    val widthBytes = widthDots / 8
    val pixels = IntArray(widthDots * widthDots)
    var commandOffset = 3
    var outputY = 0
    while (outputY < widthDots) {
        require(command[commandOffset] == 0x1d.toByte())
        require(command[commandOffset + 1] == 0x76.toByte())
        require(command[commandOffset + 2] == 0x30.toByte())
        require(command[commandOffset + 3] == 0x00.toByte())
        val encodedWidthBytes =
            (command[commandOffset + 4].toInt() and 0xff) or
                ((command[commandOffset + 5].toInt() and 0xff) shl 8)
        val stripeHeight =
            (command[commandOffset + 6].toInt() and 0xff) or
                ((command[commandOffset + 7].toInt() and 0xff) shl 8)
        require(encodedWidthBytes == widthBytes)
        val dataOffset = commandOffset + 8
        for (stripeY in 0 until stripeHeight) {
            for (x in 0 until widthDots) {
                val packed = command[dataOffset + stripeY * widthBytes + x / 8].toInt()
                val black = packed and (0x80 shr (x % 8)) != 0
                pixels[(outputY + stripeY) * widthDots + x] =
                    if (black) 0xff000000.toInt() else 0xffffffff.toInt()
            }
        }
        outputY += stripeHeight
        commandOffset = dataOffset + widthBytes * stripeHeight
    }
    return QRCodeReader()
        .decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(widthDots, widthDots, pixels))))
        .text
}
