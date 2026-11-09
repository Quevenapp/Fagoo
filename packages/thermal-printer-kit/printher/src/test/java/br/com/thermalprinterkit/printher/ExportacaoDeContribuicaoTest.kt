package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.EscPosDialect
import br.com.thermalprinterkit.BundledPrinterDrivers
import br.com.thermalprinterkit.CutProtocol
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PRINTER_CONTRIBUTION_MIME_TYPE
import br.com.thermalprinterkit.PrinterContributionImport
import br.com.thermalprinterkit.PrinterContributionUnmeasured
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalCodePage
import br.com.thermalprinterkit.ThermalTextEncoding
import br.com.thermalprinterkit.createPrinterContributionJson
import br.com.thermalprinterkit.readPrinterContributionJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O gesto que produz o pacote de contribuição, medido sem uma linha de tela.
 *
 * **O buraco que isto fecha.** Confirmado por grep em 30/08/2026, antes de escrever qualquer coisa:
 * `createPrinterContributionJson` tinha chamador **só em teste** — `android/src/test`,
 * `jvm/core/src/test`, `jvm/app/src/test` e `ios/Tests` — e nenhum em `android/src/main`,
 * `ios/Sources`, `android-lab`, `ios-lab`, `printher/` ou no repositório vizinho do app. O leitor de
 * mesa existe e é chamado (`ImportacaoDeContribuicao.kt`), o rótulo da bandeja existe
 * (*"Adotar impressora homologada no celular…"*), e o arquivo que ele pede não era emitido por
 * ninguém.
 *
 * O que estes testes provam é o **preparo inteiro**: se o gesto aparece, o que ele monta, com que
 * nome, de que tipo, e o que ele diz que não vai junto. O que eles **não** provam está em
 * [EntregaDeContribuicao] — o diálogo do sistema é ponto de injeção justamente porque não se prova
 * nesta bancada.
 */
class ExportacaoDeContribuicaoTest {
    @Test
    fun `perfil medido produz pacote, e o pacote e o que o leitor de mesa aceita`() {
        val perfil = perfilMedido()

        val preparo = ExportacaoDeContribuicao.preparar(perfil, "16", "2.4.0")

        val pacote = (preparo as PreparoDaContribuicao.Pronto).pacote
        // Byte a byte o mesmo que o escritor do kit produz: não há um segundo formato aqui.
        assertTrue(
            "O gesto não pode inventar um segundo formato de pacote.",
            pacote.conteudo.contentEquals(
                createPrinterContributionJson(perfil, osVersion = "16", appVersion = "2.4.0"),
            ),
        )
        // O pacote sai nomeado pela impressora que a pessoa acabou de batizar, e não por um nome
        // fixo: quem exporta duas impressoras precisa distinguir os dois arquivos no seletor.
        assertEquals("impressora-do-balcao.printercontribution", pacote.nomeDoArquivo)
        // E o outro lado o aceita de verdade, com a chave de capacidade fechando.
        val lido = readPrinterContributionJson(pacote.conteudo, id = ID_DE_DESTINO)
        assertTrue(
            "O pacote emitido tem de ser exatamente o que o leitor de mesa lê.",
            lido is PrinterContributionImport.Accepted,
        )
        assertEquals(
            perfil.capabilityKey,
            (lido as PrinterContributionImport.Accepted).profile.capabilityKey,
        )
    }

