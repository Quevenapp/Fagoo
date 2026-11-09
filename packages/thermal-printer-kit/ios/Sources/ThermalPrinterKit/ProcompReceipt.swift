import Foundation

/**
 Como um raster vira comando — a costura que permite dois dialetos sem duas composições.

 O desenho do símbolo (QR, código de barras, foto) e o **empacotamento em bits** são idênticos nos
 dois dialetos: a IM453H usa MSB primeiro e byte da esquerda para a direita, medido em papel em
 23/08/2026. O que muda é só o envelope — `GS v 0` de um lado, `ESC n` do outro. Injetar o envelope,
 em vez de duplicar a composição, é o que impede os dois caminhos de divergirem justamente no
 bitmap, que é onde ninguém lê o diff.

 **O teto de largura mora aqui dentro, com cada envelope, e não é herdado.** O `GS v 0` leva a
 largura em dois bytes e endereça até 65535 bytes; o `ESC n` leva em um e para em 255. Um teto só,
 escrito onde o dialeto não é conhecido, erraria para um dos dois lados — e erraria calado no lado
 que importa.

 **Divergência de forma com o Kotlin, e ela é de linguagem — duas, na verdade:**

 1. Lá isto é uma `interface` com dois `object`; aqui é um `enum`. Um protocolo Swift cujo método é
    genérico sobre a fonte (`Source: OneBitRasterSource`, passada `inout` porque as fontes deste kit
    são tipos de valor que consomem faixa a faixa) não pode ser usado por existencial: `any
    RasterEmission` não deixa chamar método genérico. O `enum` dá a mesma injeção e mantém a
    propriedade que interessa — o `switch` exaustivo do dialeto **não compila** no dia em que
    entrar um terceiro caso, que é o mesmo que o `when` do Kotlin dá lá.
 2. Lá a interface tem **dois** membros, `emit` e `addressesWidth`, e o segundo existe porque os
    emissores Kotlin cobram o contrato do comando com `require`, isto é, **lançam** — e a assinatura
    acordada de `monochromeRaster` é `ByteArray?`. Perguntar antes é o que traduz "não endereço esta
    largura" em `null` sem engolir com `runCatching` um defeito real do emissor. Aqui os dois
    emissores **recusam por `nil`**, então a pergunta e a resposta são o mesmo ato: um segundo membro
    seria uma segunda escrita da mesma regra, que é exatamente como um dos dois lados envelhece
    sozinho. A regra continua sendo do envelope; ela só não precisa ser perguntada duas vezes.
 */
enum RasterEmission: Equatable {
    /// `GS v 0` em bandas, com `ESC a 1` na frente e devolvido no fim: o caminho homologado do M1.
    case escPos

    /**
     `ESC n` em bandas, centralizado pela margem.

     A área imprimível é capturada no caso porque é ela que a centragem consome: nesta impressora não
     existe `ESC a`, então quem centraliza o gráfico é a margem do próprio comando.
     */
    case procomp(printableDots: Int)

    /**
     - Parameter stripeHeightDots: altura de banda do `GS v 0`. **O envelope `ESC n` a ignora**, e
       isso espelha o Kotlin: a banda Procomp é a de 24 dotlines que a bancada mediu, e o campo do
       layout descreve o outro comando. Ver ``ProcompRasterEmitter/defaultBandDotlines``.
     - Returns: `nil` quando a largura, a margem ou a altura não cabem **neste** envelope.
     */
    func emit<Source: OneBitRasterSource>(
        source: inout Source,
        stripeHeightDots: Int = ReceiptLayout.defaultRasterStripeHeightDots,
        verticalRasterScale: Double? = nil
    ) -> Data? {
        switch self {
        case .escPos:
            return EscPosRasterEmitter.emit(
                source: &source,
                alignment: escPosCenterAlignment,
                stripeHeightDots: stripeHeightDots,
                verticalRasterScale: verticalRasterScale
            )
        case let .procomp(printableDots):
            return ProcompRasterEmitter.emit(
                source: &source,
                leftMarginDots: ProcompRasterEmitter.centeringMarginDots(
                    widthDots: source.widthDots,
                    printableDots: printableDots
                ),
                verticalRasterScale: verticalRasterScale
            )
        }
    }
}

/// `ESC a 1` — a centragem do dialeto que tem comando de alinhamento.
private let escPosCenterAlignment: UInt8 = 1

