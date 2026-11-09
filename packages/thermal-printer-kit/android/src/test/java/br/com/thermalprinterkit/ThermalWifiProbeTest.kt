package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A sonda de família `1F 77`, byte a byte e leitura por leitura.
 *
 * **O bloco de paridade é o que mais importa aqui.** Os vetores de
 * [ThermalWifiProbeParityVectors] são literais idênticos, caractere a caractere, aos de
 * `ios/Tests/ThermalPrinterKitTests/ThermalWifiProbeTests.swift`. Não são a saída da implementação
 * gravada de volta: a tira é a que a bancada exercitou em 21/08/2026 na Bematech PP-10W e em
 * 21–22/08/2026 na GoldenSky GS-T80C-WF, e cada leitura tem um desfecho que saiu em papel.
 *
 * O que estes testes **não** provam: que a impressora está na rede, que a conexão sobreviveu ou que
 * o bloco que saiu descreve a configuração que a pessoa quer. A sonda mede uma coisa só — se a
 * tabela vendor `1F` existe e despacha — e o teste mais importante do arquivo é o que fixa que ela
 * se cala quando não mediu.
 */
class ThermalWifiProbeTest {
    // --- paridade entre plataformas ------------------------------------------------------------

    @Test
    fun `a tira da sonda sai byte a byte igual a do iOS`() {
        assertArrayEquals(
            ThermalWifiProbeParityVectors.usWFamilyStrip,
            ThermalWifiProbe.usWFamilyStrip,
        )
    }

    @Test
    fun `cada leitura leva ao resultado que saiu em papel`() {
        ThermalWifiProbeParityVectors.readings.forEach { vector ->
            assertEquals(vector.name, vector.result, ThermalWifiProbe.result(vector.reading))
            assertEquals(
                vector.name,
                vector.confirmedProtocol,
                ThermalWifiProbe.result(vector.reading).confirmedProtocol,
            )
        }
    }

    @Test
    fun `as quatro leituras medidas estao todas no bloco de paridade`() {
        // Ordem e conjunto, juntos: leitura nova sem vetor faz este teste cair antes de a derivação
        // dela existir em uma só das plataformas.
        assertEquals(
            ThermalWifiProbeReading.entries.toList(),
            ThermalWifiProbeParityVectors.readings.map { it.reading },
        )
    }

    @Test
    fun `os nomes dos enums sao os mesmos das duas plataformas`() {
        assertEquals(
            ThermalWifiProbeParityVectors.readings.map { it.rawValue },
            ThermalWifiProbeReading.entries.map { it.name },
        )
        assertEquals(
            listOf("SUBCOMMAND_SWALLOWED", "PROBE_DID_NOT_PRINT"),
            ThermalWifiProbeIndeterminacy.entries.map { it.name },
        )
    }

    @Test
    fun `os rotulos da leitura sao os mesmos das duas plataformas`() {
        assertEquals(
            ThermalWifiProbeParityVectors.readings.map { it.label },
            ThermalWifiProbeReading.entries.map { it.label },
        )
    }

    @Test
    fun `as frases de indeterminacao sao as mesmas das duas plataformas`() {
        assertEquals(
            ThermalWifiProbeParityVectors.indeterminacyMessages,
            ThermalWifiProbeIndeterminacy.entries.map { it.message },
        )
    }

