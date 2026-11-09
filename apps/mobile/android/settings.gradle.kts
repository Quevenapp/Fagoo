pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
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
rootProject.name = "Fagoo"
includeBuild("../../../packages/thermal-printer-kit/android") {
    dependencySubstitution {
        substitute(module("br.com.thermalprinterkit:thermalprinterkit")).using(project(":"))
        substitute(module("br.com.thermalprinterkit:printher")).using(project(":printher"))
    }
}
include(":app")
