package br.com.thermalprinterkit

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/*
 Um leitor de JSON do tamanho exato do problema (lote C28).

 **Por que não uma biblioteca.** O `:core-jvm` depende de `kotlinx-coroutines` e do `core` do ZXing,
 e mais nada — e essa magreza é contrato: `jvm/settings.gradle.kts` existe justamente para o
 desktop não arrastar o mundo Android, e `jvm/app/build.gradle.kts` lembra que a distribuição é MSIX
 com runtime podado por `jlink`. Acrescentar um analisador de JSON ao NÚCLEO para ler um documento
 de menos de 1 KB, de formato que nós mesmos escrevemos no arquivo ao lado, seria pagar dependência
 permanente por conveniência de um arquivo.

 **E por que estrito em vez de tolerante.** O documento não vem da nossa memória: vem de um anexo,
 de um pendrive, da folha de compartilhamento. Um analisador permissivo transforma arquivo
 corrompido em perfil parcial — e perfil parcial é o defeito que sai em papel sem erro nenhum. Aqui,
 o que não for exatamente o que o escritor produz **não é lido**: sem vírgula sobrando, sem
 comentário, sem aspas simples, sem `NaN`, com chave repetida recusada e com lixo depois do fim
 recusado. Recusar é barato; adivinhar não é.

 Nada aqui é público. Se um segundo consumidor aparecer no kit, ele vira decisão — não herança.
 */

/** O documento não é JSON, ou não é o JSON que este leitor aceita. */
internal class JsonMalformed(message: String) : Exception(message)

/** O documento é JSON, e falta uma propriedade — ou ela veio com outro tipo. */
internal class JsonMissing(message: String) : Exception(message)

/**
 * Decodifica UTF-8 **recusando** byte inválido, em vez de trocá-lo por `U+FFFD`.
 *
 * A troca silenciosa é o caminho pelo qual um arquivo truncado no meio de um acento vira um
 * `displayName` com um caractere de substituição — e um nome que a pessoa não escreveu.
 */
internal fun decodeStrictUtf8(bytes: ByteArray): String =
    StandardCharsets.UTF_8
        .newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()

internal sealed class JsonValue {
    internal data class Obj(val fields: Map<String, JsonValue>) : JsonValue()

    internal data class Arr(val items: List<JsonValue>) : JsonValue()

    internal data class Str(val value: String) : JsonValue()

    /** O texto cru do número. Quem lê decide se quer `Int` ou `Long`, e recusa o que não couber. */
    internal data class Num(val literal: String) : JsonValue()

    internal data class Bool(val value: Boolean) : JsonValue()

    internal data object Null : JsonValue()

    internal companion object {
        fun parse(text: String): JsonValue {
            val leitor = JsonScanner(text)
            val valor = leitor.readValue()
            leitor.skipWhitespace()
            if (!leitor.atEnd()) throw JsonMalformed("há conteúdo depois do fim do JSON.")
            return valor
        }
    }
}

// MARK: - Acesso com tipo, e recusa quando o tipo não é o esperado

internal fun JsonValue.Obj.optionalString(name: String): String? = (fields[name] as? JsonValue.Str)?.value

internal fun JsonValue.Obj.optionalObject(name: String): JsonValue.Obj? = fields[name] as? JsonValue.Obj

internal fun JsonValue.Obj.optionalInt(name: String): Int? =
    (fields[name] as? JsonValue.Num)?.literal?.toIntOrNull()

internal fun JsonValue.Obj.requiredString(name: String): String =
    optionalString(name) ?: throw JsonMissing("a propriedade \"$name\" está ausente ou não é texto.")

internal fun JsonValue.Obj.requiredInt(name: String): Int =
    optionalInt(name) ?: throw JsonMissing("a propriedade \"$name\" está ausente ou não é um inteiro.")

internal fun JsonValue.Obj.requiredLong(name: String): Long =
    (fields[name] as? JsonValue.Num)?.literal?.toLongOrNull()
        ?: throw JsonMissing("a propriedade \"$name\" está ausente ou não é um inteiro.")

internal fun JsonValue.Obj.requiredBoolean(name: String): Boolean =
    (fields[name] as? JsonValue.Bool)?.value
        ?: throw JsonMissing("a propriedade \"$name\" está ausente ou não é booleana.")

internal fun JsonValue.Obj.requiredStringArray(name: String): List<String> {
    val arranjo =
        fields[name] as? JsonValue.Arr
            ?: throw JsonMissing("a propriedade \"$name\" está ausente ou não é uma lista.")
    return arranjo.items.map { item ->
        (item as? JsonValue.Str)?.value
            ?: throw JsonMissing("a lista \"$name\" tem um item que não é texto.")
    }
}

// MARK: - O varredor

private class JsonScanner(private val texto: String) {
    private var posicao = 0

    fun atEnd(): Boolean = posicao >= texto.length

    fun skipWhitespace() {
        while (posicao < texto.length && texto[posicao].ehEspacoJson()) posicao++
    }

