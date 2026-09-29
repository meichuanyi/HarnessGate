package com.harnessgate.harnessgate

import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.MethodChannel

/**
 * 悬浮条服务 → Dart 的回传通道。服务与 Flutter 引擎同进程，
 * MainActivity 注册后这里就能把「挂断/点按」等事件投递回 Dart。
 */
object SystemOverlayBridge {
    var channel: MethodChannel? = null
    private val main = Handler(Looper.getMainLooper())

    fun notify(method: String) {
        main.post {
            try {
                channel?.invokeMethod(method, null)
            } catch (_: Exception) {
            }
        }
    }
}
