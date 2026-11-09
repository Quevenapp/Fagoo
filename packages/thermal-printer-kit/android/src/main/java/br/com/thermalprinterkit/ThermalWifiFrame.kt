package br.com.thermalprinterkit

/**
 * Qual gramática de configuração Wi-Fi a impressora fala.
 *
 * **Não tem padrão, de propósito** — ao contrário de [ThermalCodeEmission], que publica um
 * `DEFAULT` porque errar o desenho de um código custa uma tira de papel. Aqui errar a família custa
 * a impressora: medido em 2026-08-21, a GoldenSky GS-T80C-WF engole `12 54` e `1F 78` sem efeito
 * nenhum, e a PP-10W descarta `1F` seguido de qualquer coisa que não seja o subcomando dela.
 * Nenhuma das duas responde "não entendi". Quem chama escolhe o construtor pelo nome da família, e
 * o `when` sobre este enum é o que obriga o hospedeiro a decidir em vez de cair num ramo qualquer.
 *
 * Os casos são nomeados pelos bytes do cabeçalho, e não pela marca, pela mesma razão que manteve
 * [CutProtocol.ESC_M] em vez de "bematech": a PP-10W é uma Rongta RPP200 rebatizada, e no dia em que
 * outro rótulo aparecer com o mesmo firmware o nome do byte continua certo.
 */
enum class ThermalWifiProtocol {
    /** `1F 77` — Rongta RPP200 e a Bematech PP-10W, que é a mesma máquina rebatizada. */
    US_W,

    /** `1F 1B 1F <opcode>` — GoldenSky GS-T80C-WF e as POS-58/76/80 que compartilham a ferramenta. */
    US_ESC_US,
    ;

    /**
     * O cabeçalho, **sem** opcode. Cópia nova a cada leitura, para ninguém alterar a constante.
     *
     * Os opcodes da família `1F 1B 1F` ficam privados no construtor: publicá-los abriria caminho
     * para `B8` (modo USB), `BF` (DIP switches), `33` e `91`, que são justamente os quadros que
     * mexem no caminho de socorro da impressora.
     *
     * **Interno de propósito.** Publicado, ele entregava pronto para o fio exatamente o que os dois
     * documentos de bancada listam em "bytes que NUNCA devem ser enviados": `1F 1B 1F` solto faz o
     * próximo byte do fluxo virar seletor — e `0x42` é o opcode do buzzer —, e `1F 77` sem campos é
     * o quadro truncado que trava o parser da Rongta, porque os campos variáveis são lidos com
     * timeout −1. Quem só precisa mostrar a família usa [label].
     */
    internal val headerBytes: ByteArray
        get() =
            when (this) {
                US_W -> byteArrayOf(0x1f, 0x77)
                US_ESC_US -> byteArrayOf(0x1f, 0x1b, 0x1f)
            }

    /** Como o cabeçalho é escrito nos dois documentos de bancada. */
    val label: String
        get() =
            when (this) {
                US_W -> "1F 77"
                US_ESC_US -> "1F 1B 1F"
            }
}

/**
 * O campo `AA` do quadro `1F 77`: o modo de autenticação da rede.
 *
 * Os valores saem do próprio firmware, não de ordem de combo: o par `AA`/`EE` escolhe qual das sete
 * strings vai no `AT+WSKEY=` do módulo (desmontado em vaddr `0xb140`–`0xb1dc`), e a unidade em modo
 * AP imprimiu literalmente `OPEN,NONE` em 21/08, que é o ramo `0`/`0`. O firmware trata **qualquer
 * valor ≥ 3** como WPA2-PSK; o kit só emite o 3 porque é o que o emissor do fabricante emite.
 */
enum class ThermalWifiAuth(val byte: Int) {
    OPEN(0),
    SHARED(1),
    WPA_PSK(2),
    WPA2_PSK(3),
}

