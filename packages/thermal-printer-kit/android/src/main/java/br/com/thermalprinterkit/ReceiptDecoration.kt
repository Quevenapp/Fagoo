package br.com.thermalprinterkit

/**
 * Cabeçalho e rodapé que o app hospedeiro acrescenta a todo cupom, sem que o kit saiba o que eles
 * são.
 *
 * Existe porque um app publicado precisa carimbar o próprio papel e o kit não pode ganhar o
 * conceito: QRFesta, Vinki e Printher compilam a mesma superfície, e um rodapé no core sairia na
 * ficha de festa de quem nunca pediu. Quem não passa decoração imprime exatamente o que imprimia
 * antes — o default é nenhuma, e essa é a garantia de que esta frente não atravessa consumidor.
 *
 * As duas posições não são simétricas, e a diferença é física:
 *
 * - [header] é prepended pelo kit logo depois de `initialize()`, antes dos bytes do payload. É a
 *   única posição possível: o payload monta os próprios bytes e o kit não os interpreta.
 *   **Termine o cabeçalho numa quebra de linha.** `ESC @` descarta o que ainda estiver no buffer
 *   sem ter sido fechado por `LF`, e um payload de hospedeiro pode abrir com a própria
 *   inicialização — meia linha de cabeçalho sumiria sem erro nenhum, só no papel.
 * - [footer] é emitido dentro de [ReceiptLayout.finish]. **Precisa ser ali, não depois.**
 *   `finish()` é o corte; qualquer coisa concatenada depois dele sairia no cupom seguinte, já do
 *   outro lado da guilhotina.
 *
 * Ambos recebem o [ReceiptLayout] do perfil ativo para montar com a largura, a página de código e
 * a escala medidas naquela impressora. Nada aqui presume 58mm ou 80mm. O cabeçalho de imagem entra
 * pelo raster que o kit já tem — [ReceiptLayout.imageRaster], faixas `GS v 0` na largura medida —,
 * e o rodapé por [ReceiptLayout.text], que respeita a página de código medida. Nenhum dialeto
 * ESC/POS novo nasce daqui.
 *
 * **Que papel recebe o carimbo:** o cupom comum, o comprovante de teste — inicial e reenviado — e o
 * comprovante final da homologação, que é o recibo da instalação concluída. As tiras de sonda e o
 * comando cru não recebem: as tiras são instrumento de medida, e um raster no meio da régua de
 * geometria desloca justamente o que ela mede. A isenção das tiras é estrutural, não uma
 * condicional — elas saem de [PrinterHomologationProbes] sem layout nenhum e não têm por onde
 * receber o gancho.
 */
interface ReceiptDecoration {
    /** Bytes abertos do cupom, ou `null` para não acrescentar nada. */
    fun header(layout: ReceiptLayout): ByteArray? = null

    /** Bytes emitidos imediatamente antes do avanço e do corte, ou `null`. */
    fun footer(layout: ReceiptLayout): ByteArray? = null
}
