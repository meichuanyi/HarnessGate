package com.harnessgate.harnessgate

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "harnessgate/system"
    private var channel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
        channel = ch
        SystemOverlayBridge.channel = ch // 悬浮条服务回传「挂断/点按」用
        ch.setMethodCallHandler { call, result ->
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
                    // ---- 通话系统悬浮窗 ----
                    "canOverlay" -> result.success(Settings.canDrawOverlays(this))
                    "requestOverlay" -> {
                        startActivity(
                            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                        result.success(true)
                    }
                    "startCallOverlay" -> {
                        startOverlayService(
                            CallOverlayService.ACTION_START,
                            call.argument<String>("title"),
                            call.argument<String>("phase"),
                            call.argument<Number>("startedAtMs")?.toLong(),
                        )
                        result.success(true)
                    }
                    "showCallOverlay" -> {
                        startOverlayService(CallOverlayService.ACTION_SHOW, null, null, null)
                        result.success(true)
                    }
                    "hideCallOverlay" -> {
                        startOverlayService(CallOverlayService.ACTION_HIDE, null, null, null)
                        result.success(true)
                    }
                    "updateCallOverlay" -> {
                        startOverlayService(
                            CallOverlayService.ACTION_UPDATE,
                            call.argument<String>("title"),
                            call.argument<String>("phase"),
                            null,
                        )
                        result.success(true)
                    }
                    "stopCallOverlay" -> {
                        startOverlayService(CallOverlayService.ACTION_STOP, null, null, null)
                        result.success(true)
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                result.error("channel_failed", e.message, null)
            }
        }
    }

    override fun onDestroy() {
        if (SystemOverlayBridge.channel === channel) SystemOverlayBridge.channel = null
        channel = null
        super.onDestroy()
    }

    private fun startOverlayService(action: String, title: String?, phase: String?, startedAtMs: Long?) {
        val intent = Intent(this, CallOverlayService::class.java).setAction(action)
        title?.let { intent.putExtra(CallOverlayService.EXTRA_TITLE, it) }
        phase?.let { intent.putExtra(CallOverlayService.EXTRA_PHASE, it) }
        startedAtMs?.let { intent.putExtra(CallOverlayService.EXTRA_STARTED, it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
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
