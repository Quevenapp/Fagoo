package br.com.thermalprinterkit

import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterHomologationProbesTest {
    /** O nome da CP850 na JVM, para reler um comprovante que saiu na página medida. */
    private val CP850: Charset = Charset.forName("IBM850")

    @Test
    fun `a linha de página mede as cinco letras que distinguem as tabelas`() {
        val bytes = PrinterHomologationProbes.textEncoding().bytes()
        val utf8Line = "UTF-8: ${PrinterHomologationProbes.TEXT_ENCODING_SAMPLE}\n".toByteArray(StandardCharsets.UTF_8)

        // `café, açúcar, três` era cego: `é ç ú ê` têm o mesmo desenho em CP437 e CP860, e a linha
        // saía "certa" numa T210 que estava em CP437. Estes cinco bytes discordam onde o português
        // precisa — o til.
        val distinguem = intArrayOf(0x84, 0x87, 0x94, 0xA0, 0x88).map(Int::toByte)
        assertTrue(bytes.toList().windowed(distinguem.size).any { it == distinguem })
        assertTrue(bytes.toList().windowed(utf8Line.size).any { it.toByteArray().contentEquals(utf8Line) })
        assertFalse(bytes.toList().windowed(2).any { it == listOf(0x1B.toByte(), 0x74.toByte()) })
    }

    /** Só o corpo do texto: cabeçalho e rodapé saem por comparação com a renderização vazia. */
    private fun encodedSample(page: ThermalCodePage): ByteArray {
        fun render(value: String) =
            EscPosThermalCommands.text(
                value,
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                codePage = page,
            )
        val comAmostra = render(PrinterHomologationProbes.TEXT_ENCODING_SAMPLE)
        val vazio = render("")
        val prefixo = vazio.indices.takeWhile { comAmostra[it] == vazio[it] }.count()
        val sufixo =
            (1..vazio.size - prefixo).takeWhile {
                comAmostra[comAmostra.size - it] == vazio[vazio.size - it]
            }.count()
        return comAmostra.copyOfRange(prefixo, comAmostra.size - sufixo)
    }

    @Test
    fun `a lista abre em sem acentos, sem seleção e UTF-8, e cabe no alfabeto`() {
        val candidates = PrinterHomologationProbes.codePageCandidates

        // As três primeiras são o que a tela perguntava numa etapa separada até 12/08. Quem está
        // com o papel na mão responde qual linha saiu legível, não qual modelo de codificação quer.
        assertEquals(
            listOf(
                ThermalTextEncoding.ASCII,
                ThermalTextEncoding.FIRMWARE_DEFAULT_PAGE,
                ThermalTextEncoding.UTF_8,
            ),
            candidates.take(3).map(CodePageProbeCandidate::textEncoding),
        )
        assertEquals(listOf('a', 'b', 'c'), candidates.take(3).map(CodePageProbeCandidate::letter))
        // A linha `a` é o piso: sem acento nenhum, e por isso não pode carregar página.
        assertNull(candidates.first().codePage)
        assertNull(candidates.first().escT)
        assertEquals(ThermalCodePage.CP860, candidates[1].codePage)
        assertNull(candidates[1].escT)
        // Uma letra por linha, sem furo e sem passar do alfabeto: a resposta é uma letra.
        assertEquals(('a'..candidates.last().letter).toList(), candidates.map(CodePageProbeCandidate::letter))
        assertTrue(candidates.last().letter <= 'z')
        // Nomes antes de endereços, porque a primeira linha certa vence e o nome carrega a tabela.
        // A CP858 caiu: para esta frase ela emite os mesmos bytes da CP850, e a lista não cabia.
        assertEquals(
            listOf(ThermalCodePage.CP850, ThermalCodePage.CP1252),
            candidates.filter { !it.isAddress && it.textEncoding == ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE }
                .map(CodePageProbeCandidate::codePage),
        )
        assertEquals((0..20).toList(), candidates.filter(CodePageProbeCandidate::isAddress).map { it.escT })
        assertTrue(candidates.filter(CodePageProbeCandidate::isAddress).all { it.codePage == ThermalCodePage.CP860 })
        // Nenhuma linha repetida: duas iguais no papel deixariam a escolha ambígua.
        assertEquals(
            candidates.size,
            candidates.map { Triple(it.textEncoding, it.escT, it.codePage) }.toSet().size,
        )
    }

    @Test
    fun `nenhuma candidata dobra a frase para ASCII`() {
        // Uma página incapaz de `ã` dobraria a amostra para ASCII e sairia limpa, sem acento
        // nenhum — que é o que alguém escolheria por engano e gravaria para todas as vendas. Esse
        // texto existe uma vez só, rotulado, na linha `a`.
        PrinterHomologationProbes.codePageCandidates
            .filter { it.textEncoding.usesCodePage }
            .forEach { candidate ->
                val page = requireNotNull(candidate.codePage)
                PrinterHomologationProbes.CODE_PAGE_SAMPLE.filter { it.code >= 0x80 }.forEach { accented ->
                    assertTrue(
                        "${candidate.label} dobraria $accented para ASCII",
                        page.encode(accented) != null,
                    )
                }
            }
    }

    @Test
    fun `cada linha sai pelo encoder da venda, com a letra e a frase`() {
        // Latin-1 é bijetora byte a byte, então comparar como texto não perde os bytes altos.
        val receipt = String(PrinterHomologationProbes.codePages().bytes(), StandardCharsets.ISO_8859_1)

        PrinterHomologationProbes.codePageCandidates.forEach { candidate ->
            val row = PrinterHomologationProbes.codePageRow(candidate)
            assertTrue(candidate.label, receipt.contains(String(row, StandardCharsets.ISO_8859_1)))
        }
        // A linha sem seleção só é honesta se nenhum `ESC t` a preceder na tira.
        val firstRow = PrinterHomologationProbes.codePageRow(PrinterHomologationProbes.codePageCandidates.first())
        val prefix = receipt.substring(0, receipt.indexOf(String(firstRow, StandardCharsets.ISO_8859_1)))
        assertFalse(prefix.contains(String(byteArrayOf(0x1B, 0x74), StandardCharsets.ISO_8859_1)))
    }

    @Test
    fun `a tira não mostra código técnico nenhum`() {
        val receipt = String(PrinterHomologationProbes.codePages().bytes(), StandardCharsets.ISO_8859_1)

        // Nome de página e endereço são vocabulário da bancada. No papel só existem letra e frase;
        // o código aparece no comprovante final, onde serve ao catálogo.
        assertFalse(receipt.contains("CP8"))
        assertFalse(receipt.contains("CP4"))
        assertFalse(receipt.contains("CP1"))
        assertFalse(receipt.contains("n="))
        assertFalse(receipt.contains("PAGINA"))
        assertFalse(receipt.contains("GABARITO"))
        PrinterHomologationProbes.codePageCandidates.forEach { candidate ->
            assertTrue(receipt.contains("${candidate.letter}) "))
        }
    }

    @Test
    fun `a contagem anunciada é a desta impressora`() {
        val candidates = PrinterHomologationProbes.codePageCandidates.size
        val narrow = PrinterHomologationProbes.codePageProbeLineCount(32)
        val wide = PrinterHomologationProbes.codePageProbeLineCount(48)

        // Com as maiúsculas, a amostra passou a ocupar duas linhas **nas duas larguras**: 58
        // caracteres não cabem nem em 48 colunas. Anunciar o número de candidatas mentiria para a
        // bancada inteira, e é a tela que faz essa conta.
        val instrucao = PrinterHomologationProbes.CODE_PAGE_INSTRUCTIONS.count { it == '\n' }
        assertEquals(2 * candidates + instrucao, narrow)
        assertEquals(2 * candidates + instrucao, wide)
        assertTrue(narrow > candidates)
    }

    @Test
    fun `T210 recebe a frase CP860 na linha canônica e em n08`() {
        val candidates = PrinterHomologationProbes.codePageCandidates
        val canonical = candidates.single { it.escT == 3 && it.isAddress }
        val measured = candidates.single { it.escT == 8 && it.isAddress }

        assertEquals(ThermalCodePage.CP860, canonical.codePage)
        assertEquals(ThermalCodePage.CP860, measured.codePage)
        // Mesma frase, mesmos bytes de texto; só o endereço muda. Na T210, n=03 aponta para CP437
        // e a frase sai `cäo, açoes`; n=08 aponta para CP860 e sai inteira. Prova física pendente.
        val phrase =
            PrinterHomologationProbes.CODE_PAGE_SAMPLE.map { character ->
                (ThermalCodePage.CP860.encode(character) ?: character.code).toByte()
            }
        listOf(canonical, measured).forEach { candidate ->
            val row = PrinterHomologationProbes.codePageRow(candidate).toList()
            assertTrue(candidate.label, row.windowed(phrase.size).any { it == phrase })
        }
    }

    @Test
    fun `sonda que não corta termina com avanço suficiente para tirar a última linha`() {
        // Com 4 linhas a MP-4200 e a i9 seguraram régua raster e amostra dentro da impressora.
        // O avanço vai em quebras de linha porque a MP-4200 ignora `ESC d`.
        val tail = ByteArray(12) { 0x0A }

        listOf(
            PrinterHomologationProbes.geometry(58),
            PrinterHomologationProbes.geometry(80),
            PrinterHomologationProbes.textEncoding(),
            PrinterHomologationProbes.codePages(),
            PrinterHomologationProbes.cutProtocols(),
        ).forEach { probe ->
            assertArrayEquals(tail, probe.bytes().takeLast(tail.size).toByteArray())
        }
    }

    @Test
    fun `depois de medir avanço sondas terminam com esse avanço antes do corte`() {
        val cut = requireNotNull(PrinterHomologationProbes.commandFor(CutProtocol.GS_V_1))
        val expectedTail = ByteArray(5) { 0x0A } + cut

        listOf(
            PrinterHomologationProbes.textEncoding(CutProtocol.GS_V_1, 5),
            PrinterHomologationProbes.codePages(CutProtocol.GS_V_1, 5),
        ).forEach { probe ->
            assertArrayEquals(expectedTail, probe.bytes().takeLast(expectedTail.size).toByteArray())
        }
    }

    @Test
    fun `dialeto com avanço embutido termina só no comando medido`() {
        val protocol = CutProtocol.GS_V_65
        val cut = requireNotNull(PrinterHomologationProbes.commandFor(protocol))

        val bytes = PrinterHomologationProbes.textEncoding(protocol, 0).bytes()

        assertArrayEquals(cut, bytes.takeLast(cut.size).toByteArray())
        assertFalse(bytes.dropLast(cut.size).takeLast(12).all { it == 0x0A.toByte() })
    }

    @Test
    fun `a sonda de corte avisa para nao puxar e nao induz desistir do parcial`() {
        val ascii = String(PrinterHomologationProbes.cutProtocols().bytes(), StandardCharsets.US_ASCII)

        // A aba do corte parcial rasga na mão igual a picote: quem puxa antes de olhar perde a
        // única prova de que o comando parcial foi obedecido.
        assertTrue(ascii.contains("Nao puxe as tiras antes de ver"))
        assertTrue(ascii.contains("passa a ser o corte de toda venda"))
        // MP-4200 e i9 fazem parcial; o papel não pode mandar trocar por total.
        assertFalse(ascii.contains("nao faz parcial"))
        assertFalse(ascii.contains("escolha o total"))
    }

    @Test
    fun `nenhum bloco de corte avanca papel depois do comando`() {
        val ascii = String(PrinterHomologationProbes.cutProtocols().bytes(), StandardCharsets.ISO_8859_1)

        // Cada linha empurrada depois de um corte parcial puxa a tira presa pela aba. `ESC d` é
        // justamente o avanço, e ele não pode aparecer colado no comando de corte.
        val feed = String(ints(0x1B, 0x64), StandardCharsets.ISO_8859_1)
        PrinterHomologationProbes.cutProtocolCandidates.mapNotNull { it.commandBytes() }.forEach { command ->
            val label = command.joinToString(" ") { "%02X".format(it) }
            val afterCommand = ascii.substringAfter(String(command, StandardCharsets.ISO_8859_1))
            assertFalse(label, afterCommand.startsWith(feed))
        }
    }

    @Test
    fun `o modo troca o irmão e preserva o dialeto medido`() {
        // Dialeto é medido; modo é escolha. Antes os dois viviam no mesmo campo e a ordem dos
        // candidatos (totais primeiro) fazia toda impressora terminar em corte total.
        assertEquals(CutProtocol.GS_V_1, CutProtocol.GS_V_0.withCutMode(CutMode.PARTIAL))
        assertEquals(CutProtocol.GS_V_0, CutProtocol.GS_V_1.withCutMode(CutMode.TOTAL))
        assertEquals(CutProtocol.GS_V_66, CutProtocol.GS_V_65.withCutMode(CutMode.PARTIAL))
        assertEquals(CutProtocol.GS_V_65, CutProtocol.GS_V_66.withCutMode(CutMode.TOTAL))
        assertEquals(CutProtocol.ESC_M, CutProtocol.ESC_I.withCutMode(CutMode.PARTIAL))
        assertEquals(CutProtocol.ESC_I, CutProtocol.ESC_M.withCutMode(CutMode.TOTAL))
        assertEquals(CutProtocol.NONE, CutProtocol.NONE.withCutMode(CutMode.PARTIAL))
        assertNull(CutProtocol.NONE.cutMode)

        CutProtocol.entries.filter { it != CutProtocol.NONE }.forEach { dialect ->
            assertEquals(dialect.name, CutMode.PARTIAL, dialect.withCutMode(CutMode.PARTIAL).cutMode)
            assertEquals(dialect.name, CutMode.TOTAL, dialect.withCutMode(CutMode.TOTAL).cutMode)
            // O irmão nunca sai da família de avanço embutido, que é a regra do perfil.
            assertEquals(
                dialect.name,
                dialect in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED,
                dialect.withCutMode(CutMode.PARTIAL) in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED,
            )
        }
    }

    @Test
    fun `corte isolado termina no comando e não imprime nada depois`() {
        CutProtocol.entries.filter { it != CutProtocol.NONE }.forEach { dialect ->
            val bytes = PrinterHomologationProbes.isolatedCut(dialect).bytes()
            val command = requireNotNull(PrinterHomologationProbes.commandFor(dialect))

            assertArrayEquals(dialect.name, command, bytes.takeLast(command.size).toByteArray())
            // Sem avanço extra nos que já carregam o próprio: seria corte em posição errada.
            val hasFeed =
                String(bytes, StandardCharsets.ISO_8859_1)
                    .contains(String(ByteArray(12) { 0x0A }, StandardCharsets.ISO_8859_1))
            assertEquals(dialect.name, dialect !in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED, hasFeed)
        }
    }

    @Test
    fun `o comprovante final exercita a página medida com acento de verdade`() {
        val profile =
            MeasuredProfile.createLocal(
                displayName = "Elgin i9FULL 2",
                transports = setOf(PrinterTransport.LOCAL_WIFI),
                paperWidthMm = 58,
                printableColumns = 48,
                printableDots = 384,
                codePage = ThermalCodePage.CP850,
                cutProtocol = CutProtocol.GS_V_1,
                cutFeedLines = 2,
                measuredAtEpochMillis = 1_700_000_000_000,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        val bytes =
            PrinterHomologationProbes
                .finalReceipt(profile, transport = PrinterTransport.USB)
                .bytes()

        // Literal sem acento sai igual em CP850 e em impressora sem página: o comprovante não
        // provaria a medição que acabou de ser feita. Os bytes altos são a prova.
        val accented = EscPosThermalCommands.text(
            "Acentos: ação, opção, São João",
            ThermalTextAlignment.LEFT,
            ThermalTextStyle.NORMAL,
            0,
            ThermalCodePage.CP850,
        ).filter { (it.toInt() and 0xFF) > 0x7E }
        assertTrue(accented.isNotEmpty())
        assertTrue(bytes.any { (it.toInt() and 0xFF) > 0x7E })
        accented.forEach { assertTrue(it.toString(), bytes.contains(it)) }
        assertTrue(String(bytes, Charsets.ISO_8859_1).contains("Conex"))
        assertTrue(String(bytes, Charsets.ISO_8859_1).contains("USB"))
    }

    /**
     * A letra do comprovante é a letra da tira, e cada linha volta com a sua.
     *
     * A letra não é persistida no perfil: ela é derivada de `(codificação, página, seletor)`. Este
     * teste é o que sustenta essa decisão — se duas linhas da tira produzissem a mesma tripla, o
     * comprovante apontaria para a linha errada e ninguém perceberia.
     */
    @Test
    fun `cada linha da tira de página volta com a própria letra`() {
        PrinterHomologationProbes.codePageCandidates.forEach { candidate ->
            assertEquals(
                candidate.label,
                candidate.letter,
                PrinterHomologationProbes.codePageLetter(
                    candidate.textEncoding,
                    candidate.codePage,
                    candidate.escT.takeIf { candidate.isAddress },
                ),
            )
        }
    }

    /**
     * `Página: Nenhuma` diz duas coisas diferentes, e a letra separa as duas.
     *
     * A linha `a` é a dobra ASCII e a `c` é UTF-8: nenhuma das duas seleciona tabela, então o campo
     * da página sai igual nas duas e o comprovante não dizia qual das tiras foi escolhida.
     */
    @Test
    fun `o comprovante final carrega a letra escolhida na tira`() {
        fun receipt(encoding: ThermalTextEncoding): String {
            val profile =
                MeasuredProfile.createLocal(
                    displayName = "Impressora medida",
                    transports = setOf(PrinterTransport.USB),
                    paperWidthMm = 80,
                    printableColumns = 48,
                    printableDots = 576,
                    codePage = null,
                    textEncoding = encoding,
                    cutProtocol = CutProtocol.GS_V_1,
                    cutFeedLines = 2,
                    measuredAtEpochMillis = 1_700_000_000_000,
                    dialect = EscPosDialect.EPSON_COMPATIBLE,
                )
            return String(
                PrinterHomologationProbes.finalReceipt(profile).bytes(),
                StandardCharsets.ISO_8859_1,
            )
        }

        val ascii = PrinterHomologationProbes.codePageCandidates.first { it.textEncoding == ThermalTextEncoding.ASCII }
        val utf8 = PrinterHomologationProbes.codePageCandidates.first { it.textEncoding == ThermalTextEncoding.UTF_8 }
        assertTrue(receipt(ThermalTextEncoding.ASCII).contains("Nenhuma (letra ${ascii.letter})"))
        assertTrue(receipt(ThermalTextEncoding.UTF_8).contains("Nenhuma (letra ${utf8.letter})"))

        // Configuração manual pode gravar o que a tira não imprime; ali o comprovante não inventa.
        val manual =
            MeasuredProfile.createLocal(
                displayName = "Configurada na mão",
                transports = setOf(PrinterTransport.USB),
                paperWidthMm = 80,
                printableColumns = 48,
                printableDots = 576,
                codePage = ThermalCodePage.CP850,
                codePageSelector = 47,
                cutProtocol = CutProtocol.GS_V_1,
                cutFeedLines = 2,
                measuredAtEpochMillis = 1_700_000_000_000,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        val manualReceipt =
            String(PrinterHomologationProbes.finalReceipt(manual).bytes(), StandardCharsets.ISO_8859_1)
        assertTrue(manualReceipt.contains("CP850"))
        assertFalse(manualReceipt.contains("letra"))
    }

    @Test
    fun `nenhuma sonda emite GS ! porque a MP-4200 imprime o ! como texto`() {
        val sizeCommand = String(ints(0x1D, 0x21), StandardCharsets.ISO_8859_1)
        val payloads =
            listOf(
                PrinterHomologationProbes.geometry(58),
                PrinterHomologationProbes.geometry(80),
                PrinterHomologationProbes.codePages(),
                PrinterHomologationProbes.cutProtocols(),
                PrinterHomologationProbes.cutFeed(CutProtocol.GS_V_1),
            ) + CutProtocol.entries.filter { it != CutProtocol.NONE }
                .map(PrinterHomologationProbes::isolatedCut)

        payloads.forEach { probe ->
            // Ela engole só o `GS` e manda o `!` para o papel: a tira saía "!5" e "!!Escolha".
            assertFalse(
                String(probe.bytes(), StandardCharsets.ISO_8859_1).contains(sizeCommand),
            )
        }
        // O destaque do número continua existindo, agora em negrito e moldura ASCII.
        val strip = PrinterHomologationProbes.cutFeedStrips(CutProtocol.GS_V_1).first { it.feedLines == 5 }
        assertTrue(String(strip.probe.bytes(), StandardCharsets.US_ASCII).contains(">>> 5 <<<"))
    }

    /**
     * O comprovante final prova exatamente o que a tira mediu — maiúscula inclusive.
     *
     * Enquanto a amostra era só minúscula, esta linha dizia menos do que o papel precisava: a
     * T210 passou na tira com `cão, ações, avô` e falhou no título, porque `Ç` e `Í` moram na
     * metade alta da tabela e nunca tinham sido medidos. Agora a amostra cobre as duas metades, e
     * o comprovante repete a amostra inteira: quem conferir o papel confere a medição.
     *
     * O perfil do teste é UTF-8 de propósito: ali o texto sai nos bytes do próprio caractere, e a
     * asserção lê o que a pessoa leria. O QR fica de fora porque raster é imagem, e imagem tem
     * qualquer byte.
     */
    @Test
    fun `o comprovante final repete a amostra medida, com maiúsculas`() {
        val perfil =
            MeasuredProfile.createLocal(
                id = java.util.UUID.randomUUID().toString(),
                displayName = "MTP-II de bancada",
                transports = setOf(PrinterTransport.BLUETOOTH),
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                codePage = null,
                textEncoding = ThermalTextEncoding.UTF_8,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 1,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        val bytes = PrinterHomologationProbes.finalReceipt(perfil).bytes()
        val raster = listOf(0x1D.toByte(), 0x76.toByte(), 0x30.toByte())
        val inicioDoQr = bytes.toList().windowed(3).indexOfFirst { it == raster }
        assertTrue(inicioDoQr > 0)
        val texto = String(bytes.copyOfRange(0, inicioDoQr), StandardCharsets.UTF_8)

        // A quebra do perfil pode trocar um espaço da amostra por uma quebra de linha: o que se
        // afirma é que a amostra inteira está lá, não em que coluna ela terminou.
        val emUmaLinha = texto.replace('\n', ' ')
        assertTrue(emUmaLinha.contains(PrinterHomologationProbes.CODE_PAGE_SAMPLE))
        assertTrue(emUmaLinha.contains("ação, opção, São João"))
        // E a amostra tem as duas metades: sem isso, o comprovante voltaria a provar meia tabela.
        assertTrue(PrinterHomologationProbes.CODE_PAGE_SAMPLE.any { it.isUpperCase() && it.code > 0x7F })
        assertTrue(PrinterHomologationProbes.CODE_PAGE_SAMPLE.any { it.isLowerCase() && it.code > 0x7F })
    }

    /**
     * Nenhuma linha do comprovante final estoura a largura medida.
     *
     * Medido no papel da T210 em 12/08, já com 58 mm e 32 colunas certos: "Codificação: Padrão da
     * impressora" tem 33 caracteres, a firmware quebrou na coluna exata e saiu "impressor / a".
     * Palavra partida é a assinatura que a tela ensina a procurar para largura errada — um rótulo
     * comprido virava alarme falso justamente no papel que prova a medição certa.
     */
    @Test
    fun `nenhuma linha do comprovante final passa da largura medida`() {
        listOf(32, 48).forEach { colunas ->
            // O caso largo é o pior de cada linha nova: fator gravado (a redação com os dois
            // números) e modo não honrado, que é a redação mais comprida das três.
            val perfil =
                MeasuredProfile.createLocal(
                    id = java.util.UUID.randomUUID().toString(),
                    displayName = "Impressora de bancada com nome comprido de propósito",
                    transports = setOf(PrinterTransport.BLUETOOTH),
                    paperWidthMm = if (colunas == 32) 58 else 80,
                    printableColumns = colunas,
                    printableDots = if (colunas == 32) 384 else 576,
                    codePage = null,
                    textEncoding = ThermalTextEncoding.UTF_8,
                    cutProtocol = CutProtocol.GS_V_0,
                    cutModeHonored = false,
                    cutFeedLines = 4,
                    verticalRasterScale = 38.0 / PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_MM,
                    // As quatro redações da linha de configuração de rede têm o mesmo comprimento,
                    // então qualquer uma é o pior caso dela.
                    wifiConfigurationFamily = PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
                    measuredAtEpochMillis = 1,
                    dialect = EscPosDialect.EPSON_COMPATIBLE,
                )
            val linhasLongas = linhasDoComprovante(perfil).filter { it.length > colunas }
            assertEquals(linhasLongas.toString(), emptyList<String>(), linhasLongas)

            // E o perfil sem nada medido, que é o outro par de redações.
            val semFator =
                perfil.copy(cutProtocol = CutProtocol.NONE, cutFeedLines = 0, verticalRasterScale = null)
            val longasSemFator = linhasDoComprovante(semFator).filter { it.length > colunas }
            assertEquals(longasSemFator.toString(), emptyList<String>(), longasSemFator)
        }
    }

    /**
     * O comprovante final é a **fonte de transcrição** do cadastro de impressoras, e esta é a
     * lista de linhas que ele promete.
     *
     * A partir de 20/08 o dono passa a repassar o laboratório inteiro pela homologação e cadastrar
     * cada máquina lendo este papel. Um campo medido que não sai aqui é um campo que ninguém
     * transcreve — e a falta só aparece depois de quinze impressoras. Um `contains` por linha não
     * protegeria disso: ele passa igual quando uma linha some. A lista ordenada é o que quebra
     * quando alguém tira, renomeia ou reordena qualquer coisa.
     *
     * As linhas de compensação e de modo do corte entraram nesta lista em 20/08; as outras estão
     * congeladas como já saíam.
     */
    @Test
    fun `o comprovante final lista, em ordem, tudo que o perfil medido guarda`() {
        val medido =
            MeasuredProfile.createLocal(
                id = "6c3f1b6a-9f2d-4a1e-8f0b-2d5c7a91e4d3",
                displayName = "Inico T210",
                transports = setOf(PrinterTransport.BLUETOOTH_LE),
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                codePage = ThermalCodePage.CP850,
                cutProtocol = CutProtocol.GS_V_0,
                cutModeHonored = false,
                cutFeedLines = 4,
                verticalRasterScale = 38.0 / PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_MM,
                // Um honra o comando e o outro não: é o par que prova que são duas capacidades, e
                // não uma só com dois nomes.
                nativeQrHonored = true,
                nativeBarcodeHonored = false,
                measuredAtEpochMillis = 1_700_000_000_000,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        assertEquals(
            listOf(
                "Instalação concluída",
                "Inico T210",
                "58 mm | 32 colunas | 384 dots",
                "Conexão: Bluetooth",
                "Página: CP850 (letra d)",
                "Codificação: Byte único",
                "Corte: GS_V_0 | avanço 4",
                "Modo do corte: sai diferente",
                "Vazão: 38/48 mm | fator 0,79",
                "QR nativo: sai como código",
                "Barras nativas: sai como texto",
                // A família de configuração de rede fecha o bloco das capacidades medidas: é a
                // única que não sai da série de tiras da homologação, e por isso a última antes do
                // carimbo de data. Aqui ela é a ausência, que é o que este perfil tem a dizer.
                "Config. de rede: não determinada",
                "Medida em: ${PrinterHomologationProbes.localTimestamp(1_700_000_000_000)}",
                "Identidade GS I: não respondeu",
            ),
            linhasDoComprovante(medido, PrinterTransport.BLUETOOTH_LE, CP850).take(14),
        )

        // **Neutralidade.** O perfil sem fator, com a guilhotina obediente e anterior às duas
        // sondas tardias sai com o comprovante de sempre, linha por linha, e as linhas novas dizem
        // exatamente a ausência — que é a informação, e não a falta dela.
        val semMedidaTardia =
            medido.copy(
                cutModeHonored = true,
                verticalRasterScale = null,
                nativeQrHonored = null,
                nativeBarcodeHonored = null,
            )
        assertEquals(
            listOf(
                "Modo do corte: sai como pedido",
                "Vazão: sem compensação",
                "QR nativo: não medido",
                "Barras nativas: não medido",
                "Config. de rede: não determinada",
            ),
            linhasDoComprovante(semMedidaTardia, PrinterTransport.BLUETOOTH_LE, CP850).subList(7, 12),
        )
    }

    /**
     * A linha da família de configuração de rede separa medido de declarado, nas quatro redações.
     *
     * `AGENTS.md` obriga a linha: o comprovante final é certidão transcrita para cadastro, e lista
     * toda capacidade medida. Ela **continua saindo** quando o valor é ausente — a ausência é a
     * informação, e campo que some da folha vira campo esquecido no cadastro.
     *
     * O iOS fixa estes mesmos literais em `PrinterProbePayloadsTests`.
     */
    @Test
    fun `a linha da configuracao de rede separa medido de declarado`() {
        assertEquals(
            "Config. de rede: não determinada\n",
            PrinterHomologationProbes.wifiConfigurationFamilyLine(null),
        )
        assertEquals(
            "Config. de rede: medida, aceitou\n",
            PrinterHomologationProbes.wifiConfigurationFamilyLine(
                PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED,
            ),
        )
        assertEquals(
            "Config. de rede: medida, recusou\n",
            PrinterHomologationProbes.wifiConfigurationFamilyLine(
                PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
            ),
        )
        // A única redação que **não** diz "medida", porque ninguém mediu: escrever "medida" aqui
        // poria no papel uma medição que não houve.
        assertEquals(
            "Config. de rede: escolhida à mão\n",
            PrinterHomologationProbes.wifiConfigurationFamilyLine(
                PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US,
            ),
        )

        // Cabe na 58 mm, nas quatro — e por um caractere. `layout.wrap` parte a linha que estourar,
        // e uma linha partida desloca tudo o que vem depois no papel que serve de transcrição.
        val familias = listOf(null) + PrinterWifiConfigurationFamily.entries
        familias.forEach { familia ->
            val linha = PrinterHomologationProbes.wifiConfigurationFamilyLine(familia).trimEnd('\n')
            assertEquals(linha, 32, linha.length)
        }
    }

    /**
     * A linha da sonda de vazão, palavra por palavra, nos casos que a régua produz.
     *
     * O iOS fixa estes mesmos literais em `PrinterProbePayloadsTests`: é o par que garante que a
     * mesma impressora homologada nos dois sistemas gere o mesmo texto para o cadastro.
     */
    @Test
    fun `a linha da sonda diz a leitura, o esperado e o fator`() {
        val esperado = PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_MM

        // "Usar padrão" e tira na medida: `null` não guarda leitura, então não há milímetro a
        // citar — mas a linha continua saindo, que é o ponto desta frente.
        assertEquals(
            "Vazão: sem compensação\n",
            PrinterHomologationProbes.verticalRasterScaleLine(null),
        )
        // A T210 da bancada, 20/08: 38 mm de 48 na régua, fator 0,79 no perfil.
        assertEquals(
            "Vazão: 38/48 mm | fator 0,79\n",
            PrinterHomologationProbes.verticalRasterScaleLine(38.0 / esperado),
        )
        // A maior leitura que ainda conclui fator, e o piso da faixa do campo. Nos dois extremos o
        // milímetro reconstruído bate com o que a pessoa respondeu.
        assertEquals(
            "Vazão: 46/48 mm | fator 0,96\n",
            PrinterHomologationProbes.verticalRasterScaleLine(46.0 / esperado),
        )
        assertEquals(
            "Vazão: 24/48 mm | fator 0,50\n",
            PrinterHomologationProbes.verticalRasterScaleLine(VERTICAL_RASTER_SCALE_RANGE.start),
        )
    }

    /**
     * As duas linhas da sonda de código nativo, palavra por palavra, nos três estados.
     *
     * O iOS fixa estes mesmos seis literais em `PrinterProbePayloadsTests`: é o par que garante que
     * a mesma impressora homologada nos dois sistemas gere o mesmo texto para o cadastro.
     *
     * `não medido` é a terceira redação, e ela precisa existir: sem ela a ausência sairia como
     * `sai como texto`, que é uma **afirmação** sobre uma firmware que ninguém mediu.
     */
    @Test
    fun `as duas linhas do código nativo dizem os três estados em 32 colunas`() {
        assertEquals(
            "QR nativo: sai como código\n",
            PrinterHomologationProbes.nativeQrLine(true),
        )
        assertEquals(
            "QR nativo: sai como texto\n",
            PrinterHomologationProbes.nativeQrLine(false),
        )
        assertEquals(
            "QR nativo: não medido\n",
            PrinterHomologationProbes.nativeQrLine(null),
        )
        assertEquals(
            "Barras nativas: sai como código\n",
            PrinterHomologationProbes.nativeBarcodeLine(true),
        )
        assertEquals(
            "Barras nativas: sai como texto\n",
            PrinterHomologationProbes.nativeBarcodeLine(false),
        )
        assertEquals(
            "Barras nativas: não medido\n",
            PrinterHomologationProbes.nativeBarcodeLine(null),
        )

        // Cabem na 58 mm sem a quebra do layout precisar entrar: a mais longa tem 31 caracteres.
        listOf(true, false, null).forEach { resposta ->
            assertTrue(PrinterHomologationProbes.nativeQrLine(resposta).trimEnd().length <= 32)
            assertTrue(PrinterHomologationProbes.nativeBarcodeLine(resposta).trimEnd().length <= 32)
        }
    }

    /**
     * A tira de código nativo emite os dois comandos, sem legenda e sem payload sensível.
     *
     * O caso de falha desta sonda é o payload sair impresso como texto legível — é exatamente isso
     * que a pergunta distingue —, então o que ela carrega tem de ser uma palavra e nada mais.
     */
    @Test
    fun `a tira de código nativo manda GS ( k e GS k sem legenda`() {
        val bytes = PrinterHomologationProbes.nativeCode(384).bytes()
        val texto = bytes.toString(Charsets.US_ASCII)

        assertTrue(texto.contains("SONDA DE CODIGO NATIVO"))
        assertTrue(texto.contains("Duas figuras saem abaixo"))
        // O rodapé nomeia o defeito antes de ele acontecer, com a palavra que os dois códigos
        // carregam: quem lê não julga "isso é um código?", reconhece o que a tira ensinou.
        assertTrue(texto.contains("palavra ${PrinterHomologationProbes.NATIVE_CODE_PAYLOAD} em letras"))

        // `GS ( k` (função 180, armazenar) e `GS k` função B, os dois comandos que a etapa mede.
        assertTrue(indexOfSublist(bytes, byteArrayOf(0x1D, 0x28, 0x6B)) >= 0)
        assertTrue(indexOfSublist(bytes, byteArrayOf(0x1D, 0x6B, 73.toByte())) >= 0)

        // HRI desligada: `GS H 0`. Com a legenda ligada, um código correto sai com letras embaixo —
        // e a pergunta é justamente "saiu figura ou saíram letras".
        assertTrue(indexOfSublist(bytes, byteArrayOf(0x1D, 0x48, 0x00)) >= 0)

        // Nada de gravação em memória não volátil: nem `GS ( E` nem `FS q` aparecem aqui.
        assertEquals(-1, indexOfSublist(bytes, byteArrayOf(0x1D, 0x28, 0x45)))
        assertEquals(-1, indexOfSublist(bytes, byteArrayOf(0x1C, 0x71)))

        // O alinhamento volta para a esquerda: o nativo é estado, e estado deixado ligado
        // desalinharia a tira seguinte.
        assertTrue(indexOfSublist(bytes, byteArrayOf(0x1B, 0x61, 0x00)) >= 0)
    }

    /**
     * A tira cabe na geometria mais estreita que este kit homologa.
     *
     * 256 pontos é a menor largura raster que a sonda de geometria oferece, e um símbolo mais largo
     * que o papel sairia truncado — indistinguível de "a firmware não entendeu", que é a única
     * coisa que esta tira existe para medir. É o número que decide o tamanho do payload.
     */
    @Test
    fun `a tira de código nativo cabe em toda largura homologável`() {
        listOf(256, 288, 320, 384, 512, 576, 640).forEach { dots ->
            assertTrue("$dots dots", PrinterHomologationProbes.nativeCode(dots).size > 0)
        }
        val total =
            requireNotNull(
                ThermalBarcode.totalModules(
                    PrinterHomologationProbes.NATIVE_CODE_PAYLOAD,
                    ThermalBarcodeSymbology.CODE_128,
                ),
            )
        assertTrue(
            "O símbolo não cabe em 256 pontos com a largura de módulo mínima.",
            total * ThermalBarcode.MODULE_WIDTH_DOTS_RANGE.first <= 256,
        )
        assertThrows(IllegalArgumentException::class.java) {
            PrinterHomologationProbes.nativeCode(100)
        }
    }

    /**
     * A linha do modo do corte separa "atende o comando" de "entrega o modo".
     *
     * Medido na GoldenSky 80 mm em 10/08: os sete comandos foram obedecidos e o corte saiu
     * **sempre parcial**, inclusive nos que pedem total. O iOS fixa os mesmos literais.
     */
    @Test
    fun `a linha do modo do corte separa comando atendido de modo entregue`() {
        assertEquals(
            "Modo do corte: sai como pedido\n",
            PrinterHomologationProbes.cutModeLine(CutProtocol.GS_V_0, true),
        )
        assertEquals(
            "Modo do corte: sai diferente\n",
            PrinterHomologationProbes.cutModeLine(CutProtocol.GS_V_0, false),
        )
        // Sem guilhotina o campo do perfil continua `true` por padrão, e afirmar "sai como pedido"
        // seria afirmar sobre um corte que não acontece.
        assertEquals(
            "Modo do corte: sem guilhotina\n",
            PrinterHomologationProbes.cutModeLine(CutProtocol.NONE, true),
        )
        assertEquals(
            "Modo do corte: sem guilhotina\n",
            PrinterHomologationProbes.cutModeLine(CutProtocol.NONE, false),
        )
    }

    /**
     * As linhas de texto do comprovante final, já sem comando ESC/POS e sem o raster do QR.
     *
     * Só o texto: comando ESC/POS não ocupa coluna. `ESC @` tem dois bytes e o resto do que este
     * comprovante emite — `ESC a`, `ESC E`, `ESC t`, `GS !` — tem três.
     */
    private fun linhasDoComprovante(
        perfil: MeasuredProfile,
        transport: PrinterTransport? = null,
        // O comprovante sai na página medida, então lê-lo de volta exige a mesma tabela. `IBM850`
        // é o nome da CP850 na JVM; perfil sem página sai em UTF-8 ou na dobra ASCII, e as duas
        // atravessam UTF-8 sem perda.
        charset: Charset = StandardCharsets.UTF_8,
    ): List<String> {
        val bytes = PrinterHomologationProbes.finalReceipt(perfil, transport = transport).bytes()
        val raster = listOf(0x1D.toByte(), 0x76.toByte(), 0x30.toByte())
        val texto =
            String(
                bytes.copyOfRange(0, bytes.toList().windowed(3).indexOfFirst { it == raster }),
                charset,
            )
        val impresso = buildString {
            var i = 0
            while (i < texto.length) {
                val atual = texto[i]
                when {
                    atual.code == 0x1B && i + 1 < texto.length && texto[i + 1].code == 0x40 -> i += 2
                    atual.code == 0x1B || atual.code == 0x1D -> i += 3
                    else -> {
                        append(atual)
                        i += 1
                    }
                }
            }
        }
        return impresso.split('\n')
    }

    /**
     * Cada acento do português entra na amostra, nas duas caixas.
     *
     * A lista é escrita à mão porque é vocabulário, não tabela: quem acrescentar um acento ao
     * português precisa acrescentar aqui também, e o teste avisa.
     *
     * E nada além disso. `ü Ü` saíram porque o trema caiu do português em 2009; `ª º` saíram
     * porque nada no kit nem no app imprime ordinal, e a dobra ASCII nem os representa — a linha
     * `a` terminava em `? ?` no papel.
     */
    @Test
    fun `a amostra cobre o inventário de acentos do português`() {
        val amostra = PrinterHomologationProbes.CODE_PAGE_SAMPLE

        "àãáâéêíóôõúÀÃÁÂÉÊÍÓÔÕÚçÇ".forEach { acento ->
            assertTrue("falta $acento na amostra", amostra.contains(acento))
        }
        "üÜªºñÑ".forEach { fora ->
            assertFalse("$fora não é acento do português e não pertence à amostra", amostra.contains(fora))
        }
        // E toda candidata continua conseguindo imprimir a amostra inteira: incluir `ª º` não pode
        // ter derrubado nenhuma página da lista em silêncio.
        assertEquals(26, PrinterHomologationProbes.codePageCandidates.size)
    }

    @Test
    fun `a instrução da tira não depende da página que ainda será medida`() {
        val receipt = String(PrinterHomologationProbes.codePages().bytes(), StandardCharsets.ISO_8859_1)

        // A instrução sai em ASCII e antes de qualquer `ESC t`: ela precisa ser legível mesmo na
        // impressora cuja página é a errada — que é justamente a que vai usar esta tira.
        assertFalse(PrinterHomologationProbes.CODE_PAGE_INSTRUCTIONS.any { it.code > 0x7E })
        assertTrue(receipt.contains("Escolha a letra da linha em"))
        assertTrue(receipt.contains("maiusculas tambem."))
    }

    @Test
    fun `tabela produtiva CP437 dobra o que não existe e CP866 dobra todo português`() {
        val cp437 =
            EscPosThermalCommands.text(
                "ÃÇá",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                ThermalCodePage.CP437,
            )
        val cp866 =
            EscPosThermalCommands.text(
                "ÃÇá",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                ThermalCodePage.CP866,
            )

        assertTrue(cp437.contains('A'.code.toByte()))
        assertTrue(cp437.contains(0x80.toByte()))
        assertTrue(cp437.contains(0xA0.toByte()))
        assertFalse(cp866.any { (it.toInt() and 0xFF) > 0x7E })
        assertTrue(String(cp866, StandardCharsets.US_ASCII).contains("ACa"))
    }

    @Test
    fun `sete respostas de corte preservam os seis comandos medidos e NONE`() {
        val candidates = PrinterHomologationProbes.cutProtocolCandidates

        assertEquals(
            listOf(
                CutProtocol.GS_V_0,
                CutProtocol.GS_V_1,
                CutProtocol.GS_V_65,
                CutProtocol.GS_V_66,
                CutProtocol.ESC_I,
                CutProtocol.ESC_M,
                CutProtocol.NONE,
            ),
            candidates.map(CutProtocolProbeCandidate::protocol),
        )
        val expected =
            listOf(
                ints(0x1D, 0x56, 0x00),
                ints(0x1D, 0x56, 0x01),
                ints(0x1D, 0x56, 0x41, 0x50),
                ints(0x1D, 0x56, 0x42, 0x50),
                ints(0x1B, 0x69),
                ints(0x1B, 0x6D),
            )
        candidates.take(6).zip(expected).forEach { (candidate, bytes) ->
            assertArrayEquals(candidate.label, bytes, candidate.commandBytes())
        }
        assertNull(candidates.last().commandBytes())
    }

    @Test
    fun `GS V 65 e 66 nunca recebem avanço duplicado`() {
        assertArrayEquals(
            ints(0x1D, 0x56, 0x41, 0x50),
            EscPosThermalCommands.cut(12, CutProtocol.GS_V_65),
        )
        assertArrayEquals(
            ints(0x1D, 0x56, 0x42, 0x50),
            EscPosThermalCommands.cut(12, CutProtocol.GS_V_66),
        )
        // Quem não carrega avanço embutido recebe o avanço em quebras de linha, porque a MP-4200
        // ignora `ESC d`. As variantes 65/66 continuam saindo sem nenhum avanço na frente.
        assertArrayEquals(
            ints(0x0A, 0x0A, 0x1D, 0x56, 0x00),
            EscPosThermalCommands.cut(2, CutProtocol.GS_V_0),
        )
    }

    @Test
    fun `geometria traz régua textual e quatro faixas raster da largura escolhida`() {
        val bytes = PrinterHomologationProbes.geometry(58).bytes()
        val text = String(bytes, StandardCharsets.ISO_8859_1)

        assertTrue(text.contains(textRuler(32)))
        assertEquals(listOf(256, 288, 320, 384), rasterWidths(bytes))
    }

    @Test
    fun `comparacao de papel usa as mesmas reguas exatas da geometria`() {
        val bytes = PrinterHomologationProbes.paperWidthRulers().bytes()
        val text = String(bytes, StandardCharsets.ISO_8859_1)

        assertTrue(text.contains("58mm\n${textRuler(32)}\n384 Dots\n"))
        assertTrue(text.contains("80mm\n${textRuler(48)}\n576 Dots\n"))
        assertEquals(listOf(384, 576), rasterWidths(bytes))
        assertFalse(text.contains("=================="))
    }

    @Test
    fun `CUT FEED tem oito tiras numeradas duas vezes e um único avanço por tira`() {
        val strips = PrinterHomologationProbes.cutFeedStrips(CutProtocol.ESC_M)

        assertEquals(listOf(0, 2, 4, 5, 6, 8, 10, 12), strips.map(CutFeedProbeStrip::feedLines))
        assertTrue(PrinterHomologationProbes.CUT_FEED_BENCH_WARNING.contains("8 tiras"))
        strips.forEach { strip ->
            val bytes = strip.probe.bytes()
            val text = String(bytes, StandardCharsets.ISO_8859_1)
            // O número saía em corpo dobrado por `GS !`, comando que a MP-4200 imprime como `!`.
            // A moldura ASCII mantém as duas ocorrências que a tira precisa ter.
            assertTrue(
                "número inicial ausente em ${strip.feedLines}",
                occurrences(text, ">>> ${strip.feedLines} <<<\n") >= 2,
            )
            assertTrue(text.contains("LINHA DE REFERENCIA"))
            // A invariante continua sendo "uma fonte de avanço só", agora contada em quebras de
            // linha porque a MP-4200 ignora `ESC d`. Duas fontes de avanço deixaram dez linhas em
            // branco antes da serrilha na primeira impressão real.
            val cut = requireNotNull(PrinterHomologationProbes.commandFor(CutProtocol.ESC_M))
            assertArrayEquals(cut, bytes.takeLast(cut.size).toByteArray())
            val afterReference = text.substringAfter("LINHA DE REFERENCIA ----\n").dropLast(cut.size)
            assertEquals(
                "avanço errado em ${strip.feedLines}",
                strip.feedLines,
                afterReference.count { it == '\n' },
            )
            // O avanço vai impresso e numerado: o desperdício depois da linha de referência deixa
            // de ser papel em branco e vira contagem.
            (1..strip.feedLines).forEach { line ->
                assertTrue("linha $line ausente em ${strip.feedLines}", text.contains("$line ---- DESPERDICIO"))
            }
        }
    }

    /**
     * O custo anunciado é contado das sondas, tira por tira.
     *
     * Cada parcela é conferida contra o payload que a produz: régua de largura numa tira, régua
     * completa de geometria em outra, vazão numa, um dialeto de corte por tira, a régua inteira do
     * avanço, a tira de página e o comprovante final. Enquanto isso era literal de tela, o Android
     * anunciava 17, o iOS 7, e nenhum dos dois contava a régua de largura.
     */
    @Test
    fun `o custo em papel conta uma tira para cada pedaço que a sonda produz`() {
        assertEquals(1, PrinterHomologationPaperCost.WIDTH_RULERS)
        assertEquals(1, PrinterHomologationPaperCost.FULL_GEOMETRY)
        assertEquals(6, PrinterHomologationPaperCost.cutProtocolStrips)
        assertEquals(
            PrinterHomologationProbes.cutFeedStrips(CutProtocol.ESC_M).size,
            PrinterHomologationPaperCost.cutFeedStrips,
        )
        // Um dialeto por tira: a contagem é a dos que têm comando, e NONE não corta papel nenhum.
        assertEquals(
            PrinterHomologationProbes.cutProtocolCandidates.count { it.commandBytes() != null },
            PrinterHomologationPaperCost.cutProtocolStrips,
        )
        // A tira de código nativo sai em toda impressora — firmware não se adivinha —, então ela
        // entra no piso, e não só no teto: é ela que fez o mínimo virar cinco.
        assertEquals(1, PrinterHomologationPaperCost.NATIVE_CODE)
        assertEquals(5, PrinterHomologationPaperCost.minimumStrips)
        assertEquals(20, PrinterHomologationPaperCost.maximumStrips)
    }

    @Test
    fun `NONE e corte com alimentação embutida concluem com zero sem oito tiras`() {
        listOf(CutProtocol.NONE, CutProtocol.GS_V_65, CutProtocol.GS_V_66).forEach { protocol ->
            assertEquals(listOf(0), PrinterHomologationProbes.cutFeedChoices(protocol))
            assertTrue(PrinterHomologationProbes.cutFeedStrips(protocol).isEmpty())
        }
    }

    /** Onde a sequência de comando aparece nos bytes da tira, ou `-1`. */
    private fun indexOfSublist(
        bytes: ByteArray,
        target: ByteArray,
    ): Int {
        if (target.isEmpty() || target.size > bytes.size) return -1
        for (start in 0..bytes.size - target.size) {
            if ((target.indices).all { bytes[start + it] == target[it] }) return start
        }
        return -1
    }

    private fun rasterWidths(bytes: ByteArray): List<Int> {
        val widths = mutableListOf<Int>()
        var index = 0
        while (index + 7 < bytes.size) {
            if (
                bytes[index] == 0x1D.toByte() &&
                    bytes[index + 1] == 0x76.toByte() &&
                    bytes[index + 2] == 0x30.toByte() &&
                    bytes[index + 3] == 0x00.toByte()
            ) {
                val widthBytes =
                    (bytes[index + 4].toInt() and 0xFF) or
                        ((bytes[index + 5].toInt() and 0xFF) shl 8)
                widths += widthBytes * 8
            }
            index += 1
        }
        return widths
    }

    private fun commandCount(bytes: ByteArray, first: Int, second: Int): Int =
        bytes.indices.count { index ->
            index + 1 < bytes.size && bytes[index] == first.toByte() && bytes[index + 1] == second.toByte()
        }

    private fun occurrences(text: String, part: String): Int =
        Regex(Regex.escape(part)).findAll(text).count()

    private fun textRuler(columns: Int): String {
        val suffix = columns.toString()
        return "|" + "-".repeat(columns - suffix.length - 2) + "|" + suffix
    }

    private fun ints(vararg values: Int): ByteArray = values.map(Int::toByte).toByteArray()
}
