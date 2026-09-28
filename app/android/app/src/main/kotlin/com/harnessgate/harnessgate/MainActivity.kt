package com.harnessgate.harnessgate

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "harnessgate/system"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        // 打开本应用的系统设置页（用于手动开启麦克风权限）
                        "openAppSettings" -> {
                            startActivity(appDetailsIntent(packageName))
                            result.success(true)
                        }
                        // 打开系统语音识别服务的设置页：error_permission 多半是「识别引擎」本身没有麦克风权限
                        "openSpeechServiceSettings" -> {
                            val pkg = defaultRecognitionServicePackage()
                            if (pkg != null) {
                                startActivity(appDetailsIntent(pkg))
                            } else {
                                // 找不到具体引擎时退回系统「语音输入」设置页
                                startActivity(
                                    Intent("android.settings.VOICE_INPUT_SETTINGS")
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                )
                            }
                            result.success(pkg)
                        }
                        else -> result.notImplemented()
                    }
                } catch (e: Exception) {
                    result.error("open_settings_failed", e.message, null)
                }
            }
    }

    private fun appDetailsIntent(pkg: String): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", pkg, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    private fun defaultRecognitionServicePackage(): String? {
        val services = packageManager.queryIntentServices(
            Intent(android.speech.RecognitionService.SERVICE_INTERFACE), 0
        )
        return services.firstOrNull()?.serviceInfo?.packageName
    }
}
