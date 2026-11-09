// SPDX-License-Identifier: AGPL-3.0-only
// Adaptado do Vinki v4, código próprio autorizado para distribuição com FAGOO.
package br.com.queven.fagoo.panel

import android.content.Context
import android.os.Build
import br.com.thermalprinterkit.AndroidBleThermalPort
import br.com.thermalprinterkit.AndroidBluetoothThermalPort
import br.com.thermalprinterkit.AndroidKeystorePrinterSelectionStore
import br.com.thermalprinterkit.AndroidLocalWifiNetworkProvider
import br.com.thermalprinterkit.AndroidPrinterProfileStore
import br.com.thermalprinterkit.AndroidUsbHostThermalPort
import br.com.thermalprinterkit.BluetoothLeScanAvailability
import br.com.thermalprinterkit.BluetoothLeScanPolicy
import br.com.thermalprinterkit.ThermalPrintDelivery
import br.com.thermalprinterkit.ThermalPrintResult
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.createLocalWifiThermalPrinter

/**
 * A impressora do app Vinki (raia 6 de `fusao-no-app.md`): a composição de
 * produção do `ThermalPrinterKit`, com os quatro transportes (Wi-Fi local, USB,
 * Bluetooth clássico e LE) e os dois armazéns Android. Portada do QRSenha
 * (`createQRSenhaThermalPrinter`), sem mudança de comportamento.
 *
 * A impressora é deste celular, não um aparelho no servidor: quem imprime é o
 * totem ou a estação que está com ela. Quem chama dispara `restore()` uma vez
 * no escopo do aplicativo, porque readotar uma Bluetooth LE custa uma varredura.
 */
fun createFagooThermalPrinter(context: Context): ThermalPrinter {
    val appContext = context.applicationContext
    return createLocalWifiThermalPrinter(
        localWifiNetworkProvider = AndroidLocalWifiNetworkProvider(appContext),
        usbThermalPort = AndroidUsbHostThermalPort(appContext),
        bluetoothThermalPort = AndroidBluetoothThermalPort(appContext),
        bleThermalPort = AndroidBleThermalPort(appContext),
        selectionStore = AndroidKeystorePrinterSelectionStore(appContext),
        profileStore = AndroidPrinterProfileStore(appContext),
        bluetoothLeScanPolicy = fagooBluetoothLeScanPolicy(Build.VERSION.SDK_INT),
    )
}

/**
 * Abaixo do Android 12 a varredura BLE exige localização, que o app não pede:
 * ali a pessoa usa USB, Wi-Fi ou uma Bluetooth já pareada, e a busca BLE some.
 */
internal fun fagooBluetoothLeScanPolicy(sdkInt: Int): BluetoothLeScanPolicy =
    BluetoothLeScanPolicy {
        if (sdkInt >= Build.VERSION_CODES.S) {
            BluetoothLeScanAvailability.AVAILABLE
        } else {
            BluetoothLeScanAvailability.UNAVAILABLE_BY_HOST_POLICY
        }
    }

/** O que o totem diz do cupom da senha que acabou de mandar. */
sealed interface TicketPrint {
    data object Printing : TicketPrint

    data object Printed : TicketPrint

    /**
     * Não saiu, ou talvez tenha saído: quando a impressora aceitou os bytes e
     * não confirmou (`INDETERMINATE`), a segunda via pede confirmação humana,
     * para não saírem duas senhas iguais.
     */
    data class Failed(val message: String, val reprintNeedsConfirmation: Boolean) : TicketPrint

    /** Nenhuma impressora escolhida neste celular: a senha fica só na tela. */
    data object NoPrinter : TicketPrint

    companion object {
        fun of(result: ThermalPrintResult): TicketPrint =
            when (result) {
                ThermalPrintResult.Printed -> Printed
                is ThermalPrintResult.Failed ->
                    Failed(result.message, result.delivery == ThermalPrintDelivery.INDETERMINATE)
            }
    }
}