    @Test
    fun `o contrato de entrega e o mesmo das duas plataformas`() {
        assertEquals(
            ThermalWifiProbeParityVectors.READS_RESPONSE_BYTES,
            ThermalWifiProbe.READS_RESPONSE_BYTES,
        )
        assertEquals(
            ThermalWifiProbeParityVectors.DROPS_DELIVERING_CONNECTION,
            ThermalWifiProbe.DROPS_DELIVERING_CONNECTION,
        )
        assertEquals(
            ThermalWifiProbeParityVectors.WRITES_CONFIGURATION,
            ThermalWifiProbe.WRITES_CONFIGURATION,
        )
        assertEquals(
            ThermalWifiProbeParityVectors.AT_COMMAND_COUNT,
            ThermalWifiProbe.AT_COMMAND_COUNT,
        )
        assertEquals(
            ThermalWifiProbeParityVectors.AT_COMMAND_TIMEOUT_SECONDS,
            ThermalWifiProbe.AT_COMMAND_TIMEOUT_SECONDS,
        )
        assertEquals(
            ThermalWifiProbeParityVectors.WORST_CASE_PORT_OUTAGE_SECONDS,
            ThermalWifiProbe.worstCasePortOutageSeconds,
        )
    }

    // --- a tira que a bancada exercitou ---------------------------------------------------------

    @Test
    fun `a tira e exatamente os dois marcadores e o subcomando no meio`() {
        // `"A\n" + 1F 78 + "\nB\n"`. Os sete bytes: o par `1F 78` saiu do iPhone por TCP 9100 em 21/08/2026 e
        // trouxeram de volta `Mode:` / `SSID:` / `PWD:` na PP-10W.
        val tira = ThermalWifiProbe.usWFamilyStrip
        assertEquals(19, tira.size)
        assertArrayEquals(bytes(0x41, 0x0a), tira.copyOfRange(0, 2))
        assertArrayEquals(bytes(0x1f, 0x78), tira.copyOfRange(2, 4))
        // A quebra vem ANTES do marcador de fecho: sem ela, um `0x78` não reconhecido sairia
        // colado no `B`, e o rótulo prometeria um `x` sozinho que o papel nunca mostraria.
        assertArrayEquals(bytes(0x0a, 0x42, 0x0a), tira.copyOfRange(4, 7))
        // O avanço final, sem o qual o marcador de fecho fica dentro da impressora e a pessoa não
        // consegue responder "saiu o B?". Medido na PP-10W em 23/08.
        assertArrayEquals(ByteArray(12) { 0x0a }, tira.copyOfRange(7, 19))
    }

    @Test
    fun `os marcadores sao os da tira e nao literais soltos`() {
        // Os marcadores existem porque "não saiu nada" é ambíguo: sem eles, "o comando foi engolido"
        // e "a impressora não recebeu bytes" produzem o mesmo papel em branco — a ambiguidade que
        // custou meia hora de bancada em 21/08. Se a frase que a pessoa lê e os bytes que saem
        // discordarem, a tira deixa de ser legível, e é isso que este teste impede.
        val tira = ThermalWifiProbe.usWFamilyStrip
        assertEquals(ThermalWifiProbe.OPENING_MARKER.code, tira[0].toInt() and 0xff)
        // O fecho não é mais o penúltimo byte: depois dele vem o avanço que o tira de dentro da
        // impressora. Procurar pela posição fixa esconderia justamente essa mudança.
        val posicaoDoFecho = tira.size - 1 - ThermalWifiProbe.TEAR_FEED_LINES - 1
        assertEquals(ThermalWifiProbe.CLOSING_MARKER.code, tira[posicaoDoFecho].toInt() and 0xff)
        ThermalWifiProbeReading.entries.forEach { leitura ->
            assertTrue(
                "A frase de ${leitura.name} não cita o marcador de abertura.",
                leitura.label.contains(ThermalWifiProbe.OPENING_MARKER),
            )
        }
    }

    @Test
    fun `os marcadores nao colidem entre si nem com a letra do subcomando`() {
        // Se o marcador fosse `x`, o caso 3 — `A`, um `x`, `B` — viraria indistinguível dos outros
        // dois, e a tira pararia de medir o que existe para medir.
        val abre = ThermalWifiProbe.OPENING_MARKER
        val fecha = ThermalWifiProbe.CLOSING_MARKER
        val letra = ThermalWifiProbe.unrecognizedSubcommandLetter
        assertNotEquals(abre, fecha)
        assertNotEquals(abre, letra)
        assertNotEquals(fecha, letra)
    }

