package br.com.thermalprinterkit.printher

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.thermalprinterkit.EscPosDialect
import br.com.thermalprinterkit.CodePageProbeCandidate
import br.com.thermalprinterkit.CutProtocol
import br.com.thermalprinterkit.EscPosThermalCommands
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PrinterHomologationAnswer
import br.com.thermalprinterkit.PrinterHomologationFailurePoint
import br.com.thermalprinterkit.PrinterHomologationFlow
import br.com.thermalprinterkit.PrinterHomologationFlowPhase
import br.com.thermalprinterkit.PrinterHomologationHost
import br.com.thermalprinterkit.PrinterHomologationPaperCost
import br.com.thermalprinterkit.PrinterHomologationTarget
import br.com.thermalprinterkit.PrinterHomologationPhase
import br.com.thermalprinterkit.PrinterHomologationProbes
import br.com.thermalprinterkit.PrinterHomologationPath
import br.com.thermalprinterkit.PrinterHomologationStep
import br.com.thermalprinterkit.PrinterCutterPresence
import br.com.thermalprinterkit.PrinterCutProbeStage
import br.com.thermalprinterkit.PrinterProfileStore
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalPrintDelivery
import br.com.thermalprinterkit.ThermalPrintResult
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.ThermalTextEncoding
import br.com.thermalprinterkit.withCutMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * As duas frases da tela que descrevem **onde a configuração fica**, e não a impressora.
 *
 * Toda a superfície de homologação fala do papel que acabou de sair: largura, acento, corte,
 * avanço. Estas duas são as únicas que falam do aparelho que roda o app — "só neste celular" —, e é
 * exatamente por isso que elas não são do kit: quem sabe em que aparelho está é o hospedeiro, não a
 * tela. A tela nunca pergunta em que sistema roda; ela recebe a frase pronta e a mostra.
 *
 * O default é o de hoje, byte a byte, e é aqui que os dois literais moram — eles não existem mais
 * em nenhum outro ponto do arquivo. Quem não injeta nada não vê diferença nenhuma.
 *
 * O molde é o do B8 (`requiredInterfaceType`, `interfaceNames`): parâmetro com default, o
 * comportamento de hoje preservado. Ele vem em um valor só, e não em dois parâmetros soltos,
 * porque as duas frases são a mesma promessa dita em dois lugares — trocar uma e esquecer a outra
 * deixaria a tela dizendo duas coisas diferentes sobre o mesmo aparelho —, porque assim ele
 * atravessa a cadeia de composables sem alargar seis assinaturas a cada frase nova, e porque um
 * tipo simples é alcançável por teste de unidade JVM, que árvore Compose não é. O iOS tem a mesma
 * forma em `PrinterHomologationLocalOnlyCopy`, com os mesmos dois campos e o mesmo default.
 */
data class PrinterHomologationLocalOnlyCopy(
    /** O título do aviso de permanência, na abertura do assistente e na tela do fim. */
    val localOnlyTitle: String = DEFAULT_LOCAL_ONLY_TITLE,
    /** O rótulo do botão que encerra a homologação depois da adoção. */
    val finishTitle: String = DEFAULT_FINISH_TITLE,
) {
    companion object {
        /** O que a tela diz quando o hospedeiro não diz nada. */
        val Default = PrinterHomologationLocalOnlyCopy()
    }
}

internal const val DEFAULT_LOCAL_ONLY_TITLE = "Esta configuração fica só neste celular"
internal const val DEFAULT_FINISH_TITLE = "Usar só neste celular"

/**
 * O corpo do aviso de permanência — **do kit, e não injetável**, porque ele fala de reinstalação e
 * de outro app, e não do aparelho.
 *
 * Era um literal solto dentro do painel final e dizia *"Ela não atravessa uma reinstalação nem vai
 * para outro app."* A frase **deixou de ser verdadeira no C38**: o painel de contribuição, logo
 * abaixo deste aviso, existe justamente para mandar a medição a outro app. Manter a frase antiga
 * seria a tela prometer uma coisa e oferecer a contrária no toque seguinte.
 *
 * A frase nova preserva o que continua verdadeiro — a configuração é deste aparelho e não viaja
 * sozinha — e nomeia a única forma de ela sair: a pessoa mandando. Virou constante para a suíte
 * poder fixá-la; árvore Compose este módulo não monta em teste de unidade.
 */
internal const val DEFAULT_LOCAL_ONLY_BODY =
    "Ela não atravessa uma reinstalação, e nenhum app a recebe sem você mandar."

/**
 * API pública exata para hosts que não precisam acrescentar modificador.
 *
 * [profileActions] só aparece depois da confirmação final, quando o perfil medido já foi salvo e
 * adotado; assim uma ação do host não antecipa a confirmação humana do papel.
 *
 * [localOnlyCopy] é o ponto de injeção das duas frases que dizem em que aparelho a configuração
 * fica. O default é o de hoje.
 */
@Composable
fun PrinterHomologationScreen(
    printer: ThermalPrinter,
    store: PrinterProfileStore,
    onFinished: () -> Unit,
    profileActions: (@Composable (MeasuredProfile) -> Unit)? = null,
    localOnlyCopy: PrinterHomologationLocalOnlyCopy = PrinterHomologationLocalOnlyCopy.Default,
) {
    PrinterHomologationScreen(
        printer = printer,
        store = store,
        onFinished = onFinished,
        modifier = Modifier,
        profileActions = profileActions,
        localOnlyCopy = localOnlyCopy,
    )
}

/** Variante usada por scaffolds, inclusive pelo app de bancada. */
@Composable
fun PrinterHomologationScreen(
    printer: ThermalPrinter,
    store: PrinterProfileStore,
    onFinished: () -> Unit,
    modifier: Modifier,
    profileActions: (@Composable (MeasuredProfile) -> Unit)? = null,
    localOnlyCopy: PrinterHomologationLocalOnlyCopy = PrinterHomologationLocalOnlyCopy.Default,
) {
    val theme = ThermalPrinterTheme.neutral
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .testTag("print-setup.homologation")
                .verticalScroll(rememberScrollState())
                .padding(theme.contentPadding),
    ) {
        PrinterHomologationContent(
            printer = printer,
            store = store,
            onFinished = onFinished,
            theme = theme,
            modifier = Modifier.fillMaxWidth(),
            profileActions = profileActions,
            localOnlyCopy = localOnlyCopy,
        )
    }
}

