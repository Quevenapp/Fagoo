plugins {
    id("com.android.library") version "8.13.2"
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20"
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.20" apply false
    // Declarado só para fixar a versão do módulo `:core-jvm`; `apply false` não toca o AAR.
    id("org.jetbrains.kotlin.jvm") version "2.2.20" apply false
}

group = "br.com.thermalprinterkit"
version = "0.1.0-SNAPSHOT"

android {
    namespace = "br.com.thermalprinterkit"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("com.google.zxing:core:3.5.3")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("org.json:json:20240303")

    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
}

// A JVM de teste nao herda as `-D` da linha de comando do Gradle. Sem esta linha,
// `-Dsonda.regravar=true` seria uma instrucao que existe na documentacao e nao existe na maquina —
// e o teste continuaria vermelho sem dizer por que. Ver `SondaQrRealDoCupomTest`.
tasks.withType<Test>().configureEach {
    systemProperty("sonda.regravar", System.getProperty("sonda.regravar") ?: "false")
}
