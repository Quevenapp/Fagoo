package br.com.queven.fagoo.core

import br.com.queven.fagoo.core.net.ApiClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.Protocol
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class MobileBoundaryTest {
    @Test fun discoveryOnlyAcceptsHttpsOrigins() {
        assertEquals("https://fagoo.example",SessionStore.normalizeServer("fagoo.example/"))
        listOf("http://fagoo.example", "https://user:pass@fagoo.example", "https://fagoo.example/path", "https://fagoo.example?token=x", "https://fagoo.example/#private").forEach { assertNull(it,SessionStore.normalizeServer(it)) }
    }
    @Test fun authHeaderCannotLeaveTheCommunicationOrigin() {
        var reached=false
        val client=ApiClient("https://api.example",{"private"},{1L},{true}).okHttp.newBuilder().addInterceptor { chain ->
            reached=true
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("ok").body("{}".toResponseBody()).build()
        }.build()
        for(url in listOf("https://other.example/v1/communication/units/a/media/b/content", "https://api.example/api/v1/me", "http://api.example/v1/communication/units/a/team")) {
            try { client.newCall(Request.Builder().url(url).build()).execute(); fail(url) } catch(_:IOException) {}
        }
        assertFalse(reached)
    }
    @Test fun changedModeDiscardsInflightResponseAndMobileHeaderOnlyRestricts() {
        var generation=1L
        val client=ApiClient("https://api.example",{"private"},{generation},{true}).okHttp.newBuilder().addInterceptor { chain ->
            assertEquals("mobile",chain.request().header("X-Fagoo-Client"))
            assertEquals("Bearer private",chain.request().header("Authorization"))
            generation++
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("ok").body("private".toResponseBody()).build()
        }.build()
        try { client.newCall(Request.Builder().url("https://api.example/v1/communication/units/a/team").build()).execute(); fail("Stale response returned") } catch(_:IOException) {}
        assertFalse(client.followRedirects)
    }
}
