package br.com.thermalprinterkit.printher

/** Ações Bluetooth distintas; buscar SPP nunca autoriza iniciar uma varredura BLE. */
internal enum class BluetoothUiOperation {
    PAIRED_SPP,
    BLE_SCAN,
}

/** Resultado tipado da política do produto antes de qualquer chamada ao transporte. */
internal sealed interface BluetoothUiAccess {
    data object Allowed : BluetoothUiAccess

    data object UnavailableByHostPolicy : BluetoothUiAccess

    data class MissingPermissions(
        val permissions: Set<String>,
    ) : BluetoothUiAccess
}

internal object AndroidPrinterUiPolicy {
    const val ANDROID_12_API = 31
    const val BLUETOOTH_CONNECT_PERMISSION = "android.permission.BLUETOOTH_CONNECT"
    const val BLUETOOTH_SCAN_PERMISSION = "android.permission.BLUETOOTH_SCAN"

    /**
     * O app de produto não declara localização. Por isso BLE legado não é uma opção entre as APIs
     * 26 e 30. SPP pareado continua disponível e, no Android 12+, usa somente CONNECT.
     */
    fun bluetoothAccess(
        apiLevel: Int,
        operation: BluetoothUiOperation,
        grantedPermissions: Set<String>,
    ): BluetoothUiAccess {
        if (operation == BluetoothUiOperation.BLE_SCAN && apiLevel < ANDROID_12_API) {
            return BluetoothUiAccess.UnavailableByHostPolicy
        }
        if (apiLevel < ANDROID_12_API) return BluetoothUiAccess.Allowed

        val required =
            when (operation) {
                BluetoothUiOperation.PAIRED_SPP -> setOf(BLUETOOTH_CONNECT_PERMISSION)
                BluetoothUiOperation.BLE_SCAN ->
                    setOf(BLUETOOTH_CONNECT_PERMISSION, BLUETOOTH_SCAN_PERMISSION)
            }
        val missing = required - grantedPermissions
        return if (missing.isEmpty()) {
            BluetoothUiAccess.Allowed
        } else {
            BluetoothUiAccess.MissingPermissions(missing)
        }
    }

    /** Orientação exibida somente depois que SPP e todo BLE permitido realmente terminarem. */
    const val NO_BLUETOOTH_PRINTER_MESSAGE =
        "Nenhuma impressora Bluetooth foi encontrada. Você pode abrir os Ajustes para parear " +
            "uma impressora e procurar novamente."
}