/**
 * O campo `EE` do quadro `1F 77`, e ele é um par de opostos, não uma lista de cifras.
 *
 * O firmware só testa "é zero ou não é" (`0xb140`–`0xb1dc`): com `AA=2` ou `AA≥3`, zero manda TKIP e
 * diferente de zero manda AES; com `AA=0`, zero manda `OPEN,NONE` e diferente de zero manda
 * `OPEN,WEP-A,`; com `AA=1` ele é ignorado. Um enum de duas faces é o que essa medição autoriza —
 * um enum de quatro cifras fingiria uma escolha que a máquina não faz.
 *
 * O emissor do fabricante rotula estas duas posições como `AES` e `TPIK`; `TPIK` é typo dele para
 * TKIP, e não vale copiar erro de rótulo para dentro de API.
 */
enum class ThermalWifiCipher(val byte: Int) {
    /** `0` — `NONE` no ramo aberto, `TKIP` nos ramos WPA. */
    NONE_TKIP(0),

    /** `≠0` — `WEP-A` nos ramos aberto e compartilhado, `AES` nos ramos WPA. */
    WEP_AES(1),
}

/**
 * A segurança da rede na família `1F 77`, com a senha presa ao ramo que a usa.
 *
 * Um caso por ramo do firmware, e não um par solto de `AA`/`EE`, porque o par solto deixa escrever
 * o que a máquina não faz. [Open] é `AA=0`/`EE=0`: ali o firmware retorna em `0xb1c2` e **descarta a
 * chave**, então uma senha nesse quadro seria segredo no fio e na flash sem nenhum efeito. Aqui isso
 * não tem onde ser escrito — não há teste possível para o que não compila, e é essa a diferença.
 *
 * `toString` é redigido **na classe base e como `final`**, para que um caso novo nasça redigido em
 * vez de depender de alguém lembrar: sem isso, o `toString` sintetizado de uma `data class`
 * publicaria a chave inteira em qualquer log de estado de tela. O kit já trata segredo assim —
 * [RawHexCommand.toString], [LocalWifiPrinterEndpoint.toString].
 */
sealed class ThermalWifiSecurity {
    /** O byte `AA` deste ramo. */
    abstract val auth: ThermalWifiAuth

    /** O byte `EE` deste ramo. */
    abstract val cipher: ThermalWifiCipher

    final override fun toString(): String =
        "ThermalWifiSecurity(auth=${auth.name}, password=[REDACTED])"

    /** `OPEN,NONE`. Sem senha, e sem os bytes `KK`/`<SENHA>` no quadro. */
    object Open : ThermalWifiSecurity() {
        override val auth = ThermalWifiAuth.OPEN
        override val cipher = ThermalWifiCipher.NONE_TKIP
    }

    /** `OPEN,WEP-A,` — WEP com autenticação aberta. */
    data class WepOpen(val password: String) : ThermalWifiSecurity() {
        override val auth = ThermalWifiAuth.OPEN
        override val cipher = ThermalWifiCipher.WEP_AES
    }

    /**
     * `SHARED,WEP-A,` — WEP com chave compartilhada.
     *
     * O firmware ignora o `EE` quando `AA=1` (vaddr `0xb140`), então este ramo não tem cifra a
     * escolher: emitir `0` fixo é o que mantém o quadro determinístico entre as duas plataformas.
     */
    data class WepShared(val password: String) : ThermalWifiSecurity() {
        override val auth = ThermalWifiAuth.SHARED
        override val cipher = ThermalWifiCipher.NONE_TKIP
    }

    /** `WPAPSK,TKIP,` ou `WPAPSK,AES,`, conforme a cifra. */
    data class WpaPsk(
        override val cipher: ThermalWifiCipher,
        val password: String,
    ) : ThermalWifiSecurity() {
        override val auth = ThermalWifiAuth.WPA_PSK
    }

