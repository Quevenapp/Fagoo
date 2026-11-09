package br.com.thermalprinterkit.printher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * As frases do gesto, e a promessa de permanência que elas obrigaram a corrigir.
 *
 * ## A frase que deixou de ser verdadeira
 *
 * O painel final dizia, palavra por palavra: *"Ela não atravessa uma reinstalação nem vai para
 * outro app."* O gesto de contribuição vive **logo abaixo desse aviso** e existe justamente para
 * mandar a medição a outro app. Manter a frase seria a tela prometer uma coisa e oferecer a
 * contrária no toque seguinte — e a pessoa que confia na promessa é exatamente a que não vai
 * entender o botão.
 *
 * A frase virou constante para poder ser fixada aqui: teste de unidade JVM não monta árvore Compose
 * neste módulo, e um literal solto dentro do `@Composable` não é alcançável por prova nenhuma.
 *
 * ## O que estes testes não provam
 *
 * Que a frase chegue ao pixel. A ligação `NoticeCard(body = DEFAULT_LOCAL_ONLY_BODY)` e
 * `Text(ROTULO_DA_CONTRIBUICAO)` não passa por aqui, pela mesma razão que
 * `PrinterHomologationLocalOnlyCopyTest` já registra: quem monta árvore é a suíte instrumentada, que
 * imprime de verdade e não roda sem bancada.
 */
class FrasesDaContribuicaoTest {
    @Test
    fun `o aviso de permanencia nao promete mais que nada vai para outro app`() {
        assertEquals(
            "Ela não atravessa uma reinstalação, e nenhum app a recebe sem você mandar.",
            DEFAULT_LOCAL_ONLY_BODY,
        )
        assertFalse(
            "A frase antiga é falsa desde que o gesto de contribuição existe nesta mesma tela.",
            DEFAULT_LOCAL_ONLY_BODY.contains("nem vai para outro app"),
        )
        // O que continua verdadeiro tem de continuar dito: a configuração não viaja sozinha.
        assertTrue(DEFAULT_LOCAL_ONLY_BODY.contains("reinstalação"))
        assertTrue(DEFAULT_LOCAL_ONLY_BODY.contains("sem você mandar"))
    }

    @Test
    fun `nenhuma frase do gesto nomeia o aparelho do outro lado`() {
        // Mesma regra de `PrinterHomologationLocalOnlyCopyTest`: o kit não sabe — e não pode saber —
        // o que existe do outro lado. O rótulo da bandeja de mesa diz "no celular" porque a bandeja
        // sabe que é mesa; daqui, dizer "computador" seria inventar o destino.
        listOf(
            TITULO_DA_CONTRIBUICAO,
            CORPO_DA_CONTRIBUICAO,
            AVISO_DO_QUE_NAO_VAI_JUNTO,
            ROTULO_DA_CONTRIBUICAO,
            DEFAULT_LOCAL_ONLY_BODY,
        ).forEach { frase ->
            listOf("computador", "desktop", "windows", "linux", "mac", "pc").forEach { aparelho ->
                assertFalse(
                    "A frase nomeia o aparelho do outro lado ($aparelho): $frase",
                    frase.lowercase().contains(aparelho),
                )
            }
        }
    }

    @Test
    fun `o corpo do gesto diz o que sai e diz que endereco nao sai`() {
        // As duas metades da frase são o que a pessoa precisa para decidir. A segunda metade tem
        // prova em `ContribuicaoSemEnderecoTest`; aqui só se fixa que ela continua sendo dita.
        assertTrue(CORPO_DA_CONTRIBUICAO.contains("o que o papel mostrou"))
        assertTrue(CORPO_DA_CONTRIBUICAO.contains("Não sai o endereço"))
    }

    @Test
    fun `nenhuma frase do gesto sai em branco`() {
        listOf(
            TITULO_DA_CONTRIBUICAO,
            CORPO_DA_CONTRIBUICAO,
            AVISO_DO_QUE_NAO_VAI_JUNTO,
            ROTULO_DA_CONTRIBUICAO,
        ).forEach { frase -> assertTrue(frase.isNotBlank()) }
    }
}
