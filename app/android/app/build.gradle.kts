import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// 正式签名（key.properties + harnessgate-release.jks 都不进 git；CI 从 GitHub secrets 注入同一份）。
// 没有密钥文件时退回 debug 签名——保证任意环境可构建，但那类 APK 之间签名互不相同，
// 覆盖安装会被拒（必须固定密钥才能应用内自更新）。
// versionCode 取 git 提交总数（单调递增，摆脱手动 +N 维护——手动数字在多会话并行发版时会倒退，
// Android 按 versionCode 判升降级，倒退就是"无法降级安装"）。无 git 环境退回 flutter 版本号。
fun gitCommitCount(): Int = try {
    val proc = ProcessBuilder("git", "rev-list", "--count", "HEAD")
        .directory(rootProject.projectDir)
        .start()
    proc.waitFor()
    proc.inputStream.bufferedReader().readText().trim().toIntOrNull() ?: -1
} catch (e: Exception) {
    -1
}

val keystoreProperties = Properties().apply {
    val f = rootProject.file("app/key.properties")
    if (f.exists()) load(FileInputStream(f))
}
val hasReleaseKeystore = keystoreProperties.getProperty("storeFile") != null

android {
    namespace = "com.harnessgate.harnessgate"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        // flutter_local_notifications 等插件依赖 java.time 等 Java 8+ API → 开启脱糖
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.harnessgate.harnessgate"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // 提交数 > 历史手动 +N（当前 23）永远成立；CI 需 fetch-depth: 0 才能数全
        versionCode = if (gitCommitCount() > 0) gitCommitCount() else flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = rootProject.file("app/" + keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseKeystore) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
