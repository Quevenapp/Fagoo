package br.com.thermalprinterkit.printher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * As duas frases que dizem "celular" vêm do hospedeiro, e o default é o de hoje.
 *
 * Elas são as únicas da tela que descrevem o aparelho, e não a impressora — e num Mac elas são
 * falsas. Quem sabe em que aparelho está é o app hospedeiro; a tela recebe a frase pronta e a
 * mostra, sem perguntar em que sistema roda.
 *
 * O que estes testes provam é a forma do ponto de injeção e o default byte a byte. A ligação entre
 * o valor e o pixel — `NoticeCard(title = localOnlyCopy.localOnlyTitle)` e
 * `Text(localOnlyCopy.finishTitle)` em `PrinterHomologationScreen.kt` — não passa por aqui: teste
 * de unidade JVM não monta árvore Compose, e o módulo não tem Robolectric. Quem monta árvore é a
 * suíte instrumentada, que imprime de verdade e não roda sem bancada.
 */
class PrinterHomologationLocalOnlyCopyTest {
    @Test
    fun `o default repete as frases de hoje byte a byte`() {
        assertEquals(
            "Esta configuração fica só neste celular",
            PrinterHomologationLocalOnlyCopy.Default.localOnlyTitle,
        )
        assertEquals(
            "Usar só neste celular",
            PrinterHomologationLocalOnlyCopy.Default.finishTitle,
        )
        // O iOS fixa exatamente estes dois literais em
        // ios/UITests/ThermalPrinterKitUITests/ThermalPrinterUIContractTests.swift, e é assim que
        // as duas plataformas continuam emitindo a mesma frase sem injeção nenhuma.
        assertEquals(
            PrinterHomologationLocalOnlyCopy.Default,
            PrinterHomologationLocalOnlyCopy(),
        )
    }

    @Test
    fun `quem não injeta nada recebe o default nos dois campos`() {
        val semInjecao = PrinterHomologationLocalOnlyCopy()

        assertEquals(DEFAULT_LOCAL_ONLY_TITLE, semInjecao.localOnlyTitle)
        assertEquals(DEFAULT_FINISH_TITLE, semInjecao.finishTitle)
    }

    @Test
    fun `a frase injetada entra no lugar da de hoje`() {
        val doHospedeiro =
            PrinterHomologationLocalOnlyCopy(
                localOnlyTitle = "Frase de permanência do hospedeiro",
                finishTitle = "Botão de encerrar do hospedeiro",
            )

        assertEquals("Frase de permanência do hospedeiro", doHospedeiro.localOnlyTitle)
        assertEquals("Botão de encerrar do hospedeiro", doHospedeiro.finishTitle)
        assertNotEquals(PrinterHomologationLocalOnlyCopy.Default, doHospedeiro)
    }

    @Test
    fun `injetar uma frase não move a outra`() {
        // A promessa vem em um valor só, mas os dois campos são independentes: o hospedeiro que só
        // tiver o que dizer sobre um não perde o outro por tabela.
        val soAAbertura = PrinterHomologationLocalOnlyCopy(localOnlyTitle = "Fica só neste aparelho")
        assertEquals("Fica só neste aparelho", soAAbertura.localOnlyTitle)
        assertEquals(DEFAULT_FINISH_TITLE, soAAbertura.finishTitle)

        val soOBotao = PrinterHomologationLocalOnlyCopy(finishTitle = "Usar só neste aparelho")
        assertEquals(DEFAULT_LOCAL_ONLY_TITLE, soOBotao.localOnlyTitle)
        assertEquals("Usar só neste aparelho", soOBotao.finishTitle)
    }

    @Test
    fun `a tela não escolhe a palavra do hospedeiro`() {
        // O kit não sabe — e não pode saber — em que aparelho está. Nenhum default, nenhuma
        // constante e nenhum ramo aqui dentro conhece "Mac", "computador" ou "desktop": a única
        // palavra que o kit escreve é a de hoje, e trocá-la é decisão de quem hospeda.
        listOf(
            DEFAULT_LOCAL_ONLY_TITLE,
            DEFAULT_FINISH_TITLE,
        ).forEach { frase ->
            assertEquals(
                "Nenhuma frase do kit pode nomear o aparelho do hospedeiro: $frase",
                true,
                listOf("mac", "computador", "desktop", "windows", "linux")
                    .none { frase.lowercase().contains(it) },
            )
        }
    }
}
