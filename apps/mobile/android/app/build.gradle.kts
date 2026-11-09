import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Never package a release Firebase client into .debug. Omitting the plugin also
// omits its generated resource source set, even if an older build left files.
fun firebaseConfig(variant: String): File? {
    val expected = "br.com.queven.fagoo" + if (variant == "debug") ".debug" else ""
    for (candidate in listOf(file("src/$variant/google-services.json"), file("google-services.json"))) {
        if (!candidate.exists()) continue
        val data = try { JsonSlurper().parse(candidate) as? Map<*, *> }
            catch (_: Exception) { throw GradleException("Configuração Firebase inválida: ${candidate.name}") }
        val clients = data?.get("client") as? List<*> ?: emptyList<Any>()
        val matching = clients.any { client ->
            val info = (client as? Map<*, *>)?.get("client_info") as? Map<*, *>
            (info?.get("android_client_info") as? Map<*, *>)?.get("package_name") == expected
        }
        if (matching) return candidate
        if (candidate.parentFile.name == variant) throw GradleException("Firebase de $variant não contém o pacote $expected.")
    }
    return null
}
val requested = gradle.startParameter.taskNames.map { it.substringAfterLast(':').lowercase() }
val allVariants = requested.any { it in setOf("assemble", "build", "bundle", "check", "test", "lint") }
val wantsDebug = allVariants || requested.any { "debug" in it }
val wantsRelease = allVariants || requested.any { "release" in it }
val debugFirebase = if (wantsDebug) firebaseConfig("debug") else null
val releaseFirebase = if (wantsRelease) firebaseConfig("release") else null
if (wantsRelease && releaseFirebase == null) throw GradleException("Release exige google-services.json do pacote br.com.queven.fagoo em app/src/release.")
if (wantsDebug && wantsRelease && debugFirebase == null) throw GradleException("Compile debug e release separadamente até fornecer o cliente Firebase br.com.queven.fagoo.debug.")
if ((wantsDebug && debugFirebase != null) || wantsRelease) {
    apply(plugin = libs.plugins.google.services.get().pluginId)
} else if (wantsDebug) {
    logger.lifecycle("Fagoo: debug SEM Firebase; forneça app/src/debug/google-services.json para testar push. Nenhum recurso Firebase gerado será incluído.")
}

android {
    namespace = "br.com.queven.fagoo"
    compileSdk = 36

    defaultConfig {
        applicationId = "br.com.queven.fagoo"
        minSdk = 26
        targetSdk = 36
        versionCode = 10000
        versionName = "1.0.0"
        vectorDrawables { useSupportLibrary = true }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        // Material 3 1.3.x marca TopAppBar, ModalBottomSheet, PullToRefreshBox etc. como experimentais.
        freeCompilerArgs += listOf(
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
            "-opt-in=androidx.compose.foundation.ExperimentalFoundationApi",
            "-opt-in=androidx.compose.foundation.layout.ExperimentalLayoutApi",
        )
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/INDEX.LIST", "META-INF/DEPENDENCIES")
    }
}

dependencies {
    implementation("com.google.zxing:core:3.5.3")
    implementation("br.com.thermalprinterkit:thermalprinterkit")
    implementation("br.com.thermalprinterkit:printher")
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.coil.compose)
    implementation(libs.coil.video)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    implementation(libs.media3.datasource.okhttp)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.play.services.location)
    testImplementation(libs.junit)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