    /** `WPA2PSK,TKIP,` ou `WPA2PSK,AES,`, conforme a cifra. */
    data class Wpa2Psk(
        override val cipher: ThermalWifiCipher,
        val password: String,
    ) : ThermalWifiSecurity() {
        override val auth = ThermalWifiAuth.WPA2_PSK
    }
}

/**
 * O byte `MM` do quadro `1F 77`.
 *
 * **`1` é ponto de acesso; qualquer outro valor é cliente.** Está no firmware em `0xb35c`
 * (`cmp r0,#1 / bne → ramo STA`) e está no papel duas vezes: a gravação com o byte de modo zerado
 * imprimiu `Mode: STA`, e o ciclo de volta com `MM=01` imprimiu `Mode: AP`.
 *
 * Este mapeamento já foi "corrigido" ao contrário uma vez, em cima de um único envio cuja entrada
 * tinha um byte a menos, e a impressora saiu da rede. Quem for mexer aqui precisa de firmware ou de
 * papel — ordem de array não serve, e um envio só também não.
 */
enum class ThermalWifiMode(val byte: Int) {
    ACCESS_POINT(1),
    STATION(0),
}

/**
 * O byte `KT` da família `1F 1B 1F`, e ele **não** é o `AA`/`EE` da outra com outro nome.
 *
 * São dez posições contra sete ramos, com fronteiras diferentes: aqui WEP se divide em 64 e 128 e
 * existe um modo misto WPA/WPA2 que a Rongta não tem; lá a escolha de cifra é um bit. Não há, e não
 * deve haver, conversão entre os dois vocabulários — traduzir um no outro por índice é a mesma
 * classe de erro que inverteu o byte de modo da PP-10W e tirou uma unidade da rede.
 *
 * O índice é posição, não ordem de array: cada rótulo é carregado por endereço imediato explícito
 * (`0x004014D2`…`0x00401581`), o laço de `CB_ADDSTRING` percorre em passo 4 crescente e o combo não
 * tem `CBS_SORT`. O padrão de fábrica da própria ferramenta é `6`, WPA2-AES-PSK.
 *
 * **`0xFF` nunca sai daqui**, e é por isso que este campo é enum e não `Int`: no programa original
 * `KT` é o retorno cru de `CB_GETCURSEL`, e `CB_ERR` truncado vira `0xFF` sem que handler nenhum
 * valide.
 */
enum class ThermalWifiKeyType(val byte: Int) {
    OPEN(0),
    WEP_64(1),
    WEP_128(2),
    WPA_AES_PSK(3),
    WPA_TKIP_PSK(4),
    WPA_TKIP_AES_PSK(5),
    WPA2_AES_PSK(6),
    WPA2_TKIP(7),
    WPA2_TKIP_AES_PSK(8),
    WPA_WPA2_MIXED_MODE(9),
    ;

    /** Rede sem chave. Carregar senha aqui é segredo no quadro sem efeito nenhum. */
    val requiresPassword: Boolean
        get() = this != OPEN
}

/**
 * Qual dos três endereços do quadro `1F 1B 1F B4` está errado.
 *
 * O `B4` reescreve os três **sempre** — não existe "não mexa neste campo" —, então a recusa precisa
 * dizer qual deles, ou a pessoa conserta o errado.
 */
enum class ThermalWifiAddressField(
    /** Já com artigo, porque a frase de recusa começa por ele e o gênero muda. */
    val label: String,
) {
    IP("O endereço IP"),
    NETMASK("A máscara"),
    GATEWAY("O gateway"),
}

/**
 * Por que estes campos não viram quadro, com a frase que a pessoa lê.
 *
 * A frase mora no kit porque a regra também mora aqui: as faixas saíram do firmware e do emissor do
 * fabricante, não da tela. App que escrevesse a própria frase escreveria a própria régua junto, e as
 * duas envelheceriam separadas.
 *
 * **Nenhuma frase ecoa SSID ou senha** (AGENTS.md, Segurança). A recusa diz o limite, nunca o valor.
 */
