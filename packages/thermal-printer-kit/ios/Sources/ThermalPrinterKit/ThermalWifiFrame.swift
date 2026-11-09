import Foundation

/**
 As duas gramáticas de configuração Wi-Fi que o kit sabe montar.

 O nome é o dos bytes de cabeçalho, não o da marca, pela mesma razão que ``CutProtocol`` chama o
 dialeto de corte de `GS_V_0` e `ESC_M`: a marca muda de rótulo e o byte não. ``usW`` é o
 `1F 77` da Rongta RPP200, que a Bematech revende como PP-10W; ``usEscUs`` é o `1F 1B 1F` da
 GoldenSky GS-T80C-WF.

 **Não existe valor padrão, de propósito.** As duas famílias não são intercambiáveis e a impressora
 errada não avisa: medido em 21/08/2026, a GoldenSky engole `12 54` e `1F 78` sem efeito nenhum, e a
 Rongta não entende `1F 1B 1F`. Quem chama precisa dizer qual, e a escolha vem de sonda no aparelho —
 nunca de catálogo, que foi o que este projeto decidiu não fazer.
 */
public enum ThermalWifiProtocol: String, Codable, CaseIterable, Sendable {
    /// `1F 77` — Rongta RPP200 / Bematech PP-10W, portátil de 58 mm.
    case usW = "US_W"
    /// `1F 1B 1F` — GoldenSky GS-T80C-WF, POS de 80 mm.
    case usEscUs = "US_ESC_US"

    /// Só os bytes fixos de cabeçalho. O opcode nunca sai daqui: ele é escolhido pela função de
    /// montagem, e é isso que impede um chamador de pedir `1F 1B 1F B8` (modo USB) ou `1F 6D`
    /// (grava MAC) por parâmetro.
    ///
    /// **Interno de propósito.** Publicado, ele entregava pronto para o fio exatamente o que os
    /// dois documentos de bancada listam em "bytes que NUNCA devem ser enviados": `1F 1B 1F` solto
    /// faz o próximo byte do fluxo virar seletor — e `0x42` é o opcode do buzzer —, e `1F 77` sem
    /// campos é o quadro truncado que trava o parser da Rongta, porque os campos variáveis são
    /// lidos com timeout −1. Quem só precisa mostrar a família usa ``label``.
    internal var headerBytes: Data {
        switch self {
        case .usW: return Data([0x1f, 0x77])
        case .usEscUs: return Data([0x1f, 0x1b, 0x1f])
        }
    }

    public var label: String {
        switch self {
        case .usW: return "1F 77"
        case .usEscUs: return "1F 1B 1F"
        }
    }
}

/**
 O byte `AA` do quadro `1F 77`: quem autentica.

 Os quatro valores saíram do desmonte dos sete ramos do firmware (vaddr `0xb140`–`0xb1dc`), onde o
 par `AA`/`EE` escolhe literalmente qual string vai no `AT+WSKEY=` do módulo. O firmware trata
 **qualquer** valor `≥ 3` como WPA2-PSK; o kit emite sempre o 3, porque um número maior não
 acrescenta nada e o `MODE ≤ 2` vizinho mostra que essa firmware valida faixa por comparação crua.
 */
public enum ThermalWifiAuth: String, Codable, CaseIterable, Sendable {
    case open = "OPEN"
    case shared = "SHARED"
    case wpaPSK = "WPA_PSK"
    case wpa2PSK = "WPA2_PSK"

    public var byte: UInt8 {
        switch self {
        case .open: return 0
        case .shared: return 1
        case .wpaPSK: return 2
        case .wpa2PSK: return 3
        }
    }
}

/**
 O byte `EE` do quadro `1F 77`: qual cifra, dentro do ramo que o `AA` escolheu.

 O firmware só compara com zero, então o vocabulário real tem dois valores. O sentido deles depende
 do `AA`: com ``ThermalWifiAuth/open`` o `EE` separa `OPEN,NONE` de `OPEN,WEP-A,`; com
 ``ThermalWifiAuth/wpaPSK`` e ``ThermalWifiAuth/wpa2PSK`` ele separa TKIP de AES. É por isso que os
 dois casos carregam os dois nomes: um byte, duas leituras.
 */
