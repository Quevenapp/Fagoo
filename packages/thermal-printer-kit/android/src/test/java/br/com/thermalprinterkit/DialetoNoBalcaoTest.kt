package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A pergunta de dialeto, e as duas coisas nela que podem dar errado em silêncio.
 *
 * A primeira é a **tradução**: um índice trocado devolvendo o dialeto errado faz "Padrão" gravar
 * `PROCOMP_ESC_P` e, pior, "Diebold Procomp" gravar `EPSON_COMPATIBLE` — a sequência que travou a
 * IM453H em 23/08/2026, com a tecla de avanço morta e recuperação só no desligar e ligar.
 *
 * A segunda é a **assimetria do descritor**: ele confirma e não nega. Um teste que aceitasse
 * `suspeitaPeloDescritor` devolvendo `EPSON_COMPATIBLE` estaria aceitando ausência de indício como
 * medição, que é a forma exata do defeito que o kit fecha em todo lugar.
 */
class DialetoNoBalcaoTest {

    // ── A tradução entre o botão e o dialeto ────────────────────────────────────────────────────

    @Test
    fun `nenhum dialeto fica de fora do menu`() {
        // Um dialeto ausente do menu seria impossível de escolher, e portanto uma impressora
        // impossível de medir. A lista vem de `entries` justamente para isto não depender de
        // ninguém lembrar.
        assertEquals(EscPosDialect.entries.toSet(), DialetoNoBalcao.ordem.toSet())
        assertEquals(EscPosDialect.entries.size, DialetoNoBalcao.ordem.size)
    }

    @Test
    fun `o botao devolve o dialeto do proprio rotulo`() {
        DialetoNoBalcao.ordem.forEachIndexed { indice, dialeto ->
            assertEquals(
                "o botão ${DialetoNoBalcao.rotulos[indice]} tem de devolver $dialeto",
                dialeto,
                DialetoNoBalcao.doIndice(indice),
            )
        }
        assertEquals(DialetoNoBalcao.ordem.size, DialetoNoBalcao.rotulos.size)
    }

    @Test
    fun `o padrao nasce em primeiro, e o Procomp nunca e o que ja vem escolhido`() {
        // Quem não leu a pergunta e confirmou o primeiro botão precisa cair no lado barato do
        // erro: ESC/POS numa impressora que não fala ESC/POS custa papel; Procomp escolhido à toa
        // numa Epson custa uma medição inteira sem sentido.
        assertEquals(EscPosDialect.EPSON_COMPATIBLE, DialetoNoBalcao.ordem.first())
        assertNotEquals(EscPosDialect.PROCOMP_ESC_P, DialetoNoBalcao.ordem.first())
    }

    @Test
    fun `fora dos botoes e desistencia, e nao o padrao em silencio`() {
        // `JOptionPane.CLOSED_OPTION` é -1 no Windows; no telefone é sair da tela sem responder.
        assertNull(DialetoNoBalcao.doIndice(-1))
        assertNull(DialetoNoBalcao.doIndice(DialetoNoBalcao.ordem.size))
        assertNull(DialetoNoBalcao.doIndice(99))
    }

    @Test
    fun `cada dialeto tem rotulo e explicacao proprios`() {
        val rotulos = EscPosDialect.entries.map(DialetoNoBalcao::rotulo)
        val explicacoes = EscPosDialect.entries.map(DialetoNoBalcao::explicacao)

        assertTrue("nenhum rótulo pode ser vazio", rotulos.none { it.isBlank() })
        assertTrue("nenhuma explicação pode ser vazia", explicacoes.none { it.isBlank() })
        // Dois dialetos com o mesmo rótulo seriam dois botões idênticos: a pessoa não teria como
        // escolher, e a tradução de volta viraria sorteio.
        assertEquals(rotulos.size, rotulos.toSet().size)
        assertEquals(explicacoes.size, explicacoes.toSet().size)
    }

    // ── A frase ─────────────────────────────────────────────────────────────────────────────────

