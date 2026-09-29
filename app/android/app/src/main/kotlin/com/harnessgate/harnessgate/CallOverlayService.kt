package com.harnessgate.harnessgate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 通话系统悬浮条（覆盖在其他应用之上）+ 前台服务保活。
 *
 * - 用 WindowManager + TYPE_APPLICATION_OVERLAY 画一条胶囊：状态点 + 「通话中 mm:ss · 标题」+ 挂断。
 * - 作为前台服务运行（microphone 类型）：退到后台通话不被杀、悬浮条常驻；同时满足 Android 14+
 *   后台使用麦克风必须挂前台服务的要求。挂断/点按通过 SystemOverlayBridge 回传 Dart。
 * - 没授予「显示在其他应用上层」时，服务照常跑（保活），只是不画悬浮条。
 * - 拖拽：按住可上下左右移动位置，避免挡住状态栏/胶囊。
 */
class CallOverlayService : Service() {
    companion object {
        const val ACTION_START = "hg.overlay.START"
        const val ACTION_SHOW = "hg.overlay.SHOW"
        const val ACTION_HIDE = "hg.overlay.HIDE"
        const val ACTION_UPDATE = "hg.overlay.UPDATE"
        const val ACTION_STOP = "hg.overlay.STOP"
        const val ACTION_HANGUP = "hg.overlay.HANGUP"
        const val EXTRA_TITLE = "title"
        const val EXTRA_PHASE = "phase"
        const val EXTRA_STARTED = "startedAtMs"
        private const val NOTIF_ID = 0x4847
        private const val NOTIF_CHANNEL = "hg_call"
    }

    private val main = Handler(Looper.getMainLooper())
    private var wm: WindowManager? = null
    private var root: LinearLayout? = null
    private var dot: View? = null
    private var label: TextView? = null
    private var params: WindowManager.LayoutParams? = null

    private var title = ""
    private var phase = "listening"
    private var startedAtMs = 0L
    private var foregroundStarted = false
    private var viewVisible = false

