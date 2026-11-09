package br.com.thermalprinterkit

/**
 * Os bytes que o app **publicado** grava, congelados por literal.
 *
 * **De onde vieram, e por que isso importa.** Cada hex abaixo foi *medido*, não transcrito do
 * formato: um instrumento temporário invocou por reflexão os métodos privados `encode`/`decode` de
 * `AndroidKeystorePrinterSelectionStore` como eles estavam em `7f1fd7d`, **antes** de qualquer
 * extração, e imprimiu o que sai. É por isso que estes literais podem servir de portão — eles são
 * o disco de quem tem impressora adotada agora, e não a opinião de quem refatorou sobre como o
 * disco deveria ser.
 *
 * Quem mudar um valor daqui está mudando o que já está gravado no aparelho de outra pessoa, e a
 * consequência não é suíte vermelha: é o app publicado deixar de encontrar a impressora dela.
 *
 * **Não medido:** nenhum destes payloads foi lido de um aparelho de verdade, e os de formato
 * antigo (v2/v3) foram montados nesta bancada. O que está medido é que o código publicado emite e
 * aceita exatamente estes bytes.
 */
object VetoresGravadosDaSelecao {
    const val PERFIL_A: String = "0189a1c4-1b2d-4e5f-8a9b-0c1d2e3f4a5b"
    const val PERFIL_B: String = "7f2e6d5c-4b3a-4291-8071-6f5e4d3c2b1a"
    const val PERFIL_PUBLICADO: String = "elgin-i9full-80mm"

    /** `installationId` medido, e não recalculado: o resumo faz parte dos bytes gravados no v4. */
    const val INSTALACAO_BLE_A_66: String = "0189a1c4-1b2d-4e5f-8a9b-0c1d2e3f4a5b#52c94ff9afd3"
    const val INSTALACAO_BLE_A_77: String = "0189a1c4-1b2d-4e5f-8a9b-0c1d2e3f4a5b#3e76822abed5"
    const val INSTALACAO_WIFI_B_10: String = "7f2e6d5c-4b3a-4291-8071-6f5e4d3c2b1a#ad88b0e2d989"
    const val INSTALACAO_WIFI_B_192: String = "7f2e6d5c-4b3a-4291-8071-6f5e4d3c2b1a#639ae6f07409"

    data class Vetor(val valor: PersistedPrinterSelections, val hex: String)

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun bytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { indice ->
            hex.substring(indice * 2, indice * 2 + 2).toInt(16).toByte()
        }