sealed interface ThermalWifiRejection {
    val message: String

    data object SsidEmpty : ThermalWifiRejection {
        override val message: String = "Informe o nome da rede."
    }

    data class SsidTooLong(val max: Int) : ThermalWifiRejection {
        override val message: String = "O nome da rede aceita no máximo $max caracteres."
    }

    data object SsidNotAscii : ThermalWifiRejection {
        override val message: String = "O nome da rede aceita apenas letras e números sem acento."
    }

    data class PasswordLength(val min: Int, val max: Int) : ThermalWifiRejection {
        override val message: String = "A senha da rede precisa de $min a $max caracteres."
    }

    data object PasswordNotAscii : ThermalWifiRejection {
        override val message: String = "A senha da rede aceita apenas letras e números sem acento."
    }

    data object PasswordOnOpenNetwork : ThermalWifiRejection {
        override val message: String = "Rede aberta não leva senha."
    }

    data class AddressOctets(val field: ThermalWifiAddressField) : ThermalWifiRejection {
        override val message: String = "${field.label} precisa de quatro números de 0 a 255."
    }
}

/** Aceito, com o tamanho do quadro que sairá, ou recusado com o motivo. */
sealed interface ThermalWifiValidation {
    /**
     * [byteCount] é o tamanho do quadro em bytes, e **não** o quadro.
     *
     * A tela precisa confirmar antes de gravar — como o comando cru já confirma por contagem
     * ([RawCommandConfirmation]) — e o número de bytes é o que se pode mostrar sem repetir o
     * segredo na interface.
     */
    data class Accepted(val byteCount: Int) : ThermalWifiValidation

    data class Rejected(val reason: ThermalWifiRejection) : ThermalWifiValidation
}

/** Atalho para quem só quer o tamanho. */
val ThermalWifiValidation.byteCount: Int?
    get() = (this as? ThermalWifiValidation.Accepted)?.byteCount

/** Atalho para quem só quer a frase. */
val ThermalWifiValidation.rejection: ThermalWifiRejection?
    get() = (this as? ThermalWifiValidation.Rejected)?.reason

/**
 * Monta os quadros de configuração Wi-Fi das duas famílias, a partir de campos tipados.
 *
 * **Por que esta camada existe.** Em 21/08/2026 um quadro `1F 77` foi digitado à mão no painel de
 * comando cru, faltou um byte, e o frame deslocado **gravou assim mesmo**: SSID truncado, byte de
 * modo pego do `memset`, e a impressora saiu da rede. Um byte a menos não vira erro, vira frame
 * válido errado. Por isso aqui não há `parse(hex)`, não há `opcode:` e não há `raw:` — os bytes de
 * cabeçalho e os dois opcodes são constantes, e o único jeito de produzi-los é chamar uma destas
 * funções com campos que já passaram pela régua.
 *
 * **Estado da prova, e ele é assimétrico:**
 * - `1F 77` está **confirmado em papel**, escrevendo de verdade: o quadro de 15 bytes saiu de um
 *   iPhone pela TCP 9100, imprimiu o cupom do oráculo e a unidade subiu no modo gravado; o ciclo
 *   AP → cliente → AP fechou no mesmo dia.
 * - `1F 1B 1F` **não gravou nada ainda**. O que 22/08 mediu é que o cabeçalho de quatro bytes é
 *   honrado na TCP 9100 e que o layout do `B3` está certo — com um quadro deliberadamente **não
 *   terminado**, que não gravou nada. Comentário que disser "confirmado em hardware" para o B3/B4
 *   inteiro está mentindo.
 *
 * Convenção de erro: os construtores devolvem `null` e **nenhum byte**, como
 * [EscPosThermalCommands.qrRaster]. Quadro parcial é o modo de falha caro — os campos variáveis da
 * Rongta são lidos com timeout `−1`, então o que faltou é esperado para sempre e a impressora para
 * de imprimir. Quem precisa da frase chama [validate].
 *
 * Esta camada é pura: não conhece socket, não escolhe destino e não sabe qual impressora está do
 * outro lado. Mandar o quadro certo para a família errada continua sendo problema de quem envia —
 * ver [ThermalWifiProtocol].
 */