public enum ThermalWifiCipher: String, Codable, CaseIterable, Sendable {
    /// `0` — `NONE` no ramo aberto, `TKIP` nos ramos PSK.
    case noneTKIP = "NONE_TKIP"
    /// `≠0` — `WEP-A` no ramo aberto, `AES` nos ramos PSK. O kit emite sempre `1`.
    case wepAES = "WEP_AES"

    public var byte: UInt8 {
        switch self {
        case .noneTKIP: return 0
        case .wepAES: return 1
        }
    }
}

/**
 A segurança da rede na família `1F 77`, fechada nos sete ramos que o firmware tem.

 **Por que não é um par solto de `AA` e `EE`.** As sete combinações medidas não são o produto
 cartesiano: com `AA=1` o `EE` é ignorado, e com `AA=0`/`EE=0` o firmware retorna já em `0xb1c2` e
 **descarta a chave**. Um par solto deixaria montar `OPEN,NONE` carregando senha — bytes de segredo
 no quadro, com efeito nenhum, que é vazamento puro. Aqui ``open`` simplesmente não tem onde guardar
 uma senha.

 Os três bytes do meio colapsam em `00 00 00` no caso ``open``: `1F 77 LL <SSID> 00 00 00 MM`,
 exatamente como o emissor do fabricante faz avançando três posições sobre buffer pré-zerado
 (VA `0x436469`) — e é esse o quadro de 15 bytes confirmado em papel em 21/08/2026.
 */
public enum ThermalWifiSecurity: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// `OPEN,NONE`. Sem senha, e sem os bytes `KK`/`<SENHA>` no quadro.
    case open
    /// `OPEN,WEP-A,` — WEP com autenticação aberta.
    case wepOpen(password: String)
    /// `SHARED,WEP-A,` — WEP com chave compartilhada. O `EE` é ignorado neste ramo; sai `0`.
    case wepShared(password: String)
    /// `WPAPSK,TKIP,` ou `WPAPSK,AES,`, conforme a cifra.
    case wpaPSK(cipher: ThermalWifiCipher, password: String)
    /// `WPA2PSK,TKIP,` ou `WPA2PSK,AES,`, conforme a cifra.
    case wpa2PSK(cipher: ThermalWifiCipher, password: String)

    public var auth: ThermalWifiAuth {
        switch self {
        case .open, .wepOpen: return .open
        case .wepShared: return .shared
        case .wpaPSK: return .wpaPSK
        case .wpa2PSK: return .wpa2PSK
        }
    }

    public var cipher: ThermalWifiCipher {
        switch self {
        case .open: return .noneTKIP
        case .wepOpen: return .wepAES
        // O firmware ignora o `EE` quando `AA=1` (ramo `SHARED,WEP-A,`, vaddr `0xb140`). Emitir `0`
        // fixo é o que mantém o quadro determinístico entre as duas plataformas.
        case .wepShared: return .noneTKIP
        case .wpaPSK(let cipher, _), .wpa2PSK(let cipher, _): return cipher
        }
    }

    /// A senha que vai no quadro, ou `nil` quando o ramo não carrega nenhuma.
    var password: String? {
        switch self {
        case .open: return nil
        case .wepOpen(let password), .wepShared(let password): return password
        case .wpaPSK(_, let password), .wpa2PSK(_, let password): return password
        }
    }

    /// A senha da rede é segredo (AGENTS.md, Segurança). A descrição sintetizada de um enum com
    /// valor associado imprimiria a senha em qualquer interpolação de string — por isso esta.
    public var description: String { "ThermalWifiSecurity(auth=\(auth.rawValue), password=[REDACTED])" }
    public var debugDescription: String { description }
}

/**
 O byte `MM` do quadro `1F 77`.

 **`1` é ponto de acesso; qualquer outro valor é cliente.** Lido no firmware em `0xb35c`
 (`cmp r0,#1 / bne` → ramo STA) e confirmado em papel nos dois sentidos em 21/08/2026, no ciclo
 AP → cliente → AP feito só com telefones. Este mapeamento já foi "corrigido" ao contrário uma vez,
 a partir de um envio cuja entrada estava corrompida, e a correção tirou uma impressora da rede.
 Não reabra sem firmware novo na mão.
 */
