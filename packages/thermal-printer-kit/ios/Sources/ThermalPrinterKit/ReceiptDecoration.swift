import Foundation

/**
 Cabeçalho e rodapé que o app hospedeiro acrescenta a todo cupom, sem que o kit saiba o que eles
 são.

 Existe porque um app publicado precisa carimbar o próprio papel e o kit não pode ganhar o
 conceito: QRFesta, Vinki e Printher compilam a mesma superfície, e um rodapé no core sairia na
 ficha de festa de quem nunca pediu. Quem não passa decoração imprime exatamente o que imprimia
 antes — o default é nenhuma, e essa é a garantia de que esta frente não atravessa consumidor.
 Espelha a `ReceiptDecoration` do Android, e pelo mesmo motivo.

 As duas posições não são simétricas, e a diferença é física:

 - `header` é prepended pelo kit antes dos bytes do payload. É a única posição possível: o payload
   monta os próprios bytes e o kit não os interpreta. **Termine o cabeçalho numa quebra de linha.**
   O payload abre com `ESC @`, e `ESC @` descarta o que ainda estiver no buffer sem ter sido
   fechado por `LF` — meia linha de cabeçalho sumiria sem erro nenhum, só no papel.
 - `footer` é emitido dentro de ``ReceiptLayout/finish()``. **Precisa ser ali, não depois.**
   `finish()` é o corte; qualquer coisa concatenada depois dele sairia no cupom seguinte, já do
   outro lado da guilhotina.

 Ambos recebem o ``ReceiptLayout`` do perfil ativo e devem montar por ele — `layout.text` para o
 rodapé, `layout.imageRaster` para o cabeçalho. Isso não é estilo: `layout.text` é o que respeita a
 página de código medida, e um rodapé montado por fora sai com byte alto numa firmware que a
 ignora. Não existe caractere seguro fora do ASCII: em CP850 e CP860 o ponto médio não tem
 endereço, e escrevê-lo à mão vira lixo ou `?` no papel. Nada aqui presume 58mm ou 80mm.

 O cabeçalho de imagem entra pelo raster que o kit já tem — `layout.imageRaster(image:)`, faixas
 `GS v 0` na largura medida. Nenhum dialeto ESC/POS novo nasce daqui.

 ```swift
 final class RodapeDoApp: ReceiptDecoration {
     func footer(layout: ReceiptLayout) -> Data? {
         layout.text(layout.wrap("Impresso com o aplicativo") + "\n", alignment: 1)
     }
 }
 ```
 */
public protocol ReceiptDecoration: AnyObject {
    /// Bytes abertos do cupom, ou `nil` para não acrescentar nada.
    func header(layout: ReceiptLayout) -> Data?

    /// Bytes emitidos imediatamente antes do avanço e do corte, ou `nil`.
    func footer(layout: ReceiptLayout) -> Data?
}

public extension ReceiptDecoration {
    func header(layout: ReceiptLayout) -> Data? { nil }
    func footer(layout: ReceiptLayout) -> Data? { nil }
}

/**
 Bytes do cupom do hospedeiro, com o cabeçalho da decoração à frente.

 É o **único** ponto do kit que chama ``ThermalReceiptPayload/receiptBytes(layout:)``: os dois
 controladores passam por aqui, e é isso que impede um ponto de entrada de escapar da decoração.

 O cabeçalho é prepended porque o payload é opaco daqui — o rodapé, esse, entra dentro de
 `finish()`, antes do corte, e por isso não aparece nesta função.
 */
func decoratedReceiptBytes(
    of payload: any ThermalReceiptPayload,
    layout: ReceiptLayout
) -> Data? {
    guard let corpo = payload.receiptBytes(layout: layout) else { return nil }
    guard var cabecalho = layout.decoration?.header(layout: layout) else { return corpo }
    cabecalho.append(corpo)
    return cabecalho
}