    @Test
    fun `a letra do subcomando nao reconhecido e a do proprio byte da tira`() {
        // `0x78` é `x`. A letra sai do byte e não de uma digitação: publicá-la como literal deixaria
        // a frase descrever uma tira diferente da que sai, no dia em que o subcomando mudar.
        assertEquals('x', ThermalWifiProbe.unrecognizedSubcommandLetter)
        val byteDoSubcomando = ThermalWifiProbe.usWFamilyStrip[3].toInt() and 0xff
        assertEquals(ThermalWifiProbe.unrecognizedSubcommandLetter.code, byteDoSubcomando)
    }

    @Test
    fun `a tira nao carrega nenhum byte que os documentos proibem`() {
        // A lista das duas famílias, junta: `1F 77` grava a configuração, `1F 6D` grava MAC,
        // `1F 69` põe IP fixo, `1F 62 44 00` desliga DHCP, `1F 25` mexe em máscara/gateway,
        // `1F 4E` não existe na tabela US, `03` é o canal de atualização que apaga flash, `12 54`
        // é o autoteste (inofensivo, mas não é o que esta tira mede), e `1F 1B 1F` é o cabeçalho da
        // outra família, cujo próximo byte do fluxo viraria seletor.
        val proibidos =
            listOf(
                bytes(0x1f, 0x77), bytes(0x1f, 0x6d), bytes(0x1f, 0x69), bytes(0x1f, 0x62, 0x44, 0x00),
                bytes(0x1f, 0x25), bytes(0x1f, 0x4e), bytes(0x03), bytes(0x12, 0x54),
                bytes(0x1f, 0x1b, 0x1f),
            )
        val tira = ThermalWifiProbe.usWFamilyStrip
        proibidos.forEach { proibido ->
            assertFalse("A tira carrega ${hex(proibido)}", tira.contem(proibido))
        }
        // E o `1F` aparece uma vez só, com o `78` colado nele: qualquer outro `1F` na tira faria o
        // byte seguinte virar subcomando de alguma coisa.
        assertEquals(1, tira.count { it == 0x1f.toByte() })
        assertEquals(0x78.toByte(), tira[tira.indexOfFirst { it == 0x1f.toByte() } + 1])
    }

    @Test
    fun `a tira devolve copia nova a cada leitura`() {
        // Não tem equivalente no iOS, onde a tira é um `let` de `Data` e `Data` é tipo de valor.
        // Aqui `ByteArray` é mutável: sem a cópia, um chamador que zerasse o array publicado
        // mandaria uma tira vazia no envio seguinte, e a sonda mediria o silêncio.
        ThermalWifiProbe.usWFamilyStrip.fill(0x77)
        assertArrayEquals(
            ThermalWifiProbeParityVectors.usWFamilyStrip,
            ThermalWifiProbe.usWFamilyStrip,
        )
    }

    // --- leitura ambígua nunca vira família confirmada -------------------------------------------

