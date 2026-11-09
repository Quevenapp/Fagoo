package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.CutProtocol
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PrinterGeometry
import br.com.thermalprinterkit.PrinterHomologationFlow
import br.com.thermalprinterkit.PrinterHomologationFlowFailure
import br.com.thermalprinterkit.PrinterHomologationFlowPhase
import br.com.thermalprinterkit.PrinterHomologationFlowState
import br.com.thermalprinterkit.PrinterHomologationPath
import br.com.thermalprinterkit.PrinterHomologationPhase
import br.com.thermalprinterkit.PrinterHomologationState
import br.com.thermalprinterkit.PrinterHomologationStep
import br.com.thermalprinterkit.PrinterCutProbeStage

/** Estado somente de apresentação; toda transição sensível continua fechada no fluxo do core. */
internal data class PrinterHomologationUiSnapshot(
    val machineState: PrinterHomologationState,
    val geometry: PrinterGeometry,
    val cutProtocol: CutProtocol,
    val path: PrinterHomologationPath,
    val cutStage: PrinterCutProbeStage,
    val cutProbeProtocol: CutProtocol?,
    val successfulCutProtocols: List<CutProtocol>,
    val attemptedCutProtocols: List<CutProtocol>,
    val cutMeasurementFailed: Boolean,
    val cutFeedChoices: List<Int>,
    val requiresCutFeedBenchConfirmation: Boolean,
    val measuredRasterBytesPerSecond: Int?,
    val verticalRasterScale: Double?,
    val canGoBack: Boolean,
    val previousStep: PrinterHomologationStep?,
    val backReprintsProbes: Boolean,
    val flowPhase: PrinterHomologationFlowPhase,
    val failure: PrinterHomologationFlowFailure?,
    val measuredProfile: MeasuredProfile?,
    val finalReceiptWarning: String?,
)

internal fun PrinterHomologationFlow.uiSnapshot(
    state: PrinterHomologationFlowState,
): PrinterHomologationUiSnapshot =
    PrinterHomologationUiSnapshot(
        machineState = state.machineState,
        // Vem do estado publicado, não da máquina viva: é o que faz a tela redesenhar quando a
        // largura muda sem mudar mais nada.
        geometry = state.geometry,
        // Todas as decisões que podem manter a mesma etapa pertencem ao snapshot publicado. Ler a
        // máquina viva aqui faria o StateFlow engolir, por igualdade, a resposta gratuita "Sim".
        cutProtocol = state.cutProtocol,
        path = state.path,
        cutStage = state.cutStage,
        cutProbeProtocol = state.cutProbeProtocol,
        successfulCutProtocols = state.successfulCutProtocols,
        attemptedCutProtocols = state.attemptedCutProtocols,
        cutMeasurementFailed = state.cutMeasurementFailed,
        cutFeedChoices = state.cutFeedChoices,
        requiresCutFeedBenchConfirmation = state.requiresCutFeedBenchConfirmation,
        measuredRasterBytesPerSecond = state.measuredRasterBytesPerSecond,
        verticalRasterScale = state.verticalRasterScale,
        // O retrocesso também vem do estado publicado: quem decide se há etapa anterior é a
        // máquina, e a tela não guarda uma segunda contagem de etapas ao lado dela.
        canGoBack = state.canGoBack,
        previousStep = state.previousStep,
        backReprintsProbes = state.backReprintsProbes,
        flowPhase = state.phase,
        failure = state.failure,
        measuredProfile = state.measuredProfile,
        finalReceiptWarning = state.finalReceiptWarning,
    )

internal val PrinterHomologationUiSnapshot.acceptsHumanAnswer: Boolean
    get() =
        flowPhase == PrinterHomologationFlowPhase.MEASURING &&
            machineState.phase == PrinterHomologationPhase.AWAITING_RESPONSE

/**
 * Habilitação do "Voltar" da etapa, do jeito que a tela pergunta.
 *
 * A resposta inteira é da máquina e do fluxo; aqui ela só ganha o nome que o botão usa. A primeira
 * etapa não tem o que desfazer, e no meio de um envio ou de uma falha pendente o retrocesso não
 * aparece. O comprovante final oferece até a confirmação humana, e não depois dela.
 */
internal val PrinterHomologationUiSnapshot.offersBackStep: Boolean
    get() = canGoBack && previousStep != null

/** Rótulo da etapa, o mesmo do roteiro de progresso, para o aviso dizer para onde o toque leva. */
internal fun PrinterHomologationStep.uiLabel(): String =
    when (this) {
        PrinterHomologationStep.WIDTH -> "Largura"
        PrinterHomologationStep.GEOMETRY -> "Geometria avançada"
        PrinterHomologationStep.RASTER_THROUGHPUT -> "Altura da imagem"
        PrinterHomologationStep.NATIVE_CODE -> "Código nativo"
        PrinterHomologationStep.CUT_PROTOCOL -> "Corte"
        PrinterHomologationStep.CUT_FEED -> "Avanço"
        PrinterHomologationStep.CODE_PAGE -> "Texto"
        PrinterHomologationStep.DONE -> "Comprovante final"
    }

/**
 * O que a pessoa lê antes de tocar em "Voltar".
 *
 * O papel gasto é anunciado antes: a etapa reaberta imprime de novo quando ela avançar por ali, e
 * a frase diz isso antes do toque, não depois da tira sair.
 */
internal fun PrinterHomologationUiSnapshot.backStepNotice(): String? {
    val target = previousStep?.takeIf { canGoBack } ?: return null
    val base = "Volta para ${target.uiLabel()} e apaga as respostas desta etapa em diante."
    return if (backReprintsProbes) "$base As tiras desta etapa sairão de novo." else base
}
