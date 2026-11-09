package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalPrinterState

/**
 * O que a lista de impressoras aceita num instante, unidade por unidade.
 *
 * Gêmeo do `PrinterUnitAvailability` do iOS, e existe pelo mesmo defeito. Medido no iPhone 7 em
 * 21/08: quatro impressoras instaladas — três Bluetooth e a de rede, que era a ativa e estava
 * desligada — e a tela **inteira** ficava cinza, os "Testar", as engrenagens, as lixeiras e o
 * "Adicionar impressora". Aqui o estado do kit é um só para todos os transportes, então `busy`
 * fazia isso por construção: uma varredura Wi-Fi desabilitava os cards Bluetooth, e o inverso.
 *
 * Três regras saem daí, e é para prová-las sem Compose que elas moram fora da tela:
 *
 * 1. **Ocupação é do transporte que está ocupado.** Bytes a caminho por um meio físico não dizem
 *    nada sobre as unidades do outro.
 * 2. **Procurar não é ocupar.** Varredura não escreve no fio; ela informa, e não fecha ação
 *    nenhuma.
 * 3. **Saída de emergência não desabilita.** Excluir e adicionar são o único caminho de volta
 *    quando a ativa não responde.
 *
 * O que continua bloqueando é o que sempre precisou: um envio em curso naquele transporte — a
 * conexão em memória é uma só por meio físico, e um segundo envio seria o segundo cupom na mesma
 * impressora — e a confirmação do papel pendente.
 */
internal data class PrinterUnitActivity(
    /** Esta unidade já é a que recebe os recibos. */
    val isActive: Boolean = false,
    /** O transporte **desta** unidade está com bytes a caminho. */
    val transportIsSending: Boolean = false,
    /**
     * Um comprovante de card está a caminho por este transporte, de qualquer unidade dele: mirar
     * outra moveria a conexão em memória no meio do envio.
     */
    val receiptIsUnderwayOnTransport: Boolean = false,
    /** A pergunta do papel está aberta. */
    val setupIsOpen: Boolean = false,
)

internal object PrinterUnitAvailability {
    /**
     * Trocar quem recebe os recibos. Fechada só quando esta já é a ativa ou quando um envio deste
     * transporte está em curso.
     */
    fun allowsActivation(activity: PrinterUnitActivity): Boolean =
        !activity.isActive && !activity.sending()

    /** Mandar o comprovante desta unidade. */
    fun allowsTest(activity: PrinterUnitActivity): Boolean = !activity.sending()

    /** Abrir as opções operacionais desta unidade. */
    fun allowsConfiguration(activity: PrinterUnitActivity): Boolean = !activity.sending()

    /**
     * Sempre. Excluir é a saída de emergência: com a ativa inalcançável, é por ela que a pessoa
     * volta a ter uma impressora.
     */
    fun allowsRemoval(activity: PrinterUnitActivity): Boolean = true

    /**
     * Sempre, e pelo mesmo motivo: sem esta porta, quem tem só uma impressora e ela não responde
     * fica sem caminho nenhum.
     */
    fun allowsAddingPrinter(activity: PrinterUnitActivity): Boolean = true

    private fun PrinterUnitActivity.sending(): Boolean =
        transportIsSending || receiptIsUnderwayOnTransport || setupIsOpen
}

/**
 * Bytes a caminho, e não varredura.
 *
 * As buscas ficaram de fora de propósito: elas não escrevem no fio. Enquanto contavam como
 * ocupação, procurar num transporte desabilitava os cards do outro.
 */
internal fun ThermalPrinterState?.isSendingBytes(): Boolean =
    this is ThermalPrinterState.Connecting || this is ThermalPrinterState.Printing

/**
 * Duas unidades no mesmo rádio.
 *
 * SPP e BLE têm portas separadas no kit, mas o rádio é um só e a conexão em memória também: tratar
 * as duas como meios independentes seria autorizar dois envios que disputam o mesmo hardware.
 */
internal fun PrinterTransport.sharesRadioWith(other: PrinterTransport): Boolean =
    this == other || (isBluetoothRadio() && other.isBluetoothRadio())

internal fun PrinterTransport.isBluetoothRadio(): Boolean =
    this == PrinterTransport.BLUETOOTH || this == PrinterTransport.BLUETOOTH_LE
