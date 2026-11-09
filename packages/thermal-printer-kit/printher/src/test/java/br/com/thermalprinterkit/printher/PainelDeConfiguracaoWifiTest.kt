package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.EscPosThermalCommands
import br.com.thermalprinterkit.PrinterWifiConfigurationFamily
import br.com.thermalprinterkit.ThermalPrintDelivery
import br.com.thermalprinterkit.ThermalPrintResult
import br.com.thermalprinterkit.ThermalPrinterState
import br.com.thermalprinterkit.ThermalWifiAuth
import br.com.thermalprinterkit.ThermalWifiCipher
import br.com.thermalprinterkit.ThermalWifiFrame
import br.com.thermalprinterkit.ThermalWifiKeyType
import br.com.thermalprinterkit.ThermalWifiMode
import br.com.thermalprinterkit.ThermalWifiProbe
import br.com.thermalprinterkit.ThermalWifiProbeIndeterminacy
import br.com.thermalprinterkit.ThermalWifiProbePaperCost
import br.com.thermalprinterkit.ThermalWifiProbeReading
import br.com.thermalprinterkit.ThermalWifiProbeResult
import br.com.thermalprinterkit.ThermalWifiProtocol
import br.com.thermalprinterkit.ThermalWifiSecurity
import br.com.thermalprinterkit.ThermalWifiValidation
import br.com.thermalprinterkit.byteCount
import br.com.thermalprinterkit.rejection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A tela que grava a rede Wi-Fi dentro da impressora, provada sem Compose.
 *
 * O que se testa aqui é o mesmo que se testa nas outras telas do módulo: o tipo puro que a View
 * consome. E aqui isso pesa mais, porque as regras que este arquivo fixa custaram hardware — um
 * nome de rede errado tira a unidade da rede, e uma queda de conexão confundida com falha faria a
 * tela pedir o reenvio de um quadro que já gravou.
 *
 * **Gêmea de `PrinterWifiSetupSurfaceTests.swift`.** As duas telas foram escritas em paralelo e
 * divergiram no fluxo; cada suíte fixava a divergência do próprio lado por literal, e as duas
 * passavam verdes discordando. Os literais marcados aqui como medição são os **mesmos** literais
 * fixados lá, palavra por palavra: quem mudar um muda os dois, e uma das duas suítes cai.
 */
class PainelDeConfiguracaoWifiTest {
    // --- 1. o alvo, em quatro respostas ----------------------------------------------------------

    /**
     * Quatro motivos, e não dois, porque eles mandam a pessoa a lugares diferentes.
     *
     * O quarto caso é um só nas duas plataformas, e nomeia os **dois** gestos que resolvem: aqui se
     * mede "em uso", do outro lado se mede alcançabilidade, e nenhuma das duas mede o eixo da outra.
     * Inventar o que falta seria medir o silêncio.
     *
     * E nenhuma das quatro nomeia a unidade: `displayName` é onde marca e modelo moram, e
     * interpolá-lo aqui punha o nome do fabricante numa frase de tela por construção.
     */
    @Test
    fun `o alvo diz por onde sai ou qual gesto resolve`() {
        val candidata =
            PrinterWifiSetupContract.target(
                hasEphemeralCandidate = true,
                canSend = true,
                hasAdoptedPrinter = false,
            )
        val instalada =
            PrinterWifiSetupContract.target(
                hasEphemeralCandidate = false,
                canSend = true,
                hasAdoptedPrinter = true,
            )
        val nenhuma =
            PrinterWifiSetupContract.target(
                hasEphemeralCandidate = false,
                canSend = false,
                hasAdoptedPrinter = false,
            )
        val indisponivel =
            PrinterWifiSetupContract.target(
                hasEphemeralCandidate = false,
                canSend = false,
                hasAdoptedPrinter = true,
            )

        assertEquals(PrinterWifiSetupTarget.EPHEMERAL_CANDIDATE, candidata)
        assertEquals(PrinterWifiSetupTarget.ADOPTED_PRINTER, instalada)
        assertEquals(PrinterWifiSetupTarget.NO_PRINTER, nenhuma)
        assertEquals(PrinterWifiSetupTarget.ADOPTED_UNAVAILABLE, indisponivel)

        assertTrue(candidata.allowsSending)
        assertTrue(instalada.allowsSending)
        assertFalse(nenhuma.allowsSending)
        assertFalse(indisponivel.allowsSending)

        assertEquals(
            "Uma candidata está retida somente em memória: a tira e a configuração saem por ela.",
            PrinterWifiSetupContract.targetNotice(candidata),
        )
        assertEquals(
            "Sem candidata em memória: a tira e a configuração saem pela impressora instalada e pronta.",
            PrinterWifiSetupContract.targetNotice(instalada),
        )
        assertEquals(
            "Nenhuma candidata em memória e nenhuma impressora instalada. Procure a impressora no " +
                "scan de rede local ou em Configuração antes de configurar a rede dela.",
            PrinterWifiSetupContract.targetNotice(nenhuma),
        )
        assertEquals(
            "Há impressora instalada, e nenhuma delas recebe envio agora. Ligue a impressora e " +
                "deixe ela perto do celular, na mesma Wi-Fi, e marque ela como a impressora em uso.",
            PrinterWifiSetupContract.targetNotice(indisponivel),
        )

        val frases =
            listOf(candidata, instalada, nenhuma, indisponivel)
                .map { PrinterWifiSetupContract.targetNotice(it) }
        assertEquals(4, frases.toSet().size)
    }

    /** A candidata retida vence a instalada, porque é isso que `openHomologationTarget` faz. */
    @Test
    fun `a candidata retida tem precedencia sobre a impressora em uso`() {
        assertEquals(
            PrinterWifiSetupTarget.EPHEMERAL_CANDIDATE,
            PrinterWifiSetupContract.target(
                hasEphemeralCandidate = true,
                canSend = true,
                hasAdoptedPrinter = true,
            ),
        )
        assertEquals(
            PrinterWifiSetupTarget.EPHEMERAL_CANDIDATE,
            PrinterWifiSetupContract.target(
                hasEphemeralCandidate = true,
                canSend = false,
                hasAdoptedPrinter = false,
            ),
        )
    }

    /**
     * O sinal de candidata retida deste sistema continua sendo o estado publicado pelo kit.
     *
     * A retenção expira por tempo sem o estado mudar, e por isso o pior caso desta leitura é a frase
     * nomear a candidata quando o quadro já sairia pela instalada — nunca autorizar um envio que não
     * tem alvo, porque aí o despacho recusa.
     */
    @Test
    fun `o estado de confirmacao pendente e o sinal de candidata retida`() {
        val retida: ThermalPrinterState = ThermalPrinterState.SearchConfirmationRequired
        assertTrue(retida is ThermalPrinterState.SearchConfirmationRequired)
        assertFalse(ThermalPrinterState.Ready is ThermalPrinterState.SearchConfirmationRequired)
    }

    /**
     * Frase de contexto não é frase de desfecho.
     *
     * Quem toca em gravar e cai sem alvo lia, como resposta ao gesto, a linha que já estava
     * desenhada no topo — e num dos quatro casos ela é afirmativa: "a rede será gravada", dita como
     * resposta a um gesto em que nada foi gravado.
     */
    @Test
    fun `a recusa no gesto tem frase propria`() {
        assertEquals(
            "Nenhuma impressora alcançável agora: nem candidata em memória, nem instalada e pronta.",
            PrinterWifiSetupContract.NO_TARGET_AT_GESTURE,
        )
        PrinterWifiSetupTarget.entries.forEach { alvo ->
            assertNotEquals(
                alvo.name,
                PrinterWifiSetupContract.NO_TARGET_AT_GESTURE,
                PrinterWifiSetupContract.targetNotice(alvo),
            )
        }
    }