    @Test
    fun `leitura ambigua nunca vira familia confirmada`() {
        // **É o teste central desta camada.** Os dois casos ambíguos são coisas diferentes e nenhum
        // dos dois autoriza configurar: "saiu A e B, sem bloco" prova que algo consumiu o `1F` — e a
        // própria PP-10W faz isso com `1F 4E`, que nem existe na tabela dela —, e "não saiu nada"
        // não é resposta sobre a família, é a tira não tendo saído. Colapsar qualquer um dos dois em
        // "confirmada" mandaria `1F 77` para uma impressora que não o entende; colapsar em "ausente"
        // gravaria uma medição que ninguém fez.
        val ambiguas =
            listOf(ThermalWifiProbeReading.MARKERS_ONLY, ThermalWifiProbeReading.NOTHING_PRINTED)
        ambiguas.forEach { leitura ->
            val resultado = ThermalWifiProbe.result(leitura)
            assertNotEquals(leitura.name, ThermalWifiProbeResult.UsWFamilyHonored, resultado)
            assertNotEquals(leitura.name, ThermalWifiProbeResult.UsWFamilyAbsent, resultado)
            assertNull(leitura.name, resultado.confirmedProtocol)
            assertFalse(leitura.name, resultado.authorizesConfiguration)
        }
        // E são dois desfechos distintos, não um só: quem receber `NOTHING_PRINTED` tem de poder
        // mandar de novo, e quem receber `MARKERS_ONLY` já mandou e mediu.
        assertEquals(
            ThermalWifiProbeResult.Indeterminate(
                ThermalWifiProbeIndeterminacy.SUBCOMMAND_SWALLOWED,
            ),
            ThermalWifiProbe.result(ThermalWifiProbeReading.MARKERS_ONLY),
        )
        assertEquals(
            ThermalWifiProbeResult.Indeterminate(
                ThermalWifiProbeIndeterminacy.PROBE_DID_NOT_PRINT,
            ),
            ThermalWifiProbe.result(ThermalWifiProbeReading.NOTHING_PRINTED),
        )
        assertNotEquals(
            ThermalWifiProbe.result(ThermalWifiProbeReading.MARKERS_ONLY),
            ThermalWifiProbe.result(ThermalWifiProbeReading.NOTHING_PRINTED),
        )
    }

    @Test
    fun `so o bloco no meio autoriza configurar`() {
        ThermalWifiProbeReading.entries.forEach { leitura ->
            assertEquals(
                leitura.name,
                leitura == ThermalWifiProbeReading.BLOCK_BETWEEN_MARKERS,
                ThermalWifiProbe.result(leitura).authorizesConfiguration,
            )
        }
        assertEquals(
            ThermalWifiProtocol.US_W,
            ThermalWifiProbe.result(ThermalWifiProbeReading.BLOCK_BETWEEN_MARKERS).confirmedProtocol,
        )
    }

    @Test
    fun `o atalho do motivo devolve exatamente os desfechos indeterminados`() {
        assertEquals(
            ThermalWifiProbeIndeterminacy.SUBCOMMAND_SWALLOWED,
            ThermalWifiProbe.result(ThermalWifiProbeReading.MARKERS_ONLY).indeterminacy,
        )
        assertEquals(
            ThermalWifiProbeIndeterminacy.PROBE_DID_NOT_PRINT,
            ThermalWifiProbe.result(ThermalWifiProbeReading.NOTHING_PRINTED).indeterminacy,
        )
        assertNull(
            ThermalWifiProbe.result(ThermalWifiProbeReading.BLOCK_BETWEEN_MARKERS).indeterminacy,
        )
        assertNull(
            ThermalWifiProbe.result(ThermalWifiProbeReading.LETTER_BETWEEN_MARKERS).indeterminacy,
        )
        // Ter motivo e autorizar são incompatíveis: um resultado com os dois seria uma tela que
        // libera o quadro e explica, na mesma frase, por que não mediu nada.
        todosOsResultados().forEach { resultado ->
            if (resultado.indeterminacy != null) {
                assertFalse(resultado.toString(), resultado.authorizesConfiguration)
            }
        }
    }

    @Test
    fun `a autorizacao nunca discorda da familia confirmada`() {
        // Um estado em que `authorizesConfiguration` diz sim e `confirmedProtocol` é nulo deixaria a
        // tela mandar quadro nenhum, ou mandar o quadro de uma família que não foi medida.
        todosOsResultados().forEach { resultado ->
            assertEquals(
                resultado.toString(),
                resultado.confirmedProtocol != null,
                resultado.authorizesConfiguration,
            )
        }
    }

    // --- a GoldenSky é escolha explícita, nunca conclusão da sonda -------------------------------

