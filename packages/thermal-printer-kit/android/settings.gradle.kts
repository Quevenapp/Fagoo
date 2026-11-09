pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "thermalprinterkit"

// O core continua sendo o projeto raiz para preservar o consumo composto do M1. A superfície e o
// app de bancada são opcionais e vivem fora desta pasta para manter as fronteiras visíveis no
// monorepo, sem mudar a coordenada `br.com.thermalprinterkit:thermalprinterkit` do consumidor.
include(":printher")
project(":printher").projectDir = file("../printher")

// FAGOO inclui somente as bibliotecas usadas pelo aplicativo.
