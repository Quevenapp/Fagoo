package br.com.thermalprinterkit

enum class BluetoothLeScanAvailability {
    AVAILABLE,
    UNAVAILABLE_BY_HOST_POLICY,
}

/**
 * Decisão injetada pelo app hospedeiro. O core não conhece versão de Android, manifest nem loja.
 */
fun interface BluetoothLeScanPolicy {
    fun availability(): BluetoothLeScanAvailability

    companion object {
        val ALLOW = BluetoothLeScanPolicy { BluetoothLeScanAvailability.AVAILABLE }
    }
}