    // --- 2. os quatro passos, que são de sessão ---------------------------------------------------

    /** A sessão começa no alvo, sem família e sem inferir nenhuma: não há catálogo por modelo. */
    @Test
    fun `a sessao comeca no alvo e nao infere familia nenhuma`() {
        val inicial: PrinterWifiSetupStage = PrinterWifiSetupStage.Target

        assertEquals(PrinterWifiSetupStage.Target, inicial)
        assertNull((inicial as? PrinterWifiSetupStage.Form)?.protocol)
    }

    /**
     * O passo é estado de sessão, e **não** uma função do alvo.
     *
     * Era aqui que este lado divergia, e a consequência é pior que "descarta o formulário digitado":
     * a queda pós-escrita é o caminho **normal** desta tela — a tira e o quadro derrubam a conexão
     * que os entregou —, e derrubar o passo junto apagava a pergunta das quatro leituras e o
     * formulário exatamente depois de os bytes saírem. Perder o alvo fecha o botão; não desfaz o que
     * a pessoa já respondeu.
     */
    @Test
    fun `perder o alvo nao desfaz o passo em que a pessoa esta`() {
        val passo = PrinterWifiSetupContract.stage(ThermalWifiProbeReading.BLOCK_BETWEEN_MARKERS)
        assertEquals(PrinterWifiSetupStage.Form(ThermalWifiProtocol.US_W), passo)

        // O alvo entra só na permissão do gesto, e em lugar nenhum do passo.
        assertFalse(
            PrinterWifiSetupContract.allowsPreparing(
                PrinterWifiSetupTarget.ADOPTED_UNAVAILABLE,
                isSending = false,
                validation = ThermalWifiValidation.Accepted(15),
            ),
        )
        assertTrue(
            PrinterWifiSetupContract.allowsPreparing(
                PrinterWifiSetupTarget.ADOPTED_PRINTER,
                isSending = false,
                validation = ThermalWifiValidation.Accepted(15),
            ),
        )
    }

    /**
     * Só o bloco entre os marcadores abre formulário; as outras três leituras não abrem nenhum.
     *
     * A letra solta **nega** a família e a tira em branco não diz nada — mas nenhuma das duas é
     * permissão para montar quadro, e é por isso que as três caem no mesmo passo.
     *
     * **É aqui que a tela consulta se há escolha à mão a oferecer**, e por isso a regra é afirmada
     * aqui e não numa função à parte: `offersSelfTestFamily` era chamada só por esta suíte, e regra
     * que a tela decide noutro lugar prova a si mesma.
     */
    @Test
    fun `so o bloco entre os marcadores abre formulario`() {
        assertEquals(
            PrinterWifiSetupStage.Form(ThermalWifiProtocol.US_W),
            PrinterWifiSetupContract.stage(ThermalWifiProbeReading.BLOCK_BETWEEN_MARKERS),
        )
        assertEquals(
            PrinterWifiSetupStage.Choice(ThermalWifiProbeResult.UsWFamilyAbsent),
            PrinterWifiSetupContract.stage(ThermalWifiProbeReading.LETTER_BETWEEN_MARKERS),
        )
        assertEquals(
            PrinterWifiSetupStage.Choice(
                ThermalWifiProbeResult.Indeterminate(ThermalWifiProbeIndeterminacy.SUBCOMMAND_SWALLOWED),
            ),
            PrinterWifiSetupContract.stage(ThermalWifiProbeReading.MARKERS_ONLY),
        )
        assertEquals(
            PrinterWifiSetupStage.Choice(
                ThermalWifiProbeResult.Indeterminate(ThermalWifiProbeIndeterminacy.PROBE_DID_NOT_PRINT),
            ),
            PrinterWifiSetupContract.stage(ThermalWifiProbeReading.NOTHING_PRINTED),
        )

        val escolhas =
            ThermalWifiProbeReading.entries.count {
                PrinterWifiSetupContract.stage(it) is PrinterWifiSetupStage.Choice
            }
        assertEquals(ThermalWifiProbeReading.entries.size - 1, escolhas)
    }

    /**
     * Nenhuma leitura de papel abre o formulário da família que a pessoa escolhe à mão.
     *
     * É o contrato de `ThermalWifiProbeResult`: a sonda só fala de uma família, e "confirmar" a
     * outra exigiria escrever o quadro dela ou travar o parser à espera do terminador. Instrumento
     * que precisa quebrar a impressora para medir não é sonda. **O papel manda**: com a família
     * confirmada não há escolha a oferecer, e uma escolha ali só serviria para contrariar a medição.
     */
    @Test
    fun `a tira nunca abre o formulario da familia escolhida a mao`() {
        ThermalWifiProbeReading.entries.forEach { leitura ->
            assertNotEquals(
                leitura.name,
                PrinterWifiSetupStage.Form(PrinterWifiSetupContract.manuallyChosenProtocol)
                    as PrinterWifiSetupStage,
                PrinterWifiSetupContract.stage(leitura),
            )
        }
        assertNull(ThermalWifiProbeResult.UsWFamilyAbsent.confirmedProtocol)
        assertNotEquals(
            PrinterWifiSetupContract.manuallyChosenProtocol,
            ThermalWifiProbeResult.UsWFamilyHonored.confirmedProtocol,
        )
    }

    // --- a resposta que sobrevive ao fechamento do app --------------------------------------------

    /**
     * A tela abre no formulário quando o perfil já diz a família, e no começo quando não diz.
     *
     * Sem isto a tira sai de novo em toda abertura, e a tira custa papel. `null` continua abrindo
     * no passo do alvo, que é como a tela sempre abriu — perfil gravado antes deste campo não pode
     * passar a afirmar nada.
     */
    @Test
    fun `a tela abre no formulario quando o perfil ja diz a familia`() {
        assertEquals(
            PrinterWifiSetupStage.Target as PrinterWifiSetupStage,
            PrinterWifiSetupContract.initialStage(null),
        )
        assertEquals(
            PrinterWifiSetupStage.Form(ThermalWifiProtocol.US_W) as PrinterWifiSetupStage,
            PrinterWifiSetupContract.initialStage(
                PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED,
            ),
        )
        assertEquals(
            PrinterWifiSetupStage.Form(ThermalWifiProtocol.US_ESC_US) as PrinterWifiSetupStage,
            PrinterWifiSetupContract.initialStage(
                PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US,
            ),
        )
        // A negativa é conclusão, não lacuna: ela abre na escolha, com a frase do desfecho e a
        // escolha à mão ao lado. Reoferecer a sonda cobraria papel por uma resposta que já existe.
        assertEquals(
            PrinterWifiSetupStage.Choice(ThermalWifiProbeResult.UsWFamilyAbsent)
                as PrinterWifiSetupStage,
            PrinterWifiSetupContract.initialStage(
                PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
            ),
        )
    }

    /**
     * O passo semeado é exatamente o passo a que a mesma resposta levaria na sessão.
     *
     * Se as duas contas divergissem, a tela mostraria uma coisa depois de responder e outra ao
     * reabrir — com a mesma medição por trás.
     */
    @Test
    fun `o passo semeado e o mesmo a que a leitura levaria`() {
        ThermalWifiProbeReading.entries.forEach { leitura ->
            val gravavel = PrinterWifiSetupContract.recordableFamily(leitura) ?: return@forEach
            assertEquals(
                "$leitura reabre num passo diferente do que ela abriu",
                PrinterWifiSetupContract.stage(leitura),
                PrinterWifiSetupContract.initialStage(gravavel),
            )
        }
    }