object ThermalWifiFrame {
    /**
     * O firmware da Rongta valida `1 ≤ L1 ≤ 33` (vaddr `0x83bc`); o padrão Wi-Fi para em 32 octetos.
     * O limite publicado é a interseção, porque é a única faixa em que os dois lados concordam.
     */
    val SSID_LENGTH_RANGE: IntRange = 1..32

    /**
     * O emissor do fabricante recusa chave abaixo de 8 (VA `0x436561`) e o firmware recusa `≥ 64`
     * (vaddr `0x83f4`): a interseção é 8..63, que também é a faixa da senha WPA no padrão.
     *
     * Vale para **todo** ramo com chave, os WEP inclusive, e isso recusa a chave de 5 caracteres do
     * WEP-64. É recusa consciente: nenhuma bancada deste projeto exercitou um ramo WEP em nenhuma
     * das duas famílias, e 8..63 é o único piso que algum dos lados chegou a declarar. Inventar um
     * piso menor seria emitir quadro que ninguém mediu.
     *
     * **A faixa é da família `1F 77`, e está sendo aplicada à `1F 1B 1F` sem medição.** Ali o `B3` e
     * o `B4` não têm campo de comprimento — a chave é só terminada em NUL —, e a varredura de
     * `0x419F00`–`0x41A120` não achou validação nenhuma. Manter 8..63 nas duas é escolha
     * conservadora, não fato medido: recusar uma chave curta custa ao chamador uma mensagem, e
     * emitir uma que a firmware rejeite custa uma unidade fora da rede. Se a bancada um dia medir a
     * faixa real da GoldenSky, a constante se separa por família — e aí este comentário sai.
     */
    val PASSWORD_LENGTH_RANGE: IntRange = 8..63

    /**
     * O alfabeto aceito nos dois campos de texto das duas famílias, igual ao do
     * [EscPosThermalCommands.qrRaster].
     *
     * ASCII imprimível é a interseção segura, e a recusa de acento é deliberada em vez de
     * transliteração: a ferramenta da GoldenSky converte com `CP_THREAD_ACP`, que depende da locale
     * de quem roda, e o quadro da Rongta conta `strlen` em bytes. Fora de ASCII, o mesmo nome de
     * rede vira quadros diferentes conforme a máquina — e o piso de 0x20 é também o que garante que
     * nenhum NUL entre num campo: na família `1F 1B 1F` o NUL é o terminador, e um no meio do SSID
     * truncaria o quadro e deslocaria tudo o que vem depois.
     */
    const val PRINTABLE_ASCII_MIN = 0x20
    const val PRINTABLE_ASCII_MAX = 0x7e

    // --- família 1F 77 (Rongta RPP200 / Bematech PP-10W) ----------------------------------------

    /**
     * Confere os campos do quadro `1F 77` e diz por que recusou, quando recusa.
     *
     * O modo não aparece aqui porque [ThermalWifiMode] é fechado: não há valor de modo inválido a
     * recusar, e é essa a diferença entre um enum e o byte cru que o `memset` preencheu em 21/08.
     */
    fun validate(
        ssid: String,
        security: ThermalWifiSecurity,
    ): ThermalWifiValidation {
        val ssidBytes =
            asciiBytes(ssid) ?: return ThermalWifiValidation.Rejected(ThermalWifiRejection.SsidNotAscii)
        ssidLengthRejection(ssidBytes)?.let { return ThermalWifiValidation.Rejected(it) }

        val password =
            passwordOf(security)
                // `1F 77 LL <SSID> 00 00 00 MM`.
                ?: return ThermalWifiValidation.Accepted(7 + ssidBytes.size)
        val passwordBytes =
            asciiBytes(password)
                ?: return ThermalWifiValidation.Rejected(ThermalWifiRejection.PasswordNotAscii)
        if (passwordBytes.size !in PASSWORD_LENGTH_RANGE) {
            return ThermalWifiValidation.Rejected(passwordLengthRejection)
        }
        // `1F 77 LL <SSID> AA EE KK <SENHA> MM`.
        return ThermalWifiValidation.Accepted(7 + ssidBytes.size + passwordBytes.size)
    }

