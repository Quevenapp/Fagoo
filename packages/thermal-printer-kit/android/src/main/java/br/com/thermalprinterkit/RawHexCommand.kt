package br.com.thermalprinterkit

/**
 * Envio de comando ESC/POS cru.
 *
 * Mora no core, e não no app de bancada, porque tem dois públicos com o mesmo direito a ele: nós,
 * medindo hardware que compramos, e o usuário travado com um modelo que nunca teremos. É dele que
 * sai diagnóstico aproveitável — "mandei `1d5600` e não cortou" diz o que "não imprime" não diz.
 *
 * Explicação obrigatória antes de qualquer envio. Ela fica em produção e em teste para que uma
 * simplificação visual não transforme uma ferramenta de diagnóstico em um botão destrutivo
 * silencioso.
 */
const val RAW_COMMAND_RISK_WARNING =
    "Comandos ESC/POS podem gravar configuração não volátil — emulação, velocidade serial ou " +
        "densidade — e deixar a impressora alterada mesmo após desligar; a pessoa deve conhecer " +
        "o efeito e o comando de reversão."

fun interface RawCommandSender {
    /** Só retorna depois que o transporte concluiu ou recusou o envio. */
    suspend fun send(bytes: ByteArray)
}

/** Buffer efêmero: não implementa serialização e nunca revela o conteúdo em descrição ou erro. */
class RawHexCommand private constructor(
    private val bytes: ByteArray,
) {
    private var consumed = false

    val size: Int
        get() = bytes.size

    suspend fun sendWith(sender: RawCommandSender) {
        check(!consumed) { "O comando cru já foi consumido." }
        consumed = true
        try {
            sender.send(bytes)
        } finally {
            bytes.fill(0)
        }
    }

    fun clear() {
        if (!consumed) {
            consumed = true
            bytes.fill(0)
        }
    }

    override fun toString(): String = "RawHexCommand(size=$size, conteúdo=[REDACTED])"

    companion object {
        const val MAX_BYTES = 256

        fun parse(text: CharSequence): RawHexCommand {
            val compact = buildString(text.length) {
                text.forEach { character ->
                    when {
                        character.isWhitespace() -> Unit
                        character.isDigit() || character.lowercaseChar() in 'a'..'f' -> append(character)
                        else -> throw IllegalArgumentException("O comando deve conter apenas bytes hexadecimais.")
                    }
                }
            }
            require(compact.isNotEmpty()) { "Informe ao menos um byte hexadecimal." }
            require(compact.length % 2 == 0) { "Cada byte hexadecimal precisa de dois dígitos." }
            require(compact.length / 2 <= MAX_BYTES) { "O comando cru pode ter no máximo 256 bytes." }

            val parsed = ByteArray(compact.length / 2)
            compact.chunked(2).forEachIndexed { index, pair ->
                parsed[index] = pair.toInt(radix = 16).toByte()
            }
            return RawHexCommand(parsed)
        }
    }
}

data class RawCommandConfirmation(
    val byteCount: Int,
    val warning: String = RAW_COMMAND_RISK_WARNING,
)

/** Exige um preparo explícito e uma segunda ação consciente antes de tocar no transporte. */
class RawCommandController(
    private val sender: RawCommandSender,
) {
    private var pending: RawHexCommand? = null

    fun prepare(text: CharSequence): RawCommandConfirmation {
        pending?.clear()
        val command = RawHexCommand.parse(text)
        pending = command
        return RawCommandConfirmation(command.size)
    }

    suspend fun confirmAndSend() {
        val command = checkNotNull(pending) { "Nenhum comando cru aguarda confirmação." }
        pending = null
        command.sendWith(sender)
    }

    fun cancel() {
        pending?.clear()
        pending = null
    }
}