    fun readValue(): JsonValue {
        skipWhitespace()
        if (atEnd()) throw JsonMalformed("o JSON terminou antes de um valor.")
        return when (val caractere = texto[posicao]) {
            '{' -> readObject()
            '[' -> readArray()
            '"' -> JsonValue.Str(readString())
            't' -> {
                readLiteral("true")
                JsonValue.Bool(true)
            }
            'f' -> {
                readLiteral("false")
                JsonValue.Bool(false)
            }
            'n' -> {
                readLiteral("null")
                JsonValue.Null
            }
            else ->
                if (caractere == '-' || caractere.isDigit()) {
                    JsonValue.Num(readNumber())
                } else {
                    throw JsonMalformed("caractere inesperado na posição $posicao.")
                }
        }
    }

    private fun readObject(): JsonValue.Obj {
        expect('{')
        val campos = LinkedHashMap<String, JsonValue>()
        skipWhitespace()
        if (peek() == '}') {
            posicao++
            return JsonValue.Obj(campos)
        }
        while (true) {
            skipWhitespace()
            val chave = readString()
            // Chave repetida é recusa, e não "a última vence": num documento que descreve medição,
            // duas respostas para a mesma pergunta significam que ninguém sabe qual foi medida.
            if (campos.containsKey(chave)) throw JsonMalformed("a propriedade \"$chave\" aparece duas vezes.")
            skipWhitespace()
            expect(':')
            campos[chave] = readValue()
            skipWhitespace()
            when (val separador = peekOrThrow()) {
                ',' -> posicao++
                '}' -> {
                    posicao++
                    return JsonValue.Obj(campos)
                }
                else -> throw JsonMalformed("esperava ',' ou '}' e veio '$separador'.")
            }
        }
    }

    private fun readArray(): JsonValue.Arr {
        expect('[')
        val itens = mutableListOf<JsonValue>()
        skipWhitespace()
        if (peek() == ']') {
            posicao++
            return JsonValue.Arr(itens)
        }
        while (true) {
            itens += readValue()
            skipWhitespace()
            when (val separador = peekOrThrow()) {
                ',' -> posicao++
                ']' -> {
                    posicao++
                    return JsonValue.Arr(itens)
                }
                else -> throw JsonMalformed("esperava ',' ou ']' e veio '$separador'.")
            }
        }
    }

    private fun readString(): String {
        expect('"')
        val construtor = StringBuilder()
        while (true) {
            if (atEnd()) throw JsonMalformed("o texto não foi fechado.")
            when (val caractere = texto[posicao++]) {
                '"' -> return construtor.toString()
                '\\' -> construtor.append(readEscape())
                else -> {
                    // Controle cru dentro de texto é inválido em JSON, e recusar importa aqui: é
                    // como um `displayName` ganharia uma quebra de linha que a tela não espera.
                    if (caractere.isISOControl()) {
                        throw JsonMalformed("caractere de controle cru dentro de um texto.")
                    }
                    construtor.append(caractere)
                }
            }
        }
    }

    private fun readEscape(): Char {
        if (atEnd()) throw JsonMalformed("escape incompleto.")
        return when (val marca = texto[posicao++]) {
            '"' -> '"'
            '\\' -> '\\'
            '/' -> '/'
            'b' -> '\b'
            'f' -> FORM_FEED
            'n' -> '\n'
            'r' -> '\r'
            't' -> '\t'
            'u' -> {
                if (posicao + 4 > texto.length) throw JsonMalformed("escape unicode incompleto.")
                val hexadecimal = texto.substring(posicao, posicao + 4)
                posicao += 4
                hexadecimal.toIntOrNull(16)?.toChar() ?: throw JsonMalformed("escape unicode inválido.")
            }
            else -> throw JsonMalformed("escape desconhecido.")
        }
    }

    /**
     * Número no formato do JSON, devolvido como texto.
     *
     * `NaN`, `Infinity` e `+1` não entram por engano: quem varre são o sinal de menos, os dígitos,
     * um ponto e um expoente, nessa ordem, e nada mais.
     */
    private fun readNumber(): String {
        val inicio = posicao
        if (peek() == '-') posicao++
        while (!atEnd() && texto[posicao].isDigit()) posicao++
        if (!atEnd() && texto[posicao] == '.') {
            posicao++
            while (!atEnd() && texto[posicao].isDigit()) posicao++
        }
        if (!atEnd() && (texto[posicao] == 'e' || texto[posicao] == 'E')) {
            posicao++
            if (!atEnd() && (texto[posicao] == '+' || texto[posicao] == '-')) posicao++
            while (!atEnd() && texto[posicao].isDigit()) posicao++
        }
        val literal = texto.substring(inicio, posicao)
        if (literal.isEmpty() || literal == "-") throw JsonMalformed("número malformado na posição $inicio.")
        return literal
    }

    private fun readLiteral(esperado: String) {
        if (!texto.startsWith(esperado, posicao)) throw JsonMalformed("literal inesperado na posição $posicao.")
        posicao += esperado.length
    }

    private fun expect(caractere: Char) {
        if (atEnd() || texto[posicao] != caractere) {
            throw JsonMalformed("esperava um caractere que não veio, na posição $posicao.")
        }
        posicao++
    }

    private fun peek(): Char? = if (atEnd()) null else texto[posicao]

    private fun peekOrThrow(): Char = peek() ?: throw JsonMalformed("o JSON terminou no meio de uma estrutura.")

    private companion object {
        const val FORM_FEED = '\u000C'
    }
}

private fun Char.ehEspacoJson(): Boolean = this == ' ' || this == '\t' || this == '\n' || this == '\r'
