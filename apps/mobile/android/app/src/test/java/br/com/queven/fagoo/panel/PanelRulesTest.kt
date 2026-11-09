package br.com.queven.fagoo.panel

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class PanelRulesTest {
    private val time = Instant.parse("2026-11-09T12:00:00Z")
    private fun snapshot(status: String = "chamada", recalls: Int = 0) = PanelSnapshot(PanelUnit("unit", "Loja", "America/Sao_Paulo"), 20, time.toString(), PanelConfig(), tickets = listOf(PanelTicket("ticket", "A001", status, "1", recalls)))
    private fun job(expires: String = "2026-11-09T12:05:00Z") = PanelJob("job", "event", "audio", buildJsonObject { put("ticket_id", "ticket"); put("desk", "1"); put("recalls", 0) }, "claim", expires)
    @Test fun onlyCurrentAuthorizedCallCanSpeak() {
        assertTrue(PanelRules.canExecuteAudio(job(), snapshot(), time))
        assertFalse(PanelRules.canExecuteAudio(job(), snapshot("em_atendimento"), time))
        assertFalse(PanelRules.canExecuteAudio(job(), snapshot(recalls = 1), time))
        assertFalse(PanelRules.canExecuteAudio(job("2026-11-09T11:59:00Z"), snapshot(), time))
    }
    @Test fun expiredAndDisabledCampaignsAreExcluded() {
        val live = PanelCampaign("1", "Mídia", "https://example.com/x.png", "image", "2026-11-09T11:00:00Z", "2026-11-09T13:00:00Z", surfaces = listOf("chamada"))
        val value = snapshot().copy(campaigns = listOf(live, live.copy(id = "2", expires_at = "2026-11-09T11:00:00Z"), live.copy(id = "3", active = false), live.copy(id = "4", media_url = "http://example.com/x")))
        assertEquals(listOf("1"), PanelRules.campaigns(value, "chamada", time).map { it.id })
        assertTrue(PanelRules.campaigns(value, "emitir", time).isEmpty())
        assertTrue(PanelRules.campaigns(value.copy(config = PanelConfig(media_enabled = false)), "chamada", time).isEmpty())
    }
    @Test fun catalogKeepsAllFiveTemplateIds() {
        assertEquals(listOf("sinal", "clinica", "terminal", "vitrine", "sol"), PanelTemplate.entries.map { it.id })
        assertEquals(PanelTemplate.SINAL, PanelTemplate.fromId("unknown"))
    }
}