    /**
     * Monta `1F 77 LL <SSID> AA EE KK <SENHA> MM`, ou `null` se algum campo estiver fora de faixa.
     *
     * Vai numa escrita só, sem prefixo, comprimento, checksum ou terminador: a DLL do fabricante
     * repassa o mesmo buffer direto para `WriteFile`/`WritePrinter`/`send`, então os bytes servem
     * igual por USB, serial e TCP 9100.
     *
     * O comando roda o emissor AT do módulo, e o emissor AT derruba o modo transparente — ou seja,
     * **a própria conexão que entregou o quadro cai**. O comprovante é o cupom, que sai antes; quem
     * enviar não deve esperar resposta.
     */
    fun usW(
        ssid: String,
        security: ThermalWifiSecurity,
        mode: ThermalWifiMode,
    ): ByteArray? {
        if (validate(ssid, security) !is ThermalWifiValidation.Accepted) return null
        val ssidBytes = asciiBytes(ssid) ?: return null

        var frame = ThermalWifiProtocol.US_W.headerBytes
        frame += ssidBytes.size.toByte()
        frame += ssidBytes
        val password = passwordOf(security)
        if (password == null) {
            // Rede aberta colapsa `AA`, `EE` e `KK` em zeros — o emissor do fabricante avança três
            // posições sobre buffer pré-zerado (VA `0x436469`) e não escreve senha nenhuma. É este
            // o quadro de 15 bytes confirmado em papel.
            frame += byteArrayOf(0, 0, 0)
        } else {
            // A recusa é aqui dentro, e não num `else` alcançável por senha inválida: um `else`
            // assim emitiria o colapso de rede aberta no lugar do quadro pedido — um quadro válido,
            // bem-formado e diferente do que a pessoa mandou, que é a família de erro que esta
            // camada existe para não ter.
            val passwordBytes = asciiBytes(password) ?: return null
            frame += security.auth.byte.toByte()
            frame += security.cipher.byte.toByte()
            frame += passwordBytes.size.toByte()
            frame += passwordBytes
        }
        frame += mode.byte.toByte()
        return frame
    }

    // --- família 1F 1B 1F (GoldenSky GS-T80C-WF) ------------------------------------------------

    /** Confere os campos do quadro `B3`. */
    fun validate(
        keyType: ThermalWifiKeyType,
        ssid: String,
        password: String,
    ): ThermalWifiValidation {
        val ssidBytes =
            asciiBytes(ssid) ?: return ThermalWifiValidation.Rejected(ThermalWifiRejection.SsidNotAscii)
        ssidLengthRejection(ssidBytes)?.let { return ThermalWifiValidation.Rejected(it) }
        val passwordBytes =
            asciiBytes(password)
                ?: return ThermalWifiValidation.Rejected(ThermalWifiRejection.PasswordNotAscii)

        if (!keyType.requiresPassword) {
            // Aqui não há colapso: o `B3` sempre emite `<SENHA>00`, então uma senha numa rede aberta
            // iria mesmo para o fio, em claro, sem servir para nada.
            if (passwordBytes.isNotEmpty()) {
                return ThermalWifiValidation.Rejected(ThermalWifiRejection.PasswordOnOpenNetwork)
            }
            // `1F 1B 1F B3 <KT> <SSID>00 00`.
            return ThermalWifiValidation.Accepted(7 + ssidBytes.size)
        }
        if (passwordBytes.size !in PASSWORD_LENGTH_RANGE) {
            return ThermalWifiValidation.Rejected(passwordLengthRejection)
        }
        // `1F 1B 1F B3 <KT> <SSID>00 <SENHA>00`.
        return ThermalWifiValidation.Accepted(7 + ssidBytes.size + passwordBytes.size)
    }

