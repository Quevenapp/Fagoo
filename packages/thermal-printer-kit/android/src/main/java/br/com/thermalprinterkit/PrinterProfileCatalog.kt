package br.com.thermalprinterkit

data class PrinterProfileLookup(
    val profileId: String?,
    val capabilityKey: PrinterCapabilityKey?,
    val transport: PrinterTransport,
    val paperWidthMm: Int,
)

enum class PrinterProfileMatch {
    MEASURED_ID,
    MEASURED_CAPABILITY,
    BUNDLED,
    TEMPORARY,
}

data class ResolvedPrinterProfile(
    val profile: MeasuredProfile,
    val match: PrinterProfileMatch,
    val warning: String? = null,
)

/**
 * Resolve somente perfis medidos neste aparelho e os homologados embutidos no binário.
 * A medição local vence por ID ou capacidade porque representa o papel confirmado pela pessoa.
 */
class PrinterProfileCatalog(
    private val store: PrinterProfileStore,
    bundledProfiles: List<PrinterDriverProfile> = BundledPrinterDrivers.all,
) {
    /**
     * O factory operacional pode receber também drivers medidos já adaptados ao contrato M1.
     * Somente os perfis que realmente satisfazem o schema bundled entram nesta camada; medições
     * continuam vindo do store e preservam a precedência definida acima.
     */
    private val bundled =
        bundledProfiles.mapNotNull { profile ->
            try {
                MeasuredProfile.bundled(profile)
            } catch (_: IllegalArgumentException) {
                null
            }
        }

    fun resolve(lookup: PrinterProfileLookup): ResolvedPrinterProfile {
        val measured = store.read().filter { it.source == PrinterProfileSource.MEASURED }

        measured.firstOrNull { profile ->
            profile.id == lookup.profileId && profile.supports(lookup.transport)
        }?.let { return ResolvedPrinterProfile(it, PrinterProfileMatch.MEASURED_ID) }

        val bundledWithSameId = bundled.firstOrNull { it.id == lookup.profileId }
        val effectiveCapability =
            lookup.capabilityKey ?: bundledWithSameId?.capabilityKey

        if (effectiveCapability != null) {
            measured.firstOrNull { profile ->
                profile.capabilityKey == effectiveCapability && profile.supports(lookup.transport)
            }?.let { return ResolvedPrinterProfile(it, PrinterProfileMatch.MEASURED_CAPABILITY) }
        }

        matchingProfile(bundled, lookup, effectiveCapability)?.let {
            return ResolvedPrinterProfile(it, PrinterProfileMatch.BUNDLED)
        }

        // O dialeto aqui é **aposta declarada**, e não padrão herdado — o argumento passou a ser
        // obrigatório em 09/09/2026 justamente para que esta linha tivesse de ser escrita por
        // alguém.
        //
        // O que se sabe: este ramo só existe quando uma impressora **já adotada** perdeu o perfil
        // medido dela do store. Não há de onde tirar o dialeto: a `PersistedPrinterSelection` não
        // o guarda, e a `capabilityKey` é SHA-256 — não se volta dela para o campo.
        //
        // Por que ESC/POS, e não recusa: recusar imprimiria nada em toda impressora comum que
        // caísse aqui, que é a esmagadora maioria delas, para proteger a única família conhecida
        // que quebra. Por que isto não é o defeito de 23/08: lá o palpite acontecia **antes** da
        // medição, num caminho que toda impressora nova percorria; aqui ele acontece depois de uma
        // medição que existiu e sumiu, e vem acompanhado de `TEMPORARY_PROFILE_WARNING`, que manda
        // a interface pedir homologação em papel de novo.
        //
        // O que fica em aberto, dito com essas palavras: uma Diebold adotada cujo perfil sumisse
        // do store voltaria a receber ESC/POS por aqui. O conserto de verdade é a seleção
        // persistida guardar o dialeto — mudança de formato de disco, e não deste arquivo.
        return ResolvedPrinterProfile(
            profile =
                MeasuredProfile.temporary(
                    transport = lookup.transport,
                    paperWidthMm = lookup.paperWidthMm,
                    dialect = EscPosDialect.EPSON_COMPATIBLE,
                ),
            match = PrinterProfileMatch.TEMPORARY,
            warning = MeasuredProfile.TEMPORARY_PROFILE_WARNING,
        )
    }

    private fun matchingProfile(
        profiles: List<MeasuredProfile>,
        lookup: PrinterProfileLookup,
        capabilityKey: PrinterCapabilityKey?,
    ): MeasuredProfile? =
        profiles.firstOrNull { profile ->
            profile.id == lookup.profileId && profile.supports(lookup.transport)
        } ?: capabilityKey?.let { expected ->
            profiles.firstOrNull { profile ->
                profile.capabilityKey == expected && profile.supports(lookup.transport)
            }
        }
}

/** Leitor implementado pelo host; aliases e formatos legados não pertencem ao kit. */
fun interface LegacyPrinterProfileReader {
    fun readLegacyProfiles(): List<MeasuredProfile>
}

@ConsistentCopyVisibility
data class LegacyProfileDeletionAuthorization internal constructor(
    val confirmedProfileIds: Set<String>,
)

sealed interface PrinterProfileImportResult {
    data class Imported(
        val authorization: LegacyProfileDeletionAuthorization,
    ) : PrinterProfileImportResult

    data class Failed(
        val reason: String,
    ) : PrinterProfileImportResult
}

/** Lê, grava e relê antes de autorizar o host a remover qualquer registro legado. */
fun importLegacyPrinterProfiles(
    reader: LegacyPrinterProfileReader,
    store: PrinterProfileStore,
): PrinterProfileImportResult =
    runCatching {
        val profiles = reader.readLegacyProfiles()
        profiles.forEach(store::save)
        val confirmed = store.read().associateBy(MeasuredProfile::id)
        require(
            profiles.all { expected ->
                confirmed[expected.id]?.capabilityKey == expected.capabilityKey
            },
        ) {
            "O store neutro não confirmou todos os perfis importados."
        }
        PrinterProfileImportResult.Imported(
            LegacyProfileDeletionAuthorization(profiles.mapTo(linkedSetOf(), MeasuredProfile::id)),
        )
    }.getOrElse {
        PrinterProfileImportResult.Failed("Não foi possível confirmar a importação dos perfis.")
    }