/** Conteúdo sem rolagem para ser composto dentro de [ThermalPrinterContent]. */
@Composable
internal fun PrinterHomologationContent(
    printer: ThermalPrinter,
    store: PrinterProfileStore,
    onFinished: () -> Unit,
    theme: ThermalPrinterTheme,
    modifier: Modifier = Modifier,
    preparationAlreadyAccepted: Boolean = false,
    profileActions: (@Composable (MeasuredProfile) -> Unit)? = null,
    localOnlyCopy: PrinterHomologationLocalOnlyCopy = PrinterHomologationLocalOnlyCopy.Default,
) {
    val scope = rememberCoroutineScope()
    var introductionAccepted by
        remember(printer, store, preparationAlreadyAccepted) {
            mutableStateOf(preparationAlreadyAccepted)
        }
    var manualConfiguration by remember(printer, store) { mutableStateOf(false) }
    var cancellationInProgress by remember(printer, store) { mutableStateOf(false) }
    var cancellationFailure by remember(printer, store) { mutableStateOf(false) }
    var runtimeState by
        remember(printer, store) {
            mutableStateOf<HomologationRuntimeState>(HomologationRuntimeState.Loading)
        }
    var preparedTargetState by
        remember(printer, store) {
            mutableStateOf<PreparedHomologationTargetState>(PreparedHomologationTargetState.Loading)
        }

    fun discardPendingCandidateAndFinish() {
        if (cancellationInProgress) return
        cancellationInProgress = true
        cancellationFailure = false
        scope.launch {
            try {
                // Cancelar custo/configuração não responde nada sobre o papel. A candidata
                // pendente é descartada explicitamente antes de a tela fechar.
                printer.discardSearchedPrinter()
                onFinished()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                cancellationInProgress = false
                cancellationFailure = true
            }
        }
    }

    BackHandler(enabled = !cancellationInProgress) {
        discardPendingCandidateAndFinish()
    }

    // Abre e mantém o alvo assim que a tela aparece. A confirmação da busca expira para não deixar
    // endereço/handle antigo vivo indefinidamente, mas a pessoa pode levar mais de dois minutos
    // lendo a introdução ou conferindo o comprovante. Reabrir somente ao tocar em "Configuração
    // manual" perdia exatamente a impressora que acabou de ser testada.
    LaunchedEffect(printer, store) {
        preparedTargetState = PreparedHomologationTargetState.Loading
        val host = printer as? PrinterHomologationHost
        if (host == null) {
            preparedTargetState =
                PreparedHomologationTargetState.Unavailable(
                    "Este aparelho não oferece uma sessão temporária de teste.",
                )
            return@LaunchedEffect
        }
        preparedTargetState =
            try {
                val target = host.openHomologationTarget()
                if (target == null) {
                    PreparedHomologationTargetState.Unavailable(
                        "Procure e teste uma impressora antes de começar a configuração.",
                    )
                } else {
                    PreparedHomologationTargetState.Ready(target)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                PreparedHomologationTargetState.Unavailable(
                    "Não foi possível abrir a sessão temporária de teste.",
                )
            }
    }

    LaunchedEffect(preparedTargetState, introductionAccepted) {
        if (!introductionAccepted) return@LaunchedEffect
        runtimeState =
            try {
                when (val prepared = preparedTargetState) {
                    PreparedHomologationTargetState.Loading -> HomologationRuntimeState.Loading
                    is PreparedHomologationTargetState.Unavailable ->
                        HomologationRuntimeState.Unavailable(prepared.message)
                    is PreparedHomologationTargetState.Ready -> {
                        val target = prepared.target
                        val flow = target.openHomologation(store)
                        HomologationRuntimeState.Ready(
                            HomologationRuntime(
                                displayName = target.displayName,
                                transport = target.transport,
                                flow = flow,
                            ),
                        )
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                HomologationRuntimeState.Unavailable(
                    "Não foi possível abrir a sessão temporária de teste.",
                )
            }
    }

    val runtime = (runtimeState as? HomologationRuntimeState.Ready)?.runtime
    DisposableEffect(runtime) {
        onDispose { runtime?.close() }
    }

    Column(
        modifier = modifier.fillMaxWidth().testTag("thermal-printer.homologation.screen"),
        verticalArrangement = Arrangement.spacedBy(theme.sectionSpacing),
    ) {
        if (manualConfiguration) {
            when (val prepared = preparedTargetState) {
                PreparedHomologationTargetState.Loading -> {
                    SectionHeading("Configuração manual", "Lendo a impressora selecionada.", theme)
                    CircularProgressIndicator(color = theme.accentColor)
                }
                is PreparedHomologationTargetState.Unavailable -> {
                    SectionHeading("Configuração manual", prepared.message, theme)
                    OutlinedButton(
                        onClick = { manualConfiguration = false },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Voltar") }
                }
                is PreparedHomologationTargetState.Ready ->
                    PrinterManualConfigurationContent(
                        printer = printer,
                        store = store,
                        transport = null,
                        preparedTarget = prepared.target,
                        theme = theme,
                        onSaved = onFinished,
                        onBack = { manualConfiguration = false },
                    )
            }
        } else if (!introductionAccepted) {
            PaperCostIntroduction(
                theme = theme,
                preliminaryReceiptPending = false,
                onStart = { introductionAccepted = true },
                cancelEnabled = !cancellationInProgress,
                onCancel = ::discardPendingCandidateAndFinish,
                onManualConfiguration = { manualConfiguration = true },
                localOnlyCopy = localOnlyCopy,
            )
        } else when (val current = runtimeState) {
            HomologationRuntimeState.Loading -> {
                SectionHeading(
                    title = "Teste da impressora",
                    supportingText = "Abrindo uma sessão que existe somente em memória.",
                    theme = theme,
                )
                CircularProgressIndicator(
                    color = theme.accentColor,
                    modifier = Modifier.testTag("thermal-printer.homologation.loading"),
                )
            }
            is HomologationRuntimeState.Unavailable -> {
                SectionHeading(
                    title = "Configuração indisponível",
                    supportingText = current.message,
                    theme = theme,
                )
                NoticeCard(
                    title = "Nenhum dado foi salvo",
                    body =
                        "O alvo técnico não é persistido. Volte, teste uma impressora e tente " +
                            "novamente.",
                    tone = NoticeTone.WARNING,
                    theme = theme,
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.unavailable"),
                )
                OutlinedButton(
                    onClick = ::discardPendingCandidateAndFinish,
                    enabled = !cancellationInProgress,
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.unavailable.back"),
                ) {
                    Text("Voltar à configuração")
                }
            }
            is HomologationRuntimeState.Ready ->
                HomologationFlow(
                    runtime = current.runtime,
                    theme = theme,
                    onFinished = onFinished,
                    cancelEnabled = !cancellationInProgress,
                    onCancel = ::discardPendingCandidateAndFinish,
                    profileActions = profileActions,
                    localOnlyCopy = localOnlyCopy,
                )
        }
        if (cancellationFailure) {
            NoticeCard(
                title = "Não foi possível cancelar",
                body = "Tente novamente para descartar esta impressora com segurança.",
                tone = NoticeTone.WARNING,
                theme = theme,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * A abertura do assistente, com o custo em papel dito antes de qualquer sonda.
 *
 * [preliminaryReceiptPending] descreve o papel, não a plataforma: quem chega aqui pelo Android
 * sempre já pagou o comprovante de teste — os dois chamadores da confirmação passam `false` —, e no
 * iOS a mesma abertura também aparece **antes** dele, no caminho que aceita o custo antes da busca.
 * Conferido nos dois fluxos em 20/08. A frase do comprovante segue o estado; nada aqui pergunta em
 * que sistema está rodando.
 */
@Composable
internal fun PaperCostIntroduction(
    theme: ThermalPrinterTheme,
    preliminaryReceiptPending: Boolean,
    onStart: () -> Unit,
    cancelEnabled: Boolean,
    onCancel: () -> Unit,
    onManualConfiguration: (() -> Unit)? = null,
    localOnlyCopy: PrinterHomologationLocalOnlyCopy = PrinterHomologationLocalOnlyCopy.Default,
) {
    Column(
        modifier =
            Modifier
                .fillMaxWidth()
                .testTag("thermal-printer.homologation.introduction"),
        verticalArrangement = Arrangement.spacedBy(theme.sectionSpacing),
    ) {
        SectionHeading(
            title = "Vamos testar sua impressora",
            supportingText =
                "O teste imprime várias tirinhas de papel. É uma vez só, para o app aprender " +
                    "a sua impressora.",
            theme = theme,
        )
        Text(
            "Depois disso tudo sai certinho: acento, corte e tamanho.",
            style = if (theme.usesPrintherLayout) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
        )
        NoticeCard(
            title = paperCostHeadline(),
            body =
                if (preliminaryReceiptPending) {
                    "$PRELIMINARY_RECEIPT_NOTICE $PAPER_COST_LEFTOVER_NOTICE"
                } else {
                    "$PRELIMINARY_RECEIPT_ALREADY_PRINTED $PAPER_COST_LEFTOVER_NOTICE"
                },
            tone = NoticeTone.WARNING,
            theme = theme,
            modifier = Modifier.fillMaxWidth(),
        )
        // Quem diz *onde* a configuração fica é o hospedeiro; esta tela só mostra a frase que
        // recebeu, e não pergunta em que sistema roda.
        NoticeCard(
            title = localOnlyCopy.localOnlyTitle,
            body = "Se o app for removido, ela também será apagada.",
            tone = NoticeTone.INFO,
            theme = theme,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = onStart,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .height(if (theme.usesPrintherLayout) 68.dp else 48.dp)
                    .testTag("thermal-printer.homologation.introduction.start"),
            colors =
                ButtonDefaults.buttonColors(
                    containerColor = theme.accentColor,
                    contentColor = theme.onAccentColor,
                ),
        ) {
            Text("Começar o teste", style = if (theme.usesPrintherLayout) MaterialTheme.typography.titleMedium else MaterialTheme.typography.labelLarge)
        }
        if (onManualConfiguration != null) {
            OutlinedButton(
                onClick = onManualConfiguration,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .height(if (theme.usesPrintherLayout) 60.dp else 48.dp)
                        .testTag("thermal-printer.homologation.manual"),
            ) {
                Text("Configuração manual")
            }
        }
        TextButton(
            onClick = onCancel,
            enabled = cancelEnabled,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.homologation.introduction.cancel"),
        ) {
            Text("Agora não")
        }
    }
}

/**
 * Editor compartilhado entre a rota sem novas sondas e a engrenagem da impressora instalada.
 * Abrir e salvar esta tela não chama [PrinterHomologationTarget.openSession]: nenhum byte é enviado.
 */
@Composable
internal fun PrinterManualConfigurationContent(
    printer: ThermalPrinter,
    store: PrinterProfileStore,
    transport: PrinterTransport?,
    preparedTarget: PrinterHomologationTarget? = null,
    theme: ThermalPrinterTheme,
    onSaved: () -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var target by remember(printer, store, transport, preparedTarget) { mutableStateOf<PrinterHomologationTarget?>(null) }
    var current by remember(printer, store, transport, preparedTarget) { mutableStateOf<MeasuredProfile?>(null) }
    var loading by remember(printer, store, transport, preparedTarget) { mutableStateOf(true) }
    var loadFailure by remember(printer, store, transport, preparedTarget) { mutableStateOf<String?>(null) }

    LaunchedEffect(printer, store, transport, preparedTarget) {
        loading = true
        loadFailure = null
        try {
            val opened =
                preparedTarget
                    ?: (printer as? PrinterHomologationHost)?.openHomologationTarget(transport)
            if (opened == null) {
                loadFailure = "Não foi possível encontrar a impressora selecionada."
            } else {
                target = opened
                current = store.read().firstOrNull { it.id == opened.profileId }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            loadFailure = "Não foi possível abrir os dados desta impressora."
        } finally {
            loading = false
        }
    }

    if (loading) {
        SectionHeading("Configuração manual", "Lendo os dados salvos.", theme)
        CircularProgressIndicator(color = theme.accentColor)
        return
    }
    val openedTarget = target
    if (openedTarget == null) {
        SectionHeading("Configuração manual", loadFailure.orEmpty(), theme)
        OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Voltar") }
        return
    }

    ManualConfigurationForm(
        target = openedTarget,
        current = current,
        theme = theme,
        onBack = onBack,
        onSave = { profile, report ->
            scope.launch {
                try {
                    openedTarget.saveManualConfiguration(profile)
                    onSaved()
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Throwable) {
                    report("Não foi possível salvar. Confira os dados e tente novamente.")
                }
            }
        },
    )
}

@Composable
private fun ManualConfigurationForm(
    target: PrinterHomologationTarget,
    current: MeasuredProfile?,
    theme: ThermalPrinterTheme,
    onBack: () -> Unit,
    onSave: (MeasuredProfile, (String) -> Unit) -> Unit,
) {
    val initialGeometry = current ?: MeasuredProfile.createLocal(
        dialect = target.dialect,
        displayName = target.displayName,
        transports = setOf(target.transport),
        paperWidthMm = target.paperWidthMm,
        printableColumns = MeasuredProfile.geometryDefaults(target.paperWidthMm).printableColumns,
        printableDots = MeasuredProfile.geometryDefaults(target.paperWidthMm).printableDots,
        codePage = null,
        cutProtocol = CutProtocol.NONE,
        cutFeedLines = 0,
        measuredAtEpochMillis = 1,
    )
    var displayName by remember(target, current) { mutableStateOf(initialGeometry.displayName) }
    var paperWidth by remember(target, current) { mutableStateOf(initialGeometry.paperWidthMm) }
    var columns by remember(target, current) { mutableStateOf(initialGeometry.printableColumns.toString()) }
    var dots by remember(target, current) { mutableStateOf(initialGeometry.printableDots) }
    var hasCutter by remember(target, current) { mutableStateOf(initialGeometry.hasCutter) }
    var cutProtocol by remember(target, current) { mutableStateOf(initialGeometry.cutProtocol) }
    var cutFeed by remember(target, current) { mutableStateOf(initialGeometry.cutFeedLines) }
    val candidates = remember { PrinterHomologationProbes.codePageCandidates }
    var encoding by remember(target, current) {
        mutableStateOf(
            candidates.firstOrNull {
                it.textEncoding == initialGeometry.textEncoding &&
                    it.codePage == initialGeometry.codePage &&
                    if (initialGeometry.codePageSelector == null) !it.isAddress
                    else it.isAddress && it.escT == initialGeometry.codePageSelector
            } ?: candidates.first(),
        )
    }
    var saving by remember(target, current) { mutableStateOf(false) }
    var failure by remember(target, current) { mutableStateOf<String?>(null) }
    val protocols = listOf(CutProtocol.GS_V_0, CutProtocol.GS_V_1, CutProtocol.GS_V_65, CutProtocol.GS_V_66, CutProtocol.ESC_I, CutProtocol.ESC_M)
    val allowedFeeds = if (cutProtocol in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED) listOf(0) else MeasuredProfile.CUT_FEED_CHOICES.toList()

    Column(
        modifier = Modifier.fillMaxWidth().testTag("thermal-printer.manual.screen"),
        verticalArrangement = Arrangement.spacedBy(theme.sectionSpacing),
    ) {
        SectionHeading(
            title = "Configuração manual",
            supportingText = "Use o comprovante que você já tem. Nada será impresso nesta tela.",
            theme = theme,
        )
        OutlinedTextField(
            value = displayName,
            onValueChange = { displayName = it.take(80) },
            label = { Text("Nome da impressora") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("thermal-printer.manual.name"),
        )
        ManualChoice("Largura do papel", listOf(58, 80), paperWidth, { "$it mm" }) {
            paperWidth = it
            val defaults = MeasuredProfile.geometryDefaults(it)
            columns = defaults.printableColumns.toString()
            dots = defaults.printableDots
        }
        OutlinedTextField(
            value = columns,
            onValueChange = { columns = it.filter(Char::isDigit).take(2) },
            label = { Text("Colunas imprimíveis") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("thermal-printer.manual.columns"),
        )
        ManualChoice("Largura da imagem", MeasuredProfile.printableDotCandidates(paperWidth), dots, { "$it dots" }) { dots = it }
        ManualChoice("Sua impressora tem guilhotina?", listOf(false, true), hasCutter, { if (it) "Sim" else "Não" }) {
            hasCutter = it
            if (!it) {
                cutProtocol = CutProtocol.NONE
                cutFeed = 0
            } else if (cutProtocol == CutProtocol.NONE) {
                cutProtocol = CutProtocol.GS_V_0
            }
        }
        if (hasCutter) {
            ManualChoice("Comando de corte", protocols, cutProtocol, CutProtocol::manualLabel) {
                cutProtocol = it
                if (it in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED) cutFeed = 0
            }
            ManualChoice("Avanço antes do corte", allowedFeeds, cutFeed, { if (it == 0) "Sem avanço separado" else "$it linhas" }) { cutFeed = it }
        }
        Text("Texto e acentos", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        candidates.forEach { candidate ->
            OutlinedButton(
                onClick = { encoding = candidate },
                modifier = Modifier.fillMaxWidth().testTag("thermal-printer.manual.encoding-${candidate.letter}"),
                border = BorderStroke(if (encoding === candidate) 2.dp else 1.dp, if (encoding === candidate) theme.accentColor else theme.outlineColor),
            ) { Text("${candidate.letter}) ${candidate.label}") }
        }
        failure?.let {
            NoticeCard("Não foi possível salvar", it, NoticeTone.WARNING, theme, Modifier.fillMaxWidth())
        }
        Button(
            onClick = {
                failure = null
                val printableColumns = columns.toIntOrNull()
                try {
                    require(!saving)
                    require(printableColumns != null) { "Informe a quantidade de colunas do comprovante." }
                    val profile = manualConfigurationProfile(
                        previous = current,
                        dialect = target.dialect,
                        displayName = displayName.trim(),
                        transport = target.transport,
                        paperWidthMm = paperWidth,
                        printableColumns = printableColumns,
                        printableDots = dots,
                        encoding = encoding,
                        hasCutter = hasCutter,
                        cutProtocol = cutProtocol,
                        cutFeedLines = cutFeed,
                        nowEpochMillis = System.currentTimeMillis(),
                    )
                    saving = true
                    onSave(profile) { message -> saving = false; failure = message }
                } catch (error: IllegalArgumentException) {
                    failure = error.message ?: "Confira os dados informados."
                }
            },
            enabled = !saving,
            modifier = Modifier.fillMaxWidth().testTag("thermal-printer.manual.save"),
            colors = ButtonDefaults.buttonColors(containerColor = theme.accentColor, contentColor = theme.onAccentColor),
        ) { Text(if (saving) "Salvando…" else "Salvar configuração") }
        TextButton(onClick = onBack, enabled = !saving, modifier = Modifier.fillMaxWidth()) { Text("Voltar") }
    }
}

/**
 * O perfil que o botão "Salvar configuração" grava, fora do `@Composable` para a suíte alcançar.
 *
 * Está aqui e não em outro arquivo porque a montagem é da tela: é ela que sabe o que a pessoa
 * declarou. O relógio entra por parâmetro pelo mesmo motivo — data medida por dentro não se prova.
 *
 * **Os campos medidos tardios não têm campo em tela, e é por isso que eles precisam de dono
 * aqui.** Esta rota existe para quem já tem o comprovante em mãos e só quer declarar o que leu;
 * ela não mede sonda nenhuma, então não pode apagar o que a sonda mediu antes. Quem homologou a
 * T210 e depois trocou só a página de código perdia [MeasuredProfile.verticalRasterScale] em
 * silêncio: foto, logotipo e QR voltavam a sair ~20% mais curtos e o cupom continuava saindo.
 * A regra é a mesma de [MeasuredProfile.cutModeHonored] — o declarado ganha quando existe, e o que
 * ninguém declarou vem de [previous].
 */
internal fun manualConfigurationProfile(
    previous: MeasuredProfile?,
    /**
     * O idioma da candidata. Nao e campo desta tela, e nao ha caixa para ele: dialeto nao se
     * escolhe a mao, vem do card do catalogo e atravessa ate aqui. Sem ele a Diebold voltava a
     * ESC/POS no instante em que era salva, depois de a homologacao inteira ter saido certa.
     */
    dialect: EscPosDialect = EscPosDialect.EPSON_COMPATIBLE,
    displayName: String,
    transport: PrinterTransport,
    paperWidthMm: Int,
    printableColumns: Int,
    printableDots: Int,
    encoding: CodePageProbeCandidate,
    hasCutter: Boolean,
    cutProtocol: CutProtocol,
    cutFeedLines: Int,
    nowEpochMillis: Long,
    newId: String = java.util.UUID.randomUUID().toString(),
    /**
     * O que quem chama já tem em mãos, quando tem.
     *
     * Nenhuma tela de celular preenche isto: o comprovante em papel imprime a régua
     * (`Vazão: 38/48 mm | fator 0,79`) e é o app de mesa que a transcreve. A faixa de cada campo
     * continua sendo do [MeasuredProfile], que recusa o que estiver fora dela.
     */
    maxRasterBytesPerSecond: Int? = null,
    verticalRasterScale: Double? = null,
    nativeQrHonored: Boolean? = null,
    nativeBarcodeHonored: Boolean? = null,
): MeasuredProfile =
    MeasuredProfile.createLocal(
        id = previous?.id ?: newId,
        displayName = displayName,
        transports = setOf(transport),
        paperWidthMm = paperWidthMm,
        printableColumns = printableColumns,
        printableDots = printableDots,
        codePage = encoding.codePage,
        textEncoding = encoding.textEncoding,
        codePageSelector = encoding.escT,
        cutProtocol = if (hasCutter) cutProtocol else CutProtocol.NONE,
        cutFeedLines = if (hasCutter) cutFeedLines else 0,
        measuredAtEpochMillis =
            maxOf(
                nowEpochMillis.coerceAtLeast(1),
                (previous?.measuredAtEpochMillis ?: 0) + 1,
            ),
        cutModeHonored = previous?.cutModeHonored ?: true,
        firmwareVersion = previous?.firmwareVersion,
        maxRasterBytesPerSecond = maxRasterBytesPerSecond ?: previous?.maxRasterBytesPerSecond,
        verticalRasterScale = verticalRasterScale ?: previous?.verticalRasterScale,
        nativeQrHonored = nativeQrHonored ?: previous?.nativeQrHonored,
        nativeBarcodeHonored = nativeBarcodeHonored ?: previous?.nativeBarcodeHonored,
        // Sem parâmetro, e de propósito: esta tela não determina família de rede nenhuma. Ela só
        // não pode apagar a resposta que a tela de rede gravou — trocar a página de código de um
        // perfil que já respondeu mandaria a tira sair de novo, semanas depois, longe da causa.
        wifiConfigurationFamily = previous?.wifiConfigurationFamily,
        dialect = previous?.dialect ?: dialect,
    )

@Composable
private fun <T> ManualChoice(
    title: String,
    choices: List<T>,
    selected: T,
    label: (T) -> String,
    onSelect: (T) -> Unit,
) {
    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
    choices.forEach { choice ->
        OutlinedButton(onClick = { onSelect(choice) }, modifier = Modifier.fillMaxWidth()) {
            Text(if (choice == selected) "✓ ${label(choice)}" else label(choice))
        }
    }
}

private fun CutProtocol.manualLabel(): String =
    when (this) {
        CutProtocol.GS_V_0 -> "GS V 0 · corte total"
        CutProtocol.GS_V_1 -> "GS V 1 · corte parcial"
        CutProtocol.GS_V_65 -> "GS V 65 · total com avanço"
        CutProtocol.GS_V_66 -> "GS V 66 · parcial com avanço"
        CutProtocol.ESC_I -> "ESC i · corte total"
        CutProtocol.ESC_M -> "ESC m · corte parcial"
        CutProtocol.GS_V -> "GS V · legado"
        CutProtocol.NONE -> "Sem guilhotina"
    }

/**
 * O teto anunciado, contado pelas sondas em [PrinterHomologationPaperCost].
 *
 * A conta saiu da tela em 20/08: escrita à mão aqui e no iOS, ela divergiu — 17 de um lado, 7 do
 * outro — e nenhuma das duas contava a tira das réguas de largura, que o piso já contava.
 */
internal fun homologationPaperTestCount(): Int = PrinterHomologationPaperCost.maximumStrips

/** O teto menos o comprovante final: só o que as sondas gastam. */
internal fun homologationProbePaperTestCount(): Int =
    homologationPaperTestCount() - PrinterHomologationPaperCost.FINAL_RECEIPT

/**
 * O piso do intervalo anunciado: largura, vazão, código nativo, texto e comprovante final.
 *
 * Eram três antes da tira da imagem e quatro antes da tira de código nativo. As duas saem em toda
 * impressora — nem o descarte de linha nem a firmware avisam por marca —, então o mínimo subiu
 * junto, e hoje são cinco.
 */
internal val MINIMUM_PAPER_TEST_COUNT: Int
    get() = PrinterHomologationPaperCost.minimumStrips

/**
 * A tira de conexão ainda não saiu: sai ao tocar em "Começar o teste".
 *
 * Nenhum chamador Android passa por aqui — no Android o assistente só abre depois do comprovante
 * de teste, e a abertura sempre diz [PRELIMINARY_RECEIPT_ALREADY_PRINTED]. A frase existe porque a
 * mesma abertura no iOS **é** apresentada antes do comprovante, no caminho que aceita o custo antes
 * da busca; ela depende do estado, não da plataforma, e as duas plataformas dizem a mesma coisa no
 * mesmo estado.
 */
internal const val PRELIMINARY_RECEIPT_NOTICE =
    "A primeira sai agora, para conferir a conexão."

/** O outro estado da mesma frase: a tira de conexão já está na mão de quem lê a tela. */
internal const val PRELIMINARY_RECEIPT_ALREADY_PRINTED =
    "O comprovante preliminar já saiu."

internal const val PAPER_COST_LEFTOVER_NOTICE = "Deixe papel suficiente na impressora."

/** A frase do custo, montada da conta das sondas. O iOS emite exatamente esta. */
internal fun paperCostHeadline(): String =
    "São de $MINIMUM_PAPER_TEST_COUNT a ${homologationPaperTestCount()} tiras curtas de teste."

private const val DRAWER_PIN = 2
private const val DRAWER_ON_TIME = 50
private const val DRAWER_OFF_TIME = 250

@Composable
private fun HomologationFlow(
    runtime: HomologationRuntime,
    theme: ThermalPrinterTheme,
    onFinished: () -> Unit,
    cancelEnabled: Boolean,
    onCancel: () -> Unit,
    profileActions: (@Composable (MeasuredProfile) -> Unit)?,
    localOnlyCopy: PrinterHomologationLocalOnlyCopy,
) {
    val flowState by runtime.flow.state.collectAsStateWithLifecycle()
    val snapshot = runtime.flow.uiSnapshot(flowState)
    val scope = rememberCoroutineScope()
    var localFailure by remember(runtime) { mutableStateOf<String?>(null) }
    var showDrawerConfirmation by remember(runtime) { mutableStateOf(false) }
    var drawerActionSending by remember(runtime) { mutableStateOf(false) }
    var drawerActionResult by remember(runtime) { mutableStateOf<String?>(null) }

    fun runAction(action: () -> Unit) {
        localFailure = null
        runCatching(action).onFailure {
            localFailure = "Esta resposta não é válida para a sonda que terminou de imprimir."
        }
    }

    fun runSendingAction(
        onSuccess: (() -> Unit)? = null,
        action: suspend () -> Unit,
    ) {
        localFailure = null
        scope.launch {
            val result = runHomologationCall(action)
            if (result.isFailure) {
                localFailure = "Não foi possível concluir esta etapa do teste."
            } else {
                onSuccess?.invoke()
            }
        }
    }

    fun sendDrawerKickPulse() {
        if (drawerActionSending) return
        showDrawerConfirmation = false
        drawerActionSending = true
        drawerActionResult = null
        scope.launch {
            val message =
                try {
                    val command =
                        requireNotNull(
                            EscPosThermalCommands.drawerKickPulse(
                                pin = DRAWER_PIN,
                                onTime = DRAWER_ON_TIME,
                                offTime = DRAWER_OFF_TIME,
                            ),
                        )
                    val session = runtime.flow.target.openSession()
                    try {
                        when (val sent = session.send(command)) {
                            ThermalPrintResult.Printed ->
                                "O transporte concluiu o comando. Confira a gaveta: este retorno " +
                                    "não prova que ela existe nem que abriu."
                            is ThermalPrintResult.Failed ->
                                if (sent.delivery == ThermalPrintDelivery.INDETERMINATE) {
                                    "O transporte não confirmou o fim. O pulso pode ter chegado; " +
                                        "confira a gaveta antes de tentar novamente."
                                } else {
                                    "O comando não foi enviado. Nada será repetido automaticamente."
                                }
                        }
                    } finally {
                        command.fill(0)
                        session.close()
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Throwable) {
                    "Não foi possível concluir o comando. Nada será repetido automaticamente."
                }
            drawerActionSending = false
            drawerActionResult = message
        }
    }

    SectionHeading(
        title = "Testar e configurar",
        supportingText =
            "${runtime.displayName} · ${runtime.transport.uiLabel}. O rascunho não é salvo.",
        theme = theme,
    )
    if (snapshot.machineState.step != PrinterHomologationStep.DONE) {
        HomologationProgress(snapshot, theme)
    }

    localFailure?.let { message ->
        NoticeCard(
            title = "Ação não concluída",
            body = message,
            tone = NoticeTone.WARNING,
            theme = theme,
            modifier = Modifier.fillMaxWidth(),
        )
    }

    if (snapshot.cutMeasurementFailed) {
        NoticeCard(
            title = "Não foi possível medir o corte",
            body =
                "Os comandos testados não cortaram o papel. O perfil seguirá sem guilhotina; " +
                    "o comprovante final ainda precisa sair certo antes da adoção.",
            tone = NoticeTone.WARNING,
            theme = theme,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.homologation.cut-not-measured"),
        )
    }

    when {
        snapshot.machineState.phase == PrinterHomologationPhase.SENDING ->
            SendingPanel(theme)
        snapshot.machineState.phase == PrinterHomologationPhase.FAILED ->
            ProbeFailurePanel(
                snapshot = snapshot,
                theme = theme,
                onRetry = { runAction(runtime.flow::retryProbe) },
            )
        snapshot.machineState.step == PrinterHomologationStep.DONE ->
            FinalReceiptPanel(
                runtime = runtime,
                snapshot = snapshot,
                theme = theme,
                runAction = ::runAction,
                runSendingAction = ::runSendingAction,
                onValidationFailure = { localFailure = it },
                onFinished = onFinished,
                goBack = { runAction(runtime.flow::goBack) },
                profileActions = profileActions,
                localOnlyCopy = localOnlyCopy,
            )
        snapshot.machineState.step == PrinterHomologationStep.WIDTH ->
            WidthStep(
                snapshot = snapshot,
                theme = theme,
                send = { runSendingAction { runtime.flow.sendPaperWidthRulers() } },
                choose = { runAction { runtime.flow.choosePaperWidthFromPrintedRulers(it) } },
                chooseNone = { runAction { runtime.flow.chooseNoPaperWidthFromPrintedRulers() } },
            )
        snapshot.machineState.step == PrinterHomologationStep.GEOMETRY ->
            GeometryStep(
                snapshot = snapshot,
                theme = theme,
                send = { runSendingAction { runtime.flow.sendCurrentProbe() } },
                answer = { runAction { runtime.flow.answer(it) } },
                onValidationFailure = { localFailure = it },
                goBack = { runAction(runtime.flow::goBack) },
            )
        snapshot.machineState.step == PrinterHomologationStep.RASTER_THROUGHPUT ->
            RasterThroughputStep(
                snapshot = snapshot,
                theme = theme,
                send = { runSendingAction { runtime.flow.sendCurrentProbe() } },
                answer = { runAction { runtime.flow.answer(it) } },
                answerPrintedInFull = {
                    runAction(runtime.flow::answerRasterThroughputPrintedInFull)
                },
                skipMeasurement = {
                    runAction(runtime.flow::skipRasterThroughputMeasurement)
                },
                onValidationFailure = { localFailure = it },
                goBack = { runAction(runtime.flow::goBack) },
            )
        // Mesma dependência que põe a etapa depois da vazão na máquina: a largura de módulo sai da
        // área imprimível medida, e a tela precisa da mesma sonda para poder desenhar os dois blocos.
        snapshot.machineState.step == PrinterHomologationStep.NATIVE_CODE ->
            NativeCodeStep(
                snapshot = snapshot,
                theme = theme,
                send = { runSendingAction { runtime.flow.sendCurrentProbe() } },
                answer = { runAction { runtime.flow.answer(it) } },
                skipMeasurement = { runAction(runtime.flow::skipNativeCodeMeasurement) },
                goBack = { runAction(runtime.flow::goBack) },
            )
        snapshot.machineState.step == PrinterHomologationStep.CODE_PAGE ->
            CodePageStep(
                snapshot = snapshot,
                theme = theme,
                send = { runSendingAction { runtime.flow.sendCurrentProbe() } },
                answer = { runAction { runtime.flow.answer(it) } },
                goBack = { runAction(runtime.flow::goBack) },
            )
        snapshot.machineState.step == PrinterHomologationStep.CUT_PROTOCOL ->
            CutProtocolStep(
                snapshot = snapshot,
                theme = theme,
                send = { runSendingAction { runtime.flow.sendAllCutProbes() } },
                answerPresence = { runAction { runtime.flow.answerCutterPresence(it) } },
                choose = { runAction { runtime.flow.chooseCutProtocol(it) } },
                goBack = { runAction(runtime.flow::goBack) },
            )
        snapshot.machineState.step == PrinterHomologationStep.CUT_FEED ->
            CutFeedStep(
                snapshot = snapshot,
                theme = theme,
                // O aviso já diz o que vai sair; um diálogo em cima disso é a mesma pergunta duas
                // vezes. Quem não quer as oito tiras pula, e o botão diz o que pular custa.
                requestBenchConfirmation = { runSendingAction { runtime.flow.confirmCutFeedBenchAndSend() } },
                skipMeasurement = { runAction(runtime.flow::skipCutFeedMeasurement) },
                acceptZero = { runAction(runtime.flow::acceptAutomaticCutFeed) },
                answer = { runAction { runtime.flow.answer(it) } },
                goBack = { runAction(runtime.flow::goBack) },
            )
    }

    val drawerActionEnabled =
        !drawerActionSending &&
            snapshot.machineState.phase != PrinterHomologationPhase.SENDING &&
            snapshot.flowPhase !in
                setOf(
                    PrinterHomologationFlowPhase.SENDING_FINAL_RECEIPT,
                    PrinterHomologationFlowPhase.ADOPTING,
                    PrinterHomologationFlowPhase.FINISHED,
                )
    if (snapshot.flowPhase != PrinterHomologationFlowPhase.FINISHED) {
        DrawerActionPanel(
            sending = drawerActionSending,
            enabled = drawerActionEnabled,
            result = drawerActionResult,
            onPrepare = { showDrawerConfirmation = true },
            theme = theme,
        )
    }

    if (snapshot.flowPhase != PrinterHomologationFlowPhase.FINISHED) {
        OutlinedButton(
            onClick = onCancel,
            enabled = cancelEnabled,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.homologation.cancel"),
        ) {
            Text("Cancelar teste")
        }
    }

    if (showDrawerConfirmation) {
        AlertDialog(
            onDismissRequest = { showDrawerConfirmation = false },
            modifier = Modifier.testTag("thermal-printer.homologation.drawer.dialog"),
            title = { Text("Abrir a gaveta agora?") },
            text = {
                Text(
                    "A gaveta pode se abrir imediatamente e expor dinheiro. Afaste pessoas e " +
                        "objetos da frente dela. O comando não mede nem salva a presença de gaveta.",
                )
            },
            confirmButton = {
                Button(
                    onClick = ::sendDrawerKickPulse,
                    modifier =
                        Modifier.testTag(
                            "thermal-printer.homologation.drawer.confirm",
                        ),
                ) {
                    Text("Abrir gaveta agora")
                }
            },
            dismissButton = {
                TextButton(onClick = { showDrawerConfirmation = false }) {
                    Text("Cancelar")
                }
            },
        )
    }
}

@Composable
private fun DrawerActionPanel(
    sending: Boolean,
    enabled: Boolean,
    result: String?,
    onPrepare: () -> Unit,
    theme: ThermalPrinterTheme,
) {
    StepCard(
        title = "Ação avulsa: gaveta",
        tag = "thermal-printer.homologation.drawer",
        theme = theme,
    ) {
        Text(
            "Não faz parte da homologação e não altera o perfil. Sem uma gaveta conhecida " +
                "ligada, a ausência de movimento não permite concluir se esta impressora tem porta.",
        )
        OutlinedButton(
            onClick = onPrepare,
            enabled = enabled,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.homologation.drawer.prepare"),
        ) {
            Text(if (sending) "Enviando comando…" else "Preparar abertura da gaveta")
        }
        result?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun HomologationProgress(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
) {
    val current = snapshot.machineState.step
    val labels =
        buildList {
            add(PrinterHomologationStep.WIDTH to "Largura")
            if (snapshot.path == PrinterHomologationPath.ADVANCED) {
                add(PrinterHomologationStep.GEOMETRY to "Geometria avançada")
            }
            addAll(
                listOf(
                    PrinterHomologationStep.RASTER_THROUGHPUT to "Altura da imagem",
                    // Mesma posição da máquina: depois da vazão, porque a largura de módulo sai da
                    // área imprimível medida; antes do corte, porque não depende de guilhotina.
                    PrinterHomologationStep.NATIVE_CODE to "Código nativo",
                    PrinterHomologationStep.CUT_PROTOCOL to "Corte",
                    PrinterHomologationStep.CUT_FEED to "Avanço",
                    PrinterHomologationStep.CODE_PAGE to "Texto",
                ),
            )
        }
    Column(
        modifier = Modifier.fillMaxWidth().testTag("thermal-printer.homologation.progress"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        labels.forEachIndexed { index, (step, label) ->
            val marker =
                when {
                    current.ordinal > step.ordinal -> "✓"
                    current == step -> "●"
                    else -> "○"
                }
            Text(
                "$marker ${index + 1}. $label",
                style = MaterialTheme.typography.bodySmall,
                color =
                    if (current == step) {
                        theme.accentColor
                    } else {
                        theme.cardContentColor.copy(alpha = 0.72f)
                    },
                fontWeight = if (current == step) FontWeight.SemiBold else FontWeight.Normal,
            )
        }
    }
}

/**
 * O "Voltar" da etapa, onde as ações dela moram.
 *
 * Some sozinho quando não há o que desfazer — a primeira etapa, um envio em curso, uma falha
 * pendente —, porque quem responde isso é a máquina, não uma contagem de etapas guardada aqui. O
 * aviso abaixo do botão anuncia o papel antes do toque; voltar em si não imprime nada.
 *
 * As cores são fixadas no tema do kit em vez de herdadas do `colorScheme` do hospedeiro. Era o
 * único botão acionável da homologação sem cor própria: num host de primária apagada ele saía
 * cinza, do jeito que um botão desabilitado sai, e quem via a largura errada não tentava tocar.
 * Relatado no iPhone 7 em 20/08. O contorno mantém a hierarquia — a ação principal da etapa
 * continua sendo a única preenchida — e o desabilitado continua apagado, pelo padrão do Material.
 */
@Composable
private fun StepBackButton(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    onBack: () -> Unit,
) {
    if (!snapshot.offersBackStep) return
    OutlinedButton(
        onClick = onBack,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = theme.accentColor),
        border = BorderStroke(1.dp, theme.accentColor),
        modifier =
            Modifier
                .fillMaxWidth()
                .testTag("thermal-printer.homologation.back"),
    ) {
        Text("Voltar", fontWeight = FontWeight.SemiBold)
    }
    snapshot.backStepNotice()?.let { notice ->
        Text(
            notice,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("thermal-printer.homologation.back.notice"),
        )
    }
}

@Composable
private fun WidthStep(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    send: () -> Unit,
    choose: (Int) -> Unit,
    chooseNone: () -> Unit,
) {
    // A primeira etapa não oferece "Voltar": não existe premissa anterior para desfazer, e a saída
    // daqui continua sendo "Cancelar teste".
    StepCard(
        title = "1. Largura",
        tag = "thermal-printer.homologation.width",
        theme = theme,
    ) {
        if (snapshot.machineState.phase == PrinterHomologationPhase.READY) {
            Text("Vamos imprimir uma comparação curta de 58 mm e 80 mm.")
            ProbeSendButton(
                label = "Imprimir réguas de 58 e 80 mm",
                tag = "thermal-printer.homologation.width.send",
                theme = theme,
                onClick = send,
            )
        } else {
            Text("Qual medida ficou certa no seu papel?")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(58, 80).forEach { width ->
                    Button(
                        onClick = { choose(width) },
                        modifier = Modifier.weight(1f).testTag("thermal-printer.homologation.width.$width"),
                    ) {
                        Text("$width mm")
                    }
                }
            }
            Button(
                onClick = chooseNone,
                modifier = Modifier.fillMaxWidth().testTag("thermal-printer.homologation.width.none"),
            ) { Text("Nenhum") }
            Text(
                "Nenhum imprime uma única régua textual de 24 a 64 colunas e uma régua raster de 256 a 640 dots.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun GeometryStep(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    send: () -> Unit,
    answer: (PrinterHomologationAnswer.Geometry) -> Unit,
    onValidationFailure: (String) -> Unit,
    goBack: () -> Unit,
) {
    StepCard(
        title = "1. Geometria",
        tag = "thermal-printer.homologation.geometry",
        theme = theme,
    ) {
        if (snapshot.machineState.phase == PrinterHomologationPhase.READY) {
            Text("Será impressa uma única régua completa: 24–64 colunas e 256–640 dots.")
            ProbeSendButton(
                label = "Imprimir régua de geometria",
                tag = "thermal-printer.homologation.geometry.send",
                theme = theme,
                onClick = send,
            )
        } else if (snapshot.acceptsHumanAnswer) {
            var columnsText by
                remember(snapshot.machineState) {
                    mutableStateOf(snapshot.geometry.printableColumns.toString())
                }
            var selectedDots by
                remember(snapshot.machineState) {
                    mutableStateOf(snapshot.geometry.printableDots)
                }
            val dotChoices =
                remember { (256..640 step 32).toList() }
            val maxPrintedColumns = 64

            Text(
                "Informe a última coluna textual que saiu inteira. Depois escolha a maior faixa " +
                    "raster cuja borda esquerda e direita apareceram completas.",
            )
            OutlinedTextField(
                value = columnsText,
                onValueChange = { columnsText = it.filter(Char::isDigit).take(2) },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.homologation.geometry.columns"),
                label = { Text("Última coluna inteira") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
            )
            dotChoices.forEach { dots ->
                OutlinedButton(
                    onClick = { selectedDots = dots },
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.geometry.dots-$dots"),
                ) {
                    Text(if (selectedDots == dots) "● $dots dots" else "$dots dots")
                }
            }
            val columns = columnsText.toIntOrNull()
            val qrWidth =
                if (columns == null) 0 else MeasuredProfile.qrWidthDots(columns, selectedDots)
            Text(
                "QR raster resultante: $qrWidth dots (mínimo seguro: " +
                    "${MeasuredProfile.MIN_SAFE_RASTER_QR_DOTS}).",
                style = MaterialTheme.typography.bodySmall,
            )
            Button(
                onClick = {
                    when {
                        columns == null || columns !in 24..maxPrintedColumns ->
                            onValidationFailure(
                                "Escolha uma coluna que apareceu na régua impressa (24 a " +
                                    "$maxPrintedColumns).",
                            )
                        qrWidth < MeasuredProfile.MIN_SAFE_RASTER_QR_DOTS ->
                            onValidationFailure(
                                "A área escolhida é menor que o mínimo seguro do QR raster.",
                            )
                        else ->
                            answer(
                                PrinterHomologationAnswer.Geometry(
                                    paperWidthMm = if (columns <= 32 && selectedDots <= 384) 58 else 80,
                                    printableColumns = columns,
                                    printableDots = selectedDots,
                                ),
                            )
                    }
                },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.homologation.geometry.answer"),
            ) {
                Text("Confirmar geometria do papel")
            }
        }
        StepBackButton(snapshot, theme, goBack)
    }
}

/**
 * A etapa que mede vazão: uma tira de altura conhecida, e a régua responde.
 *
 * A pergunta é a mesma das etapas de geometria — "o que você mediu no papel?" —, porque é a única
 * que quem está na frente da impressora consegue responder. Nem a tira nem esta tela dizem quanto
 * ela deveria medir: dizer isso antes é ensinar a resposta.
 */
@Composable
private fun RasterThroughputStep(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    send: () -> Unit,
    answer: (PrinterHomologationAnswer.RasterThroughput) -> Unit,
    answerPrintedInFull: () -> Unit,
    skipMeasurement: () -> Unit,
    onValidationFailure: (String) -> Unit,
    goBack: () -> Unit,
) {
    StepCard(
        title = "2. Altura da imagem",
        tag = "thermal-printer.homologation.raster-throughput",
        theme = theme,
    ) {
        if (snapshot.machineState.phase == PrinterHomologationPhase.READY) {
            Text(
                "Sai uma tira cinza de largura cheia. Há impressora que imprime toda imagem mais " +
                    "baixa do que ela é, sem avisar — a foto sai achatada e o QR pode não ler. " +
                    "Medir esta tira é o que descobre isso, e o app passa a corrigir sozinho.",
            )
            ProbeSendButton(
                label = "Imprimir a tira cinza",
                tag = "thermal-printer.homologation.raster-throughput.send",
                theme = theme,
                onClick = send,
            )
        } else if (snapshot.acceptsHumanAnswer) {
            val expectedMm = PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_MM
            var lengthText by remember(snapshot.machineState) { mutableStateOf("") }

            Text(
                "Meça a altura do bloco cinza, do traço de cima ao traço de baixo, e informe em " +
                    "milímetros. Se ele saiu do tamanho certo, use o botão abaixo.",
            )
            OutlinedTextField(
                value = lengthText,
                onValueChange = { lengthText = it.filter(Char::isDigit).take(3) },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.homologation.raster-throughput.length"),
                label = { Text("Altura medida (mm)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
            )
            Button(
                onClick = {
                    val millimetres = lengthText.toIntOrNull()
                    if (millimetres == null || millimetres !in 1..expectedMm) {
                        onValidationFailure(
                            "Informe a altura medida em milímetros, entre 1 e $expectedMm. A " +
                                "tira não sai maior do que foi enviada.",
                        )
                    } else {
                        answer(PrinterHomologationAnswer.RasterThroughput(millimetres))
                    }
                },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.homologation.raster-throughput.answer"),
            ) {
                Text("Confirmar a medida")
            }
            OutlinedButton(
                onClick = answerPrintedInFull,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.homologation.raster-throughput.full"),
            ) {
                Text("Saiu do tamanho certo")
            }
            // Esta é a única etapa que pede uma régua de fora; as outras se leem na própria tira.
            // Sem saída, quem não tem régua chutaria um número — e chute vira teto gravado.
            OutlinedButton(
                onClick = skipMeasurement,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.homologation.raster-throughput.skip"),
            ) {
                Text("Usar padrão")
            }
            Text(
                "Sem régua por perto? \"Usar padrão\" deixa a imagem exatamente como sai hoje. " +
                    "Em modelos que encolhem, as imagens continuam saindo mais baixas — dá para " +
                    "medir depois, homologando a impressora de novo.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        StepBackButton(snapshot, theme, goBack)
    }
}

/**
 * A etapa que mede se a firmware desenha QR e código de barras nativos, ou os troca por texto.
 *
 * Uma pergunta por bloco, porque `GS ( k` e `GS k` são comandos de gerações diferentes e nada
 * obriga uma firmware a atender os dois — uma impressora pode desenhar um e trocar o outro por
 * letras. "Saiu texto, ou não saiu nada" fica junto numa única opção porque as duas coisas
 * significam a mesma coisa para o perfil: o comando não produziu código, e separá-las pediria um
 * julgamento que não muda o resultado. "Não consigo dizer" grava os dois campos ausentes, sem
 * palpite — um palpite errado faria o app oferecer o comando nativo numa firmware que imprime o
 * payload como texto no meio do cupom.
 */
@Composable
private fun NativeCodeStep(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    send: () -> Unit,
    answer: (PrinterHomologationAnswer.NativeCode) -> Unit,
    skipMeasurement: () -> Unit,
    goBack: () -> Unit,
) {
    StepCard(
        title = "3. Código nativo",
        tag = "thermal-printer.homologation.native-code",
        theme = theme,
    ) {
        if (snapshot.machineState.phase == PrinterHomologationPhase.READY) {
            Text(
                "Sai uma tira com duas figuras: um QR e um código de barras, pedidos direto à " +
                    "impressora. Há firmware que não entende esses comandos e imprime letras no " +
                    "lugar da figura — esta tira é o que descobre isso.",
            )
            ProbeSendButton(
                label = "Imprimir a tira das duas figuras",
                tag = "thermal-printer.homologation.native-code.send",
                theme = theme,
                onClick = send,
            )
        } else if (snapshot.acceptsHumanAnswer) {
            // Começam em "saiu figura" porque é o caso comum, e porque nenhum dos dois vira perfil
            // sem alguém tocar em "Confirmar o que saiu": quem não sabe dizer usa "Não consigo
            // dizer", que grava a ausência nos dois campos. Espelha a decisão do iOS.
            var qrHonored by remember(snapshot.machineState) { mutableStateOf(true) }
            var barcodeHonored by remember(snapshot.machineState) { mutableStateOf(true) }

            Text("O que saiu em cada figura?")
            Text(
                "Se no lugar da figura saiu a palavra SONDA em letras, ou não saiu nada, escolha " +
                    "a segunda opção.",
                style = MaterialTheme.typography.bodySmall,
            )

            Text("1) O QR", fontWeight = FontWeight.SemiBold)
            ChoiceButton(
                label = "Saiu um QR quadrado",
                tag = "thermal-printer.homologation.native-code.qr-yes",
                onClick = { qrHonored = true },
                selected = qrHonored,
            )
            ChoiceButton(
                label = "Saiu texto, ou não saiu nada",
                tag = "thermal-printer.homologation.native-code.qr-no",
                onClick = { qrHonored = false },
                selected = !qrHonored,
            )

            Text("2) O código de barras", fontWeight = FontWeight.SemiBold)
            ChoiceButton(
                label = "Saiu um código de barras",
                tag = "thermal-printer.homologation.native-code.barcode-yes",
                onClick = { barcodeHonored = true },
                selected = barcodeHonored,
            )
            ChoiceButton(
                label = "Saiu texto, ou não saiu nada",
                tag = "thermal-printer.homologation.native-code.barcode-no",
                onClick = { barcodeHonored = false },
                selected = !barcodeHonored,
            )

            Button(
                onClick = { answer(PrinterHomologationAnswer.NativeCode(qrHonored, barcodeHonored)) },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.homologation.native-code.answer"),
            ) {
                Text("Confirmar o que saiu")
            }
            // Quem não sabe dizer não pode ser empurrado a escolher: palpite vira capacidade
            // gravada, e capacidade gravada errada faz o app oferecer um comando que a firmware
            // imprimiria como texto no meio do cupom.
            OutlinedButton(
                onClick = skipMeasurement,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.homologation.native-code.skip"),
            ) {
                Text("Não consigo dizer")
            }
        }
        StepBackButton(snapshot, theme, goBack)
    }
}

@Composable
private fun CodePageStep(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    send: () -> Unit,
    answer: (PrinterHomologationAnswer.CodePage) -> Unit,
    goBack: () -> Unit,
) {
    StepCard(
        title = "6. Texto e acentos",
        tag = "thermal-printer.homologation.code-page",
        theme = theme,
    ) {
        if (snapshot.machineState.phase == PrinterHomologationPhase.READY) {
            // O número é o desta impressora, e a conta é da própria sonda: com as maiúsculas a
            // amostra passou a ocupar duas linhas nas duas larguras, e contar candidatas mentiria.
            val lines =
                PrinterHomologationProbes.codePageProbeLineCount(snapshot.geometry.printableColumns)
            Text(
                // Teto, não previsão: firmware que engole byte alto imprime a letra e mais nada,
                // e a tira sai bem menor. Medido na MTP-II em 12/08 — 21 linhas em branco.
                "Sai uma tira de até $lines linhas, uma por letra, todas com os mesmos acentos — " +
                    "minúsculas e MAIÚSCULAS. Linha em branco é resposta: aquele endereço não " +
                    "imprimiu nada. A linha a) sai sem acento nenhum, e é a resposta de quando " +
                    "nada mais der certo.",
            )
            ProbeSendButton(
                label = "Imprimir até $lines linhas",
                tag = "thermal-printer.homologation.code-page.send",
                theme = theme,
                onClick = send,
            )
        } else if (snapshot.acceptsHumanAnswer) {
            Text(
                "Escolha a letra da primeira linha em que **todos** os acentos saíram — as " +
                    "maiúsculas também. Se nenhuma outra saiu, a linha a) é a resposta.",
            )
            // Só a letra, como no papel. Nome de página e endereço são vocabulário nosso e só
            // aparecem no comprovante final, onde servem ao catálogo.
            PrinterHomologationProbes.codePageCandidates.forEach { candidate ->
                ChoiceButton(
                    label = "Linha ${candidate.letter}",
                    tag = "thermal-printer.homologation.code-page-${candidate.letter}",
                    onClick = {
                        answer(PrinterHomologationAnswer.CodePage(candidate.letter))
                    },
                )
            }
        }
        StepBackButton(snapshot, theme, goBack)
    }
}

@Composable
private fun CutProtocolStep(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    send: () -> Unit,
    answerPresence: (PrinterCutterPresence) -> Unit,
    choose: (CutProtocol) -> Unit,
    goBack: () -> Unit,
) {
    StepCard(
        title = "4. Protocolo de corte",
        tag = "thermal-printer.homologation.cut-protocol",
        theme = theme,
    ) {
        when {
            snapshot.cutStage == PrinterCutProbeStage.ASKING_PRESENCE -> {
                Text("Sua impressora corta o papel sozinha?")
                listOf(
                    PrinterCutterPresence.YES to "Sim",
                    PrinterCutterPresence.NO to "Não",
                    PrinterCutterPresence.UNKNOWN to "Não sei",
                ).forEach { (presence, label) ->
                    ChoiceButton(
                        label = label,
                        tag = "thermal-printer.homologation.cutter-${presence.name.lowercase()}",
                        onClick = { answerPresence(presence) },
                    )
                }
            }
            snapshot.cutStage == PrinterCutProbeStage.SELECTING_ADVANCED_RESULT -> {
                // A escolha é à vista de todas as tiras. Perguntar tira a tira pedia julgamento
                // sobre uma tira só, e a pessoa não tinha com o que comparar.
                // Com uma tira só não há o que comparar, e não há número impresso nela: a
                // pergunta vira "cortou?". Os rótulos seguem o papel que saiu.
                val umaTiraSo = snapshot.attemptedCutProtocols.size == 1
                Text(
                    if (umaTiraSo) {
                        "A tira saiu. Ela se separou do rolo?"
                    } else {
                        "Compare as tiras. Escolha o corte que você quer usar em toda venda — o " +
                            "número está impresso em cada uma."
                    },
                )
                snapshot.attemptedCutProtocols.forEachIndexed { index, protocol ->
                    ChoiceButton(
                        label = if (umaTiraSo) "Cortou" else "Corte ${index + 1}",
                        tag = "thermal-printer.homologation.cut-protocol-${protocol.name.lowercase()}",
                        onClick = { choose(protocol) },
                    )
                }
                ChoiceButton(
                    label = if (umaTiraSo) "Não cortou" else "Nenhuma cortou",
                    tag = "thermal-printer.homologation.cut-protocol-none",
                    onClick = { choose(CutProtocol.NONE) },
                )
            }
            snapshot.machineState.phase == PrinterHomologationPhase.READY -> {
                val total = snapshot.attemptedCutProtocols.size
                // A série ESC/POS manda seis comandos; a Procomp manda um só, porque os dois cortes
                // medidos naquela firmware cortam igual e o emissor manda `ESC w` de qualquer jeito.
                // "1 tiras" na tela é a costura aparecendo, e a frase muda com o número.
                Text(
                    if (total == 1) {
                        "Vamos imprimir uma tira com o comando de corte desta impressora. Depois " +
                            "você diz se ela cortou."
                    } else {
                        "Vamos imprimir $total tiras, uma por comando de corte, numeradas. Depois " +
                            "você escolhe qual corte ficou do jeito que você quer."
                    },
                )
                ProbeSendButton(
                    label = if (total == 1) "Imprimir a tira de corte" else "Imprimir as $total tiras de corte",
                    tag = "thermal-printer.homologation.cut-protocol.send",
                    theme = theme,
                    onClick = send,
                )
            }
        }
        StepBackButton(snapshot, theme, goBack)
    }
}

@Composable
private fun CutFeedStep(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    requestBenchConfirmation: () -> Unit,
    skipMeasurement: () -> Unit,
    acceptZero: () -> Unit,
    answer: (PrinterHomologationAnswer.CutFeed) -> Unit,
    goBack: () -> Unit,
) {
    StepCard(
        title = "5. Avanço antes do corte",
        tag = "thermal-printer.homologation.cut-feed",
        theme = theme,
    ) {
        when {
            snapshot.cutFeedChoices == listOf(0) && snapshot.acceptsHumanAnswer -> {
                Text(
                    if (snapshot.cutProtocol == CutProtocol.NONE) {
                        "Sem guilhotina, o avanço medido desta etapa é zero e nenhuma tira extra " +
                            "será impressa."
                    } else {
                        "Este protocolo já leva a alimentação medida no próprio comando. O avanço " +
                            "separado é zero e nenhuma tira extra será impressa."
                    },
                )
                Button(
                    onClick = acceptZero,
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.cut-feed-zero"),
                ) {
                    Text("Confirmar avanço zero")
                }
            }
            snapshot.machineState.phase == PrinterHomologationPhase.READY -> {
                // Nenhum valor chega escolhido: a distância entre a cabeça e a lâmina é física de
                // cada impressora, e esta etapa existe para medi-la. Pular é decisão explícita, e
                // o que entra é o palpite de outra bancada — dito com essas palavras.
                Text(PrinterHomologationProbes.CUT_FEED_BENCH_WARNING)
                ProbeSendButton(
                    label = "Imprimir",
                    tag = "thermal-printer.homologation.cut-feed.prepare",
                    theme = theme,
                    onClick = requestBenchConfirmation,
                )
                ChoiceButton(
                    label = "Pular (usa 5 linhas, medido em outra impressora)",
                    tag = "thermal-printer.homologation.cut-feed.skip",
                    onClick = skipMeasurement,
                )
            }
            snapshot.acceptsHumanAnswer -> {
                Text(
                    "Cada tira traz o número no início e logo antes da linha de referência. " +
                        "Escolha o menor avanço que não cortou o texto.",
                )
                snapshot.cutFeedChoices.forEach { lines ->
                    ChoiceButton(
                        label = "$lines linhas",
                        tag = "thermal-printer.homologation.cut-feed-$lines",
                        onClick = { answer(PrinterHomologationAnswer.CutFeed(lines)) },
                    )
                }
            }
        }
        StepBackButton(snapshot, theme, goBack)
    }
}

@Composable
private fun SendingPanel(theme: ThermalPrinterTheme) {
    StepCard(
        title = "Enviando sonda",
        tag = "thermal-printer.homologation.sending",
        theme = theme,
    ) {
        CircularProgressIndicator(color = theme.accentColor)
        Text(
            "A resposta ficará disponível somente depois que o transporte concluir o callback.",
        )
    }
}

@Composable
private fun ProbeFailurePanel(
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    onRetry: () -> Unit,
) {
    val failure = requireNotNull(snapshot.machineState.failure)
    StepCard(
        title = "A sonda não foi concluída",
        tag = "thermal-printer.homologation.failure",
        theme = theme,
    ) {
        Text(failure.message)
        if (failure.delivery == ThermalPrintDelivery.INDETERMINATE) {
            NoticeCard(
                title = "Resultado indeterminado",
                body =
                    "A transmissão começou. Confira o papel e só prepare outra tentativa se " +
                        "tiver certeza de que a sonda não saiu.",
                tone = NoticeTone.DANGER,
                theme = theme,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        OutlinedButton(
            onClick = onRetry,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.homologation.failure.retry"),
        ) {
            Text(
                if (failure.delivery == ThermalPrintDelivery.INDETERMINATE) {
                    "Não saiu — preparar nova tentativa"
                } else {
                    "Preparar nova tentativa"
                },
            )
        }
    }
}

@Composable
private fun FinalReceiptPanel(
    runtime: HomologationRuntime,
    snapshot: PrinterHomologationUiSnapshot,
    theme: ThermalPrinterTheme,
    runAction: (() -> Unit) -> Unit,
    runSendingAction: ((() -> Unit)?, suspend () -> Unit) -> Unit,
    onValidationFailure: (String) -> Unit,
    onFinished: () -> Unit,
    goBack: () -> Unit,
    profileActions: (@Composable (MeasuredProfile) -> Unit)?,
    localOnlyCopy: PrinterHomologationLocalOnlyCopy,
) {
    val profile = requireNotNull(snapshot.measuredProfile)
    // O campo já vem preenchido com o nome que a impressora declarou na busca — o mesmo que o
    // diálogo de permissão do Android mostra. Vinha vazio, e o rodapé dizia "em branco mantém o
    // nome atual" sem mostrar qual era: quem chegava aqui via "Impressora temporária" no resumo e
    // não tinha como saber que o aparelho já tinha se identificado.
    var profileName by
        remember(runtime, snapshot.measuredProfile?.id) {
            mutableStateOf(snapshot.measuredProfile?.displayName.orEmpty())
        }
    var profileNameInvalid by remember(runtime) { mutableStateOf(false) }
    StepCard(
        title =
            if (snapshot.flowPhase == PrinterHomologationFlowPhase.FINISHED) {
                "Pronto! Sua impressora está configurada."
            } else {
                "Comprovante final"
            },
        tag = "thermal-printer.homologation.done",
        theme = theme,
    ) {
        ProfileSummary(profile)
        when (snapshot.flowPhase) {
            PrinterHomologationFlowPhase.FINAL_RECEIPT_READY -> {
                Text(
                    "A configuração ainda está apenas em memória. Imprima o comprovante final e confira " +
                        "texto, acentos, QR, avanço e corte.",
                )
                ProbeSendButton(
                    label = "Imprimir comprovante final",
                    tag = "thermal-printer.homologation.final.send",
                    theme = theme,
                    onClick = {
                        runSendingAction(null) { runtime.flow.sendFinalReceipt() }
                    },
                )
            }
            PrinterHomologationFlowPhase.SENDING_FINAL_RECEIPT -> {
                CircularProgressIndicator(color = theme.accentColor)
                Text("Aguardando o callback real do transporte.")
            }
            PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION -> {
                snapshot.finalReceiptWarning?.let { warning ->
                    NoticeCard(
                        title = "Entrega final indeterminada",
                        body = warning,
                        tone = NoticeTone.DANGER,
                        theme = theme,
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .testTag(
                                    "thermal-printer.homologation.final.indeterminate",
                                ),
                    )
                }
                Text(
                    "Confira o comprovante final. A configuração só fica neste celular depois " +
                        "da sua confirmação no papel.",
                )
                // A largura é a única capacidade que o roteiro curto não mede: ela vem do palpite
                // da busca. O comprovante final a denuncia, mas só para quem sabe o que procurar —
                // a T210 saiu com "Codificação: Padrão da impressor / a", e a palavra partida era
                // a prova de que 48 colunas não cabem numa firmware de 32.
                Text(
                    "Olhe se alguma palavra quebrou no meio. Palavra partida quer dizer que a " +
                        "largura está maior que a desta impressora — volte e escolha 58 mm.",
                    style = MaterialTheme.typography.bodySmall,
                )
                // Nomear no fim, e não no começo: agora a pessoa sabe qual impressora acabou de
                // produzir o comprovante. O perfil medido deixa de herdar um nome temporário que
                // não distingue as impressoras da bancada.
                OutlinedTextField(
                    value = profileName,
                    onValueChange = {
                        profileName = it
                        profileNameInvalid = false
                    },
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.final.name"),
                    label = { Text("Nome desta impressora") },
                    placeholder = { Text("Ex.: balcão, cozinha, T210") },
                    singleLine = true,
                    isError = profileNameInvalid,
                )
                Text(
                    "É este o nome que vai para a lista. Troque se quiser reconhecer pelo lugar.",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (profileNameInvalid) {
                    Text(
                        "Use um nome local de até 80 caracteres, sem IP, MAC, VID/PID ou UUID.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Button(
                    onClick = {
                        try {
                            runtime.flow.renameFinalProfile(profileName)
                            runSendingAction(
                                if (profileActions == null) {
                                    {
                                        runtime.close()
                                        onFinished()
                                    }
                                } else {
                                    null
                                },
                            ) { runtime.flow.confirmFinalReceipt() }
                        } catch (_: IllegalArgumentException) {
                            profileNameInvalid = true
                            onValidationFailure(
                                "O nome não foi aceito. Informe apenas um nome local para " +
                                    "reconhecer esta impressora.",
                            )
                        } catch (_: IllegalStateException) {
                            onValidationFailure(
                                "A confirmação final não está mais disponível neste estado.",
                            )
                        }
                    },
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.final.correct"),
                    colors =
                        ButtonDefaults.buttonColors(
                            containerColor = theme.accentColor,
                            contentColor = theme.onAccentColor,
                        ),
                ) {
                    Text("Saiu certo")
                }
                OutlinedButton(
                    onClick = {
                        runAction(runtime.flow::restartAfterFinalProblem)
                    },
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.final.problem"),
                ) {
                    Text("Saiu com problema — medir novamente")
                }
                TextButton(
                    onClick = {
                        runAction(runtime.flow::prepareFinalReceiptRetryAfterNotPrinted)
                    },
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.final.not-printed"),
                ) {
                    Text("Não saiu — preparar novo envio")
                }
            }
            PrinterHomologationFlowPhase.ADOPTING -> {
                CircularProgressIndicator(color = theme.accentColor)
                Text(
                    "Salvando a configuração e confirmando a seleção. Nenhum comprovante será " +
                        "reenviado.",
                    modifier = Modifier.testTag("thermal-printer.homologation.final.adopting"),
                )
            }
            PrinterHomologationFlowPhase.FAILED -> {
                val failure = requireNotNull(snapshot.failure)
                when (failure.point) {
                    PrinterHomologationFailurePoint.FINAL_RECEIPT -> {
                        NoticeCard(
                            title =
                                if (failure.delivery == ThermalPrintDelivery.INDETERMINATE) {
                                    "Resultado final indeterminado"
                                } else {
                                    "Comprovante final não enviado"
                                },
                            body =
                                if (failure.delivery == ThermalPrintDelivery.INDETERMINATE) {
                                    "A transmissão começou. Confira o papel e só prepare outra " +
                                        "tentativa se tiver certeza de que o comprovante não saiu."
                                } else {
                                    failure.message
                                },
                            tone =
                                if (failure.delivery == ThermalPrintDelivery.INDETERMINATE) {
                                    NoticeTone.DANGER
                                } else {
                                    NoticeTone.WARNING
                                },
                            theme = theme,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedButton(
                            onClick = { runAction(runtime.flow::retryFinalReceipt) },
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag("thermal-printer.homologation.final.retry"),
                        ) {
                            Text(
                                if (failure.delivery == ThermalPrintDelivery.INDETERMINATE) {
                                    "Não saiu — preparar nova tentativa"
                                } else {
                                    "Preparar nova tentativa"
                                },
                            )
                        }
                    }
                    PrinterHomologationFailurePoint.ADOPTION -> {
                        NoticeCard(
                            title = "Impressora ainda não selecionada",
                            body = failure.message,
                            tone = NoticeTone.WARNING,
                            theme = theme,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedButton(
                            onClick = {
                                runSendingAction(
                                    if (profileActions == null) {
                                        {
                                            runtime.close()
                                            onFinished()
                                        }
                                    } else {
                                        null
                                    },
                                ) { runtime.flow.confirmFinalReceipt() }
                            },
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag(
                                        "thermal-printer.homologation.final.retry-adoption",
                                    ),
                        ) {
                            Text("Tentar salvar novamente, sem reimprimir")
                        }
                    }
                    PrinterHomologationFailurePoint.PROBE -> Unit
                }
            }
            PrinterHomologationFlowPhase.FINISHED -> {
                Text("Já dá para imprimir.")
                // A mesma promessa da abertura, dita de novo no fim. É a mesma frase, e por isso o
                // mesmo campo: injetar uma e esquecer a outra deixaria a tela dizendo duas coisas
                // diferentes sobre o mesmo aparelho. O corpo continua sendo do kit — ele fala de
                // reinstalação e de outro app, não do aparelho.
                NoticeCard(
                    title = localOnlyCopy.localOnlyTitle,
                    body = DEFAULT_LOCAL_ONLY_BODY,
                    tone = NoticeTone.INFO,
                    theme = theme,
                    modifier = Modifier.fillMaxWidth(),
                )
                // O gesto que produz o pacote de contribuição mora aqui, e não numa tela própria,
                // porque quem acabou de homologar é quem tem o que contribuir: o perfil medido está
                // salvo, o papel já foi conferido, e a pessoa ainda está com a impressora na frente.
                // Perfil que não é MEASURED não chega a esta fase, e mesmo assim o painel decide
                // sozinho se aparece — ver `ExportacaoDeContribuicao.preparar`.
                ContribuicaoDaMedicaoPanel(perfil = profile, theme = theme)
                profileActions?.invoke(profile)
                Button(
                    onClick = {
                        runtime.close()
                        onFinished()
                    },
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .testTag("thermal-printer.homologation.finished.use-local"),
                    colors =
                        ButtonDefaults.buttonColors(
                            containerColor = theme.accentColor,
                            contentColor = theme.onAccentColor,
                        ),
                ) {
                    // O rótulo diz em que aparelho a configuração ficou, e isso quem sabe é o
                    // hospedeiro.
                    Text(localOnlyCopy.finishTitle)
                }
            }
            PrinterHomologationFlowPhase.MEASURING -> Unit
        }
        // A tira de acentos é a última medida, e a letra escolhida nela só se prova aqui. Quem lê
        // no comprovante que escolheu errado volta e refaz — enquanto não disser "saiu certo".
        // Depois da confirmação o botão some sozinho: quem responde isso é o fluxo.
        StepBackButton(snapshot, theme, goBack)
    }
}

@Composable
private fun ProfileSummary(profile: MeasuredProfile) {
    Text(
        "${profile.paperWidthMm} mm · ${profile.printableColumns} colunas · " +
            "${profile.printableDots} dots",
        fontWeight = FontWeight.SemiBold,
    )
    Text(
        "Página: ${profile.codePage?.name ?: "Nenhuma"} · " +
            "corte: ${profile.cutProtocol.name} · avanço: ${profile.cutFeedLines}",
        style = MaterialTheme.typography.bodySmall,
    )
    Text(
        "Status: NONE até existir uma sonda própria.",
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
private fun StepCard(
    title: String,
    tag: String,
    theme: ThermalPrinterTheme,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().testTag(tag),
        colors =
            CardDefaults.cardColors(
                containerColor = theme.cardContainerColor,
                contentColor = theme.cardContentColor,
            ),
        border = BorderStroke(1.dp, theme.outlineColor),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun ProbeSendButton(
    label: String,
    tag: String,
    theme: ThermalPrinterTheme,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().testTag(tag),
        colors =
            ButtonDefaults.buttonColors(
                containerColor = theme.accentColor,
                contentColor = theme.onAccentColor,
            ),
    ) {
        Text(label)
    }
}

@Composable
private fun ChoiceButton(
    label: String,
    tag: String,
    onClick: () -> Unit,
    selected: Boolean = false,
) {
    // O seletor de modo precisa mostrar qual lado está valendo antes de a pessoa tocar no bloco:
    // o botão do bloco é que envia a resposta, e ele carrega o modo escolhido junto.
    if (selected) {
        Button(
            onClick = onClick,
            modifier = Modifier.fillMaxWidth().testTag(tag),
        ) {
            Text(label)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            modifier = Modifier.fillMaxWidth().testTag(tag),
        ) {
            Text(label)
        }
    }
}

private sealed interface HomologationRuntimeState {
    data object Loading : HomologationRuntimeState

    data class Ready(val runtime: HomologationRuntime) : HomologationRuntimeState

    data class Unavailable(val message: String) : HomologationRuntimeState
}

private sealed interface PreparedHomologationTargetState {
    data object Loading : PreparedHomologationTargetState

    data class Ready(val target: PrinterHomologationTarget) : PreparedHomologationTargetState

    data class Unavailable(val message: String) : PreparedHomologationTargetState
}

private class HomologationRuntime(
    val displayName: String,
    val transport: PrinterTransport,
    val flow: PrinterHomologationFlow,
) : AutoCloseable {
    override fun close() = flow.close()
}

private val PrinterTransport.uiLabel: String
    get() =
        when (this) {
            PrinterTransport.LOCAL_WIFI -> "Wi-Fi"
            PrinterTransport.USB -> "USB"
            PrinterTransport.BLUETOOTH -> "Bluetooth pareado (SPP)"
            PrinterTransport.BLUETOOTH_LE -> "Bluetooth LE"
        }

private suspend fun runHomologationCall(action: suspend () -> Unit): Result<Unit> =
    try {
        action()
        Result.success(Unit)
    } catch (error: CancellationException) {
        throw error
    } catch (_: Throwable) {
        Result.failure(IllegalStateException("Ação de homologação não concluída."))
    }
