package br.com.thermalprinterkit

import java.io.ByteArrayOutputStream

/**
 * Um cupom pronto para virar bytes ESC/POS.
 *
 * Existe para manter o pacote de impressão sem domínio: produto, venda e relatório pertencem à
 * camada de cima. Aqui só se sabe montar bytes e mandar para a impressora.
 */
interface ThermalReceiptPayload {
    fun receiptBytes(layout: ReceiptLayout): ByteArray

    /**
     * Zera o material sensível depois da impressão.
     *
     * Uma assinatura de cupom pode ser token de capacidade: se sobrar na memória, sobra num heap
     * dump. [ThermalPrinter.print] chama isto mesmo quando a impressão falha no meio.
     */
    fun clear()
}

/**
 * Concatena os comandos e zera cada um em seguida.
 *
 * O `finally` não é zelo excessivo: os arrays intermediários carregam o payload do QR, e uma
 * exceção no meio da montagem deixaria a assinatura viva na memória.
 */
fun receiptBytes(commands: List<ByteArray>): ByteArray =
    try {
        ByteArrayOutputStream().use { stream ->
            commands.forEach(stream::write)
            stream.toByteArray()
        }
    } finally {
        commands.forEach { command -> command.fill(0) }
    }
