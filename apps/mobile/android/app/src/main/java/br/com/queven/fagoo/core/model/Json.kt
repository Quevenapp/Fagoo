package br.com.queven.fagoo.core.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Configuração única de JSON: tolera campos desconhecidos e valores ausentes (o backend evolui). */
val FagooJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

/** Vários campos do banco chegam como JSON serializado em string (attachments, content, tags). */
fun String?.parseJsonObject(): JsonObject {
    if (this.isNullOrBlank()) return JsonObject(emptyMap())
    return runCatching { FagooJson.parseToJsonElement(this) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
}

fun String?.parseJsonStringList(): List<String> {
    if (this.isNullOrBlank()) return emptyList()
    val element = runCatching { FagooJson.parseToJsonElement(this) }.getOrNull() as? JsonArray ?: return emptyList()
    return element.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
}

fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
fun JsonObject.double(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull
fun JsonObject.bool(key: String): Boolean? {
    val p = this[key] as? JsonPrimitive ?: return null
    return p.booleanOrNull ?: p.longOrNull?.let { it != 0L }
}
fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
fun JsonObject.array(key: String): JsonArray? = this[key] as? JsonArray
fun JsonElement.asStringOrNull(): String? = runCatching { jsonPrimitive.contentOrNull }.getOrNull()