    @Test
    fun `a pergunta diz o que se perde ao errar, e nao so o nome do protocolo`() {
        val frase = DialetoNoBalcao.pergunta("Cozinha")

        assertTrue("a pergunta nomeia a impressora", frase.contains("Cozinha"))
        // O custo de errar é a impressora parada, não papel — e a frase precisa dizer isso, ou é
        // respondida no chute.
        assertTrue("a pergunta avisa que trava o aparelho", frase.contains("trava"))
        assertTrue("a pergunta nomeia a família", frase.contains("Procomp"))
    }

    @Test
    fun `sem nome a pergunta nao inventa um`() {
        // No telefone a pergunta vem antes de existir nome: a medição começa pela grade de
        // modelos. A frase precisa funcionar assim, sem "a null fala" nem nome de placeholder.
        listOf(null, "", "   ").forEach { vazio ->
            val frase = DialetoNoBalcao.pergunta(vazio)
            assertTrue("a frase continua sendo uma pergunta", frase.contains("Em que língua"))
            assertTrue("a frase fala da impressora", frase.contains("impressora fala"))
            assertTrue("o aviso do travamento sobrevive", frase.contains("trava"))
            assertTrue("nada de 'null' na tela", !frase.contains("null"))
        }
    }

    // ── O descritor: ele confirma, e não nega ───────────────────────────────────────────────────

    @Test
    fun `o descritor medido da IM453H levanta a suspeita de Procomp`() {
        // Lido por `dumpsys usb` em 23/08/2026, sem gastar papel e sem escrever byte no caminho de
        // impressão: manufacturer_name=Diebold, product_name=IM453H.
        assertEquals(
            EscPosDialect.PROCOMP_ESC_P,
            DialetoNoBalcao.suspeitaPeloDescritor("Diebold", "IM453H"),
        )
        // Cada metade sozinha basta: um hub pode entregar só uma delas.
        assertEquals(
            EscPosDialect.PROCOMP_ESC_P,
            DialetoNoBalcao.suspeitaPeloDescritor("Diebold"),
        )
        assertEquals(
            EscPosDialect.PROCOMP_ESC_P,
            DialetoNoBalcao.suspeitaPeloDescritor(null, "IM453H"),
        )
    }

    @Test
    fun `a suspeita nao depende de caixa nem de pontuacao no nome declarado`() {
        assertEquals(
            EscPosDialect.PROCOMP_ESC_P,
            DialetoNoBalcao.suspeitaPeloDescritor("DIEBOLD NIXDORF"),
        )
        assertEquals(
            EscPosDialect.PROCOMP_ESC_P,
            DialetoNoBalcao.suspeitaPeloDescritor("Impressora Diebold-Procomp"),
        )
    }

    @Test
    fun `o descritor nunca devolve Epson, porque ausencia de indicio nao e medicao`() {
        // A assimetria é o ponto: "não diz Diebold" pode ser uma paralela atrás de um conversor,
        // um hub que reescreve o nome, ou um descritor genérico. Transformar isso em "é Epson"
        // seria inventar uma medição — e é assim que uma Diebold recebe ESC/POS.
        listOf(
            arrayOf<String?>("EPSON", "TM-T20X-II"),
            arrayOf<String?>("Bematech", "MP-4200 TH"),
            arrayOf<String?>("USB Printer"),
            arrayOf<String?>(null, null),
            arrayOf<String?>("", "   "),
        ).forEach { nomes ->
            val suspeita = DialetoNoBalcao.suspeitaPeloDescritor(*nomes)
            assertNotEquals(
                "descritor nenhum tem autoridade para afirmar ESC/POS",
                EscPosDialect.EPSON_COMPATIBLE,
                suspeita,
            )
            assertNull("sem marcador, não há suspeita", suspeita)
        }
    }

    @Test
    fun `escolher ESC POS para um aparelho que se anuncia Diebold produz aviso`() {
        val aviso =
            DialetoNoBalcao.avisoDeDescritorContrariado(
                EscPosDialect.EPSON_COMPATIBLE,
                "Diebold",
                "IM453H",
            )

        assertTrue("o aviso precisa existir", aviso != null)
        assertTrue("o aviso nomeia o aparelho", aviso!!.contains("Diebold"))
        assertTrue("o aviso diz o que se perde", aviso.contains("trava"))
    }

