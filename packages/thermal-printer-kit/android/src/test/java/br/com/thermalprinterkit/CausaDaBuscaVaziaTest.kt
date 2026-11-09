package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A decisão de causa, exercida sem rádio nenhum.
 *
 * As funções vivem fora das portas justamente para isto: `BluetoothAdapter` responde "Stub!" na JVM
 * de teste, então instanciar [AndroidBluetoothThermalPort] ou [AndroidBleThermalPort] aqui não
 * mediria nada. O que estes testes provam é a política. **O que nenhum teste desta suíte alcança**
 * é a leitura dos fatos no aparelho — que `isEnabled` seja falso com o rádio desligado, que
 * `bondedDevices` liste o que os Ajustes mostram, que `bluetoothLeScanner` volte nulo quando volta.
 * Isso é contrato do Android e só a bancada física confirma.
 */
class CausaDaBuscaVaziaTest {
    private val tudoCerto =
        Fatos(
            modeloFalaBluetooth = true,
            radioPresente = true,
            radioLigado = true,
            temPermissaoDeConexao = true,
            pareadas = 2,
            comServicoDeImpressao = 1,
        )

    @Test
    fun `com uma pareada que imprime nao ha causa nenhuma`() {
        assertNull(tudoCerto.causa())
    }

    @Test
    fun `perfil sem o transporte nao vira ligue o bluetooth`() {
        assertEquals(
            CausaDaBuscaPareadaVazia.ModeloNaoFalaBluetooth,
            tudoCerto.copy(modeloFalaBluetooth = false).causa(),
        )
    }

    @Test
    fun `aparelho sem radio e diferente de radio desligado`() {
        val semRadio = tudoCerto.copy(radioPresente = false, radioLigado = false).causa()
        val desligado = tudoCerto.copy(radioLigado = false).causa()

        assertEquals(CausaDaBuscaPareadaVazia.SemRadioNoAparelho, semRadio)
        assertEquals(CausaDaBuscaPareadaVazia.RadioDesligado, desligado)
    }

    /**
     * Com o rádio desligado não se lê `bondedDevices`, então a lista chega vazia por impedimento.
     * Se "nenhuma pareada" vencesse aqui, o balcão seria mandado parear de novo o que já está
     * pareado — e o pareamento continuaria lá, intacto, depois do passeio pelos Ajustes.
     */
    @Test
    fun `o impedimento vence o silencio que ele mesmo causou`() {
        assertEquals(
            CausaDaBuscaPareadaVazia.RadioDesligado,
            tudoCerto.copy(radioLigado = false, pareadas = 0, comServicoDeImpressao = 0).causa(),
        )
        assertEquals(
            CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada,
            tudoCerto.copy(
                temPermissaoDeConexao = false,
                pareadas = 0,
                comServicoDeImpressao = 0,
            ).causa(),
        )
    }

    @Test
    fun `nenhuma pareada e diferente de pareadas sem servico de impressao`() {
        val nenhuma = tudoCerto.copy(pareadas = 0, comServicoDeImpressao = 0).causa()
        // O caso do fone e da caixa de som: a lista dos Ajustes não está vazia, e nenhuma delas
        // imprime. Ver a medição de bancada em `looksLikePrinter`.
        val semImpressao = tudoCerto.copy(pareadas = 3, comServicoDeImpressao = 0).causa()

        assertEquals(CausaDaBuscaPareadaVazia.NenhumaPareada, nenhuma)
        assertEquals(CausaDaBuscaPareadaVazia.PareadasSemServicoDeImpressao(3), semImpressao)
    }

    @Test
    fun `varredura le sem impedimento libera o radio`() {
        assertNull(impedimentoLe())
    }

