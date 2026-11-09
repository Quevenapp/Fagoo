import Foundation

/**
 Um único lugar decide se um dialeto pode usar o caminho ESC/POS.

 **Por que isto existe, medido em 23/08/2026 numa Diebold IM453H.** O kit mandou a ela o comprovante
 de teste ESC/POS de sempre. Saíram códigos no papel — o esperado, já que a firmware dela é ESC/P da
 Diebold Procomp e não tem **nenhum** comando `GS`. O que não era esperado é o resto: a impressora
 **travou**. A tecla física de avanço de papel parou de responder, e `ESC r` — que o manual dela
 descreve como "tratado na recepção", isto é, obedecido fora da fila — **não recuperou**. Só
 desligar e ligar recuperou.

 É essa a diferença que este arquivo guarda. Mandar o dialeto errado não custa bobina: custa a
 impressora parada até alguém ir fisicamente até ela. Num balcão, isso é o atendimento parado.

 **O formato é proposital.** Todo `switch` daqui é exaustivo sobre ``EscPosDialect``, **sem
 `default`**. Um dialeto novo não compila até que alguém responda aqui se ele pode ou não emitir
 ESC/POS. A resposta padrão não existe — e não pode existir, porque o padrão silencioso seria
 "emite", que é exatamente o defeito que travou a IM453H.

 Espelha `android/src/main/java/br/com/thermalprinterkit/EscPosDialectGate.kt`, e as duas perguntas
 que descrevem chamador estão reescritas para o que **este** kit tem — ver
 ``usesEscPosStatusQueries(_:)``, que nasce sem nenhum.
 */
public enum EscPosDialectGate {
    /**
     Se o kit sabe **compor um cupom inteiro** neste dialeto: texto, raster e corte.

     É esta a pergunta que os caminhos de escrita fazem antes de abrir a porta. Um dialeto sem
     composição não pode chegar ao fio de jeito nenhum — não porque o cupom sairia feio, mas porque
     foi assim que a IM453H travou em 23/08/2026, com a tecla de avanço morta e recuperação só no
     desligar e ligar.

     Os dois valores respondem `true` hoje. O `switch` continua exaustivo e sem `default` pela mesma
     razão de sempre: **o próximo dialeto não compila até alguém responder aqui**, e o padrão
     silencioso seria "pode", que é o defeito.
     */
    public static func composesReceipt(_ dialect: EscPosDialect) -> Bool {
        switch dialect {
        case .epsonCompatible:
            return true
        // Desde 30/08/2026 no lado Swift: `ProcompEscP` (texto e atributos),
        // `ProcompRasterEmitter` (`ESC n`) e o `ReceiptLayout` compondo pelo dialeto do perfil.
        case .procompEscP:
            return true
        }
    }

    /**
     Verdadeiro somente para dialetos cujo aparelho entende o ESC/POS que o kit emite — o corpo do
     recibo **e** o prólogo do transporte (`DLE EOT` de status e `ESC @` de init).

     **Não** é o mesmo que ``composesReceipt(_:)``. Esta pergunta decide o **formato dos bytes**;
     aquela decide se há cupom para compor. Confundir as duas foi o que este arquivo passou a
     distinguir quando o dialeto Procomp ganhou emissor: "não falamos ESC/POS com ela" deixou de
     significar "não imprimimos nela".

     **Nenhum caminho de produção pergunta isto, e é preciso dizer por quê.** No Kotlin ela era o
     portão da homologação — "esta impressora fala ESC/POS?" antes de mandar uma sonda. Com duas
     séries de sondas essa passou a ser a pergunta errada: quem decide é o dialeto **dos bytes**
     contra o do alvo, em ``PrinterHomologationSession``. As perguntas concretas que sobraram têm
     cada uma o seu portão — ``usesEscPosStatusQueries(_:)`` para o `DLE EOT` e
     ``usesEscPosIdentityQuery(_:)`` para o `GS I`.

     A propriedade continua verdadeira e continua fixada por teste. **Não a use como trava nova sem
     antes escrever qual comando ela está protegendo**: foi genérica demais uma vez, e o preço foi
     uma impressora que só podia ser adotada sem medição.
     */
    public static func emitsEscPos(_ dialect: EscPosDialect) -> Bool {
        switch dialect {
        case .epsonCompatible:
            return true
        // Este `false` não quer dizer "não sabemos imprimir": quer dizer "**não** emitimos ESC/POS
        // para ela". O kit tem o dialeto inteiro — `ProcompEscP` para texto e atributos,
        // `ProcompRasterEmitter` para `ESC n`, e o `ReceiptLayout` compondo pelo dialeto do perfil.
        // O que este portão continua garantindo é que **nenhum byte ESC/POS** alcance uma firmware
        // que trava com eles.
        case .procompEscP:
            return false
        }
    }