    /**
     * Monta `1F 1B 1F B3 <KT> <SSID>00 <SENHA>00`, ou `null` se algum campo estiver fora de faixa.
     *
     * **É o comando de menor risco da família, e por isso existe separado do quadro completo.** A
     * varredura exaustiva do handler (`0x419F00`–`0x41A120`) por qualquer operando `[edi+0xD0..0xDB]`
     * não achou nenhum: o `B3` **não carrega endereço**, então não há como perder a impressora por
     * IP fixo errado.
     *
     * Sem campo de comprimento, sem checksum, sem terminador final e sem `\n`: quem separa SSID de
     * senha é o `NUL`. Vai numa escrita só — a ferramenta do fabricante nunca fragmenta, e não há
     * evidência de que o firmware remonte.
     */
    fun usEscUsWifiOnly(
        keyType: ThermalWifiKeyType,
        ssid: String,
        password: String,
    ): ByteArray? {
        if (validate(keyType, ssid, password) !is ThermalWifiValidation.Accepted) return null
        val ssidBytes = asciiBytes(ssid) ?: return null
        val passwordBytes = asciiBytes(password) ?: return null

        var frame = ThermalWifiProtocol.US_ESC_US.headerBytes
        frame += WIFI_ONLY_OPCODE.toByte()
        frame += keyType.byte.toByte()
        frame += ssidBytes
        frame += 0.toByte()
        frame += passwordBytes
        frame += 0.toByte()
        return frame
    }

    /** Confere os campos do quadro `B4`, os três endereços inclusive. */
    fun validate(
        ip: List<Int>,
        netmask: List<Int>,
        gateway: List<Int>,
        keyType: ThermalWifiKeyType,
        ssid: String,
        password: String,
    ): ThermalWifiValidation {
        // O endereço vem antes do Wi-Fi na ordem da recusa porque é o campo que tira a impressora da
        // rede: SSID errado se corrige com outro quadro, IP fixo errado às vezes só com cabo.
        val addresses =
            listOf(
                ThermalWifiAddressField.IP to ip,
                ThermalWifiAddressField.NETMASK to netmask,
                ThermalWifiAddressField.GATEWAY to gateway,
            )
        addresses.forEach { (field, octets) ->
            if (!isAddress(octets)) {
                return ThermalWifiValidation.Rejected(ThermalWifiRejection.AddressOctets(field))
            }
        }
        val wifi = validate(keyType, ssid, password)
        if (wifi !is ThermalWifiValidation.Accepted) return wifi
        // Os doze octetos são tudo o que o `B4` acrescenta sobre o `B3`.
        return ThermalWifiValidation.Accepted(wifi.byteCount + 12)
    }