    /** O formato corrente (v4). Ida **e** volta: o mesmo literal serve de alvo e de entrada. */
    fun gravados(): List<Pair<String, Vetor>> =
        listOf(
            "vazio" to Vetor(
                PersistedPrinterSelections(),
                "00000004000000",
            ),
            "usbComIdentidade" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.Usb(
                            PERFIL_A,
                            UsbConnectionIdentity(0x0483, 0x5743, "SN-1234"),
                        ),
                    ),
                ),
                "0000000400000101002430313839613163342d316232642d346535662d386139" +
                    "622d306331643265336634613562010000048300005743010007534e2d313233" +
                    "34",
            ),
            "usbSemIdentidade" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(PersistedPrinterSelection.Usb(PERFIL_A, null)),
                ),
                "0000000400000101002430313839613163342d316232642d346535662d386139" +
                    "622d30633164326533663461356200",
            ),
            "usbSemSerial" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.Usb(
                            PERFIL_PUBLICADO,
                            UsbConnectionIdentity(0x1234, 0x5678, null),
                        ),
                    ),
                ),
                "00000004000001010011656c67696e2d693966756c6c2d38306d6d0100001234" +
                    "0000567800",
            ),
            "bluetoothComEndereco" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.Bluetooth(PERFIL_A, "66:22:CC:DD:EE:FF"),
                    ),
                ),
                "0000000400000103002430313839613163342d316232642d346535662d386139" +
                    "622d30633164326533663461356201001136363a32323a43433a44443a45453a" +
                    "4646",
            ),
            "bluetoothSemEndereco" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(PersistedPrinterSelection.Bluetooth(PERFIL_A, null)),
                ),
                "0000000400000103002430313839613163342d316232642d346535662d386139" +
                    "622d30633164326533663461356200",
            ),
            "bleComEndereco" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.BluetoothLe(PERFIL_B, "11:22:33:44:55:66"),
                    ),
                ),
                "0000000400000104002437663265366435632d346233612d343239312d383037" +
                    "312d36663565346433633262316101001131313a32323a33333a34343a35353a" +
                    "3636",
            ),
            "wifiComEndpoint" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.LocalWifi(
                            PERFIL_A,
                            PersistedNetworkEndpoint("192.168.0.87", 9100),
                        ),
                    ),
                ),
                "0000000400000102002430313839613163342d316232642d346535662d386139" +
                    "622d30633164326533663461356201000c3139322e3136382e302e3837000023" +
                    "8c",
            ),
            "wifiSemEndpoint" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(PersistedPrinterSelection.LocalWifi(PERFIL_A, null)),
                ),
                "0000000400000102002430313839613163342d316232642d346535662d386139" +
                    "622d30633164326533663461356200",
            ),
            "duasUnidadesMesmoPerfil" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.BluetoothLe(PERFIL_A, "11:22:33:44:55:66"),
                        PersistedPrinterSelection.BluetoothLe(PERFIL_A, "11:22:33:44:55:77"),
                    ),
                    active = PrinterTransport.BLUETOOTH_LE,
                    activeProfileId = PERFIL_A,
                    activeInstallationId = INSTALACAO_BLE_A_77,
                ),
                "0000000401002430313839613163342d316232642d346535662d386139622d30" +
                    "633164326533663461356201003130313839613163342d316232642d34653566" +
                    "2d386139622d3063316432653366346135622333653736383232616265643502" +
                    "04002430313839613163342d316232642d346535662d386139622d3063316432" +
                    "6533663461356201001131313a32323a33333a34343a35353a36360400243031" +
                    "3839613163342d316232642d346535662d386139622d30633164326533663461" +
                    "356201001131313a32323a33333a34343a35353a3737",
            ),
            "misturaCompleta" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.Usb(
                            PERFIL_A,
                            UsbConnectionIdentity(0x0483, 0x5743, "SN-1234"),
                        ),
                        PersistedPrinterSelection.LocalWifi(
                            PERFIL_B,
                            PersistedNetworkEndpoint("10.0.0.42", 9100),
                        ),
                        PersistedPrinterSelection.Bluetooth(
                            PERFIL_PUBLICADO,
                            "66:22:CC:DD:EE:FF",
                        ),
                    ),
                    active = PrinterTransport.LOCAL_WIFI,
                    activeProfileId = PERFIL_B,
                    activeInstallationId = INSTALACAO_WIFI_B_10,
                ),
                "0000000401002437663265366435632d346233612d343239312d383037312d36" +
                    "663565346433633262316101003137663265366435632d346233612d34323931" +
                    "2d383037312d3666356534643363326231612361643838623065326439383903" +
                    "01002430313839613163342d316232642d346535662d386139622d3063316432" +
                    "65336634613562010000048300005743010007534e2d31323334020024376632" +
                    "65366435632d346233612d343239312d383037312d3666356534643363326231" +
                    "6101000931302e302e302e34320000238c030011656c67696e2d693966756c6c" +
                    "2d38306d6d01001136363a32323a43433a44443a45453a4646",
            ),
        )

    /**
     * Formatos antigos, e o que o código publicado **faz** com eles.
     *
     * Estes bytes foram montados aqui — nenhum aparelho os produziu. O que o teste congela é a
     * migração: v2 carrega o transporte ativo num byte, v3 carrega o perfil ativo, e nenhum dos
     * dois conhece unidade. A instalação ativa é reconstruída, e o valor reconstruído está abaixo
     * por literal porque ele é o que decide qual impressora recebe cupom depois da atualização.
     */
    fun antigos(): List<Pair<String, Vetor>> =
        listOf(
            "v2ComAtivo" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.BluetoothLe(PERFIL_A, "11:22:33:44:55:66"),
                    ),
                    active = PrinterTransport.BLUETOOTH_LE,
                    activeProfileId = PERFIL_A,
                    activeInstallationId = INSTALACAO_BLE_A_66,
                ),
                "00000002040104002430313839613163342d316232642d346535662d38613962" +
                    "2d30633164326533663461356201001131313a32323a33333a34343a35353a36" +
                    "36",
            ),
            "v2SemAtivo" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(PersistedPrinterSelection.Usb(PERFIL_A, null)),
                ),
                "00000002000101002430313839613163342d316232642d346535662d38613962" +
                    "2d30633164326533663461356200",
            ),
            "v3ComPerfilAtivo" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.LocalWifi(
                            PERFIL_B,
                            PersistedNetworkEndpoint("192.168.0.87", 9100),
                        ),
                    ),
                    active = PrinterTransport.LOCAL_WIFI,
                    activeProfileId = PERFIL_B,
                    activeInstallationId = INSTALACAO_WIFI_B_192,
                ),
                "0000000301002437663265366435632d346233612d343239312d383037312d36" +
                    "66356534643363326231610102002437663265366435632d346233612d343239" +
                    "312d383037312d36663565346433633262316101000c3139322e3136382e302e" +
                    "38370000238c",
            ),
            "v3SemPerfilAtivo" to Vetor(
                PersistedPrinterSelections(
                    selections = listOf(
                        PersistedPrinterSelection.Bluetooth(PERFIL_A, "66:22:CC:DD:EE:FF"),
                    ),
                ),
                "00000003000103002430313839613163342d316232642d346535662d38613962" +
                    "2d30633164326533663461356201001136363a32323a43433a44443a45453a46" +
                    "46",
            ),
        )
}