public enum ThermalWifiMode: String, Codable, CaseIterable, Sendable {
    /// A impressora vira o ponto de acesso. É a rota de volta garantida.
    case accessPoint = "ACCESS_POINT"
    /// A impressora entra na rede de outro ponto de acesso.
    case station = "STATION"

    public var byte: UInt8 {
        switch self {
        case .accessPoint: return 1
        case .station: return 0
        }
    }
}

/**
 O byte `KT` da família `1F 1B 1F`: o vocabulário de segurança da GoldenSky.

 **É outro vocabulário, e não se traduz por índice para o da Rongta.** Aqui há dez valores num byte
 só; lá há dois bytes com sete combinações. Mapear um no outro por posição é exatamente a armadilha
 que já derrubou uma impressora neste projeto.

 A numeração não veio de ordem de array: cada posição recebe seu literal por endereço imediato
 explícito (`0x004014D2`…`0x00401581`), o laço de `CB_ADDSTRING` percorre o bloco em passo 4
 crescente e o combo não tem `CBS_SORT`.

 **`0xFF` nunca sai daqui.** Na ferramenta do fabricante o `KT` é o retorno cru de `CB_GETCURSEL`,
 e `CB_ERR` truncado vira `0xFF` sem que handler nenhum valide. Um enum fechado é o que impede isso
 de existir por engano do chamador.
 */
public enum ThermalWifiKeyType: String, Codable, CaseIterable, Sendable {
    case open = "OPEN"
    case wep64 = "WEP_64"
    case wep128 = "WEP_128"
    case wpaAESPSK = "WPA_AES_PSK"
    case wpaTKIPPSK = "WPA_TKIP_PSK"
    case wpaTKIPAESPSK = "WPA_TKIP_AES_PSK"
    case wpa2AESPSK = "WPA2_AES_PSK"
    case wpa2TKIP = "WPA2_TKIP"
    case wpa2TKIPAESPSK = "WPA2_TKIP_AES_PSK"
    case wpaWPA2MixedMode = "WPA_WPA2_MIXED_MODE"

    public var byte: UInt8 {
        switch self {
        case .open: return 0
        case .wep64: return 1
        case .wep128: return 2
        case .wpaAESPSK: return 3
        case .wpaTKIPPSK: return 4
        case .wpaTKIPAESPSK: return 5
        case .wpa2AESPSK: return 6
        case .wpa2TKIP: return 7
        case .wpa2TKIPAESPSK: return 8
        case .wpaWPA2MixedMode: return 9
        }
    }

    /// Rede sem chave. Carregar senha aqui é segredo no quadro sem efeito nenhum.
    public var requiresPassword: Bool { self != .open }
}

/// Qual dos três endereços do quadro `1F 1B 1F B4` está errado.
///
/// O `B4` reescreve os três **sempre** — não existe "não mexa neste campo" —, então a recusa precisa
/// dizer qual deles, ou a pessoa conserta o errado.
public enum ThermalWifiAddressField: String, Codable, CaseIterable, Sendable {
    case ip = "IP"
    case netmask = "NETMASK"
    case gateway = "GATEWAY"

    /// Já com artigo, porque a frase de recusa começa por ele e o gênero muda.
    public var label: String {
        switch self {
        case .ip: return "O endereço IP"
        case .netmask: return "A máscara"
        case .gateway: return "O gateway"
        }
    }
}

/**
 Por que estes campos não viram quadro, com a frase que a pessoa lê.

 A frase mora no kit porque a regra também mora aqui: as faixas saíram do firmware e do emissor do
 fabricante, não da tela. App que escrevesse a própria frase escreveria a própria régua junto, e as
 duas envelheceriam separadas.

 **Nenhuma frase ecoa SSID ou senha** (AGENTS.md, Segurança). A recusa diz o limite, nunca o valor.
 */
public enum ThermalWifiRejection: Equatable, Sendable {
    case ssidEmpty
    case ssidTooLong(max: Int)
    case ssidNotASCII
    case passwordLength(min: Int, max: Int)
    case passwordNotASCII
    case passwordOnOpenNetwork
    case addressOctets(field: ThermalWifiAddressField)