    /**
     * Só as leituras conclusivas são gravadas; os dois indeterminados não gravam nada.
     *
     * "Não saiu nada" e "os marcadores saíram sem o bloco" não são resposta sobre a impressora, e
     * gravá-los seria gravar a ausência de medição — a tela avança do mesmo jeito, ela só não
     * escreve.
     */
    @Test
    fun `so a leitura conclusiva desce ao perfil`() {
        assertEquals(
            PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED,
            PrinterWifiSetupContract.recordableFamily(
                ThermalWifiProbeReading.BLOCK_BETWEEN_MARKERS,
            ),
        )
        assertEquals(
            PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
            PrinterWifiSetupContract.recordableFamily(
                ThermalWifiProbeReading.LETTER_BETWEEN_MARKERS,
            ),
        )
        assertNull(
            PrinterWifiSetupContract.recordableFamily(ThermalWifiProbeReading.MARKERS_ONLY),
        )
        assertNull(
            PrinterWifiSetupContract.recordableFamily(ThermalWifiProbeReading.NOTHING_PRINTED),
        )
    }

    /**
     * A escolha à mão é gravada como escolha, e descreve a mesma família que a tela abre.
     *
     * Duas constantes descrevendo famílias diferentes fariam a tela abrir um formulário e o perfil
     * guardar o outro — e a divergência só apareceria no papel de quem reabrisse a tela.
     */
    @Test
    fun `a escolha a mao e gravada como escolha e da mesma familia do formulario`() {
        assertEquals(
            PrinterWifiSetupContract.manuallyChosenProtocol,
            PrinterWifiSetupContract.manuallyChosenFamily.configuredProtocol,
        )
        assertFalse(PrinterWifiSetupContract.manuallyChosenFamily.wasMeasured)
    }

    /**
     * A frase da dúvida é a do kit, inteira; só a da negativa é da tela — e ela **existe**.
     *
     * A letra solta é o único desfecho que **nega** a família, e era o único que este lado deixava
     * sem explicação: a tela desenhava só `indeterminacy`, que é nulo ali, e a pessoa respondia a
     * pergunta e não lia nada — a tela sugerindo que a resposta não valeu.
     */
    @Test
    fun `a frase da duvida e a do kit e a da negativa e da tela`() {
        assertEquals(
            ThermalWifiProbeIndeterminacy.SUBCOMMAND_SWALLOWED.message,
            PrinterWifiSetupContract.unconfirmedNotice(
                ThermalWifiProbeResult.Indeterminate(ThermalWifiProbeIndeterminacy.SUBCOMMAND_SWALLOWED),
            ),
        )
        assertEquals(
            ThermalWifiProbeIndeterminacy.PROBE_DID_NOT_PRINT.message,
            PrinterWifiSetupContract.unconfirmedNotice(
                ThermalWifiProbeResult.Indeterminate(ThermalWifiProbeIndeterminacy.PROBE_DID_NOT_PRINT),
            ),
        )
        assertEquals(
            "A impressora imprimiu o comando como texto em vez de obedecer: ela não aceita " +
                "configuração deste jeito.",
            PrinterWifiSetupContract.unconfirmedNotice(ThermalWifiProbeResult.UsWFamilyAbsent),
        )
        // A negativa não é dúvida, e por isso o kit não publica frase para ela: se a tela dependesse
        // de `indeterminacy` ali, o desfecho mais conclusivo ficaria mudo.
        assertNull(ThermalWifiProbeResult.UsWFamilyAbsent.indeterminacy)
        // Confirmado não tem o que explicar: o passo seguinte é o formulário.
        assertNull(PrinterWifiSetupContract.unconfirmedNotice(ThermalWifiProbeResult.UsWFamilyHonored))
    }

    // --- 3. o transporte não decide nada ---------------------------------------------------------

    /**
     * O comando derruba a conexão que o entregou. Uma falha logo depois da escrita é o caminho
     * normal — tratá-la como fracasso faria a tela pedir reenvio de um quadro que já gravou.
     */
    @Test
    fun `queda depois do inicio da escrita conta como chegada, igual a impressao concluida`() {
        val concluida = PrinterWifiSetupContract.dispatch(ThermalPrintResult.Printed)
        val caiuNoMeio =
            PrinterWifiSetupContract.dispatch(
                ThermalPrintResult.Failed(
                    message = "A conexão caiu.",
                    state = ThermalPrinterState.LocalWifiPrinterUnavailable,
                    delivery = ThermalPrintDelivery.INDETERMINATE,
                ),
            )

        assertEquals(PrinterWifiDispatch.REACHED_PRINTER, concluida)
        assertEquals(PrinterWifiDispatch.REACHED_PRINTER, caiuNoMeio)
        assertTrue(concluida.advancesToReading)
        assertTrue(caiuNoMeio.advancesToReading)
        // A mesma frase nos dois: o desfecho do transporte não é a leitura, e a tela não finge que é.
        assertEquals(
            PrinterWifiSetupContract.probeDispatchNotice(concluida),
            PrinterWifiSetupContract.probeDispatchNotice(caiuNoMeio),
        )
    }

    /**
     * Escrita que não começou não abre a pergunta da leitura.
     *
     * Se nada saiu do telefone não há papel sobre o que perguntar, e perguntar assim mesmo
     * convidaria a responder "não saiu nada" — que seria a leitura de uma tira que nunca foi mandada.
     */
    @Test
    fun `escrita que nao comecou nao abre a pergunta da leitura`() {
        val naoSaiu =
            PrinterWifiSetupContract.dispatch(
                ThermalPrintResult.Failed(
                    message = "Sem rota para a impressora.",
                    state = ThermalPrinterState.LocalWifiPrinterUnavailable,
                    delivery = ThermalPrintDelivery.NOT_SENT,
                ),
            )

        assertEquals(PrinterWifiDispatch.NOT_SENT, naoSaiu)
        assertFalse(naoSaiu.advancesToReading)
        assertFalse(PrinterWifiDispatch.NO_TARGET.advancesToReading)
        assertTrue(PrinterWifiDispatch.REACHED_PRINTER.advancesToReading)

        assertEquals(
            PrinterWifiSetupStage.Reading,
            PrinterWifiSetupContract.stageAfterProbe(PrinterWifiDispatch.REACHED_PRINTER),
        )
        assertNull(PrinterWifiSetupContract.stageAfterProbe(PrinterWifiDispatch.NOT_SENT))
        assertNull(PrinterWifiSetupContract.stageAfterProbe(PrinterWifiDispatch.NO_TARGET))
    }

    /** Falha que o kit não tipou é tratada como "pode ter chegado": o lado seguro é a olhada no papel. */
    @Test
    fun `falha inesperada conta como possivel chegada`() {
        assertEquals(
            PrinterWifiDispatch.REACHED_PRINTER,
            PrinterWifiSetupContract.dispatchOfUnexpectedFailure(),
        )
    }