    /**
     * O defeito que o `canScan()` escondia: rádio desligado e permissão faltando eram o mesmo
     * `false`, e os dois chamadores traduziam esse `false` para `BluetoothPermissionDenied`. Quem
     * estava com o Bluetooth desligado lia "Autorize o acesso a dispositivos Bluetooth" e ia
     * procurar um botão de permissão que já estava concedido.
     */
    @Test
    fun `radio desligado no le nao sai como permissao negada`() {
        val desligado = impedimentoLe(radioLigado = false)
        val semPermissao = impedimentoLe(temPermissaoDeVarredura = false)

        assertEquals(CausaDaVarreduraLeVazia.RadioDesligado, desligado)
        assertEquals(CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada, semPermissao)
        assertEquals(ThermalPortFailure.BluetoothUnavailable, falhaDaVarreduraLe(desligado!!))
        assertEquals(
            ThermalPortFailure.BluetoothPermissionDenied,
            falhaDaVarreduraLe(semPermissao!!),
        )
    }

    @Test
    fun `varredor ausente nao e a mesma coisa que ninguem anunciar`() {
        val semVarredor = impedimentoLe(varredorPresente = false)

        assertEquals(CausaDaVarreduraLeVazia.SemVarredorNoAparelho, semVarredor)
        // Nenhum pacote saiu do rádio, então isto não é falha de canal — e também não é "aproxime
        // a impressora", que é a única frase certa para a varredura que aconteceu inteira.
        assertNull(falhaDaVarreduraLe(semVarredor!!))
    }

    @Test
    fun `politica do hospedeiro vence antes de qualquer fato do radio`() {
        assertEquals(
            CausaDaVarreduraLeVazia.BloqueadaPeloHospedeiro,
            impedimentoLe(hospedeiroPermiteVarrer = false, radioLigado = false),
        )
    }

    private fun impedimentoLe(
        modeloFalaBluetoothLe: Boolean = true,
        hospedeiroPermiteVarrer: Boolean = true,
        radioPresente: Boolean = true,
        radioLigado: Boolean = true,
        temPermissaoDeVarredura: Boolean = true,
        varredorPresente: Boolean = true,
    ): CausaDaVarreduraLeVazia? =
        impedimentoDaVarreduraLe(
            modeloFalaBluetoothLe = modeloFalaBluetoothLe,
            hospedeiroPermiteVarrer = hospedeiroPermiteVarrer,
            radioPresente = radioPresente,
            radioLigado = radioLigado,
            temPermissaoDeVarredura = temPermissaoDeVarredura,
            varredorPresente = varredorPresente,
        )

    private data class Fatos(
        val modeloFalaBluetooth: Boolean,
        val radioPresente: Boolean,
        val radioLigado: Boolean,
        val temPermissaoDeConexao: Boolean,
        val pareadas: Int,
        val comServicoDeImpressao: Int,
    ) {
        fun causa(): CausaDaBuscaPareadaVazia? =
            causaDaBuscaPareadaVazia(
                modeloFalaBluetooth = modeloFalaBluetooth,
                radioPresente = radioPresente,
                radioLigado = radioLigado,
                temPermissaoDeConexao = temPermissaoDeConexao,
                pareadas = pareadas,
                comServicoDeImpressao = comServicoDeImpressao,
            )
    }

    /**
     * A tabela que faltava, medida caso a caso.
     *
     * `estadoDaBuscaVazia` é o que traduz causa em estado publicado desde que as portas Android
     * pararam de lançar. Enquanto essa tradução não existia, **toda** saída `Vazia` virava
     * `BluetoothUnavailable` — inclusive as duas de permissão, que são as únicas em que "ligue o
     * Bluetooth" é conselho errado, porque o rádio já está ligado.
     */
    @Test
    fun `so as duas causas de permissao viram pedido de autorizacao`() {
        assertEquals(
            ThermalPrinterState.BluetoothPermissionDenied,
            estadoDaBuscaVazia(CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada),
        )
        assertEquals(
            ThermalPrinterState.BluetoothPermissionDenied,
            estadoDaBuscaVazia(CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada),
        )
        assertEquals(
            ThermalPrinterState.BluetoothLeUnavailableByHostPolicy,
            estadoDaBuscaVazia(CausaDaVarreduraLeVazia.BloqueadaPeloHospedeiro),
        )
        listOf(
            CausaDaBuscaPareadaVazia.NaoInformada,
            CausaDaBuscaPareadaVazia.KitSemPortaBluetooth,
            CausaDaBuscaPareadaVazia.ModeloNaoFalaBluetooth,
            CausaDaBuscaPareadaVazia.SemRadioNoAparelho,
            CausaDaBuscaPareadaVazia.RadioDesligado,
            CausaDaBuscaPareadaVazia.NenhumaPareada,
            CausaDaBuscaPareadaVazia.PareadasSemServicoDeImpressao(3),
            CausaDaVarreduraLeVazia.SemVarredorNoAparelho,
            CausaDaVarreduraLeVazia.NinguemAnunciou(6_000),
        ).forEach { causa ->
            assertEquals(
                "esta causa não pode virar pedido de permissão: $causa",
                ThermalPrinterState.BluetoothUnavailable,
                estadoDaBuscaVazia(causa),
            )
        }
    }
}