    @Test
    fun `a candidata avisa a partir da suspeita que ela carrega, e nao do rotulo`() {
        // A tela chama esta versão porque o que denuncia a família é o `manufacturer_name`, e o
        // rótulo da lista é o `product_name`. Recalcular a suspeita a partir do rótulo daria outra
        // resposta — "IM453H" denuncia, mas um produto genérico atrás de um fabricante Diebold não.
        val aviso =
            DialetoNoBalcao.avisoDeSuspeitaContrariada(
                escolhido = EscPosDialect.EPSON_COMPATIBLE,
                suspeita = EscPosDialect.PROCOMP_ESC_P,
                nomeDeclarado = "Impressora USB 1",
            )

        assertTrue(aviso != null)
        assertTrue("o aviso nomeia o que está na lista", aviso!!.contains("Impressora USB 1"))
        assertTrue("o aviso diz o que se perde", aviso.contains("trava"))
        assertTrue("o aviso nomeia a família suspeita", aviso.contains("Diebold"))
    }

    @Test
    fun `sem suspeita a candidata nao interrompe nada`() {
        // O descritor confirma e não nega: candidata que nada declarou segue o fluxo de sempre.
        EscPosDialect.entries.forEach { escolhido ->
            assertNull(
                DialetoNoBalcao.avisoDeSuspeitaContrariada(
                    escolhido = escolhido,
                    suspeita = null,
                    nomeDeclarado = "Impressora USB 1",
                ),
            )
        }
    }

    @Test
    fun `o aviso sobrevive a uma candidata sem nome`() {
        val aviso =
            DialetoNoBalcao.avisoDeSuspeitaContrariada(
                escolhido = EscPosDialect.EPSON_COMPATIBLE,
                suspeita = EscPosDialect.PROCOMP_ESC_P,
                nomeDeclarado = null,
            )

        assertTrue(aviso != null)
        assertTrue("nada de 'null' na tela", !aviso!!.contains("null"))
    }

    // ── A saída de quem não sabe ────────────────────────────────────────────────────────────────

    @Test
    fun `quem nao sabe recebe o autoteste da propria impressora, e nao uma sonda nossa`() {
        val texto = DialetoNoBalcao.comoDescobrir()

        // O gesto precisa estar inteiro: sem o "soltar quando o led apagar", manter pressionado
        // abre o Menu de Configuração — que muda o alvo da medição em vez de descrevê-lo.
        assertTrue("diz para desligar e ligar", texto.contains("Desligue"))
        assertTrue("diz para segurar o avanço", texto.contains("avanço"))
        assertTrue("diz quando soltar", texto.contains("solte"))
        assertTrue("diz o que procurar no papel", texto.contains("IM453H"))
        assertTrue("nomeia as duas respostas possíveis", texto.contains("Diebold Procomp"))
        assertTrue(texto.contains("Padrão (ESC/POS)"))
    }

    @Test
    fun `nao ha aviso quando a resposta e o descritor concordam, nem quando ele nada diz`() {
        assertNull(
            DialetoNoBalcao.avisoDeDescritorContrariado(
                EscPosDialect.PROCOMP_ESC_P,
                "Diebold",
                "IM453H",
            ),
        )
        // Descritor sem marcador não contradiz ninguém — nem quem respondeu Procomp. O aparelho
        // não se anunciou, e o aviso seria ruído em cima de quem está com ele na mão.
        assertNull(
            DialetoNoBalcao.avisoDeDescritorContrariado(
                EscPosDialect.PROCOMP_ESC_P,
                "EPSON",
                "TM-T20X-II",
            ),
        )
        assertNull(
            DialetoNoBalcao.avisoDeDescritorContrariado(EscPosDialect.EPSON_COMPATIBLE, null),
        )
    }
}