    /**
     * Nenhum dos três desfechos da tira afirma o que saiu no papel.
     *
     * **"Os bytes começaram a sair" e não "a tira saiu".** O transporte prova que a escrita começou,
     * não que a tira imprimiu; afirmar a saída — que era o que este lado fazia, com a frase visível
     * ao mesmo tempo que a pergunta — enviesa contra a leitura "não saiu nada", que é exatamente a
     * que separa "engoliu o comando" de "não chegou byte".
     *
     * E a frase de "nada saiu" não promete resposta nenhuma: a tela inteira é construída sobre
     * `readsResponseBytes == false`, e não existe "chegar a responder".
     */
    @Test
    fun `os desfechos da tira nunca afirmam o papel`() {
        assertEquals(
            "Os bytes começaram a sair. Pela rede, a conexão cai logo depois, e isso é " +
                "esperado. Agora olhe o papel: só ele responde.",
            PrinterWifiSetupContract.probeDispatchNotice(PrinterWifiDispatch.REACHED_PRINTER),
        )
        assertEquals(
            "Nada saiu deste telefone. Confira a conexão e mande a tira de novo.",
            PrinterWifiSetupContract.probeDispatchNotice(PrinterWifiDispatch.NOT_SENT),
        )
        assertEquals(
            PrinterWifiSetupContract.NO_TARGET_AT_GESTURE,
            PrinterWifiSetupContract.probeDispatchNotice(PrinterWifiDispatch.NO_TARGET),
        )

        val chegou = PrinterWifiSetupContract.probeDispatchNotice(PrinterWifiDispatch.REACHED_PRINTER)
        assertFalse(chegou, chegou.contains("A tira saiu"))
        assertTrue(chegou, chegou.contains("é esperado"))

        PrinterWifiDispatch.entries.forEach { desfecho ->
            val frase = PrinterWifiSetupContract.probeDispatchNotice(desfecho)
            assertFalse(frase, frase.contains("responder"))
            assertFalse(frase, frase.contains("resposta da impressora"))
        }
    }

    /** Sem alvo a tela diz isso com frase própria, e não repetindo a linha do topo. */
    @Test
    fun `sem alvo o desfecho nao repete a frase de contexto`() {
        PrinterWifiSetupTarget.entries.forEach { alvo ->
            val contexto = PrinterWifiSetupContract.targetNotice(alvo)
            assertNotEquals(
                alvo.name,
                contexto,
                PrinterWifiSetupContract.probeDispatchNotice(PrinterWifiDispatch.NO_TARGET),
            )
            assertNotEquals(
                alvo.name,
                contexto,
                PrinterWifiSetupContract.sendOutcomeNotice(
                    PrinterWifiDispatch.NO_TARGET,
                    ThermalWifiProtocol.US_ESC_US,
                ),
            )
        }
    }

    // --- 4. os dois vocabulários de segurança, sem tradução por índice ---------------------------