/**
 * O comprovante de teste não afirma medição que ninguém fez.
 *
 * **O papel que qualquer pessoa alcança tocando em "imprimir teste"**, sem passar por homologação
 * nenhuma. Ele imprimia `Página:`, `Codificação:` e `Corte: <nome do enum ESC/POS>` para qualquer
 * dialeto — e num perfil Procomp as três são falsas: não há `ESC t` nesta firmware (o texto sai em
 * ABICOMP, tabela de fábrica, provada em papel em 23/08/2026) e nenhum byte `GS` chega a ela, porque
 * `procompFinish` emite `ESC w` sem consultar `cutProtocol`.
 *
 * A certidão de homologação já dizia o certo desde 30/08/2026 — ver `ProcompHomologationProbes` —,
 * e era só esta folha que continuava mentindo. O gêmeo iOS tinha o mesmo defeito e o mesmo conserto.
 */
class ComprovanteDeTesteNoDialetoTest {

    @Test
    fun `num perfil Procomp o papel diz a tabela de fabrica e o comando de corte`() {
        val frases =
            linhasDoDialetoNoComprovante(BundledPrinterDrivers.dieboldIm453h, "ABICOMP")

        assertFalse("não há `ESC t` nesta firmware", frases.contains("Página:"))
        assertFalse("a tabela é de fábrica, e não uma escolha", frases.contains("Codificação:"))
        assertFalse("o nome do enum viraria cadastro um mês depois", frases.contains("GS V"))
        assertTrue(frases.contains("Tabela: ABICOMP (fábrica)"))
        // A IM453H do catálogo não declara guilhotina — ver `BundledPrinterDrivers.dieboldIm453h`.
        assertTrue(frases.contains("Corte: sem guilhotina"))
    }

    /** E a Procomp que **tem** guilhotina diz o comando que sai, e não o nome do enum ESC/POS. */
    @Test
    fun `numa Procomp com guilhotina o papel diz ESC w e nao o nome do enum`() {
        val comGuilhotina =
            BundledPrinterDrivers.dieboldIm453h.copy(
                id = "medido.diebold.com-guilhotina",
                hasCutter = true,
                cutProtocol = CutProtocol.GS_V_1,
                cutFeedLines = 4,
            )

        val frases = linhasDoDialetoNoComprovante(comGuilhotina, "ABICOMP")

        assertTrue(frases.contains("Corte: ESC w (parcial) | avanço 4"))
        assertFalse("o campo guarda GS V 1, mas nenhum byte GS chega a ela", frases.contains("GS V"))
    }

    /** A contraprova: no papel ESC/POS as três linhas continuam saindo, porque lá elas são medição. */
    @Test
    fun `num perfil ESC-POS as tres linhas de sempre continuam saindo`() {
        val frases =
            linhasDoDialetoNoComprovante(BundledPrinterDrivers.elginI9Full2, "CP850")

        assertTrue(frases.contains("Página:"))
        assertTrue(frases.contains("Codificação: CP850"))
        assertTrue(frases.contains("Corte:"))
        assertFalse("ABICOMP é da outra firmware", frases.contains("Tabela: ABICOMP"))
    }
}