/**
 Um bloco de texto no dialeto Procomp, com atributos e alinhamento.

 **Alinhamento é preenchimento**, porque não existe `ESC a`. **Tamanho é liga/desliga**, porque a
 firmware oferece expandido e dupla altura, e não multiplicador arbitrário: qualquer multiplicador
 maior que um vira o atributo correspondente, e é a melhor aproximação honesta do ``ThermalTextSize``
 do kit.

 O bloco **fecha o que abriu**. Sai com os atributos desligados um a um, pelos comandos que foram
 vistos desligando cada um — nesta firmware não há `ESC @` para zerar tudo de uma vez, e confiar num
 reset que só o manual promete é o tipo de suposição que já custou caro aqui.

 Espelha `procompText` de `android/src/main/java/br/com/thermalprinterkit/ProcompReceipt.kt`.
 */
func procompText(
    _ value: String,
    alignment: UInt8,
    bold: Bool,
    size: ThermalTextSize,
    columns: Int,
    table: ProcompCodeTable = .abicomp
) -> Data {
    let expandido = size.widthMultiplier > 1
    let duplaAltura = size.heightMultiplier > 1
    // Texto expandido ocupa o dobro por caractere, então o preenchimento conta em colunas do dobro.
    let colunasEfetivas = max(1, columns / (expandido ? 2 : 1))
    var data = Data()

    if bold { data.append(ProcompEscP.emphasisOn()) }
    if expandido { data.append(ProcompEscP.expandedOn()) }
    if duplaAltura { data.append(ProcompEscP.doubleHeight(true)) }

    // Uma linha por vez: o preenchimento alinha **cada** linha, e o alinhamento do bloco inteiro não
    // existe nesta impressora. Quebra de linha preservada como veio.
    //
    // **Linha vazia não recebe preenchimento**, e isso não é economia de bytes. Separar um texto que
    // termina em quebra devolve um segmento vazio no fim, e preencher esse segmento deixava o cursor
    // no meio da linha, **sem LF depois**. Medido em papel na IM453H em 24/08/2026: um bloco
    // centrado de `"\nCupom de exemplo\n"` terminava com 24 espaços soltos, e a linha seguinte — de
    // 35 colunas, que cabem de sobra nas 48 desta impressora — começava na coluna 24, estourava a
    // largura e partia "Item ... Valor" em duas. O defeito parecia largura errada do perfil, e não
    // era: a régua de colunas confirmou 48.
    //
    // No caminho ESC/POS isso nunca apareceu porque lá o alinhamento é `ESC a` e linha vazia é só um
    // LF. O preenchimento é invenção deste dialeto, então a borda também é dele.
    let linhas = value.split(separator: "\n", omittingEmptySubsequences: false)
    for (indice, linha) in linhas.enumerated() {
        if indice > 0 { data.append(ProcompEscP.lineFeed) }
        if linha.isEmpty { continue }
        data.append(
            ProcompEscP.encode(
                ProcompEscP.padded(
                    String(linha),
                    columns: colunasEfetivas,
                    alignment: procompAlignment(alignment)
                ),
                table: table
            )
        )
    }

    if duplaAltura { data.append(ProcompEscP.doubleHeight(false)) }
    if expandido { data.append(ProcompEscP.expandedOff()) }
    if bold { data.append(ProcompEscP.emphasisOff()) }
    return data
}

/**
 O que fecha um cupom nesta impressora: avanço e a guilhotina, ou só avanço para destacar.

 `ESC w` e `ESC US` cortaram os dois, e os dois cortaram **parcial** — a guilhotina desta unidade está
 configurada "Somente Parcial". O `ESC w` é o escolhido por ser o corte simples; o `ESC US` embute
 avanço próprio, que brigaria com o avanço do perfil.

 **O `ESC w` também alimenta sozinho, medido em 26/08/2026.** A régua de avanço da homologação saiu
 inteira nesta impressora e a tira de **avanço 0 não comeu texto**: quem cobre a distância entre a
 cabeça e a lâmina é a própria firmware.

 Avanço fora da faixa medida do `LF` não vira tira inventada: sai sem avanço, e o corte continua
 saindo. É o mesmo "quem passa número à mão ouve não" dos emissores, dobrado ao fato de que
 ``ReceiptLayout/finish()`` não pode devolver `nil`.
 */
func procompFinish(hasCutter: Bool, cutFeedLines: Int, tearFeedLines: Int) -> Data {
    if hasCutter {
        var data = ProcompEscP.feed(lines: cutFeedLines) ?? Data()
        data.append(ProcompEscP.cut(.escW))
        return data
    }
    return ProcompEscP.feed(lines: tearFeedLines) ?? Data()
}

/// `ESC a n` do ESC/POS é o vocabulário do kit; aqui ele só escolhe de que lado sobra o espaço.
private func procompAlignment(_ alignment: UInt8) -> ProcompAlignment {
    switch alignment {
    case 1: return .center
    case 2: return .right
    default: return .left
    }
}