    @Test
    fun `nenhuma leitura confirma a familia da GoldenSky`() {
        // A GoldenSky engole o `1F 78` porque o cabeçalho dela é `1F 1B 1F` e o parser descarta o
        // par ao ver um `78` onde esperava `1B`. Mas qualquer firmware que consuma o byte seguinte
        // ao `1F` produz a mesma tira, então papel nenhum a identifica. Confirmá-la exigiria
        // escrever o quadro dela ou travar o parser à espera dos NUL — que foi o que a bancada fez
        // de propósito em 22/08, e não é instrumento.
        ThermalWifiProbeReading.entries.forEach { leitura ->
            assertNotEquals(
                leitura.name,
                ThermalWifiProtocol.US_ESC_US,
                ThermalWifiProbe.result(leitura).confirmedProtocol,
            )
        }
        todosOsResultados().forEach { resultado ->
            assertNotEquals(ThermalWifiProtocol.US_ESC_US, resultado.confirmedProtocol)
        }
    }

    // --- a pessoa relata a leitura, não a conclusão ----------------------------------------------

    @Test
    fun `nenhuma frase da sonda cita marca modelo ou familia`() {
        // O padrão do kit: quem está com a tira na mão responde o que viu. Uma frase que diga
        // "Rongta" ou "GoldenSky" transforma a pergunta em "que impressora é esta?", que é catálogo
        // — e catálogo é exatamente o que este projeto decidiu não fazer, porque em 21/08 alguém
        // poria a GoldenSky na lista por ser "80 mm com Wi-Fi".
        val proibidas =
            listOf(
                "Rongta", "Bematech", "GoldenSky", "PP-10W", "RPP200", "GS-T80C",
                "1F 77", "1F 1B 1F", "compatível", "compativel", "suportada", "incompatível",
            )
        val frases =
            ThermalWifiProbeReading.entries.map { it.label } +
                ThermalWifiProbeIndeterminacy.entries.map { it.message }
        frases.forEach { frase ->
            proibidas.forEach { proibida ->
                assertFalse(
                    "$frase — cita $proibida",
                    frase.contains(proibida, ignoreCase = true),
                )
            }
        }
    }

    @Test
    fun `cada frase de indeterminacao diz que aquilo nao e resposta`() {
        // A indeterminação só serve se ela chegar como indeterminação. "Sumiu" e "não saiu" são
        // fáceis de ler como "não tem", e é essa leitura que a frase precisa desfazer.
        ThermalWifiProbeIndeterminacy.entries.forEach { indeterminacao ->
            assertTrue(indeterminacao.name, indeterminacao.message.contains("não"))
            assertTrue(indeterminacao.name, indeterminacao.message.isNotEmpty())
        }
        assertEquals(
            ThermalWifiProbeIndeterminacy.entries.size,
            ThermalWifiProbeIndeterminacy.entries.map { it.message }.toSet().size,
        )
    }

    @Test
    fun `cada leitura tem uma frase propria`() {
        val frases = ThermalWifiProbeReading.entries.map { it.label }
        assertEquals(frases.size, frases.toSet().size)
        assertTrue(frases.all { it.isNotEmpty() })
    }

    // --- o que sobrevive ao disco -----------------------------------------------------------------

    /**
     * O indeterminado não tem como ser gravado, e é isso que separa este tipo do da sonda.
     *
     * Espelhar [ThermalWifiProbeResult] no perfil tornaria "não saiu nada" e "os marcadores saíram
     * sem o bloco" representáveis em disco — e um perfil assim afirmaria medição onde não houve
     * nenhuma. A ausência de medição já tem forma: `null`.
     */
    @Test
    fun `o indeterminado nao tem como ser gravado no perfil`() {
        ThermalWifiProbeIndeterminacy.entries.forEach { motivo ->
            assertNull(
                "$motivo virou valor gravável",
                PrinterWifiConfigurationFamily.measured(
                    ThermalWifiProbeResult.Indeterminate(motivo),
                ),
            )
        }
        // E não há outro caminho: os três casos do tipo são exatamente os que a lista abaixo fixa.
        assertEquals(
            listOf(
                PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED,
                PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
                PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US,
            ),
            PrinterWifiConfigurationFamily.entries.toList(),
        )
    }

