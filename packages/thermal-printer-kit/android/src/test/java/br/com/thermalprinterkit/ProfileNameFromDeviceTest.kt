package br.com.thermalprinterkit

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfileNameFromDeviceTest {
    @Test
    fun `nome declarado pelo aparelho serve como nome de perfil`() {
        // Medido na bancada: o Bluetooth já dizia `T210_D0E9` enquanto o perfil nascia
        // "Impressora temporária". Quem se identifica tem nome melhor que o nosso genérico.
        assertTrue(isAcceptableProfileName("T210_D0E9"))
        assertTrue(isAcceptableProfileName("MTP-II_BD7E"))
        assertTrue(isAcceptableProfileName("  Impressora do balcao  "))
    }

    @Test
    fun `nome com cara de identificador tecnico e recusado antes de virar perfil`() {
        // Recusar aqui evita construir um perfil que só falharia ao salvar.
        assertFalse(isAcceptableProfileName("00:11:22:33:44:55"))
        assertFalse(isAcceptableProfileName("192.168.1.110"))
        assertFalse(isAcceptableProfileName("VID 0416 PID 5011"))
        assertFalse(isAcceptableProfileName("   "))
    }
}