    private val tick = object : Runnable {
        override fun run() {
            render()
            if (viewVisible) main.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                title = intent.getStringExtra(EXTRA_TITLE) ?: title
                phase = intent.getStringExtra(EXTRA_PHASE) ?: phase
                startedAtMs = intent.getLongExtra(EXTRA_STARTED, startedAtMs)
                startForegroundIfNeeded()
                ensureView()
                setVisible(false) // 刚发起通话通常还在前台，先不显示；退到后台再 show
            }
            ACTION_SHOW -> { startForegroundIfNeeded(); ensureView(); setVisible(true) }
            ACTION_HIDE -> { startForegroundIfNeeded(); setVisible(false) }
            ACTION_UPDATE -> {
                intent.getStringExtra(EXTRA_TITLE)?.let { title = it }
                intent.getStringExtra(EXTRA_PHASE)?.let { phase = it }
                if (intent.hasExtra(EXTRA_STARTED)) startedAtMs = intent.getLongExtra(EXTRA_STARTED, startedAtMs)
                startForegroundIfNeeded()
                render()
            }
            ACTION_HANGUP -> SystemOverlayBridge.notify("onCallOverlayHangup")
            ACTION_STOP -> {
                startForegroundIfNeeded() // 满足 startForegroundService 的 5s 约束后再收
                cleanup()
                stopSelf()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 从最近任务划掉 = Activity/Flutter 引擎被销毁，通话无法继续，一并收起悬浮条与服务
        cleanup()
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    /* ---------- 前台服务与通知 ---------- */

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(NOTIF_CHANNEL) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(NOTIF_CHANNEL, "通话", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "语音通话进行中"
                    setShowBadge(false)
                },
                )
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val hangup = PendingIntent.getService(
            this,
            1,
            Intent(this, CallOverlayService::class.java).setAction(ACTION_HANGUP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, NOTIF_CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        return b
            .setContentTitle("HarnessGate 通话中")
            .setContentText(if (title.isNotEmpty()) title else "实时语音通话")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentIntent(open)
            .addAction(
                Notification.Action.Builder(
                    android.graphics.drawable.Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                    "挂断",
                    hangup,
                ).build(),
            )
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_CALL)
            .build()
    }

    private fun startForegroundIfNeeded() {
        if (foregroundStarted) return
        foregroundStarted = true
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                0
            }
            startForeground(NOTIF_ID, n, type)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    /* ---------- 悬浮条视图 ---------- */

    private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    private fun colorFor(p: String): Int = when (p) {
        "listening" -> 0xFF2EA043.toInt()
        "speaking" -> 0xFF58A6FF.toInt()
        "thinking" -> 0xFFD29922.toInt()
        "error" -> 0xFFF85149.toInt()
        else -> 0xFF8B949E.toInt()
    }

    private fun ensureView() {
        if (root != null) return
        if (!Settings.canDrawOverlays(this)) return // 无权限：保活但不画

        val ctx = this
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14f), dp(7f), dp(8f), dp(7f))
            background = GradientDrawable().apply {
                cornerRadius = dp(999f).toFloat()
                setColor(0xF216202E.toInt())
                setStroke(dp(1f), 0x3358A6FF)
            }
            elevation = dp(6f).toFloat()
        }

        val dotView = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(dp(9f), dp(9f))
        }
        row.addView(dotView)
        dot = dotView

        val text = TextView(ctx).apply {
            setTextColor(0xFFE8EBF1.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(dp(8f), 0, dp(6f), 0)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
        }
        row.addView(text)
        label = text

        val hangup = ImageView(ctx).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
            setColorFilter(0xFFF85149.toInt())
            setPadding(dp(6f), dp(6f), dp(6f), dp(6f))
            layoutParams = LinearLayout.LayoutParams(dp(34f), dp(34f))
            setOnClickListener { SystemOverlayBridge.notify("onCallOverlayHangup") }
        }
        row.addView(hangup)

        row.setOnClickListener {
            // 回前台：拉起 MainActivity；到前台后 Dart 会隐藏本悬浮条
            try {
                startActivity(
                    packageManager.getLaunchIntentForPackage(packageName)?.apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    },
                )
            } catch (_: Exception) {
            }
        }
        // 拖动定位
        row.setOnTouchListener(object : android.view.View.OnTouchListener {
            private var downX = 0f
            private var downY = 0f
            private var startX = 0
            private var startY = 0
            private var moved = false
            override fun onTouch(v: View, e: android.view.MotionEvent): Boolean {
                val p = params ?: return false
                when (e.action) {
                    android.view.MotionEvent.ACTION_DOWN -> {
                        downX = e.rawX; downY = e.rawY
                        startX = p.x; startY = p.y
                        moved = false
                        return true
                    }
                    android.view.MotionEvent.ACTION_MOVE -> {
                        val dx = (e.rawX - downX).toInt()
                        val dy = (e.rawY - downY).toInt()
                        if (kotlin.math.abs(dx) > dp(4f) || kotlin.math.abs(dy) > dp(4f)) moved = true
                        p.x = startX + dx
                        p.y = startY + dy
                        try { wm?.updateViewLayout(v, p) } catch (_: Exception) {}
                        return true
                    }
                    android.view.MotionEvent.ACTION_UP -> {
                        if (!moved) v.performClick()
                        return true
                    }
                }
                return false
            }
        })

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            x = 0
            y = dp(8f)
        }
        params = lp
        try {
            wm?.addView(row, lp)
            root = row
            render()
        } catch (_: Exception) {
            root = null
        }
    }

    private fun render() {
        val d = dot ?: return
        val c = colorFor(phase)
        d.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(c)
            setStroke(dp(1f), c)
        }
        val durMs = if (startedAtMs > 0) System.currentTimeMillis() - startedAtMs else 0
        val mm = ((durMs / 1000) / 60 % 60).toString().padStart(2, '0')
        val ss = ((durMs / 1000) % 60).toString().padStart(2, '0')
        val t = title.ifEmpty { "会话" }
        label?.text = "通话中 $mm:$ss · ${if (t.length > 14) t.substring(0, 14) + "…" else t}"
    }

    private fun setVisible(visible: Boolean) {
        val p = params ?: return
        val r = root
        if (r == null) { viewVisible = false; return }
        viewVisible = visible
        r.visibility = if (visible) View.VISIBLE else View.GONE
        main.removeCallbacks(tick)
        if (visible) {
            render()
            main.postDelayed(tick, 1000)
        }
    }

    private fun cleanup() {
        main.removeCallbacks(tick)
        viewVisible = false
        root?.let { try { wm?.removeView(it) } catch (_: Exception) {} }
        root = null
        dot = null
        label = null
        params = null
        if (foregroundStarted) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
            foregroundStarted = false
        }
    }
}