    /**
     * Monta `1F 1B 1F B4 <IP×4> <MÁSCARA×4> <GATEWAY×4> <KT> <SSID>00 <SENHA>00`, ou `null`.
     *
     * **Os três endereços são obrigatórios porque o comando reescreve os três, sempre.** Não existe
     * "não mexa neste campo": na ferramenta do fabricante o retorno de `UpdateData` é ignorado
     * (`0x41979A`/`0x4197A1`) e octeto em branco vira zero em silêncio. Aqui octeto ausente é
     * recusa, não zero.
     *
     * Octetos em ordem natural `a.b.c.d`, provado por dois caminhos independentes: o `IPM_GETADDRESS`
     * do DDX e o default `192.168.123.100` do próprio binário. Os parâmetros são `Int` para a
     * validação acontecer antes da conversão — converter para `Byte` primeiro faria `256` chegar ao
     * fio como `0`, que é um endereço válido e errado.
     */
    fun usEscUsAll(
        ip: List<Int>,
        netmask: List<Int>,
        gateway: List<Int>,
        keyType: ThermalWifiKeyType,
        ssid: String,
        password: String,
    ): ByteArray? {
        if (validate(ip, netmask, gateway, keyType, ssid, password) !is ThermalWifiValidation.Accepted) {
            return null
        }
        val ssidBytes = asciiBytes(ssid) ?: return null
        val passwordBytes = asciiBytes(password) ?: return null

        var frame = ThermalWifiProtocol.US_ESC_US.headerBytes
        frame += EVERYTHING_OPCODE.toByte()
        frame += octets(ip + netmask + gateway)
        frame += keyType.byte.toByte()
        frame += ssidBytes
        frame += 0.toByte()
        frame += passwordBytes
        frame += 0.toByte()
        return frame
    }

    // --- régua interna --------------------------------------------------------------------------

    /**
     * Opcodes da família `1F 1B 1F`. São privados de propósito: publicá-los abriria caminho para
     * `B8` (modo USB), `BF` (DIP switches), `33` e `91`, que são os quadros desta família que mexem
     * no caminho de socorro.
     */
    private const val WIFI_ONLY_OPCODE = 0xb3
    private const val EVERYTHING_OPCODE = 0xb4

    private val passwordLengthRejection =
        ThermalWifiRejection.PasswordLength(
            min = PASSWORD_LENGTH_RANGE.first,
            max = PASSWORD_LENGTH_RANGE.last,
        )

    /** A senha que vai no quadro, ou `null` quando o ramo não carrega nenhuma. */
    private fun passwordOf(security: ThermalWifiSecurity): String? =
        when (security) {
            ThermalWifiSecurity.Open -> null
            is ThermalWifiSecurity.WepOpen -> security.password
            is ThermalWifiSecurity.WepShared -> security.password
            is ThermalWifiSecurity.WpaPsk -> security.password
            is ThermalWifiSecurity.Wpa2Psk -> security.password
        }

    /**
     * Os bytes, ou `null` se algum sair do ASCII imprimível.
     *
     * Conta em **bytes**, não em caracteres: `LL` e `KK` da Rongta são `strlen`, e `String.length`
     * conta unidades de UTF-16. Recusar unidade a unidade antes de contar é o que faz as duas coisas
     * concordarem — depois da recusa, uma unidade é um byte.
     */
    private fun asciiBytes(value: String): ByteArray? {
        if (value.any { it.code !in PRINTABLE_ASCII_MIN..PRINTABLE_ASCII_MAX }) return null
        return ByteArray(value.length) { value[it].code.toByte() }
    }

    private fun ssidLengthRejection(bytes: ByteArray): ThermalWifiRejection? =
        when {
            bytes.size < SSID_LENGTH_RANGE.first -> ThermalWifiRejection.SsidEmpty
            // Nome invisível é a vizinhança imediata da string vazia, e o preço de gravar o SSID
            // errado é a unidade sair da rede — na Rongta, medido em 21/08. Espaço no meio ou nas
            // pontas de um nome real continua legítimo; só o todo-espaço cai aqui.
            bytes.all { it == 0x20.toByte() } -> ThermalWifiRejection.SsidEmpty
            bytes.size > SSID_LENGTH_RANGE.last ->
                ThermalWifiRejection.SsidTooLong(SSID_LENGTH_RANGE.last)
            else -> null
        }

    private fun isAddress(octets: List<Int>): Boolean =
        octets.size == 4 && octets.all { it in 0..255 }

    private fun octets(values: List<Int>): ByteArray = ByteArray(values.size) { values[it].toByte() }
}
