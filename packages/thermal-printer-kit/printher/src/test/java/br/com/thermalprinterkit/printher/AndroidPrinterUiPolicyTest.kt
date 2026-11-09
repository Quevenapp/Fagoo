package br.com.thermalprinterkit.printher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidPrinterUiPolicyTest {
    @Test
    fun `api 26 a 30 permite somente spp pareado sem pedir localizacao`() {
        (26..30).forEach { apiLevel ->
            assertEquals(
                BluetoothUiAccess.Allowed,
                AndroidPrinterUiPolicy.bluetoothAccess(
                    apiLevel = apiLevel,
                    operation = BluetoothUiOperation.PAIRED_SPP,
                    grantedPermissions = emptySet(),
                ),
            )
            assertEquals(
                BluetoothUiAccess.UnavailableByHostPolicy,
                AndroidPrinterUiPolicy.bluetoothAccess(
                    apiLevel = apiLevel,
                    operation = BluetoothUiOperation.BLE_SCAN,
                    grantedPermissions = emptySet(),
                ),
            )
        }
    }

    @Test
    fun `android 12 exige connect para spp e scan mais connect para ble`() {
        assertEquals(
            BluetoothUiAccess.MissingPermissions(
                setOf(AndroidPrinterUiPolicy.BLUETOOTH_CONNECT_PERMISSION),
            ),
            AndroidPrinterUiPolicy.bluetoothAccess(
                apiLevel = 31,
                operation = BluetoothUiOperation.PAIRED_SPP,
                grantedPermissions = emptySet(),
            ),
        )

        val bleAccess =
            AndroidPrinterUiPolicy.bluetoothAccess(
                apiLevel = 31,
                operation = BluetoothUiOperation.BLE_SCAN,
                grantedPermissions = emptySet(),
            )
        assertEquals(
            BluetoothUiAccess.MissingPermissions(
                setOf(
                    AndroidPrinterUiPolicy.BLUETOOTH_CONNECT_PERMISSION,
                    AndroidPrinterUiPolicy.BLUETOOTH_SCAN_PERMISSION,
                ),
            ),
            bleAccess,
        )
    }

    @Test
    fun `lista bluetooth vazia oferece ajustes somente depois da busca combinada`() {
        assertTrue(AndroidPrinterUiPolicy.NO_BLUETOOTH_PRINTER_MESSAGE.contains("Ajustes"))
        assertTrue(AndroidPrinterUiPolicy.NO_BLUETOOTH_PRINTER_MESSAGE.contains("parear"))
    }

    @Test
    fun `interface apresenta um unico bluetooth em todas as versoes`() {
        (26..30).forEach { apiLevel ->
            assertEquals("Configure por Wi-Fi, USB ou Bluetooth.", configurationTransportSummary(apiLevel))
        }
        assertEquals("Configure por Wi-Fi, USB ou Bluetooth.", configurationTransportSummary(31))
    }
}