    /**
     * Os dois desfechos conclusivos da tira viram valor gravado, e a negativa junto.
     *
     * A negativa custou papel e é conclusiva: sem gravá-la, a tela reoferece a sonda a quem já
     * respondeu.
     */
    @Test
    fun `os dois desfechos conclusivos viram valor gravado`() {
        assertEquals(
            PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED,
            PrinterWifiConfigurationFamily.measured(ThermalWifiProbeResult.UsWFamilyHonored),
        )
        assertEquals(
            PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
            PrinterWifiConfigurationFamily.measured(ThermalWifiProbeResult.UsWFamilyAbsent),
        )
    }

    /**
     * O valor gravado diz **como** foi determinado, e não só qual é a família.
     *
     * É a decisão de desenho inteira: a primeira família é medida pela tira, a segunda é escolha da
     * pessoa porque nenhuma sonda a confirma. Guardar as duas do mesmo jeito faria uma sessão
     * futura acreditar que houve medição onde houve escolha.
     */
    @Test
    fun `o valor gravado carrega a procedencia e nao so a familia`() {
        assertTrue(PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED.wasMeasured)
        assertTrue(PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT.wasMeasured)
        assertFalse(PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US.wasMeasured)

        // E medido não é sinônimo de configurável: a negativa é medição conclusiva e mesmo assim
        // não autoriza quadro nenhum, porque ela diz qual família **não** é.
        assertEquals(
            ThermalWifiProtocol.US_W,
            PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED.configuredProtocol,
        )
        assertEquals(
            ThermalWifiProtocol.US_ESC_US,
            PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US.configuredProtocol,
        )
        assertNull(PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT.configuredProtocol)
    }

    /**
     * A família da GoldenSky nunca chega ao perfil por medição, nem por engano de construção.
     *
     * Mesma disciplina de [ThermalWifiProbeResult], onde os desfechos conclusivos são `data object`
     * sem valor associado: a única porta que vem da sonda é [PrinterWifiConfigurationFamily.measured],
     * e nenhuma leitura de papel sai dela com a segunda família.
     */
    @Test
    fun `nenhuma leitura grava a segunda familia como medida`() {
        ThermalWifiProbeReading.entries.forEach { leitura ->
            val gravavel =
                PrinterWifiConfigurationFamily.measured(ThermalWifiProbe.result(leitura))
            assertNotEquals(
                "$leitura gravaria escolha como medição",
                PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US,
                gravavel,
            )
            gravavel?.let { assertTrue(it.wasMeasured) }
        }
    }

    /**
     * Os nomes gravados são os mesmos das duas plataformas: eles vão para o disco, e disco que
     * diverge entre plataformas é perfil que uma grava e a outra não lê.
     */
    @Test
    fun `os nomes gravados sao os mesmos das duas plataformas`() {
        assertEquals(
            listOf("MEASURED_US_W_HONORED", "MEASURED_US_W_ABSENT", "CHOSEN_US_ESC_US"),
            PrinterWifiConfigurationFamily.entries.map { it.name },
        )
    }

    // --- o custo em papel -------------------------------------------------------------------------

    @Test
    fun `o custo em papel nao depende do desfecho`() {
        // Uma tira só, e o preço é o mesmo nos quatro desfechos: o que muda é o que a impressora
        // imprime dentro dela. Sem ramo, a tela anuncia o custo antes de mandar e não erra para
        // menos — que é o erro que a regra proíbe.
        assertEquals(ThermalWifiProbeParityVectors.PAPER_STRIPS, ThermalWifiProbePaperCost.FAMILY_PROBE)
        assertEquals(ThermalWifiProbeParityVectors.PAPER_STRIPS, ThermalWifiProbePaperCost.minimumStrips)
        assertEquals(ThermalWifiProbeParityVectors.PAPER_STRIPS, ThermalWifiProbePaperCost.maximumStrips)
        assertEquals(ThermalWifiProbePaperCost.minimumStrips, ThermalWifiProbePaperCost.maximumStrips)
    }