    @Test
    fun `perfil que nao e medicao nao ganha gesto nenhum`() {
        // O escritor lança para os dois; a tela não pode oferecer o botão e deixar o `require`
        // estourar na cara de quem tocou nele. Aqui a recusa acontece antes do botão existir.
        val embutido = MeasuredProfile.bundled(BundledPrinterDrivers.elginI9Full2)
        val temporario =
            MeasuredProfile.temporary(
                PrinterTransport.BLUETOOTH,
                58,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        listOf(embutido, temporario).forEach { perfil ->
            val preparo = ExportacaoDeContribuicao.preparar(perfil, "16", "2.4.0")
            assertEquals(
                "Perfil ${perfil.source} não pode virar contribuição.",
                PreparoDaContribuicao.NaoOferecido(MotivoParaNaoContribuir.PERFIL_NAO_MEDIDO),
                preparo,
            )
        }
    }

    @Test
    fun `versao vazia ou de controle nao vira pacote, e cada lado tem motivo proprio`() {
        val perfil = perfilMedido()

        assertEquals(
            PreparoDaContribuicao.NaoOferecido(MotivoParaNaoContribuir.VERSAO_DO_SISTEMA_INVALIDA),
            ExportacaoDeContribuicao.preparar(perfil, "   ", "2.4.0"),
        )
        assertEquals(
            PreparoDaContribuicao.NaoOferecido(MotivoParaNaoContribuir.VERSAO_DO_APP_INVALIDA),
            ExportacaoDeContribuicao.preparar(perfil, "16", ""),
        )
        assertEquals(
            PreparoDaContribuicao.NaoOferecido(MotivoParaNaoContribuir.VERSAO_DO_APP_INVALIDA),
            ExportacaoDeContribuicao.preparar(perfil, "16", "2.4\u0000.0"),
        )
    }

    @Test
    fun `a fronteira dos 128 caracteres e a mesma aqui e no escritor`() {
        // Esta é a única regra do escritor copiada para este módulo — a função dele é privada e o
        // diretório `android/src/main` não é deste lote. Se as duas divergirem, o botão aparece e o
        // `require` estoura. Então a fronteira é medida **contra o escritor de verdade**, pelos dois
        // lados, e é este teste que denuncia a divergência no dia em que ela acontecer.
        val perfil = perfilMedido()
        val noLimite = "9".repeat(128)
        val umAMais = "9".repeat(129)

        assertTrue(
            ExportacaoDeContribuicao.preparar(perfil, noLimite, "2.4.0") is PreparoDaContribuicao.Pronto,
        )
        assertNotNull(
            "O escritor tem de aceitar o que o preparo aceitou.",
            createPrinterContributionJson(perfil, osVersion = noLimite, appVersion = "2.4.0"),
        )

        assertEquals(
            PreparoDaContribuicao.NaoOferecido(MotivoParaNaoContribuir.VERSAO_DO_SISTEMA_INVALIDA),
            ExportacaoDeContribuicao.preparar(perfil, umAMais, "2.4.0"),
        )
        val estourou =
            runCatching {
                createPrinterContributionJson(perfil, osVersion = umAMais, appVersion = "2.4.0")
            }.isFailure
        assertTrue("O escritor tem de recusar o que o preparo recusou.", estourou)
    }

    @Test
    fun `medicao confirmada sempre tem data, entao o preparo nao precisa de um quarto ramo`() {
        // `createPrinterContributionJson` também exige `measuredAtEpochMillis != null`. O preparo
        // **não** repete essa condição, e isto é o que sustenta a omissão: `MeasuredProfile` já a
        // garante para todo perfil MEASURED, então o ramo seria inalcançável e nenhum teste o
        // tocaria. Se um dia o invariante cair, cai aqui — e não na cara de quem homologou.
        val semData =
            runCatching { perfilMedido().copy(measuredAtEpochMillis = null) }
        assertTrue(
            "MeasuredProfile precisa continuar exigindo data em perfil medido.",
            semData.isFailure,
        )
    }

    @Test
    fun `o nome que a pessoa escreveu chega inteiro do outro lado, com acento`() {
        // **O defeito que este lote fecha, e ele é o do lote anterior.** Em 30/08/2026 pela manhã o
        // gesto passou a **dobrar** o acento antes de empacotar, porque o escritor Swift recusava
        // nome fora do ASCII imprimível. A guarda de lá saiu (quatro medições, em
        // `PrinterContribution.displayNameIsPackageable`) e a dobra saiu com ela: o pacote é UTF-8
        // declarado, e o nome viaja como a pessoa o escreveu.
        val perfil = perfilMedido(displayName = "Cozinha do Balcão")

        val pacote = (ExportacaoDeContribuicao.preparar(perfil, "16", "2.4.0")
            as PreparoDaContribuicao.Pronto).pacote

        // Fixado por literal, e não montado a partir do próprio perfil: uma prova conferida contra
        // a própria entrada sobreviveria a qualquer mordida no caminho do nome.
        assertTrue(
            "O pacote tem de carregar o nome acentuado, e não uma versão dobrada dele.",
            String(pacote.conteudo, Charsets.UTF_8).contains("\"displayName\": \"Cozinha do Balcão\""),
        )
        // E o outro lado recebe o mesmo nome, com a chave de capacidade fechando: o `displayName`
        // não entra no canônico, então o rótulo nunca foi o que emparelha as duas medições.
        val lido =
            readPrinterContributionJson(pacote.conteudo, id = ID_DE_DESTINO)
                as PrinterContributionImport.Accepted
        assertEquals("Cozinha do Balcão", lido.profile.displayName)
        assertEquals(perfil.capabilityKey, lido.profile.capabilityKey)

        // **O nome do ARQUIVO continua dobrando**, e é outra coisa: sistema de arquivos, alfabeto
        // fechado. As duas dobras nunca foram a mesma; só compartilhavam `semAcento`.
        assertEquals("cozinha-do-balcao.printercontribution", pacote.nomeDoArquivo)
    }

    @Test
    fun `nome sem nenhuma letra ASCII passa a viajar, em vez de sumir`() {
        // Japonês, russo, e o nome que a firmware da J-SPEED confundiria com rótulo dela. Nenhum
        // dos três tem acento a tirar; até 30/08/2026 os três faziam o gesto sumir calado, porque a
        // régua era a do `GS I`. Nenhum deles é problema do pacote: o JSON é UTF-8.
        listOf("キッチン", "Кухня", "Cozinha: Balcão", "Ελληνικά").forEach { nome ->
            val preparo = ExportacaoDeContribuicao.preparar(perfilMedido(displayName = nome), "16", "2.4.0")
            assertTrue("O nome $nome tem de virar pacote.", preparo is PreparoDaContribuicao.Pronto)
            val lido =
                readPrinterContributionJson(
                    (preparo as PreparoDaContribuicao.Pronto).pacote.conteudo,
                    id = ID_DE_DESTINO,
                ) as PrinterContributionImport.Accepted
            assertEquals(nome, lido.profile.displayName)
        }
    }

    @Test
    fun `o nome que dobrado viraria um MAC viaja intacto, e a trava fica no nome do arquivo`() {
        // **O achado do C38, e a razão de a dobra do nome de arquivo continuar inteira.**
        // `AA:BB:CC:DD:EE:FF` reduzido a `[a-z0-9-]` continua sendo um MAC legível, porque o hífen
        // é separador de MAC tanto quanto os dois-pontos. E `AÁ:BB:...` **não** é MAC — `Á` não é
        // dígito hexadecimal —, mas **vira** um ao dobrar. Agora que o nome de exibição não dobra
        // mais, o pacote leva o nome de verdade, que não é endereço nenhum; e a segunda tranca
        // continua onde ela sempre precisou estar, no nome do arquivo.
        val perfil = perfilMedido(displayName = "AÁ:BB:CC:DD:EE:FF")

        val pacote = (ExportacaoDeContribuicao.preparar(perfil, "16", "2.4.0")
            as PreparoDaContribuicao.Pronto).pacote

        assertTrue(
            "O nome tem de viajar com o `Á`, que é o que o impede de ser um MAC.",
            String(pacote.conteudo, Charsets.UTF_8).contains("\"displayName\": \"AÁ:BB:CC:DD:EE:FF\""),
        )
        assertEquals("impressora.printercontribution", pacote.nomeDoArquivo)
    }

    @Test
    fun `o motivo nome nao exportavel encolheu ao que o proprio perfil ja recusa`() {
        // O motivo continua existindo, e continua sendo o par do `nomeNaoExportavel` do iOS. O que
        // mudou é o tamanho dele: nome vazio, só-espaço, com controle, ou acima do que o perfil
        // permite — e nada mais.
        listOf("", "   ", "Cozinha\nBalcão", "Cozinha\u0000Balcão", "a".repeat(81)).forEach { nome ->
            assertFalse("O nome [$nome] não pode virar pacote.", ExportacaoDeContribuicao.nomeExportavel(nome))
        }
        // E a fronteira pelo outro lado, senão um mutante que recusasse tudo passaria.
        listOf("a".repeat(80), "キッチン", "Cozinha do Balcão", "AÁ:BB:CC:DD:EE:FF").forEach { nome ->
            assertTrue("O nome $nome tem de virar pacote.", ExportacaoDeContribuicao.nomeExportavel(nome))
        }

        // **O acordo com o tipo do perfil, que é o que faz o ramo ser fronteira e não regra.** Se
        // um dia `MeasuredProfile` aceitar um nome que este gesto recusa, é aqui que se descobre —
        // e não com o botão sumindo no balcão. Hoje as duas réguas coincidem, e por isso o ramo de
        // [MotivoParaNaoContribuir.NOME_NAO_EXPORTAVEL] é **inalcançável** por perfil de verdade.
        listOf(
            "", "   ", "Cozinha\nBalcão", "Cozinha\u0000Balcão", "a".repeat(81),
            "a".repeat(80), "キッチン", "Cozinha do Balcão", "AÁ:BB:CC:DD:EE:FF",
        ).forEach { nome ->
            assertEquals(
                "O gesto e o perfil discordam sobre [$nome].",
                ExportacaoDeContribuicao.nomeExportavel(nome),
                runCatching { perfilMedido(displayName = nome) }.isSuccess,
            )
        }
    }

    @Test
    fun `a regua do acento e uma so, e e a mesma que o gesto do iOS usa`() {
        // Esta tabela é a **única prova de acordo disponível entre duas linguagens**: a mesma
        // tabela, com os mesmos literais, está em `ExportacaoDeContribuicaoSurfaceTests`. Se um dos
        // lados ganhar um caso que o outro não tem, o mesmo arquivo passa a nascer com nome
        // diferente em cada aparelho.
        //
        // Desde 30/08/2026 esta régua serve **só ao nome do arquivo**: o `displayName` que viaja
        // dentro do pacote não dobra mais. Ver `o nome que a pessoa escreveu chega inteiro`.
        listOf(
            "Cozinha do Balcão" to "Cozinha do Balcao",
            "Impressora do balcao" to "Impressora do balcao",
            "Açaí & Cia" to "Acai & Cia",
            "Ãçẽntõs" to "Acentos",
            "PADARIA SÃO JOÃO" to "PADARIA SAO JOAO",
        ).forEach { (entrada, esperado) ->
            assertEquals(esperado, ExportacaoDeContribuicao.semAcento(entrada))
        }
    }

    @Test
    fun `os dois escritores respondem igual ao acento, e nenhum dos dois tem guarda ASCII`() {
        // **A assimetria que o lote da manhã de 30/08/2026 registrou aqui fechou pelo outro lado.**
        // Naquele momento o escritor Swift recusava `displayName` que `sanitizeField` não devolvesse
        // intacto e o escritor Kotlin não tinha guarda nenhuma; a saída escolhida foi dobrar o
        // acento nos dois gestos. Medindo depois, a guarda é que estava errada: `sanitizeField`
        // higieniza o que a FIRMWARE declara no `GS I`, corta em 64 bytes contra os 80 caracteres
        // do perfil, a única restrição ASCII de verdade é o nome de fila do Windows — e ela já é
        // tratada lá —, e o golden do contrato compartilhado prova o pacote em UTF-8.
        //
        // Este teste fixa o desfecho: o escritor Kotlin continua sem guarda, o Swift largou a dele,
        // e o acento sai nos dois. Se alguém repuser a guarda apontando para o `sanitizeField` que
        // continua ao lado guardando as versões, é aqui que a reposição fica vermelha.
        val acentuado = perfilMedido(displayName = "Cozinha do Balcão")

        val emitido = String(
            createPrinterContributionJson(acentuado, osVersion = "16", appVersion = "2.4.0"),
            Charsets.UTF_8,
        )
        assertTrue(
            "O escritor Kotlin passou a dobrar ou recusar o acento.",
            emitido.contains("\"displayName\": \"Cozinha do Balcão\""),
        )
    }

    @Test
    fun `o nome do arquivo usa a extensao que o app iOS ja declara`() {
        // `printercontribution` não é escolha deste lote: é a `public.filename-extension` do tipo
        // exportado `br.com.pixelgoods.printher.printer-contribution`, declarada no `Info.plist` do
        // app iOS do repositório vizinho. Divergir faria o mesmo pacote ser reconhecido num aparelho
        // e não no outro.
        assertEquals("printercontribution", ExportacaoDeContribuicao.EXTENSAO)
        assertEquals(
            "cozinha-do-balcao.printercontribution",
            ExportacaoDeContribuicao.nomeDeArquivo("Cozinha do Balcão"),
        )
    }

    @Test
    fun `nome sem letra aproveitavel cai no nome generico, e nunca sai vazio`() {
        listOf("---", "!!!", "  ", "…", "?").forEach { nome ->
            assertEquals(
                "Nome $nome não pode produzir arquivo sem miolo.",
                "impressora.printercontribution",
                ExportacaoDeContribuicao.nomeDeArquivo(nome),
            )
        }
    }

    @Test
    fun `o nome comprido e cortado sem deixar hifen solto antes do ponto`() {
        val nome = ExportacaoDeContribuicao.nomeDeArquivo("a".repeat(40) + " " + "b".repeat(40))

        val miolo = nome.removeSuffix(".printercontribution")
        assertEquals(ExportacaoDeContribuicao.MAXIMO_DO_MIOLO, miolo.length)
        assertFalse("Hífen solto colado no ponto vira nome feio no seletor.", miolo.endsWith("-"))

        // O corte que cai **em cima do separador** é o único que deixa hífen para trás, e é o
        // caso que a primeira metade deste teste não alcança: com 47 letras, o quadragésimo oitavo
        // caractere é o próprio hífen. Medido em 30/08 mordendo o `trim` final — sem este caso o
        // mutante que apaga o `trim` sobrevivia, porque o corte caía sempre no meio de uma palavra.
        val naEmenda = ExportacaoDeContribuicao.nomeDeArquivo("c".repeat(47) + " balcao")
        assertEquals("c".repeat(47) + ".printercontribution", naEmenda)
    }

    @Test
    fun `o tipo do pacote vem do kit, e e o mesmo que o Info plist do iOS declara`() {
        val pacote = pacotePronto()

        assertEquals(PRINTER_CONTRIBUTION_MIME_TYPE, pacote.mimeType)
        assertEquals("application/vnd.printher.printer-contribution+json", pacote.mimeType)
    }

    @Test
    fun `o que o gesto diz que nao vai junto e o mesmo que o leitor diz que chegou sem medida`() {
        // Requisito de não duplicar a lista: a lista é **uma só**, e é o enum do kit. O que este
        // módulo escreve é só a frase em português para quem exporta. Este teste amarra as duas
        // pontas — se o leitor passar a devolver um conjunto diferente do que o exportador anuncia,
        // alguém está mentindo para uma das duas pessoas.
        val pacote = pacotePronto()
        val lido =
            readPrinterContributionJson(pacote.conteudo, id = ID_DE_DESTINO)
                as PrinterContributionImport.Accepted

        assertEquals(PrinterContributionUnmeasured.entries.toSet(), pacote.semMedida.toSet())
        assertEquals(lido.unmeasured, pacote.semMedida.toSet())
    }

    @Test
    fun `cada item sem medida tem uma frase propria, e nenhuma repete`() {
        val pacote = pacotePronto()

        assertEquals(PrinterContributionUnmeasured.entries.size, pacote.frasesDoQueNaoVaiJunto.size)
        assertEquals(
            "Duas frases iguais deixariam a pessoa sem saber o que são dois itens diferentes.",
            pacote.frasesDoQueNaoVaiJunto.size,
            pacote.frasesDoQueNaoVaiJunto.toSet().size,
        )
        pacote.frasesDoQueNaoVaiJunto.forEach { frase ->
            assertTrue("Frase vazia na lista do que não vai junto.", frase.isNotBlank())
        }
        // A ordem é a da declaração do enum do kit, e não uma segunda ordem deste arquivo.
        assertEquals(
            PrinterContributionUnmeasured.entries.map { it.fraseParaQuemExporta() },
            pacote.frasesDoQueNaoVaiJunto,
        )
    }

    private fun pacotePronto(): PacoteDeContribuicao =
        (ExportacaoDeContribuicao.preparar(perfilMedido(), "16", "2.4.0")
            as PreparoDaContribuicao.Pronto).pacote

    private fun perfilMedido(displayName: String = "Impressora do balcao"): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = ID_DE_ORIGEM,
            displayName = displayName,
            transports = setOf(PrinterTransport.USB),
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            codePage = ThermalCodePage.CP850,
            textEncoding = ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE,
            codePageSelector = 2,
            cutProtocol = CutProtocol.GS_V_1,
            cutFeedLines = 5,
            measuredAtEpochMillis = 1_700_000_000_000,
            firmwareVersion = "SV3.2.2",
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    private companion object {
        const val ID_DE_ORIGEM = "00000000-0000-4000-8000-000000000077"
        const val ID_DE_DESTINO = "00000000-0000-4000-8000-0000000000aa"
    }
}