    public var message: String {
        switch self {
        case .ssidEmpty:
            return "Informe o nome da rede."
        case .ssidTooLong(let max):
            return "O nome da rede aceita no máximo \(max) caracteres."
        case .ssidNotASCII:
            return "O nome da rede aceita apenas letras e números sem acento."
        case .passwordLength(let min, let max):
            return "A senha da rede precisa de \(min) a \(max) caracteres."
        case .passwordNotASCII:
            return "A senha da rede aceita apenas letras e números sem acento."
        case .passwordOnOpenNetwork:
            return "Rede aberta não leva senha."
        case .addressOctets(let field):
            return "\(field.label) precisa de quatro números de 0 a 255."
        }
    }
}

/// Aceito, com o tamanho do quadro que sairá, ou recusado com o motivo.
public enum ThermalWifiValidation: Equatable, Sendable {
    /**
     O associado é o tamanho do quadro em bytes, e **não** o quadro.

     A tela precisa confirmar antes de gravar — como o comando cru já confirma por contagem
     (``RawCommandConfirmation``) — e o número de bytes é o que se pode mostrar sem repetir o
     segredo na interface.
     */
    case accepted(byteCount: Int)
    case rejected(reason: ThermalWifiRejection)

    /// Atalho para quem só quer o tamanho.
    public var byteCount: Int? {
        if case .accepted(let count) = self { return count }
        return nil
    }

    /// Atalho para quem só quer a frase.
    public var rejection: ThermalWifiRejection? {
        if case .rejected(let reason) = self { return reason }
        return nil
    }
}

/**
 Monta os quadros de configuração Wi-Fi das duas famílias, a partir de campos tipados.

 **Por que esta camada existe.** Em 21/08/2026 um quadro `1F 77` foi digitado à mão no painel de
 comando cru, faltou o byte `61` de um `a`, e o frame deslocado **gravou assim mesmo**: SSID
 truncado, byte de modo pego do `memset`, e a impressora saiu da rede. Um byte a menos não vira
 erro, vira frame válido errado. Por isso aqui não há `init(hex:)`, `parse(text:)` nem parâmetro
 que produza opcode: os bytes de cabeçalho são constantes internas, e entrada fora de faixa devolve
 `nil` sem emitir byte nenhum.

 **Quadro parcial é pior que quadro nenhum.** Na Rongta os campos variáveis são lidos com timeout
 `−1` (vaddr `0x83a6`): quadro incompleto trava o parser até chegarem bytes que nunca virão, e a
 impressora para de imprimir. Fora de faixa é pior ainda — o handler sai por `0x844a` sem consumir,
 e o SSID vira comando ESC/POS de topo. Daí a regra: valida tudo, então emite tudo, ou não emite
 nada.

 **Estado da prova, e ele é diferente nas duas famílias.** O `1F 77` está confirmado em papel
 escrevendo de verdade: o quadro de 15 bytes abaixo saiu de um iPhone por TCP 9100, imprimiu o cupom
 `Mode: STA` e a unidade subiu em modo cliente no boot seguinte; o ciclo AP → cliente → AP foi
 fechado com `MM=01`. O `1F 1B 1F` **não**: o que a bancada provou em 22/08/2026 é que o cabeçalho
 de quatro bytes é honrado na 9100 e que o layout do `B3` está certo, com um quadro deliberadamente
 **não terminado** que não gravou nada. Nenhum quadro desta segunda família chegou a escrever.

 Esta camada é pura: não conhece socket, não escolhe destino e não lê resposta. Espelho literal de
 `ThermalWifiFrame.kt`; quem mexer numa faixa aqui mexe nas duas, e a suíte de paridade existe para
 gritar quando isso não acontecer.
 */
public enum ThermalWifiFrame {
    /// O firmware valida `1 ≤ L1 ≤ 33` (vaddr `0x83bc`); o padrão Wi-Fi para em 32. Vale a
    /// interseção, que é a mais apertada das duas.
    public static let ssidLengthRange = 1...32