    @Test
    fun `o custo desta sonda nao entra na conta da homologacao`() {
        // A tira não é etapa de homologação: ela sai quando alguém vai configurar a rede, em
        // impressora que pode estar homologada há semanas. Somá-la ali faria toda homologação
        // anunciar um pedaço de papel que ela nunca imprime. As parcelas abaixo são as que
        // `PrinterHomologationPaperCost` declara, e nenhuma delas é esta sonda.
        assertEquals(
            PrinterHomologationPaperCost.WIDTH_RULERS +
                PrinterHomologationPaperCost.RASTER_THROUGHPUT +
                PrinterHomologationPaperCost.NATIVE_CODE +
                PrinterHomologationPaperCost.CODE_PAGE +
                PrinterHomologationPaperCost.FINAL_RECEIPT,
            PrinterHomologationPaperCost.minimumStrips,
        )
        assertEquals(
            PrinterHomologationPaperCost.minimumStrips +
                PrinterHomologationPaperCost.FULL_GEOMETRY +
                PrinterHomologationPaperCost.cutProtocolStrips +
                PrinterHomologationPaperCost.cutFeedStrips,
            PrinterHomologationPaperCost.maximumStrips,
        )
    }

    // --- corpus -----------------------------------------------------------------------------------

    /** Todo resultado que esta camada consegue produzir, inclusive os que nenhuma leitura produz. */
    private fun todosOsResultados(): List<ThermalWifiProbeResult> =
        listOf(ThermalWifiProbeResult.UsWFamilyHonored, ThermalWifiProbeResult.UsWFamilyAbsent) +
            ThermalWifiProbeIndeterminacy.entries.map(ThermalWifiProbeResult::Indeterminate)

    private fun ByteArray.contem(agulha: ByteArray): Boolean =
        agulha.isNotEmpty() &&
            size >= agulha.size &&
            (0..size - agulha.size).any { inicio ->
                copyOfRange(inicio, inicio + agulha.size).contentEquals(agulha)
            }

    private fun hex(value: ByteArray): String =
        value.joinToString(" ") { "%02X".format(it.toInt() and 0xff) }

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
}

/**
 * Os vetores fixos da paridade Android–iOS.
 *
 * **Estes literais são idênticos aos de `ThermalWifiProbeTests.swift`.** Quem alterar um altera o
 * outro no mesmo commit, ou as duas suítes discordam — que é exatamente o que se quer que aconteça
 * quando as duas sondas divergirem, porque uma pessoa que responde "saiu A e B" no Android e no iOS
 * tem de estar respondendo a mesma pergunta.
 *
 * De onde cada bloco veio, e nenhum deles é a saída desta implementação:
 * - o par `1F 78` é o que devolveu o bloco na Bematech PP-10W e o que sumiu sem deixar `x` na
 *   GoldenSky GS-T80C-WF, ambos em 21/08/2026, pela TCP 9100; os marcadores `A` e `B` vêm do degrau 2
 *   de `docs/goldensky-configuracao-wifi.md`, exercitado em 22/08 — a tira inteira, com os dois
 *   juntos, é a composição das duas medições, não um envio único que alguém tenha feito;
 * - os desfechos 1 e 2 saíram em papel; o 3 é previsto pelo firmware e nunca saiu; o 4 é a tira não
 *   tendo saído, e ele existe no tipo porque sem marcador ele é indistinguível do 2;
 * - a conta do contrato de entrega vem do desmonte do emissor AT (vaddr `0xb2e8`–`0xba00`), com os
 *   nove comandos e o timeout de 5 s de cada um, em `docs/pp10w-configuracao-wifi.md`.
 */