    /**
     Os bytes que abrem todo trabalho, **por dialeto**.

     Antes isto era fixo: ``EscPos/initialize()``, isto é `ESC @`, antes de qualquer corpo. Medido em
     23/08/2026 na IM453H — `ESC @` não é comando dela, e o `40h` foi parar no papel como um `@` na
     frente de **todas** as tiras do dia. O prólogo era nosso, não dela.

     No lugar dele, o dialeto Procomp abre desligando cada atributo com o comando que desliga aquele
     atributo, todos vistos agindo em papel — em vez de confiar num reset único que só o manual
     promete. Ver ``ProcompEscP/reset()``.
     */
    public static func prologue(for dialect: EscPosDialect) -> Data {
        switch dialect {
        case .epsonCompatible: return EscPos.initialize()
        case .procompEscP: return ProcompEscP.reset()
        }
    }

    /**
     Se vale perguntar status pelo `DLE EOT` do ESC/POS antes de imprimir.

     A pergunta são seis bytes (`10 04 02` e `10 04 04`). Numa firmware que não os conhece eles são
     bytes soltos no meio de um fluxo — e nesta impressora byte solto no lugar errado não erra
     caractere, trava o aparelho. Eles **não** deixaram glifo na bancada, mas "não imprimiu" não é
     "não teve efeito", e não há por que continuar perguntando a quem não fala essa língua.

     **Esta pergunta nasce sem chamador nenhum neste kit, e a ausência é medição, não esquecimento.**
     Do lado Kotlin quem a faz é o prólogo de `LocalWifiThermalPrinter`; aqui `grep 0x10` em
     `Sources/ThermalPrinterKit` não devolve nada — **o kit Swift nunca mandou `DLE EOT`**, nem no
     Wi-Fi nem no Bluetooth. Ela existe para o dia em que alguém escrever esse prólogo: nesse dia a
     resposta já está aqui, medida, em vez de ser inventada junto com o código novo. Copiar o
     comentário do Kotlin descreveria um mecanismo que este kit não tem.

     O recorte é por **dialeto** de propósito, e não pelo `statusProtocol` do perfil. O campo existe
     e seria o lugar conceitualmente certo, mas hoje nenhum transporte o consulta: usá-lo mudaria o
     comportamento de toda impressora com `statusProtocol == .none`, que é praticamente todo perfil
     medido — e essas eu não posso medir agora. Ver `docs/diebold-im453h.md`.
     */
    public static func usesEscPosStatusQueries(_ dialect: EscPosDialect) -> Bool {
        switch dialect {
        case .epsonCompatible: return true
        case .procompEscP: return false
        }
    }

    /**
     Se vale perguntar fabricante, modelo e firmware pelo `GS I` do ESC/POS.

     Pergunta separada da do status porque é **outro comando**, e este arquivo responde uma pergunta
     por vez — juntar as duas faria a resposta de uma decidir a da outra sem que ninguém tivesse
     medido isso.

     `GS I` é comando `GS`, e a IM453H não tem nenhum. **Neste kit ela tem exatamente um chamador**,
     e ele é o furo que este lote fecha: ``PrinterHomologationSession/sendFinalReceipt()`` chama
     `readIdentity` sempre que o remetente diz saber ler, e ``LocalWifiPrinterProbeSender`` diz que
     sabe sem olhar perfil nenhum — o transporte então dispara `1D 49 41`, `1D 49 42` e `1D 49 43`
     por um caminho que não passa por sonda alguma.

     O custo de errar é o de sempre nesta firmware: byte solto no lugar errado não erra caractere,
     trava o aparelho.
     */
    public static func usesEscPosIdentityQuery(_ dialect: EscPosDialect) -> Bool {
        switch dialect {
        case .epsonCompatible: return true
        case .procompEscP: return false
        }
    }
}