    /**
     Faixa de comprimento da senha, em bytes, para todo ramo que carrega chave.

     A interseção medida: o emissor do fabricante recusa `len < 8` ou `len > 0x40` (VA `0x436561`) e
     o firmware recusa `L2 ≥ 0x40` (vaddr `0x83f4`). Sobra 8..63.

     **O piso de 8 é do emissor, não do padrão Wi-Fi**, e vale também para os ramos WEP: a checagem
     do fabricante é única e fica antes do `0x4365dc`, que grava o `KK` de todo quadro com chave.
     Uma chave WEP-40 de cinco caracteres é recusada aqui de propósito — nenhuma medição desta
     bancada jamais conseguiu enviar uma.

     **A faixa é da família `1F 77`, e está sendo aplicada à `1F 1B 1F` sem medição.** Ali o `B3` e
     o `B4` não têm campo de comprimento — a chave é só terminada em NUL —, e a varredura de
     `0x419F00`–`0x41A120` não achou validação nenhuma. Manter 8..63 nas duas é escolha
     conservadora, não fato medido: recusar uma chave curta custa ao chamador uma mensagem, e
     emitir uma que a firmware rejeite custa uma unidade fora da rede. Se a bancada um dia medir a
     faixa real da GoldenSky, a constante se separa por família — e aí este comentário sai.
     */
    public static let passwordLengthRange = 8...63

    /// ASCII imprimível, e nada mais. É o piso que exclui o `NUL`: na família `1F 1B 1F` o `NUL` é o
    /// terminador de campo, então um zero no meio do SSID truncaria o quadro e deslocaria a senha;
    /// na Rongta o firmware aborta em `0x83d8` se o primeiro byte do SSID for zero. Acento é
    /// recusado em vez de transliterado porque a GoldenSky converte por `CP_THREAD_ACP`, que depende
    /// da locale de quem enviou — ASCII é a interseção que não depende de ninguém.
    public static let printableASCIIMin: UInt8 = 0x20
    public static let printableASCIIMax: UInt8 = 0x7e

    // MARK: - família 1F 77 (Rongta RPP200 / Bematech PP-10W)

    /// Confere os campos do quadro `1F 77` e diz por que recusou, quando recusa.
    ///
    /// O modo não aparece aqui porque ``ThermalWifiMode`` é fechado: não há valor de modo inválido a
    /// recusar, e é essa a diferença entre um enum e o byte cru que o `memset` preencheu em 21/08.
    public static func validate(ssid: String, security: ThermalWifiSecurity) -> ThermalWifiValidation {
        guard let ssidBytes = asciiBytes(ssid) else { return .rejected(reason: .ssidNotASCII) }
        if let reason = ssidLengthRejection(ssidBytes) { return .rejected(reason: reason) }

        guard let password = security.password else {
            // `1F 77 LL <SSID> 00 00 00 MM`.
            return .accepted(byteCount: 7 + ssidBytes.count)
        }
        guard let passwordBytes = asciiBytes(password) else { return .rejected(reason: .passwordNotASCII) }
        guard passwordLengthRange.contains(passwordBytes.count) else {
            return .rejected(reason: passwordLengthRejection)
        }
        // `1F 77 LL <SSID> AA EE KK <SENHA> MM`.
        return .accepted(byteCount: 7 + ssidBytes.count + passwordBytes.count)
    }

    /**
     Monta `1F 77 LL <SSID> AA EE KK <SENHA> MM`, ou `nil` se algum campo estiver fora de faixa.

     Vai numa escrita só, sem prefixo, comprimento, checksum ou terminador: a DLL do fabricante
     repassa o mesmo buffer direto para `WriteFile`/`WritePrinter`/`send`, então os bytes servem
     igual por USB, serial e TCP 9100.

     O comando roda o emissor AT do módulo, e o emissor AT derruba o modo transparente — ou seja,
     **a própria conexão que entregou o quadro cai**. O comprovante é o cupom, que sai antes; quem
     enviar não deve esperar resposta.
     */
    public static func usW(
        ssid: String,
        security: ThermalWifiSecurity,
        mode: ThermalWifiMode
    ) -> Data? {
        guard case .accepted = validate(ssid: ssid, security: security),
              let ssidBytes = asciiBytes(ssid)
        else { return nil }

        var frame = ThermalWifiProtocol.usW.headerBytes
        frame.append(UInt8(ssidBytes.count))
        frame.append(contentsOf: ssidBytes)
        if let password = security.password {
            // A recusa é aqui dentro, e não numa condição que caia no `else`: um `else` alcançável
            // por senha inválida emitiria o colapso de rede aberta no lugar do quadro pedido — um
            // quadro válido, bem-formado e diferente do que a pessoa mandou, que é a família de erro
            // que esta camada existe para não ter.
            guard let passwordBytes = asciiBytes(password) else { return nil }
            frame.append(security.auth.byte)
            frame.append(security.cipher.byte)
            frame.append(UInt8(passwordBytes.count))
            frame.append(contentsOf: passwordBytes)
        } else {
            // Rede aberta colapsa `AA`, `EE` e `KK` em zeros — o emissor do fabricante avança três
            // posições sobre buffer pré-zerado (VA `0x436469`) e não escreve senha nenhuma. É este
            // o quadro de 15 bytes confirmado em papel.
            frame.append(contentsOf: [0, 0, 0])
        }
        frame.append(mode.byte)
        return frame
    }

