package br.com.queven.fagoo.core

import br.com.queven.fagoo.core.model.DeviceRegistration
import br.com.queven.fagoo.core.model.FagooJson
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

class DeviceRegistrationContractTest {
    @Test fun androidRegistrationHttpBodyIncludesRequiredPlatform() {
        val registration = DeviceRegistration(
            platform = "android",
            provider = "fcm",
            token = "synthetic-fcm-token",
            name = "QA Android",
            app_version = "1.0.0-debug",
            profiles = listOf("00000000-0000-4000-8000-000000000001"),
            enabled = true,
        )
        // Exercise the same Retrofit converter and Json instance as ApiClient.
        val retrofit = Retrofit.Builder().baseUrl("https://api.example/")
            .addConverterFactory(FagooJson.asConverterFactory("application/json".toMediaType()))
            .build()
        val converter = retrofit.requestBodyConverter<DeviceRegistration>(
            DeviceRegistration::class.java, emptyArray(), emptyArray(),
        )
        val buffer = Buffer()
        requireNotNull(converter.convert(registration)).writeTo(buffer)
        val body = FagooJson.parseToJsonElement(buffer.readUtf8()).jsonObject

        assertEquals("android", body["platform"]?.jsonPrimitive?.content)
        assertEquals("synthetic-fcm-token", body["token"]?.jsonPrimitive?.content)
        assertEquals("QA Android", body["name"]?.jsonPrimitive?.content)
        assertEquals("1.0.0-debug", body["app_version"]?.jsonPrimitive?.content)
        assertEquals(listOf("00000000-0000-4000-8000-000000000001"),
            body["profiles"]?.jsonArray?.map { it.jsonPrimitive.content })
        assertFalse(FagooJson.configuration.encodeDefaults)
    }
}