    @Test
    fun `cada escolha de seguranca cai no ramo que o firmware espera`() {
        val senha = "chave-de-teste"

        assertEquals(ThermalWifiSecurity.Open, PrinterWifiSecurityChoice.OPEN.security(senha))
        assertEquals(
            ThermalWifiSecurity.WepOpen(senha),
            PrinterWifiSecurityChoice.WEP_OPEN.security(senha),
        )
        assertEquals(
            ThermalWifiSecurity.WepShared(senha),
            PrinterWifiSecurityChoice.WEP_SHARED.security(senha),
        )
        assertEquals(
            ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.NONE_TKIP, senha),
            PrinterWifiSecurityChoice.WPA_TKIP.security(senha),
        )
        assertEquals(
            ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.WEP_AES, senha),
            PrinterWifiSecurityChoice.WPA_AES.security(senha),
        )
        assertEquals(
            ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.NONE_TKIP, senha),
            PrinterWifiSecurityChoice.WPA2_TKIP.security(senha),
        )
        assertEquals(
            ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, senha),
            PrinterWifiSecurityChoice.WPA2_AES.security(senha),
        )

        // Sete ramos, sete pares distintos: não é o produto cartesiano de dois bytes.
        val pares =
            PrinterWifiSecurityChoice.entries
                .map { it.security(senha) }
                .map { "${it.auth}/${it.cipher}" }
                .toSet()
        assertEquals(7, pares.size)
    }

    @Test
    fun `rede aberta nao carrega chave nenhuma nesta familia`() {
        val aberta = PrinterWifiSecurityChoice.OPEN.security("chave-que-seria-descartada")

        assertEquals(ThermalWifiAuth.OPEN, aberta.auth)
        assertEquals(ThermalWifiCipher.NONE_TKIP, aberta.cipher)
        assertFalse(PrinterWifiSecurityChoice.OPEN.requiresPassword)
        PrinterWifiSecurityChoice.entries
            .filter { it != PrinterWifiSecurityChoice.OPEN }
            .forEach { assertTrue(it.name, it.requiresPassword) }
        // O tipo do kit não tem onde guardar a senha neste ramo, e é isso que impede o segredo de ir
        // ao fio sem efeito: aqui só se prova que a tela não inventou um lugar para ela.
        assertEquals(ThermalWifiSecurity.Open, aberta)
    }

    /**
     * Sete ramos contra dez posições, com fronteiras diferentes. Traduzir um no outro por índice é a
     * classe de erro que já inverteu o byte de modo e tirou uma unidade da rede.
     */
    @Test
    fun `os dois vocabularios de seguranca nao se alinham por indice`() {
        assertEquals(7, PrinterWifiSecurityChoice.entries.size)
        assertEquals(10, ThermalWifiKeyType.entries.size)

        val porFamiliaComCupom = PrinterWifiSecurityChoice.entries.map { it.label }
        val porFamiliaSemCupom =
            ThermalWifiKeyType.entries.map { PrinterWifiSetupContract.label(it) }

        assertEquals(porFamiliaComCupom.size, porFamiliaComCupom.toSet().size)
        assertEquals(porFamiliaSemCupom.size, porFamiliaSemCupom.toSet().size)

        // E o índice troca a cifra de lugar: quem traduzisse por posição pediria TKIP e mandaria
        // AES. É a mesma classe de erro que inverteu o byte de modo e tirou uma unidade da rede.
        val tkip = porFamiliaComCupom.indexOf("WPA (TKIP)")
        val aes = porFamiliaComCupom.indexOf("WPA (AES)")
        assertEquals("WPA (AES)", porFamiliaSemCupom[tkip])
        assertEquals("WPA (TKIP)", porFamiliaSemCupom[aes])
        // E há posições que simplesmente não existem do outro lado.
        assertTrue(porFamiliaSemCupom.contains("WPA e WPA2 juntos"))
        assertFalse(porFamiliaComCupom.contains("WPA e WPA2 juntos"))
        assertFalse(porFamiliaSemCupom.contains(PrinterWifiSecurityChoice.WEP_SHARED.label))
    }

    @Test
    fun `so a rede aberta dispensa senha nas dez posicoes da outra familia`() {
        val semSenha = ThermalWifiKeyType.entries.filterNot { it.requiresPassword }

        assertEquals(listOf(ThermalWifiKeyType.OPEN), semSenha)
    }

    /**
     * O modo é oferecido com a rota de volta garantida na frente.
     *
     * Oferecer o modo cliente primeiro — que era o que este lado fazia — é oferecer primeiro o modo
     * que derruba o ponto de acesso pelo qual a pessoa pode estar conectada.
     */
    @Test
    fun `o modo e oferecido com o ponto de acesso na frente`() {
        assertEquals(
            listOf(ThermalWifiMode.ACCESS_POINT, ThermalWifiMode.STATION),
            ThermalWifiMode.entries.toList(),
        )
    }

    // --- 5. o formulário, com a régua do kit -----------------------------------------------------

    /**
     * Botão fechado sempre tem frase junto.
     *
     * Botão cinza sem uma linha dizendo o que acontece é o defeito que travou a lista de impressoras
     * deste kit em 21/08. Os seletores nascem vazios de propósito, então a tela diz qual falta — na
     * ordem do formulário, com o modo primeiro porque ele muda o sentido do campo de nome.
     */
    @Test
    fun `enquanto falta escolha a tela diz qual`() {
        assertEquals(
            "Escolha como a impressora vai ficar na rede.",
            PrinterWifiSetupContract.pendingChoiceNotice(
                ThermalWifiProtocol.US_W,
                securityChosen = false,
                modeChosen = false,
            ),
        )
        assertEquals(
            "Escolha a segurança da rede.",
            PrinterWifiSetupContract.pendingChoiceNotice(
                ThermalWifiProtocol.US_W,
                securityChosen = false,
                modeChosen = true,
            ),
        )
        assertNull(
            PrinterWifiSetupContract.pendingChoiceNotice(
                ThermalWifiProtocol.US_W,
                securityChosen = true,
                modeChosen = true,
            ),
        )

        // A segunda família não tem modo: cobrar um seria pedir escolha que não vira byte nenhum.
        assertEquals(
            "Escolha a segurança da rede.",
            PrinterWifiSetupContract.pendingChoiceNotice(
                ThermalWifiProtocol.US_ESC_US,
                securityChosen = false,
                modeChosen = false,
            ),
        )
        assertNull(
            PrinterWifiSetupContract.pendingChoiceNotice(
                ThermalWifiProtocol.US_ESC_US,
                securityChosen = true,
                modeChosen = false,
            ),
        )
    }

    /** Sem escolha feita não há quadro a confirmar, e envio no ar não abre o segundo envio. */
    @Test
    fun `sem escolha feita o gesto fica fechado`() {
        val alvo = PrinterWifiSetupTarget.ADOPTED_PRINTER

        assertFalse(PrinterWifiSetupContract.allowsPreparing(alvo, isSending = false, validation = null))
        assertTrue(
            PrinterWifiSetupContract.allowsPreparing(
                alvo,
                isSending = false,
                validation = ThermalWifiValidation.Accepted(15),
            ),
        )
        assertFalse(
            PrinterWifiSetupContract.allowsPreparing(
                alvo,
                isSending = false,
                validation = ThermalWifiValidation.Rejected(br.com.thermalprinterkit.ThermalWifiRejection.SsidEmpty),
            ),
        )
        assertFalse(
            PrinterWifiSetupContract.allowsPreparing(
                alvo,
                isSending = true,
                validation = ThermalWifiValidation.Accepted(15),
            ),
        )
        listOf(PrinterWifiSetupTarget.NO_PRINTER, PrinterWifiSetupTarget.ADOPTED_UNAVAILABLE)
            .forEach {
                assertFalse(
                    it.name,
                    PrinterWifiSetupContract.allowsPreparing(
                        it,
                        isSending = false,
                        validation = ThermalWifiValidation.Accepted(15),
                    ),
                )
            }
    }

    /** As faixas saíram do firmware, não da tela: a frase de recusa é a do kit, palavra por palavra. */
    @Test
    fun `a recusa de campo vem pronta da camada de quadro`() {
        assertEquals(
            "Informe o nome da rede.",
            ThermalWifiFrame.validate("", PrinterWifiSecurityChoice.OPEN.security("")).rejection?.message,
        )
        assertEquals(
            "O nome da rede aceita no máximo 32 caracteres.",
            ThermalWifiFrame
                .validate("A".repeat(33), PrinterWifiSecurityChoice.OPEN.security(""))
                .rejection
                ?.message,
        )
        assertEquals(
            "O nome da rede aceita apenas letras e números sem acento.",
            ThermalWifiFrame
                .validate("REDE-CAFÉ", PrinterWifiSecurityChoice.OPEN.security(""))
                .rejection
                ?.message,
        )
        assertEquals(
            "A senha da rede precisa de 8 a 63 caracteres.",
            ThermalWifiFrame
                .validate("REDE-CASA", PrinterWifiSecurityChoice.WPA2_AES.security("curta"))
                .rejection
                ?.message,
        )
        // Na outra família a rede aberta recusa senha, porque lá o quadro emite o campo de qualquer
        // jeito. Na primeira ela nem tem onde guardá-la. São dois formulários, não um com um `if`.
        assertEquals(
            "Rede aberta não leva senha.",
            ThermalWifiFrame
                .validate(ThermalWifiKeyType.OPEN, "REDE-CASA", "12345678")
                .rejection
                ?.message,
        )
    }

    /**
     * Rede aberta na família com cupom: a senha digitada antes não entra no quadro, e não vira
     * recusa. O campo some da tela; aqui se prova que a régua concorda.
     */
    @Test
    fun `rede aberta com cupom aceita e nao carrega a senha digitada antes`() {
        val checagem =
            ThermalWifiFrame.validate(
                "REDE-CASA",
                PrinterWifiSecurityChoice.OPEN.security("senha-que-ficou-no-campo"),
            )

        assertEquals(16, checagem.byteCount)
        assertEquals(
            ThermalWifiFrame
                .usW("REDE-CASA", ThermalWifiSecurity.Open, ThermalWifiMode.ACCESS_POINT)
                ?.size,
            checagem.byteCount,
        )
    }

    /** Sem endereço nesta versão: o formulário sem cupom tem três campos, e nenhum deles é IP. */
    @Test
    fun `a familia sem cupom entra so pelo quadro que grava rede`() {
        val checagem =
            ThermalWifiFrame.validate(ThermalWifiKeyType.WPA2_AES_PSK, "REDE-CASA", "12345678")
        val soRede =
            ThermalWifiFrame.usEscUsWifiOnly(ThermalWifiKeyType.WPA2_AES_PSK, "REDE-CASA", "12345678")
        val comEndereco =
            ThermalWifiFrame.usEscUsAll(
                ip = listOf(192, 168, 0, 50),
                netmask = listOf(255, 255, 255, 0),
                gateway = listOf(192, 168, 0, 1),
                keyType = ThermalWifiKeyType.WPA2_AES_PSK,
                ssid = "REDE-CASA",
                password = "12345678",
            )

        assertEquals(soRede?.size, checagem.byteCount)
        // Os doze octetos do quadro completo são exatamente o que esta tela não oferece.
        assertEquals(soRede!!.size + 12, comEndereco!!.size)
    }

    // --- 6. a contagem anunciada ------------------------------------------------------------------

    /**
     * O número anunciado é o que sai **no fio**, e não o do quadro.
     *
     * A contagem anunciada é uma medição, e um número que não descreve o que sai é uma medição
     * errada. Neste sistema os quatro caminhos de escrita do transporte prefixam o inicializador
     * ESC/POS antes do payload — e o caminho desta tela passa por eles, porque
     * `openHomologationTarget() → openSession() → send()` desemboca em `run*ReceiptBytes`. O portão
     * anunciava o tamanho do quadro e o fio levava dois bytes a mais, com esta suíte fixando a
     * contagem contra o quadro em vez de contra o fio: verde e errada.
     *
     * **Do outro lado o prefixo é zero**, porque lá o transporte entrega os bytes sem tocá-los, e a
     * suíte de lá fixa o número de lá contra o fio de lá. As duas telas anunciam o que cada uma
     * manda; o que nenhuma faz é anunciar um número que não descreve nenhum dos dois. Tirar o
     * prefixo daqui mudaria toda impressão deste sistema, cupom de venda homologado inclusive, e
     * isso não se faz sem impressora na bancada.
     */
    @Test
    fun `o tamanho anunciado e o tamanho do que sai no fio`() {
        val prefixo = EscPosThermalCommands.initialize().size
        assertEquals(prefixo, PrinterWifiSetupContract.hostSendPrefixByteCount)
        assertEquals(2, prefixo)

        val comCupom =
            ThermalWifiFrame.validate(
                "REDE-CASA",
                PrinterWifiSecurityChoice.WPA2_AES.security("12345678"),
            )
        val quadroComCupom =
            ThermalWifiFrame.usW(
                "REDE-CASA",
                ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "12345678"),
                ThermalWifiMode.STATION,
            )

        assertEquals(24, comCupom.byteCount)
        assertEquals(quadroComCupom?.size, comCupom.byteCount)
        assertEquals(24 + prefixo, PrinterWifiSetupContract.announcedByteCount(24))

        val semCupom =
            ThermalWifiFrame.validate(ThermalWifiKeyType.WPA2_AES_PSK, "REDE-CASA", "12345678")
        assertEquals(24, semCupom.byteCount)

        assertEquals(
            "Confirmar ${24 + prefixo} bytes",
            PrinterWifiSetupContract.confirmationTitle(24),
        )
        assertEquals(
            "A configuração sai em ${15 + prefixo} bytes, num envio só.",
            PrinterWifiSetupContract.byteCountNotice(15),
        )
    }

    /**
     * A tira também é prefixada neste sistema, e o payload dela não traz o inicializador.
     *
     * Quem prefixa é a porta, e não a sonda: o payload é o mesmo dos dois lados, e o que difere é a
     * camada de baixo.
     */
    @Test
    fun `a tira nao carrega o inicializador dentro do payload`() {
        val tira = ThermalWifiProbe.usWFamilyStrip
        val prefixo = EscPosThermalCommands.initialize()

        assertFalse(tira.take(prefixo.size).toByteArray().contentEquals(prefixo))
        assertEquals(
            tira.size + PrinterWifiSetupContract.hostSendPrefixByteCount,
            PrinterWifiSetupContract.announcedByteCount(tira.size),
        )
    }

    // --- 7. o segredo ----------------------------------------------------------------------------

    @Test
    fun `o quadro pendente nao publica a senha na descricao`() {
        val quadro =
            PrinterWifiPendingFrame(
                requireNotNull(
                    ThermalWifiFrame.usW(
                        "REDE-CASA",
                        ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "senha-secreta"),
                        ThermalWifiMode.STATION,
                    ),
                ),
                warning = "aviso",
            )

        assertFalse(quadro.toString().contains("senha-secreta"))
        assertTrue(quadro.toString().contains("[REDACTED]"))
        assertEquals(29, quadro.byteCount)
    }

    @Test
    fun `o buffer do quadro e zerado depois do envio`() =
        kotlinx.coroutines.test.runTest {
            val bytes =
                requireNotNull(
                    ThermalWifiFrame.usW(
                        "REDE-CASA",
                        ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "senha-secreta"),
                        ThermalWifiMode.STATION,
                    ),
                )
            val quadro = PrinterWifiPendingFrame(bytes, warning = "aviso")

            var recebeu = 0
            quadro.sendWith { entregue -> recebeu = entregue.size }

            assertEquals(bytes.size, recebeu)
            assertTrue(bytes.all { it == 0.toByte() })
        }

    @Test
    fun `cancelar tambem zera o buffer`() {
        val bytes =
            requireNotNull(
                ThermalWifiFrame.usW(
                    "REDE-CASA",
                    ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "senha-secreta"),
                    ThermalWifiMode.STATION,
                ),
            )

        PrinterWifiPendingFrame(bytes, warning = "aviso").clear()

        assertTrue(bytes.all { it == 0.toByte() })
    }

    /**
     * A defesa do kit continua de pé do lado da tela: o `toString` da segurança é redigido na classe
     * base, e a tela não constrói nenhum agregado que o contorne.
     */
    @Test
    fun `a seguranca montada pela tela continua redigida`() {
        PrinterWifiSecurityChoice.entries.forEach { escolha ->
            val descricao = escolha.security("senha-secreta").toString()

            assertFalse(escolha.name, descricao.contains("senha-secreta"))
            assertTrue(escolha.name, descricao.contains("[REDACTED]"))
        }
    }

    /** A pessoa é avisada do destino da senha **antes** de digitá-la. */
    @Test
    fun `a tela diz o que acontece com a senha antes de ela ser digitada`() {
        assertEquals(
            "A senha fica somente nesta tela enquanto ela está aberta: não é salva, nem " +
                "registrada, nem mostrada depois.",
            PrinterWifiSetupContract.PASSWORD_NOTICE,
        )
    }

    // --- 8. as frases da tela --------------------------------------------------------------------

    /**
     * O comprovante é o papel, e a janela de correção é da família que imprime cupom.
     *
     * A promessa "dá para reenviar corrigido" foi medida numa família só. Repeti-la na outra
     * transformaria falta de medição em medição — era o outro lado que a prometia nas duas.
     */
    @Test
    fun `so a familia com cupom promete a janela de correcao`() {
        val comCupom =
            PrinterWifiSetupContract.confirmationWarning(
                ThermalWifiProtocol.US_W,
                ThermalWifiMode.STATION,
            )
        val semCupom =
            PrinterWifiSetupContract.confirmationWarning(ThermalWifiProtocol.US_ESC_US, mode = null)

        assertTrue(comCupom, comCupom.contains("a conexão vai cair no meio"))
        assertTrue(comCupom, comCupom.contains("cupom"))
        assertTrue(comCupom, comCupom.contains("dá para reenviar corrigido"))
        assertTrue(comCupom, comCupom.contains("desligar e ligar"))
        assertTrue(comCupom, comCupom.contains("boot"))

        assertFalse(semCupom, semCupom.contains("reenviar corrigido"))
        assertFalse(semCupom, semCupom.contains("próximo boot"))
        assertTrue(semCupom, semCupom.contains("só apita"))
        assertTrue(semCupom, semCupom.contains("três cliques no avanço de papel"))
        assertTrue(semCupom, semCupom.contains("a impressora sai da rede"))
    }

    /**
     * O aviso de perder a rede do próprio ponto de acesso sai nas **duas** famílias.
     *
     * Na primeira quem o carrega é o aviso por modo, que acerta os dois sentidos; na segunda não há
     * byte de modo, e ali "entrar na rede nova" é verdade sem ressalva. O aviso único deste lado
     * errava num ramo: anexado ao modo ponto de acesso, ele dizia que a rede desaparece quando a
     * impressora entrar na rede nova — e nesse modo ela não entra em rede nenhuma, ela cria a
     * própria.
     */
    @Test
    fun `o aviso de perder o ponto de acesso sai nas duas familias`() {
        ThermalWifiMode.entries.forEach { modo ->
            val aviso = PrinterWifiSetupContract.confirmationWarning(ThermalWifiProtocol.US_W, modo)
            assertTrue(aviso, aviso.contains(PrinterWifiSetupContract.modeWarning(modo)))
        }
        assertTrue(
            PrinterWifiSetupContract
                .confirmationWarning(ThermalWifiProtocol.US_ESC_US, mode = null)
                .contains(PrinterWifiSetupContract.ACCESS_POINT_HANDOFF_NOTICE),
        )
        // O texto genérico seria falso no modo em que a impressora **cria** a rede em vez de entrar
        // numa: ele não pode aparecer no ramo do ponto de acesso.
        assertFalse(
            PrinterWifiSetupContract
                .confirmationWarning(ThermalWifiProtocol.US_W, ThermalWifiMode.ACCESS_POINT)
                .contains(PrinterWifiSetupContract.ACCESS_POINT_HANDOFF_NOTICE),
        )
        // A segunda família não tem modo; o aviso de modo não pode aparecer ali.
        val outra =
            PrinterWifiSetupContract.confirmationWarning(ThermalWifiProtocol.US_ESC_US, mode = null)
        ThermalWifiMode.entries.forEach {
            assertFalse(outra, outra.contains(PrinterWifiSetupContract.modeWarning(it)))
        }
    }

    /** O aviso do modo sai antes de gravar, e é diferente nos dois modos. */
    @Test
    fun `o aviso de perder a rede sai antes e muda com o modo`() {
        val cliente = PrinterWifiSetupContract.modeWarning(ThermalWifiMode.STATION)
        val ponto = PrinterWifiSetupContract.modeWarning(ThermalWifiMode.ACCESS_POINT)

        assertNotEquals(cliente, ponto)
        assertTrue(cliente, cliente.contains("perde essa rede"))
        assertTrue(ponto, ponto.contains("rede própria"))
        assertNotEquals(
            PrinterWifiSetupContract.label(ThermalWifiMode.STATION),
            PrinterWifiSetupContract.label(ThermalWifiMode.ACCESS_POINT),
        )
    }

    /**
     * O rótulo do portão é o mesmo do painel de comando cru, nas duas plataformas.
     *
     * É o vocabulário já estabelecido para "vou mandar bytes que gravam configuração não volátil" —
     * e o painel de comando cru **deste módulo** já o usava, então o painel novo divergia até do
     * vizinho de tela.
     */
    @Test
    fun `o portao usa o vocabulario do comando cru`() {
        assertEquals("Conheço o efeito e a reversão", PrinterWifiSetupContract.CONFIRM_BUTTON_TITLE)
    }

    /**
     * Nem o sucesso nem a queda afirmam o que saiu no papel, e só "não começou a escrever" autoriza
     * mandar de novo sem olhar o papel.
     */
    @Test
    fun `depois de gravar, cada familia manda conferir onde o comprovante existe`() {
        val chegouComCupom =
            PrinterWifiSetupContract.sendOutcomeNotice(
                PrinterWifiDispatch.REACHED_PRINTER,
                ThermalWifiProtocol.US_W,
            )
        val chegouSemCupom =
            PrinterWifiSetupContract.sendOutcomeNotice(
                PrinterWifiDispatch.REACHED_PRINTER,
                ThermalWifiProtocol.US_ESC_US,
            )

        assertTrue(chegouComCupom, chegouComCupom.contains("Os bytes começaram a sair."))
        assertTrue(chegouComCupom, chegouComCupom.contains("O comprovante é o papel"))
        // Medido na bancada em 23/08: gravar não derruba a impressora da rede antiga — a rede nova
        // só passa a valer no boot seguinte. Sem esta frase a pessoa fica esperando um efeito que
        // não vem, e conclui que o envio falhou.
        assertTrue(chegouComCupom, chegouComCupom.contains("desligue e ligue"))
        assertTrue(chegouComCupom, chegouComCupom.contains("cupom"))
        assertFalse(chegouComCupom, chegouComCupom.contains("A rede foi gravada"))

        assertTrue(chegouSemCupom, chegouSemCupom.contains("autoteste"))
        assertFalse(chegouSemCupom, chegouSemCupom.contains("mandar de novo corrigido"))

        assertEquals(
            "Nada saiu deste telefone: a rede da impressora não foi alterada. Confira a conexão e " +
                "mande de novo.",
            PrinterWifiSetupContract.sendOutcomeNotice(
                PrinterWifiDispatch.NOT_SENT,
                ThermalWifiProtocol.US_W,
            ),
        )
        assertEquals(
            PrinterWifiSetupContract.NO_TARGET_AT_GESTURE,
            PrinterWifiSetupContract.sendOutcomeNotice(
                PrinterWifiDispatch.NO_TARGET,
                ThermalWifiProtocol.US_W,
            ),
        )
    }

    /**
     * O papel da tira é contado da própria sonda, e os marcadores são interpolados dela.
     *
     * Escrito à mão, o número divergiu entre plataformas e ficou parado enquanto as sondas mudavam;
     * o marcador copiado como literal descreveria uma tira que a sonda talvez não emita mais. O
     * custo lê o pior caso, que é o que se anuncia antes de gastar — os dois lados liam constantes
     * diferentes para a mesma pergunta.
     */
    @Test
    fun `o custo em papel e os marcadores saem da sonda, e nao de literal na tela`() {
        assertEquals(ThermalWifiProbePaperCost.minimumStrips, ThermalWifiProbePaperCost.maximumStrips)
        assertEquals("Sai uma tira curta de papel.", PrinterWifiSetupContract.probePaperCostNotice)

        val explicacao = PrinterWifiSetupContract.probeExplanation
        assertTrue(explicacao, explicacao.contains("${ThermalWifiProbe.OPENING_MARKER} em cima"))
        assertTrue(explicacao, explicacao.contains("${ThermalWifiProbe.CLOSING_MARKER} embaixo"))

        val silencio = PrinterWifiSetupContract.portOutageNotice
        assertTrue(silencio, silencio.contains("${ThermalWifiProbe.worstCasePortOutageSeconds} segundos"))
    }

    /**
     * Texto de tela é para quem está com a impressora na mão.
     *
     * Nada de opcode, cabeçalho em hexadecimal, endereço de firmware ou marca — nomear a marca
     * traria de volta o catálogo por modelo que este projeto decidiu não fazer, e foi por catálogo
     * que uma impressora quase recebeu o comando de outra família.
     *
     * **A varredura só vale porque toda frase da tela desce até o contrato**, e é por isso que a
     * frase do alvo não interpola mais o `displayName` da unidade: era ele que podia trazer o nome
     * do fabricante para dentro desta lista, e o teste só passava porque a fixture se chamava
     * "Balcão".
     */
    @Test
    fun `nenhuma frase da tela cita byte, opcode ou marca`() {
        val proibidos =
            listOf(
                "1F", "1f", "0x", "B3", "B4", "opcode", "ESC/POS", "AT+", "hexadecimal",
                "GoldenSky", "Rongta", "Bematech", "Printher", "QRFesta", "Vinki",
            )

        todasAsFrases().forEach { frase ->
            proibidos.forEach { proibido ->
                assertFalse("$proibido em: $frase", frase.contains(proibido))
            }
        }
    }

    /** Nenhuma frase da tela ecoa a senha do cliente nem o nome da família em hexadecimal. */
    @Test
    fun `nenhuma frase ecoa a senha nem o rotulo da familia`() {
        val senha = "SenhaSecretaDoCliente1"

        (
            todasAsFrases() +
                listOf(
                    ThermalWifiFrame
                        .validate("RedeDoCliente", PrinterWifiSecurityChoice.WPA2_AES.security("curta"))
                        .rejection
                        ?.message
                        .orEmpty(),
                    ThermalWifiFrame
                        .validate(ThermalWifiKeyType.OPEN, "RedeDoCliente", senha)
                        .rejection
                        ?.message
                        .orEmpty(),
                )
        ).forEach { frase ->
            assertFalse(frase, frase.contains(senha))
            assertFalse(frase, frase.contains(ThermalWifiProtocol.US_W.label))
            assertFalse(frase, frase.contains(ThermalWifiProtocol.US_ESC_US.label))
        }
    }

    /** A tela não promete resposta que ela não recebe, e diz que a queda é esperada. */
    @Test
    fun `a tela anuncia que o comprovante e o papel e que a conexao cai`() {
        assertTrue(PrinterWifiSetupContract.INTRO_NOTICE.contains("O comprovante é o papel"))
        assertTrue(PrinterWifiSetupContract.INTRO_NOTICE.contains("não recebe resposta nenhuma"))
        assertTrue(PrinterWifiSetupContract.INTRO_NOTICE.contains("cai no meio — isso é esperado"))
    }

    @Test
    fun `a oferta do caminho manual anuncia o autoteste antes do toque`() {
        assertTrue(
            PrinterWifiSetupContract.MANUAL_CHOICE_EXPLANATION
                .contains("a escolha é sua, e não uma medição"),
        )
        assertTrue(
            PrinterWifiSetupContract.MANUAL_CHOICE_PROOF_WARNING
                .contains("três cliques no avanço de papel"),
        )
        assertTrue(PrinterWifiSetupContract.MANUAL_CHOICE_PROOF_WARNING.contains("autoteste"))
    }

    /** O formulário diz o que o abriu, e a família escolhida à mão diz que ali não houve medição. */
    @Test
    fun `o formulario diz o que o abriu`() {
        assertEquals(
            "A tira identificou como esta impressora aceita configuração.",
            PrinterWifiSetupContract.formProvenanceNotice(ThermalWifiProtocol.US_W),
        )
        assertEquals(
            "Você escolheu este formato: nenhuma tira o confirma, e a impressora não avisa se ele " +
                "estiver errado.",
            PrinterWifiSetupContract.formProvenanceNotice(
                PrinterWifiSetupContract.manuallyChosenProtocol,
            ),
        )
    }

    /** O campo de nome muda de sentido com o modo, e sem modo escolhido não promete nenhum. */
    @Test
    fun `o campo de nome muda de sentido com o modo`() {
        assertEquals(
            "Nome da rede que a impressora vai criar",
            PrinterWifiSetupContract.ssidFieldLabel(ThermalWifiMode.ACCESS_POINT),
        )
        assertEquals(
            "Nome da rede em que a impressora vai entrar",
            PrinterWifiSetupContract.ssidFieldLabel(ThermalWifiMode.STATION),
        )
        assertEquals("Nome da rede", PrinterWifiSetupContract.ssidFieldLabel(null))
    }

    /** Falha do aplicativo não vira "confira os dados": isso mandaria caçar erro em campo correto. */
    @Test
    fun `inconsistencia entre regua e emissor se anuncia como falha do aplicativo`() {
        assertTrue(PrinterWifiSetupContract.FRAME_CONSTRUCTION_FAILURE.contains("falha do aplicativo"))
        assertTrue(
            PrinterWifiSetupContract.FRAME_CONSTRUCTION_FAILURE
                .contains("nada foi enviado à impressora"),
        )
    }

    /**
     * Nenhuma frase da tela é vazia.
     *
     * Constante esquecida sem texto passaria despercebida por todas as varreduras acima, que só
     * afirmam o que uma frase **não** contém.
     */
    @Test
    fun `todas as frases fixadas existem`() {
        assertTrue(todasAsFrases().isNotEmpty())
        assertTrue(todasAsFrases().none { it.isBlank() })
    }

    /**
     * Tudo o que esta tela pode desenhar, num lugar só.
     *
     * **Gêmea de `todasAsFrasesDaTela` do outro lado.** Frase que não aparece aqui não é varrida, e
     * frase que não está no contrato não pode aparecer aqui.
     */
    private fun todasAsFrases(): List<String> =
        listOf(
            PrinterWifiSetupContract.PANEL_TITLE,
            PrinterWifiSetupContract.INTRO_NOTICE,
            PrinterWifiSetupContract.NO_TARGET_AT_GESTURE,
            PrinterWifiSetupContract.probePaperCostNotice,
            PrinterWifiSetupContract.portOutageNotice,
            PrinterWifiSetupContract.probeExplanation,
            PrinterWifiSetupContract.PROBE_BUTTON_TITLE,
            PrinterWifiSetupContract.PROBE_AGAIN_BUTTON_TITLE,
            PrinterWifiSetupContract.ANSWER_AGAIN_BUTTON_TITLE,
            PrinterWifiSetupContract.RESTART_BUTTON_TITLE,
            PrinterWifiSetupContract.SENDING_NOTICE,
            PrinterWifiSetupContract.READING_QUESTION,
            PrinterWifiSetupContract.MANUAL_CHOICE_TITLE,
            PrinterWifiSetupContract.MANUAL_CHOICE_EXPLANATION,
            PrinterWifiSetupContract.MANUAL_CHOICE_PROOF_WARNING,
            PrinterWifiSetupContract.MANUAL_CHOICE_BUTTON_TITLE,
            PrinterWifiSetupContract.PASSWORD_FIELD_LABEL,
            PrinterWifiSetupContract.PASSWORD_NOTICE,
            PrinterWifiSetupContract.SECURITY_LABEL,
            PrinterWifiSetupContract.MODE_LABEL,
            PrinterWifiSetupContract.ACCESS_POINT_HANDOFF_NOTICE,
            PrinterWifiSetupContract.PREPARE_BUTTON_TITLE,
            PrinterWifiSetupContract.CONFIRM_BUTTON_TITLE,
            PrinterWifiSetupContract.CANCEL_BUTTON_TITLE,
            PrinterWifiSetupContract.FRAME_CONSTRUCTION_FAILURE,
            PrinterWifiSetupContract.STORED_FAMILY_NOTICE,
            PrinterWifiSetupContract.confirmationTitle(15),
            PrinterWifiSetupContract.byteCountNotice(15),
            PrinterWifiSetupContract.ssidFieldLabel(null),
        ) +
            ThermalWifiProtocol.entries.flatMap { familia ->
                listOfNotNull(
                    PrinterWifiSetupContract.formProvenanceNotice(familia),
                    PrinterWifiSetupContract.pendingChoiceNotice(familia, false, false),
                    PrinterWifiSetupContract.pendingChoiceNotice(familia, false, true),
                )
            } +
            PrinterWifiSetupTarget.entries.map { PrinterWifiSetupContract.targetNotice(it) } +
            PrinterWifiDispatch.entries.map { PrinterWifiSetupContract.probeDispatchNotice(it) } +
            listOfNotNull(
                PrinterWifiSetupContract.unconfirmedNotice(ThermalWifiProbeResult.UsWFamilyAbsent),
                PrinterWifiSetupContract.unconfirmedNotice(
                    ThermalWifiProbeResult.Indeterminate(
                        ThermalWifiProbeIndeterminacy.SUBCOMMAND_SWALLOWED,
                    ),
                ),
                PrinterWifiSetupContract.unconfirmedNotice(
                    ThermalWifiProbeResult.Indeterminate(
                        ThermalWifiProbeIndeterminacy.PROBE_DID_NOT_PRINT,
                    ),
                ),
            ) +
            ThermalWifiMode.entries.flatMap { modo ->
                listOf(
                    PrinterWifiSetupContract.label(modo),
                    PrinterWifiSetupContract.modeWarning(modo),
                    PrinterWifiSetupContract.ssidFieldLabel(modo),
                    PrinterWifiSetupContract.confirmationWarning(ThermalWifiProtocol.US_W, modo),
                )
            } +
            listOf(
                PrinterWifiSetupContract.confirmationWarning(
                    ThermalWifiProtocol.US_ESC_US,
                    mode = null,
                ),
            ) +
            ThermalWifiProtocol.entries.flatMap { familia ->
                PrinterWifiDispatch.entries.map {
                    PrinterWifiSetupContract.sendOutcomeNotice(it, familia)
                }
            } +
            PrinterWifiSecurityChoice.entries.map { it.label } +
            ThermalWifiKeyType.entries.map { PrinterWifiSetupContract.label(it) } +
            ThermalWifiProbeReading.entries.map { it.label }
}
