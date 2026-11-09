package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterContributionTest {
    @Test
    fun `pacote é JSON UTF-8 estável e igual ao contrato compartilhado`() {
        val profile = measuredProfile()

        val encoded = createPrinterContributionJson(profile, osVersion = "16", appVersion = "2.4.0")
        val json = encoded.toString(StandardCharsets.UTF_8)

        assertTrue(encoded.contentEquals(json.toByteArray(StandardCharsets.UTF_8)))
        assertEquals(
            """
            {
              "kind": "printher.printer-contribution",
              "version": 1,
              "profile": {
                "displayName": "Impressora da José",
                "firmwareVersion": "SV3.2.2",
                "transports": ["BLUETOOTH", "BLUETOOTH_LE", "LOCAL_WIFI", "USB"],
                "paperWidthMm": 80,
                "printableColumns": 48,
                "printableDots": 576,
                "textEncoding": "SINGLE_BYTE_CODE_PAGE",
                "codePage": "CP850",
                "codePageSelector": 8,
                "cutProtocol": "GS_V_1",
                "cutModeHonored": false,
                "cutFeedLines": 5,
                "dialect": "EPSON_COMPATIBLE",
                "capabilityKey": "${profile.capabilityKey.value}",
                "measuredAtEpochMillis": 1234567890000
              },
              "platform": { "os": "android", "osVersion": "16", "appVersion": "2.4.0" }
            }

            """.trimIndent(),
            json,
        )
    }

    @Test
    fun `pacote não leva id local endpoint nem identificador técnico`() {
        val profile = measuredProfile()
        val root =
            JSONObject(
                createPrinterContributionJson(profile, "16", "2.4.0")
                    .toString(StandardCharsets.UTF_8),
            )
        val payload = root.toString()
        val profileKeys = root.getJSONObject("profile").keys().asSequence().toSet()

        assertEquals(setOf("kind", "version", "profile", "platform"), root.keys().asSequence().toSet())
        assertEquals(
            setOf("os", "osVersion", "appVersion"),
            root.getJSONObject("platform").keys().asSequence().toSet(),
        )
        assertEquals(
            setOf(
                "displayName",
                "firmwareVersion",
                "transports",
                "paperWidthMm",
                "printableColumns",
                "printableDots",
                "textEncoding",
                "codePage",
                "codePageSelector",
                "cutProtocol",
                "cutModeHonored",
                "cutFeedLines",
                "dialect",
                "capabilityKey",
                "measuredAtEpochMillis",
            ),
            profileKeys,
        )
        assertFalse(payload.contains(profile.id))
        listOf("ip", "mac", "vid", "pid", "uuid", "peripheral", "address", "serial", "endpoint")
            .forEach { forbidden ->
                assertFalse("campo técnico encontrado: $forbidden", profileKeys.any { it.equals(forbidden, true) })
            }
    }

    @Test
    fun `somente medição confirmada pode ser exportada`() {
        assertThrows(IllegalArgumentException::class.java) {
            createPrinterContributionJson(
                MeasuredProfile.bundled(BundledPrinterDrivers.elginI9Full2),
                "16",
                "2.4.0",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            createPrinterContributionJson(
                MeasuredProfile.temporary(PrinterTransport.BLUETOOTH, 58, dialect = EscPosDialect.EPSON_COMPATIBLE),
                "16",
                "2.4.0",
            )
        }
    }

    @Test
    fun `UTF-8 usa o nome neutro fixado pelo contrato`() {
        val utf8 =
            measuredProfile().copy(
                codePage = null,
                codePageSelector = null,
                textEncoding = ThermalTextEncoding.UTF_8,
            )

        val profile =
            JSONObject(
                createPrinterContributionJson(utf8, "16", "2.4.0")
                    .toString(StandardCharsets.UTF_8),
            ).getJSONObject("profile")

        assertEquals("UTF8", profile.getString("textEncoding"))
        assertTrue(profile.isNull("codePage"))
        assertTrue(profile.isNull("codePageSelector"))
    }

    @Test
    fun `tipo do pacote e proprio, nunca application slash json`() {
        // O tipo genérico faria o app que recebe contribuição aparecer na folha de
        // compartilhamento de todo JSON do aparelho, e a filtragem viraria validação depois do
        // fato. O par MIME/UTI é contrato entre dois apps: mudá-lo aqui sem mudar lá derruba o
        // caminho inteiro em silêncio, porque o destino simplesmente deixa de ser oferecido.
        assertEquals(
            "application/vnd.printher.printer-contribution+json",
            PRINTER_CONTRIBUTION_MIME_TYPE,
        )
    }

    private fun measuredProfile(): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = "00000000-0000-4000-8000-000000000077",
            displayName = "Impressora da José",
            transports = setOf(PrinterTransport.LOCAL_WIFI, PrinterTransport.BLUETOOTH),
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            codePage = ThermalCodePage.CP850,
            codePageSelector = 8,
            cutProtocol = CutProtocol.GS_V_1,
            cutModeHonored = false,
            cutFeedLines = 5,
            measuredAtEpochMillis = 1_234_567_890_000,
            firmwareVersion = "SV3.2.2",
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )
}