    // MARK: - família 1F 1B 1F (GoldenSky GS-T80C-WF)

    /// Confere os campos do quadro `B3`.
    public static func validate(
        keyType: ThermalWifiKeyType,
        ssid: String,
        password: String
    ) -> ThermalWifiValidation {
        guard let ssidBytes = asciiBytes(ssid) else { return .rejected(reason: .ssidNotASCII) }
        if let reason = ssidLengthRejection(ssidBytes) { return .rejected(reason: reason) }
        guard let passwordBytes = asciiBytes(password) else { return .rejected(reason: .passwordNotASCII) }

        guard keyType.requiresPassword else {
            // Aqui não há colapso: o `B3` sempre emite `<SENHA>00`, então uma senha numa rede aberta
            // iria mesmo para o fio, em claro, sem servir para nada.
            guard passwordBytes.isEmpty else { return .rejected(reason: .passwordOnOpenNetwork) }
            // `1F 1B 1F B3 <KT> <SSID>00 00`.
            return .accepted(byteCount: 7 + ssidBytes.count)
        }
        guard passwordLengthRange.contains(passwordBytes.count) else {
            return .rejected(reason: passwordLengthRejection)
        }
        // `1F 1B 1F B3 <KT> <SSID>00 <SENHA>00`.
        return .accepted(byteCount: 7 + ssidBytes.count + passwordBytes.count)
    }

    /**
     Monta `1F 1B 1F B3 <KT> <SSID>00 <SENHA>00`, ou `nil` se algum campo estiver fora de faixa.

     **É o comando de menor risco da família, e por isso ele existe separado do quadro completo.**
     A varredura exaustiva do handler (`0x419F00`–`0x41A120`) por qualquer operando `[edi+0xD0..0xDB]`
     não achou nenhum: o `B3` **não carrega endereço**, então não há como perder a impressora por IP
     fixo errado.

     Sem campo de comprimento, sem checksum, sem terminador final e sem `\n`: quem separa SSID de
     senha é o `NUL`. Vai numa escrita só — a ferramenta do fabricante nunca fragmenta, e não há
     evidência de que o firmware remonte.
     */
    public static func usEscUsWifiOnly(
        keyType: ThermalWifiKeyType,
        ssid: String,
        password: String
    ) -> Data? {
        guard case .accepted = validate(keyType: keyType, ssid: ssid, password: password),
              let ssidBytes = asciiBytes(ssid),
              let passwordBytes = asciiBytes(password)
        else { return nil }

        var frame = ThermalWifiProtocol.usEscUs.headerBytes
        frame.append(wifiOnlyOpcode)
        frame.append(keyType.byte)
        frame.append(contentsOf: ssidBytes)
        frame.append(0)
        frame.append(contentsOf: passwordBytes)
        frame.append(0)
        return frame
    }

    /// Confere os campos do quadro `B4`, incluindo os três endereços.
    public static func validate(
        ip: [Int],
        netmask: [Int],
        gateway: [Int],
        keyType: ThermalWifiKeyType,
        ssid: String,
        password: String
    ) -> ThermalWifiValidation {
        // O endereço vem antes do Wi-Fi na ordem da recusa porque é o campo que tira a impressora da
        // rede: SSID errado se corrige com outro quadro, IP fixo errado às vezes só com cabo.
        let addresses: [(ThermalWifiAddressField, [Int])] = [
            (.ip, ip), (.netmask, netmask), (.gateway, gateway),
        ]
        for (field, octets) in addresses where !isAddress(octets) {
            return .rejected(reason: .addressOctets(field: field))
        }
        let wifi = validate(keyType: keyType, ssid: ssid, password: password)
        guard case .accepted(let wifiByteCount) = wifi else { return wifi }
        // Os doze octetos são tudo o que o `B4` acrescenta sobre o `B3`.
        return .accepted(byteCount: wifiByteCount + 12)
    }

