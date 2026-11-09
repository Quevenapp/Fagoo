package br.com.thermalprinterkit

import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager

/**
 * Inventário das interfaces USB que o kit sabe usar.
 *
 * Foi esta sonda que revelou por que a Bematech MP-4200 "não era reconhecida": ela se apresenta como
 * `CDC_DATA` (10), e não como impressora (7). Sem enxergar a classe, "não reconheceu" fica
 * indistinguível de "não está no cabo" — e essa distinção é a diferença entre um relato útil e um
 * relato inútil, venha ele da nossa bancada ou de um usuário do outro lado do país.
 */
enum class UsbInterfaceClass(val usbClass: Int, val label: String) {
    PRINTER(UsbConstants.USB_CLASS_PRINTER, "PRINTER"),
    CDC_DATA(UsbConstants.USB_CLASS_CDC_DATA, "CDC_DATA"),
    ;

    companion object {
        fun from(value: Int): UsbInterfaceClass? = entries.firstOrNull { it.usbClass == value }
    }
}

/**
 * Entrada só de sessão. O identificador é uma ordem efêmera e a apresentação não inclui VID, PID,
 * serial, caminho do kernel ou qualquer outro identificador técnico.
 */
class UsbInventoryEntry internal constructor(
    val id: Long,
    val interfaceClass: UsbInterfaceClass,
    internal val device: UsbDevice,
    internal val usbInterface: UsbInterface,
) {
    val label: String = "Dispositivo USB $id · ${interfaceClass.label}"

    override fun toString(): String = "UsbInventoryEntry(id=$id, classe=${interfaceClass.label})"
}

class AndroidUsbInventory(context: Context) {
    private val manager = context.applicationContext.getSystemService(UsbManager::class.java)

    fun read(): List<UsbInventoryEntry> {
        var nextId = 1L
        return manager.deviceList.values.flatMap { device ->
            (0 until device.interfaceCount).mapNotNull { interfaceIndex ->
                val usbInterface = device.getInterface(interfaceIndex)
                val accepted = UsbInterfaceClass.from(usbInterface.interfaceClass) ?: return@mapNotNull null
                UsbInventoryEntry(
                    id = nextId++,
                    interfaceClass = accepted,
                    device = device,
                    usbInterface = usbInterface,
                )
            }
        }
    }
}
