package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * **O portão da extração: nenhum byte gravado mudou.**
 *
 * Existe gente com impressora adotada agora, com a seleção selada no chaveiro do Android. A extração
 * do formato para [BinaryPrinterSelectionCodec] mexeu num arquivo do núcleo **publicado**, e o risco
 * dela não é suíte vermelha — é o app na loja deixar de encontrar a impressora de alguém, em
 * silêncio, na atualização.
 *
 * Por isso os alvos deste arquivo não foram escritos por quem refatorou: são os literais de
 * [VetoresGravadosDaSelecao], medidos por reflexão nos métodos privados do código publicado em
 * `7f1fd7d`, **antes** de a primeira linha sair do lugar. Grava-se com o código de antes, lê-se com
 * o de depois, e compara-se — nos dois sentidos, porque um codec que só escreve igual ainda pode ler
 * diferente.
 */
class PrinterSelectionCodecGravadoTest {
    @Test
    fun gravaExatamenteOsBytesDoCodigoPublicado() {
        VetoresGravadosDaSelecao.gravados().forEach { (nome, caso) ->
            assertEquals(
                nome,
                caso.hex,
                VetoresGravadosDaSelecao.hex(BinaryPrinterSelectionCodec.encode(caso.valor)),
            )
        }
    }

    @Test
    fun leExatamenteOsBytesDoCodigoPublicado() {
        VetoresGravadosDaSelecao.gravados().forEach { (nome, caso) ->
            assertEquals(
                nome,
                caso.valor,
                BinaryPrinterSelectionCodec.decode(VetoresGravadosDaSelecao.bytes(caso.hex)),
            )
        }
    }

    /**
     * O caso que dói de verdade: o chaveiro de quem atualizou de uma versão antiga. v2 guardava o
     * transporte ativo num byte e v3 o perfil ativo; nenhum dos dois sabia de unidade, e a instalação
     * ativa é reconstruída na leitura. Quem recebe cupom depois da atualização sai daqui.
     */
    @Test
    fun leOsFormatosAntigosComoOCodigoPublicadoLia() {
        VetoresGravadosDaSelecao.antigos().forEach { (nome, caso) ->
            assertEquals(
                nome,
                caso.valor,
                BinaryPrinterSelectionCodec.decode(VetoresGravadosDaSelecao.bytes(caso.hex)),
            )
        }
    }

    @Test
    fun aVersaoGravadaContinuaSendoQuatro() {
        assertEquals(4, BinaryPrinterSelectionCodec.PAYLOAD_VERSION)
        assertEquals(2, BinaryPrinterSelectionCodec.MIN_SUPPORTED_VERSION)
        assertEquals(32, BinaryPrinterSelectionCodec.MAX_SELECTIONS)
    }

    @Test
    fun idaEVoltaPreservaCadaCaso() {
        VetoresGravadosDaSelecao.gravados().forEach { (nome, caso) ->
            val volta =
                BinaryPrinterSelectionCodec.decode(BinaryPrinterSelectionCodec.encode(caso.valor))
            assertEquals(nome, caso.valor, volta)
        }
    }

    /** Versão que não existe não vira instalação suposta: falha, e quem chama trata. */
    @Test
    fun recusaVersaoAnteriorAMigracaoEscrita() {
        val v1 = VetoresGravadosDaSelecao.bytes("00000001000000")
        assertThrows(IllegalArgumentException::class.java) {
            BinaryPrinterSelectionCodec.decode(v1)
        }
    }

    @Test
    fun recusaVersaoDoFuturo() {
        val v5 = VetoresGravadosDaSelecao.bytes("00000005000000")
        assertThrows(IllegalArgumentException::class.java) {
            BinaryPrinterSelectionCodec.decode(v5)
        }
    }

    /** Byte sobrando é registro adulterado, e adulterado não vira destino de cupom. */
    @Test
    fun recusaSobraNoFimDoRegistro() {
        val comSobra = VetoresGravadosDaSelecao.bytes("00000004000000" + "ff")
        assertThrows(IllegalArgumentException::class.java) {
            BinaryPrinterSelectionCodec.decode(comSobra)
        }
    }

    @Test
    fun recusaContagemAcimaDoTeto() {
        // Versão 4, sem perfil ativo, sem instalação ativa, e 33 seleções anunciadas.
        val demais = VetoresGravadosDaSelecao.bytes("000000040000" + "21")
        assertThrows(IllegalArgumentException::class.java) {
            BinaryPrinterSelectionCodec.decode(demais)
        }
    }

    @Test
    fun recusaTransporteDesconhecido() {
        val transporteInvalido =
            VetoresGravadosDaSelecao.bytes(
                "00000004" + "0000" + "01" + "09" + "0003" + "616263",
            )
        assertThrows(IllegalStateException::class.java) {
            BinaryPrinterSelectionCodec.decode(transporteInvalido)
        }
    }

    /**
     * A identidade física nunca chega ao texto — e o codec é o ponto onde ela passa em claro, então
     * é aqui que a redação precisa continuar valendo depois da mudança de casa.
     */
    @Test
    fun nenhumaSelecaoImprimeIdentidadeFisica() {
        val comEndereco =
            PersistedPrinterSelections(
                selections = listOf(
                    PersistedPrinterSelection.Bluetooth(
                        VetoresGravadosDaSelecao.PERFIL_A,
                        "66:22:CC:DD:EE:FF",
                    ),
                    PersistedPrinterSelection.LocalWifi(
                        VetoresGravadosDaSelecao.PERFIL_B,
                        PersistedNetworkEndpoint("10.0.0.42", 9100),
                    ),
                ),
            )
        val texto = comEndereco.toString() + comEndereco.selections.joinToString { it.toString() }
        listOf("66:22:CC:DD:EE:FF", "10.0.0.42", "9100").forEach { segredo ->
            assertEquals("$segredo apareceu em texto", false, texto.contains(segredo))
        }
    }

    /**
     * O AAD do Android é da caixa-forte do Android, e o de mesa é outro. São dois cofres, e um não
     * pode aceitar o texto cifrado do outro — ver o teste de recusa cruzada no `:desktop-core`.
     */
    @Test
    fun oAadDoAndroidEhDeAndroid() {
        val android = "thermal-printer-kit:android:selection:v1"
        assertNotEquals(android, "thermal-printer-kit:windows:selection:v1")
        assertNotEquals(android, "thermal-printer-kit:macos:selection:v1")
    }
}