    /**
     Monta `1F 1B 1F B4 <IP×4> <MÁSCARA×4> <GATEWAY×4> <KT> <SSID>00 <SENHA>00`, ou `nil`.

     **Os três endereços são obrigatórios porque o comando reescreve os três, sempre.** Não existe
     "não mexa neste campo": na ferramenta do fabricante o retorno de `UpdateData` é ignorado
     (`0x41979A`/`0x4197A1`) e octeto em branco vira zero em silêncio. Aqui octeto ausente é recusa,
     não zero.

     Octetos em ordem natural `a.b.c.d`, provado por dois caminhos independentes: o `IPM_GETADDRESS`
     do DDX e o default `192.168.123.100` do próprio binário. Os argumentos são `Int` para a
     validação acontecer antes da conversão — inicializar `UInt8` por truncamento faria `256` chegar
     ao fio como `0`, que é um endereço válido e errado.
     */
    public static func usEscUsAll(
        ip: [Int],
        netmask: [Int],
        gateway: [Int],
        keyType: ThermalWifiKeyType,
        ssid: String,
        password: String
    ) -> Data? {
        guard case .accepted = validate(
            ip: ip, netmask: netmask, gateway: gateway,
            keyType: keyType, ssid: ssid, password: password
        ),
        let ssidBytes = asciiBytes(ssid),
        let passwordBytes = asciiBytes(password)
        else { return nil }

        var frame = ThermalWifiProtocol.usEscUs.headerBytes
        frame.append(everythingOpcode)
        frame.append(contentsOf: (ip + netmask + gateway).map { UInt8($0) })
        frame.append(keyType.byte)
        frame.append(contentsOf: ssidBytes)
        frame.append(0)
        frame.append(contentsOf: passwordBytes)
        frame.append(0)
        return frame
    }

    // MARK: - régua interna

    /// Opcodes da família `1F 1B 1F`. São `private` de propósito: publicá-los abriria caminho para
    /// `B8` (modo USB), `BF` (DIP switches), `33` e `91`, que são os quadros desta família que
    /// mexem no caminho de socorro.
    private static let wifiOnlyOpcode: UInt8 = 0xb3
    private static let everythingOpcode: UInt8 = 0xb4

    private static let passwordLengthRejection = ThermalWifiRejection.passwordLength(
        min: passwordLengthRange.lowerBound,
        max: passwordLengthRange.upperBound
    )

    /// Os bytes, ou `nil` se algum sair do ASCII imprimível.
    ///
    /// Conta em **bytes**, não em caracteres: `LL` e `KK` da Rongta são `strlen`, e `String.count`
    /// mente para qualquer coisa fora do ASCII. Validar byte a byte antes de contar é o que faz as
    /// duas coisas concordarem.
    private static func asciiBytes(_ value: String) -> [UInt8]? {
        let bytes = Array(value.utf8)
        guard bytes.allSatisfy({ (printableASCIIMin...printableASCIIMax).contains($0) }) else { return nil }
        return bytes
    }

    private static func ssidLengthRejection(_ bytes: [UInt8]) -> ThermalWifiRejection? {
        if bytes.count < ssidLengthRange.lowerBound { return .ssidEmpty }
        // Nome invisível é a vizinhança imediata da string vazia, e o preço de gravar o SSID errado
        // é a unidade sair da rede — na Rongta, medido em 21/08. Espaço no meio ou nas pontas de um
        // nome real continua legítimo; só o todo-espaço cai aqui.
        if bytes.allSatisfy({ $0 == 0x20 }) { return .ssidEmpty }
        if bytes.count > ssidLengthRange.upperBound {
            return .ssidTooLong(max: ssidLengthRange.upperBound)
        }
        return nil
    }

    private static func isAddress(_ octets: [Int]) -> Bool {
        octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
    }
}
