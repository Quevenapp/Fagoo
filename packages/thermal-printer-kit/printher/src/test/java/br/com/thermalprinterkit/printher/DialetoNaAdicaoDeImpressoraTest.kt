package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.EscPosDialect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A decisão que estava dentro da tela, e que por isso não tinha prova possível sem emulador.
 *
 * **O que caiu aqui.** Até 09/09/2026 a tela de adicionar impressora escrevia, em três lugares,
 * `selectedProfile?.driver?.dialect ?: EscPosDialect.EPSON_COMPATIBLE`. O terceiro deles é o ponto
 * por onde **toda** busca passa — a escolha de conexão —, então o `?:` alcançava os quatro
 * transportes de uma vez. Uma Diebold IM453H chegada por "Nova impressora" recebia o prólogo
 * ESC/POS na primeira tira da medição: `ESC @` e uma régua em `GS v 0`, que é a sequência medida
 * travando o aparelho em 23/08/2026.
 *
 * Estes testes não provam que a tela desenha certo — isso é `androidTest`. Eles provam a parte que
 * quebra em silêncio: quem vence entre o card e a resposta, e que ausência continua sendo ausência.
 */
class DialetoNaAdicaoDeImpressoraTest {

    @Test
    fun `sem card e sem resposta nao existe dialeto, e nao existe padrao`() {
        // O `null` aqui é o teste inteiro. Se algum dia isto devolver EPSON_COMPATIBLE, o defeito
        // de 23/08 voltou — e volta calado, porque nada na tela muda de aparência.
        val escolhido =
            DialetoNaAdicaoDeImpressora.daCandidata(doCard = null, respondido = null)

        assertNull("ausência de resposta não pode virar dialeto", escolhido)
        assertNotEquals(EscPosDialect.EPSON_COMPATIBLE, escolhido)
        assertTrue(
            DialetoNaAdicaoDeImpressora.faltaPerguntar(doCard = null, respondido = null),
        )
    }

    @Test
    fun `o card responde sozinho, e a pergunta nao e feita`() {
        val escolhido =
            DialetoNaAdicaoDeImpressora.daCandidata(
                doCard = EscPosDialect.PROCOMP_ESC_P,
                respondido = null,
            )

        assertEquals(EscPosDialect.PROCOMP_ESC_P, escolhido)
        assertFalse(
            DialetoNaAdicaoDeImpressora.faltaPerguntar(
                doCard = EscPosDialect.PROCOMP_ESC_P,
                respondido = null,
            ),
        )
    }

    @Test
    fun `sem card, quem responde e a pessoa`() {
        assertEquals(
            EscPosDialect.PROCOMP_ESC_P,
            DialetoNaAdicaoDeImpressora.daCandidata(
                doCard = null,
                respondido = EscPosDialect.PROCOMP_ESC_P,
            ),
        )
        assertEquals(
            EscPosDialect.EPSON_COMPATIBLE,
            DialetoNaAdicaoDeImpressora.daCandidata(
                doCard = null,
                respondido = EscPosDialect.EPSON_COMPATIBLE,
            ),
        )
    }

    @Test
    fun `o card vence a resposta, e nao o contrario`() {
        // Uma resposta digitada para a impressora anterior não pode decidir a seguinte. É o mesmo
        // formato do defeito da largura: a T210 foi medida em 80 mm porque a largura atravessou de
        // outra impressora, em 12/08. Inverter os dois lados deste `?:` reabre aquele buraco no
        // campo que trava o aparelho em vez de estragar o papel.
        assertEquals(
            EscPosDialect.PROCOMP_ESC_P,
            DialetoNaAdicaoDeImpressora.daCandidata(
                doCard = EscPosDialect.PROCOMP_ESC_P,
                respondido = EscPosDialect.EPSON_COMPATIBLE,
            ),
        )
        assertEquals(
            EscPosDialect.EPSON_COMPATIBLE,
            DialetoNaAdicaoDeImpressora.daCandidata(
                doCard = EscPosDialect.EPSON_COMPATIBLE,
                respondido = EscPosDialect.PROCOMP_ESC_P,
            ),
        )
    }

    @Test
    fun `as duas perguntas nao podem divergir`() {
        // Uma decide rota e a outra decide bytes. Se elas discordarem, existe um caminho que entra
        // na busca sem dialeto ou uma pergunta feita a quem já respondeu.
        val valores = listOf(null, EscPosDialect.EPSON_COMPATIBLE, EscPosDialect.PROCOMP_ESC_P)
        valores.forEach { card ->
            valores.forEach { resposta ->
                assertEquals(
                    "card=$card resposta=$resposta",
                    DialetoNaAdicaoDeImpressora.daCandidata(card, resposta) == null,
                    DialetoNaAdicaoDeImpressora.faltaPerguntar(card, resposta),
                )
            }
        }
    }

    // ── A rota ──────────────────────────────────────────────────────────────────────────────────

    @Test
    fun `Nova impressora cai na pergunta antes de escolher a conexao`() {
        // A ordem é o que protege o aparelho: o perfil temporário nasce na escolha de conexão, e é
        // o dialeto dele que decide o prólogo do transporte. Perguntar depois seria perguntar
        // tarde.
        assertEquals(
            PrinterSetupPath.NEW_PROFILE_DIALECT,
            DialetoNaAdicaoDeImpressora.telaDepoisDaGrade(doCard = null),
        )
    }

    @Test
    fun `quem escolheu um card pula a pergunta`() {
        EscPosDialect.entries.forEach { doCard ->
            assertEquals(
                "o card $doCard já respondeu",
                PrinterSetupPath.NEW_PROFILE_CONNECTION,
                DialetoNaAdicaoDeImpressora.telaDepoisDaGrade(doCard),
            )
        }
    }

    @Test
    fun `voltar leva de volta a onde a pessoa esteve`() {
        assertEquals(
            PrinterSetupPath.NEW_PROFILE_DIALECT,
            DialetoNaAdicaoDeImpressora.telaAoVoltarDaConexao(doCard = null),
        )
        EscPosDialect.entries.forEach { doCard ->
            assertEquals(
                "quem veio de card não passou pela pergunta, e não pode cair nela ao voltar",
                PrinterSetupPath.MODEL_GRID,
                DialetoNaAdicaoDeImpressora.telaAoVoltarDaConexao(doCard),
            )
        }
    }

    @Test
    fun `ida e volta sao a mesma tela para quem nao tem card`() {
        // Se estas duas divergirem, "Voltar" da conexão pularia a pergunta e a próxima ida a ela
        // apagaria a resposta — ou pior, deixaria a pessoa presa entre duas telas.
        assertEquals(
            DialetoNaAdicaoDeImpressora.telaDepoisDaGrade(doCard = null),
            DialetoNaAdicaoDeImpressora.telaAoVoltarDaConexao(doCard = null),
        )
    }
}
