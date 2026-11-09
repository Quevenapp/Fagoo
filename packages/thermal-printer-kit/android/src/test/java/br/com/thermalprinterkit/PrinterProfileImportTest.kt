package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterProfileImportTest {
    @Test
    fun `host só recebe autorização depois da releitura do perfil neutro`() {
        val profile = measured()
        val store = InMemoryPrinterProfileStore()

        val result = importLegacyPrinterProfiles(LegacyPrinterProfileReader { listOf(profile) }, store)

        assertTrue(result is PrinterProfileImportResult.Imported)
        result as PrinterProfileImportResult.Imported
        assertEquals(setOf(profile.id), result.authorization.confirmedProfileIds)
        assertEquals(profile.capabilityKey, store.read().single().capabilityKey)
    }

    @Test
    fun `falha de confirmação não autoriza apagar perfil legado`() {
        val store =
            object : PrinterProfileStore {
                override fun read(): List<MeasuredProfile> = emptyList()
                override fun save(profile: MeasuredProfile) = Unit
                override fun remove(profileId: String) = Unit
                override fun clear() = Unit
            }

        val result = importLegacyPrinterProfiles(LegacyPrinterProfileReader { listOf(measured()) }, store)

        assertTrue(result is PrinterProfileImportResult.Failed)
    }

    @Test
    fun `seleção legada também exige gravar e reler antes da autorização`() {
        val expected =
            PersistedPrinterSelections().with(
                PersistedPrinterSelection.LocalWifi(BundledPrinterDrivers.elginI9Full2.id),
            )
        val store = InMemoryPrinterSelectionStore()

        val result =
            importLegacyPrinterSelections(
                LegacyPrinterSelectionReader { expected },
                store,
            )

        assertTrue(result is PrinterSelectionImportResult.Imported)
        assertEquals(expected, store.read())
    }

    @Test
    fun `seleção não confirmada nunca entrega autorização de exclusão`() {
        val expected =
            PersistedPrinterSelections().with(
                PersistedPrinterSelection.Usb(BundledPrinterDrivers.elginI9Full2.id),
            )
        val broken =
            object : PrinterSelectionStore {
                override fun read() = PersistedPrinterSelections()
                override fun save(selections: PersistedPrinterSelections) = Unit
                override fun clear() = Unit
            }

        val result = importLegacyPrinterSelections(LegacyPrinterSelectionReader { expected }, broken)

        assertTrue(result is PrinterSelectionImportResult.Failed)
    }

    private fun measured(): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = "00000000-0000-4000-8000-000000000021",
            displayName = "Impressora importada",
            transports = setOf(PrinterTransport.USB),
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            codePage = ThermalCodePage.CP850,
            cutProtocol = CutProtocol.GS_V_1,
            cutFeedLines = 5,
            measuredAtEpochMillis = 1,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )
}
