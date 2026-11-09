package br.com.thermalprinterkit

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.lang.reflect.Modifier
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterProfileStoreTest {
    @Test
    fun `o perfil sobrevive ao disco com endereço modo de corte e firmware`() {
        // A sessão só adota se o perfil relido for igual ao salvo. Campo novo fora do formato faz
        // os dois diferirem em silêncio, e foi o que perdeu a homologação da T210 no iOS — aqui o
        // sintoma seria pior: o acento voltaria errado depois de reabrir o app.
        val storage = InMemoryPrinterProfileStorage()
        val medido =
            MeasuredProfile.createLocal(
                id = "00000000-0000-4000-8000-0000000000aa",
                displayName = "T210 de bancada",
                transports = setOf(PrinterTransport.BLUETOOTH),
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                codePage = ThermalCodePage.CP860,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 1,
                codePageSelector = 8,
                cutModeHonored = false,
                firmwareVersion = "SV3.2.2",
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        BinaryPrinterProfileStore(storage).save(medido)

        // Store novo lendo o mesmo disco: é o que acontece ao reabrir o app.
        assertEquals(medido, BinaryPrinterProfileStore(storage).read().single())
    }

    @Test
    fun `novo processo relê as capacidades persistidas`() {
        val storage = InMemoryPrinterProfileStorage()
        BinaryPrinterProfileStore(storage).save(profile(UUID_1, measuredAt = 10))

        val restarted = BinaryPrinterProfileStore(storage).read()

        assertEquals(listOf(UUID_1), restarted.map(MeasuredProfile::id))
        assertEquals(384, restarted.single().printableDots)
    }

    @Test
    fun `UTF-8 atravessa o formato binário v4 sem virar ASCII`() {
        val storage = InMemoryPrinterProfileStorage()
        val utf8 = profile(UUID_1, measuredAt = 10).copy(
            codePage = null,
            codePageSelector = null,
            textEncoding = ThermalTextEncoding.UTF_8,
        )

        BinaryPrinterProfileStore(storage).save(utf8)

        assertEquals(utf8, BinaryPrinterProfileStore(storage).read().single())
        assertEquals(ThermalTextEncoding.UTF_8, BinaryPrinterProfileStore(storage).read().single().textEncoding)
    }

    @Test
    fun `v2 é relido sem firmware e migrado para v9 sem transporte de bancada`() {
        val storage = InMemoryPrinterProfileStorage()
        storage.write(version2Profile())

        val restored = BinaryPrinterProfileStore(storage).read().single()

        assertEquals(null, restored.firmwareVersion)
        assertEquals(ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE, restored.textEncoding)
        val encoded = requireNotNull(storage.read())
        val version = java.io.DataInputStream(encoded.inputStream()).use { input ->
            input.readInt()
            input.readInt()
        }
        assertEquals(10, version)
        // Perfil que nunca foi medido para NV RAM volta conservador: reenviar raster funciona em
        // toda impressora que já imprime imagem, e uma gravação em memória não volátil feita por
        // engano não se desfaz.
        assertEquals(false, restored.supportsNvLogo)
        // Mesma regra para a vazão: aquele aparelho nunca a mediu, e sem teto é como o cupom dele
        // sempre saiu. Inventar um número aqui frearia impressora que nunca precisou de freio.
        assertEquals(null, restored.maxRasterBytesPerSecond)
        // E para a compensação vertical: sem fator, o raster continua saindo como sempre saiu.
        // Presumir um fator esticaria a foto de impressora que nunca encolheu nada.
        assertEquals(null, restored.verticalRasterScale)
        // E para as duas respostas da sonda de código nativo: aquela impressora nunca viu a tira.
        // `null` não é "não" — é "ninguém perguntou" —, e é o que faz Ajustes mandar remedir em vez
        // de afirmar que a firmware não entende o comando.
        assertEquals(null, restored.nativeQrHonored)
        assertEquals(null, restored.nativeBarcodeHonored)
        // E para a família de configuração de rede: aquela impressora nunca respondeu a tira, e
        // "nunca determinado" é a única coisa verdadeira a dizer sobre ela. Presumir uma família
        // mandaria o quadro de uma para uma impressora que pode ser da outra.
        assertEquals(null, restored.wifiConfigurationFamily)
    }

    /**
     * Um blob v8 volta com as duas respostas ausentes e é regravado como v10.
     *
     * É a retrocompatibilidade inteira num teste: perfil medido antes da sonda existir não pode
     * ganhar capacidade que ninguém mediu, e não pode perder nada do que já tinha. `null` nos dois
     * campos é o que faz o cupom daquela impressora continuar saindo exatamente como sai hoje — o
     * padrão é rasterizado, e a trava do layout exige `true`.
     */
    @Test
    fun `um blob v8 volta com as duas respostas ausentes e é regravado como v10`() {
        val storage = InMemoryPrinterProfileStorage()
        storage.write(version8Profile())

        val restored = BinaryPrinterProfileStore(storage).read().single()

        assertEquals(null, restored.nativeQrHonored)
        assertEquals(null, restored.nativeBarcodeHonored)
        // O resto da medição atravessa intacto: migração não é oportunidade de perder campo.
        assertEquals(UUID_1, restored.id)
        assertEquals(384, restored.printableDots)
        assertEquals(ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE, restored.textEncoding)
        assertEquals(0.8, restored.verticalRasterScale!!, 1e-9)

        val rewritten = requireNotNull(storage.read())
        DataInputStream(rewritten.inputStream()).use { input ->
            assertEquals(0x54504b50, input.readInt())
            assertEquals(10, input.readInt())
        }
        // E a releitura do blob já migrado devolve o mesmo perfil, sem segunda migração.
        assertEquals(restored, BinaryPrinterProfileStore(storage).read().single())
    }

    /**
     * As duas respostas sobrevivem ao disco, e sobrevivem **separadas**.
     *
     * `GS ( k` e `GS k` são comandos diferentes, e uma firmware pode honrar um e não o outro: o par
     * `(true, false)` é o caso que um campo só não saberia representar. Foi um round-trip de ponta a
     * ponta que denunciou que o store não gravava nada disso.
     */
    @Test
    fun `as duas respostas da sonda de código nativo sobrevivem ao ciclo de disco`() {
        listOf(
            null to null,
            true to true,
            true to false,
            false to true,
            false to false,
        ).forEach { (qr, barras) ->
            val storage = InMemoryPrinterProfileStorage()
            val medido =
                profile(UUID_1, measuredAt = 7)
                    .copy(nativeQrHonored = qr, nativeBarcodeHonored = barras)

            BinaryPrinterProfileStore(storage).save(medido)
            val relido = BinaryPrinterProfileStore(storage).read().single()

            assertEquals("$qr/$barras", qr, relido.nativeQrHonored)
            assertEquals("$qr/$barras", barras, relido.nativeBarcodeHonored)
            // Igualdade de perfil inteiro: é o que a adoção confere antes de trocar a seleção, e é
            // por onde um campo esquecido no store derruba a homologação depois da bobina gasta.
            assertEquals(medido, relido)
        }
    }

    /**
     * Um envelope da versão anterior — v8, o formato imediatamente antes deste campo — continua
     * carregando, e volta com a pergunta em aberto.
     *
     * **Este é o teste que a regressão exige.** O formato é posicional: um `if (version >= ...)`
     * inserido no meio, ou um `else` que consuma bytes quando não devia, dessincroniza o fluxo
     * deste perfil **e de todos os seguintes** — e o desfecho é o `catch` que limpa o store
     * inteiro, sem log e sem sintoma até alguém perceber que a impressora sumiu. O envelope é
     * montado à mão aqui, e não pelo `encode` atual, justamente para exercitar o formato antigo.
     */
    @Test
    fun `v8 é relido com a pergunta de configuracao de rede em aberto e migrado para v10`() {
        val storage = InMemoryPrinterProfileStorage()
        storage.write(version8Profile())

        val restored = BinaryPrinterProfileStore(storage).read().single()

        assertEquals(null, restored.wifiConfigurationFamily)
        // O resto da medição v8 atravessa intacto: perder um campo vizinho aqui seria a mesma
        // dessincronização, com outro sintoma.
        assertEquals(8, restored.codePageSelector)
        assertEquals(false, restored.cutModeHonored)
        assertEquals("SV3.2.2", restored.firmwareVersion)
        assertEquals(true, restored.supportsNvLogo)
        assertEquals(8_192, restored.maxRasterBytesPerSecond)
        assertEquals(0.8, restored.verticalRasterScale!!, 1e-9)

        val encoded = requireNotNull(storage.read())
        val version =
            java.io.DataInputStream(encoded.inputStream()).use { input ->
                input.readInt()
                input.readInt()
            }
        assertEquals(10, version)
    }

    /**
     * A família de configuração de rede sobrevive ao disco, com a procedência intacta.
     *
     * Se ela se perdesse na volta, a tira de identificação sairia de novo em toda abertura da tela
     * — papel gasto por uma pergunta já respondida. E se voltasse sem a procedência, uma sessão
     * futura leria declaração como medição.
     */
    @Test
    fun `a familia de configuracao de rede sobrevive ao ciclo de disco`() {
        PrinterWifiConfigurationFamily.entries.forEach { familia ->
            val storage = InMemoryPrinterProfileStorage()
            val comFamilia =
                profile(UUID_1, measuredAt = 7).withWifiConfigurationFamily(familia)

            BinaryPrinterProfileStore(storage).save(comFamilia)

            // Store novo lendo o mesmo disco: é o que acontece ao reabrir o app.
            val relido = BinaryPrinterProfileStore(storage).read().single()
            assertEquals("A família gravada não voltou do disco.", familia, relido.wifiConfigurationFamily)
            assertEquals(familia.wasMeasured, relido.wifiConfigurationFamily!!.wasMeasured)
            assertEquals(comFamilia, relido)
        }
    }

    @Test
    fun `perfil sem resposta de configuracao de rede volta nao determinado`() {
        val storage = InMemoryPrinterProfileStorage()
        BinaryPrinterProfileStore(storage).save(profile(UUID_1, measuredAt = 7))
        assertEquals(null, BinaryPrinterProfileStore(storage).read().single().wifiConfigurationFamily)
    }

    /**
     * Duas medições que só diferem na família de configuração continuam sendo a mesma capacidade.
     *
     * Ela não muda um byte de cupom: decide qual quadro a tela de configuração monta, e quadro de
     * configuração não é cupom. Pô-la na chave desassociaria todo perfil já medido e já contribuído
     * para distinguir papéis idênticos — é a mesma régua que mantém `cutModeHonored` fora.
     */
    @Test
    fun `a familia de configuracao de rede fica fora da chave de capacidades`() {
        val semFamilia = profile(UUID_1, measuredAt = 10)

        PrinterWifiConfigurationFamily.entries.forEach { familia ->
            assertEquals(
                "$familia moveu a chave de capacidades",
                semFamilia.capabilityKey,
                semFamilia.withWifiConfigurationFamily(familia).capabilityKey,
            )
        }
    }

    /**
     * Gravar a resposta é read-modify-write, preserva o resto do perfil e confirma pela releitura.
     */
    @Test
    fun `gravar a familia preserva o perfil e confirma pela releitura`() {
        val storage = InMemoryPrinterProfileStorage()
        val store = BinaryPrinterProfileStore(storage)
        val medido =
            profile(UUID_1, measuredAt = 7).copy(
                verticalRasterScale = 0.8,
                firmwareVersion = "SV3.2.2",
            )
        store.save(medido)

        assertTrue(
            store.recordWifiConfigurationFamily(
                PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
                UUID_1,
            ),
        )

        val relido = BinaryPrinterProfileStore(storage).read().single()
        assertEquals(
            PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
            relido.wifiConfigurationFamily,
        )
        assertEquals(0.8, relido.verticalRasterScale!!, 1e-9)
        assertEquals("SV3.2.2", relido.firmwareVersion)
        // A data não anda: nada foi remedido no papel, e mexer nela reordenaria a lista de perfis
        // por causa de uma resposta de tela.
        assertEquals(7L, relido.measuredAtEpochMillis)
    }

    /**
     * Regravar o mesmo perfil, com a mesma data, escreve — e não é engolido em silêncio.
     *
     * **Isto estava quebrado, e só não doía por acidente.** `canonicalize` desempatava com `maxBy`,
     * que devolve o primeiro máximo, e o primeiro é o que já estava no disco: `save` do mesmo ID
     * com a mesma data era um no-op sem erro nenhum. O único caminho de regravação existente — a
     * edição manual — empurra a data de propósito, e o comentário de `nextMeasurementDate` já
     * registrava o sintoma: "empate faz a releitura devolver o registro antigo".
     *
     * A tela de rede grava sem mexer na data, porque nada foi remedido no papel. Sem este
     * comportamento, a resposta da pessoa sumiria entre uma sessão e outra.
     */
    @Test
    fun `regravar o mesmo perfil com a mesma data nao e engolido`() {
        val storage = InMemoryPrinterProfileStorage()
        val store = BinaryPrinterProfileStore(storage)
        store.save(profile(UUID_1, measuredAt = 7, columns = 32))

        store.save(profile(UUID_1, measuredAt = 7, columns = 30))

        val relido = BinaryPrinterProfileStore(storage).read().single()
        assertEquals(30, relido.printableColumns)
        assertEquals(7L, relido.measuredAtEpochMillis)

        // E a regra vizinha continua de pé: medição **mais antiga** não sobrescreve a mais nova.
        // Empate é escrita; retroceder no tempo, não.
        store.save(profile(UUID_1, measuredAt = 3, columns = 48))
        assertEquals(30, BinaryPrinterProfileStore(storage).read().single().printableColumns)
    }

    /**
     * Sem perfil para escrever, nada é gravado e nenhum registro é inventado.
     *
     * A candidata retida em memória não tem perfil persistido, e a instalada pode nem ter sido
     * resolvida para um. Criar o registro ali seria gravar uma impressora que ninguém homologou.
     */
    @Test
    fun `gravar a familia sem perfil nao inventa registro`() {
        val store = BinaryPrinterProfileStore(InMemoryPrinterProfileStorage())

        assertFalse(
            store.recordWifiConfigurationFamily(
                PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED,
                UUID_1,
            ),
        )
        assertTrue(store.read().isEmpty())
    }

    @Test
    fun `v4 descarta perfil publicado sem perder medição local do mesmo blob`() {
        // O v4 não codificava a origem. O slug publicado é a evidência que restou do antigo perfil
        // de origem CATALOG; a migração precisa consumir apenas esse registro e preservar o UUID.
        val storage = InMemoryPrinterProfileStorage()
        storage.write(version4WithPublishedAndMeasuredProfiles())

        val restored = BinaryPrinterProfileStore(storage).read()

        assertEquals(listOf(UUID_1), restored.map(MeasuredProfile::id))
        assertEquals(PrinterProfileSource.MEASURED, restored.single().source)
        val rewritten = requireNotNull(storage.read())
        java.io.DataInputStream(rewritten.inputStream()).use { input ->
            assertEquals(0x54504b50, input.readInt())
            // A limpeza regrava o schema corrente com apenas a medição e sem transporte de bancada.
            assertEquals(10, input.readInt())
            assertEquals(1, input.readInt())
            assertEquals(UUID_1, input.readUTF())
        }
    }

    /**
     * A capacidade de NV RAM sobrevive ao disco, e só quando foi medida.
     *
     * Perfil medido pelo usuário nunca é sobrescrito por atualização; se o `supportsNvLogo` se
     * perdesse na volta, o app cairia em reenviar raster — que funciona — mas a medição da bancada
     * teria sido jogada fora em silêncio, que é a categoria de defeito que este store existe para
     * impedir.
     */
    @Test
    fun `a capacidade de NV RAM sobrevive ao ciclo de disco`() {
        val storage = InMemoryPrinterProfileStorage()
        val comNvRam = profile(UUID_1, measuredAt = 7).copy(supportsNvLogo = true)

        BinaryPrinterProfileStore(storage).save(comNvRam)

        val relido = BinaryPrinterProfileStore(storage).read().single()
        assertTrue("A capacidade medida não voltou do disco.", relido.supportsNvLogo)
        assertEquals(comNvRam, relido)
    }

    @Test
    fun `perfil sem medicao de NV RAM volta como false`() {
        val storage = InMemoryPrinterProfileStorage()
        BinaryPrinterProfileStore(storage).save(profile(UUID_1, measuredAt = 7))
        assertEquals(false, BinaryPrinterProfileStore(storage).read().single().supportsNvLogo)
    }

    /**
     * O teto de vazão sobrevive ao disco, e só quando foi medido.
     *
     * Se ele se perdesse na volta, o transporte voltaria a soltar o raster byte a byte e a foto
     * voltaria a encolher na T210 — sem erro em lugar nenhum, só no papel, que é a categoria de
     * defeito que este store existe para impedir.
     */
    @Test
    fun `o teto de vazao sobrevive ao ciclo de disco`() {
        val storage = InMemoryPrinterProfileStorage()
        val comTeto = profile(UUID_1, measuredAt = 7).copy(maxRasterBytesPerSecond = 8_192)

        BinaryPrinterProfileStore(storage).save(comTeto)

        val relido = BinaryPrinterProfileStore(storage).read().single()
        assertEquals("O teto medido não voltou do disco.", 8_192, relido.maxRasterBytesPerSecond)
        assertEquals(comTeto, relido)
    }

    @Test
    fun `perfil sem medicao de vazao volta sem teto`() {
        val storage = InMemoryPrinterProfileStorage()
        BinaryPrinterProfileStore(storage).save(profile(UUID_1, measuredAt = 7))
        assertEquals(null, BinaryPrinterProfileStore(storage).read().single().maxRasterBytesPerSecond)
    }

    /**
     * Duas medições que só diferem no teto continuam sendo a mesma capacidade.
     *
     * O teto não muda um byte do cupom — muda o ritmo com que os bytes saem do rádio. Pô-lo na
     * chave mudaria a chave de todo perfil já medido para distinguir papéis idênticos.
     */
    @Test
    fun `o teto de vazao fica fora da chave de capacidades`() {
        val semTeto = profile(UUID_1, measuredAt = 10)

        assertEquals(
            semTeto.capabilityKey,
            semTeto.copy(maxRasterBytesPerSecond = 8_192).capabilityKey,
        )
    }

    /**
     * O fator de compensação sobrevive ao disco, e só quando foi medido.
     *
     * Se ele se perdesse na volta, a foto voltaria a sair 20% mais baixa na T210 — sem erro em
     * lugar nenhum, só no papel, que é a categoria de defeito que este store existe para impedir.
     */
    @Test
    fun `o fator de compensacao sobrevive ao ciclo de disco`() {
        val storage = InMemoryPrinterProfileStorage()
        val comFator = profile(UUID_1, measuredAt = 7).copy(verticalRasterScale = 0.8)

        BinaryPrinterProfileStore(storage).save(comFator)

        val relido = BinaryPrinterProfileStore(storage).read().single()
        assertEquals("O fator medido não voltou do disco.", 0.8, relido.verticalRasterScale!!, 1e-9)
        assertEquals(comFator, relido)
    }

    @Test
    fun `perfil sem medicao de altura volta sem fator`() {
        val storage = InMemoryPrinterProfileStorage()
        BinaryPrinterProfileStore(storage).save(profile(UUID_1, measuredAt = 7))
        assertEquals(null, BinaryPrinterProfileStore(storage).read().single().verticalRasterScale)
    }

    /**
     * Duas medições que só diferem no fator **não** são a mesma capacidade.
     *
     * Este é o oposto do teto de vazão, e de propósito: o fator muda os bytes emitidos — a mesma
     * foto vira 1,25x mais linhas com 0,80 —, então dois perfis que diferem nele produzem cupons
     * diferentes. Casá-los pelo catálogo devolveria a foto encolhida por outro caminho.
     *
     * E a chave de quem **não** tem fator não se move: o campo só entra na string canônica quando
     * existe, para nenhuma medição já feita mudar de identidade por causa deste commit.
     */
    @Test
    fun `o fator de compensacao entra na chave de capacidades`() {
        val semFator = profile(UUID_1, measuredAt = 10)
        val comFator = semFator.copy(verticalRasterScale = 0.8)

        assertNotEquals(semFator.capabilityKey, comFator.capabilityKey)
        assertNotEquals(
            comFator.capabilityKey,
            semFator.copy(verticalRasterScale = 0.75).capabilityKey,
        )
        assertEquals(
            comFator.capabilityKey,
            semFator.copy(verticalRasterScale = 0.8).capabilityKey,
        )
    }

    @Test
    fun `corrupção descarta medição em vez de inventar capacidade`() {
        val storage = InMemoryPrinterProfileStorage()
        storage.write(byteArrayOf(0x01, 0x02, 0x03))
        val store = BinaryPrinterProfileStore(storage)

        assertTrue(store.read().isEmpty())
        assertEquals(null, storage.read())
    }

    @Test
    fun `ID duplicado preserva somente a medição mais recente`() {
        val store = BinaryPrinterProfileStore(InMemoryPrinterProfileStorage())
        store.save(profile(UUID_1, measuredAt = 20, columns = 32))
        store.save(profile(UUID_1, measuredAt = 10, columns = 30))

        val stored = store.read()

        assertEquals(1, stored.size)
        assertEquals(20L, stored.single().measuredAtEpochMillis)
        assertEquals(32, stored.single().printableColumns)
    }

    @Test
    fun `IDs distintos com mesma capability continuam disponíveis ao resolvedor`() {
        val store = BinaryPrinterProfileStore(InMemoryPrinterProfileStorage())
        store.save(profile(UUID_1, measuredAt = 10))
        store.save(profile(UUID_2, measuredAt = 20))

        assertEquals(listOf(UUID_2, UUID_1), store.read().map(MeasuredProfile::id))
        assertEquals(1, store.read().map(MeasuredProfile::capabilityKey).distinct().size)
        assertEquals(
            profile(UUID_1, measuredAt = 10).capabilityKey,
            profile(UUID_1, measuredAt = 10).copy(firmwareVersion = "SV3.2.2").capabilityKey,
        )
    }

    @Test
    fun `store rejeita toda fonte que não seja medição local`() {
        val store = BinaryPrinterProfileStore(InMemoryPrinterProfileStorage())

        assertThrows(IllegalArgumentException::class.java) {
            store.save(MeasuredProfile.bundled(BundledPrinterDrivers.elginI9Full2))
        }
        assertThrows(IllegalArgumentException::class.java) {
            store.save(MeasuredProfile.temporary(PrinterTransport.USB, 80, dialect = EscPosDialect.EPSON_COMPATIBLE))
        }
    }

    @Test
    fun `serialização allowlist não tem campo para endpoint ou identificador de peripheral`() {
        val storage = InMemoryPrinterProfileStorage()
        BinaryPrinterProfileStore(storage).save(profile(UUID_1, measuredAt = 10))
        val encoded = requireNotNull(storage.read())
        val text = String(encoded, StandardCharsets.ISO_8859_1)
        val persistedFields =
            MeasuredProfile::class.java.declaredFields
                .filterNot { Modifier.isStatic(it.modifiers) || it.isSynthetic }
                .map { it.name.lowercase() }

        listOf("ip", "address", "mac", "vid", "pid", "peripheral", "endpoint", "serial").forEach { forbidden ->
            assertFalse("campo técnico encontrado: $forbidden", persistedFields.any { it.contains(forbidden) })
        }
        assertFalse(text.contains("192.168."))
        assertFalse(text.contains("AA:BB:CC"))
    }

    @Test
    fun `resolvedor respeita ID medido antes de capability equivalente`() {
        val store = InMemoryPrinterProfileStore()
        val exact = profile(UUID_1, measuredAt = 10, columns = 30)
        val equivalentButNewer = profile(UUID_2, measuredAt = 20, columns = 32)
        store.save(exact)
        store.save(equivalentButNewer)
        val resolver = PrinterProfileCatalog(store)

        val resolved =
            resolver.resolve(
                PrinterProfileLookup(
                    profileId = UUID_1,
                    capabilityKey = equivalentButNewer.capabilityKey,
                    transport = PrinterTransport.BLUETOOTH,
                    paperWidthMm = 58,
                ),
            )

        assertEquals(UUID_1, resolved.profile.id)
        assertEquals(PrinterProfileMatch.MEASURED_ID, resolved.match)
    }

    @Test
    fun `medição de mesma capability vence catálogo e catálogo vence temporário`() {
        val measuredMp4200 =
            MeasuredProfile.createLocal(
                id = UUID_1,
                displayName = "Medição local",
                transports = BundledPrinterDrivers.bematechMp4200Th.transports,
                paperWidthMm = 80,
                printableColumns = 48,
                printableDots = 576,
                codePage = null,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 10,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        val store = InMemoryPrinterProfileStore().apply { save(measuredMp4200) }
        val resolver = PrinterProfileCatalog(store)

        val measured =
            resolver.resolve(
                PrinterProfileLookup(
                    "unknown.same.capability",
                    measuredMp4200.capabilityKey,
                    PrinterTransport.USB,
                    80,
                ),
            )
        val bundled =
            PrinterProfileCatalog(InMemoryPrinterProfileStore()).resolve(
                PrinterProfileLookup(
                    BundledPrinterDrivers.bematechMp4200Th.id,
                    null,
                    PrinterTransport.USB,
                    80,
                ),
            )
        val temporary =
            resolver.resolve(
                PrinterProfileLookup("unknown.profile", null, PrinterTransport.BLUETOOTH_LE, 58),
            )

        assertEquals(PrinterProfileMatch.MEASURED_CAPABILITY, measured.match)
        assertEquals(UUID_1, measured.profile.id)
        assertEquals(PrinterProfileMatch.BUNDLED, bundled.match)
        assertEquals(PrinterProfileMatch.TEMPORARY, temporary.match)
        assertEquals(MeasuredProfile.TEMPORARY_PROFILE_WARNING, temporary.warning)
        assertSame(PrinterStatusProtocol.NONE, temporary.profile.statusProtocol)
    }

    private fun profile(
        id: String,
        measuredAt: Long,
        columns: Int = 32,
    ): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = id,
            displayName = "Impressora de bancada",
            transports = setOf(PrinterTransport.BLUETOOTH, PrinterTransport.BLUETOOTH_LE),
            paperWidthMm = 58,
            printableColumns = columns,
            printableDots = 384,
            codePage = null,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            measuredAtEpochMillis = measuredAt,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    private fun version2Profile(): ByteArray =
        ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(0x54504b50)
                output.writeInt(2)
                output.writeInt(1)
                output.writeUTF(UUID_1)
                output.writeUTF("Impressora de bancada")
                output.writeInt((1 shl 2) or (1 shl 3))
                output.writeInt(58)
                output.writeInt(32)
                output.writeInt(384)
                output.writeInt(2)
                output.writeInt(0)
                output.writeInt(0)
                output.writeInt(1)
                output.writeInt(0)
                output.writeLong(10)
                output.writeInt(8)
                output.writeBoolean(true)
            }
            bytes.toByteArray()
        }

    /**
     * O envelope da versão imediatamente anterior a este campo, escrito à mão byte a byte.
     *
     * **Escrito à mão de propósito**, como as outras fixtures deste arquivo: o ponto do teste é
     * exercitar o formato antigo sem passar pelo `encode` atual, que só sabe escrever o mais novo.
     * A ordem abaixo é a do v8, e cada linha está anotada com o campo e a versão que a introduziu.
     */
    private fun version8Profile(): ByteArray =
        ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(0x54504b50) // MAGIC
                output.writeInt(8) // VERSION anterior
                output.writeInt(1) // quantidade de perfis
                output.writeUTF(UUID_1) // id
                output.writeUTF("Impressora de bancada") // displayName
                // A máscara de transporte deixou de ser escrita no v5: aqui ela não existe.
                output.writeInt(58) // paperWidthMm
                output.writeInt(32) // printableColumns
                output.writeInt(384) // printableDots
                output.writeInt(2) // codePage (2 = CP860)
                output.writeInt(0) // cutProtocol (0 = NONE)
                output.writeInt(0) // cutFeedLines
                output.writeInt(1) // dialect (1 = EPSON_COMPATIBLE)
                output.writeInt(0) // statusProtocol (0 = NONE)
                output.writeLong(10) // measuredAtEpochMillis
                output.writeInt(8) // codePageSelector (v2)
                output.writeBoolean(false) // cutModeHonored (v2)
                output.writeBoolean(true) // firmwareVersion presente (v3)
                output.writeUTF("SV3.2.2") // firmwareVersion (v3)
                output.writeInt(1) // textEncoding (v4, 1 = SINGLE_BYTE_CODE_PAGE)
                output.writeBoolean(true) // supportsNvLogo (v6)
                output.writeInt(8_192) // maxRasterBytesPerSecond (v7)
                output.writeDouble(0.8) // verticalRasterScale (v8)
                // Nem o v9 nem o v10 existem neste envelope: é isso que os dois testes provam.
            }
            bytes.toByteArray()
        }

    private fun version4WithPublishedAndMeasuredProfiles(): ByteArray =
        ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(0x54504b50)
                output.writeInt(4)
                output.writeInt(2)
                writeVersion4Profile(output, "community.portable58.escpos", measuredAt = 0)
                writeVersion4Profile(output, UUID_1, measuredAt = 10)
            }
            bytes.toByteArray()
        }

    private fun writeVersion4Profile(
        output: DataOutputStream,
        id: String,
        measuredAt: Long,
    ) {
        output.writeUTF(id)
        output.writeUTF("Impressora de bancada")
        output.writeInt((1 shl 2) or (1 shl 3))
        output.writeInt(58)
        output.writeInt(32)
        output.writeInt(384)
        output.writeInt(2)
        output.writeInt(0)
        output.writeInt(0)
        output.writeInt(1)
        output.writeInt(0)
        output.writeLong(measuredAt)
        output.writeInt(8)
        output.writeBoolean(true)
        output.writeBoolean(false)
        output.writeInt(1)
    }

    private companion object {
        const val UUID_1 = "00000000-0000-4000-8000-000000000011"
        const val UUID_2 = "00000000-0000-4000-8000-000000000012"
    }
}