internal object ThermalWifiProbeParityVectors {
    /** `"A\n" + 1F 78 + "\nB\n"` — os sete bytes do comando, mais o avanço de 12 linhas. */
    val usWFamilyStrip: ByteArray =
        bytes(0x41, 0x0a, 0x1f, 0x78, 0x0a, 0x42, 0x0a) + ByteArray(12) { 0x0a }

    internal class ReadingVector(
        val name: String,
        val reading: ThermalWifiProbeReading,
        val rawValue: String,
        val label: String,
        val result: ThermalWifiProbeResult,
        val confirmedProtocol: ThermalWifiProtocol?,
    )

    val readings: List<ReadingVector> =
        listOf(
            // Desfecho 1, medido na Bematech PP-10W em 21/08/2026: saiu o bloco `Mode: AP` /
            // `SSID: Bematech` / `PWD: OPEN,NONE`, que são literais do firmware da Rongta. É o
            // desfecho que fechou a questão da tabela vendor, porque o `1F 4E` no mesmo dia não
            // produziu nada.
            ReadingVector(
                "bloco entre os marcadores",
                ThermalWifiProbeReading.BLOCK_BETWEEN_MARKERS,
                "BLOCK_BETWEEN_MARKERS",
                "Saiu A, depois um bloco com Mode, SSID e PWD, depois B.",
                ThermalWifiProbeResult.UsWFamilyHonored,
                ThermalWifiProtocol.US_W,
            ),
            // Desfecho 2, medido na GoldenSky GS-T80C-WF em 21/08/2026: o texto simples saiu pela
            // mesma 9100 e o `1F 78` sumiu sem deixar `x`. Indeterminado, e não "GoldenSky".
            ReadingVector(
                "só os marcadores",
                ThermalWifiProbeReading.MARKERS_ONLY,
                "MARKERS_ONLY",
                "Saiu A e saiu B, e nada entre os dois.",
                ThermalWifiProbeResult.Indeterminate(
                    ThermalWifiProbeIndeterminacy.SUBCOMMAND_SWALLOWED,
                ),
                null,
            ),
            // Desfecho 3: o `1F` não foi consumido como prefixo e o `0x78` caiu no buffer de
            // impressão. É o único desfecho que nega a família, e nega porque mostra o byte inteiro
            // no papel.
            ReadingVector(
                "a letra entre os marcadores",
                ThermalWifiProbeReading.LETTER_BETWEEN_MARKERS,
                "LETTER_BETWEEN_MARKERS",
                "Saiu A, depois um x sozinho, depois B.",
                ThermalWifiProbeResult.UsWFamilyAbsent,
                null,
            ),
            // Desfecho 4: nem o marcador de abertura, que é texto puro. Não é resposta sobre a
            // família.
            ReadingVector(
                "papel em branco",
                ThermalWifiProbeReading.NOTHING_PRINTED,
                "NOTHING_PRINTED",
                "Não saiu nada, nem o A.",
                ThermalWifiProbeResult.Indeterminate(
                    ThermalWifiProbeIndeterminacy.PROBE_DID_NOT_PRINT,
                ),
                null,
            ),
        )

    /** As frases de indeterminação, na ordem dos casos. */
    val indeterminacyMessages: List<String> =
        listOf(
            "O comando sumiu sem deixar marca no papel. Qualquer impressora que engula o prefixo " +
                "faz isso, então isto não identifica a família.",
            "A tira não saiu. Confira papel e conexão e mande de novo: isto não é resposta sobre a " +
                "impressora.",
        )

    /** O contrato de entrega, declarado igual nas duas plataformas. */
    const val READS_RESPONSE_BYTES = false
    const val DROPS_DELIVERING_CONNECTION = true
    const val WRITES_CONFIGURATION = false
    const val AT_COMMAND_COUNT = 9
    const val AT_COMMAND_TIMEOUT_SECONDS = 5
    const val WORST_CASE_PORT_OUTAGE_SECONDS = 45

    /** Uma tira, nos quatro desfechos. */
    const val PAPER_STRIPS = 1

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
}
