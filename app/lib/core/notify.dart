import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 本地通知：回合完成 / 等待授权时提醒。
///
/// 约束（v1 本地通知的边界）：只在 APP 进程存活期间有效（前台或后台挂着），
/// 进程被系统杀死后 WS 断开、收不到事件——服务端推送属后续版本。
class Notifier {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static const _prefKey = 'hg_notify';
  static bool _enabled = true;
  static bool _ready = false;

  /// 当前正在查看的会话（ChatPage 进入/退出时维护）——盯着看的会话不弹通知
  static String? viewingSessionId;

  /// 点击通知 → 跳转对应会话（main 里注入导航回调）
  static void Function(String sessionId)? onTap;

  /// 点击「新版本已就绪」通知 → 调起安装（main 里注入）
  static void Function(String apkPath)? onUpdateReady;

  static bool get enabled => _enabled;

  /// 应用更新通知的固定 id（同一条通知复用/覆盖）
  static const _updateId = 0x484701;

  static Future<void> init() async {
    final p = await SharedPreferences.getInstance();
    _enabled = p.getBool(_prefKey) ?? true;
    try {
      const android = AndroidInitializationSettings('@mipmap/ic_launcher');
      const darwin = DarwinInitializationSettings();
      await _plugin.initialize(
        const InitializationSettings(android: android, iOS: darwin, macOS: darwin),
        onDidReceiveNotificationResponse: (resp) {
          final payload = resp.payload;
          if (payload == null || payload.isEmpty) return;
          // 应用更新通知的 payload 形如 "update:<apk路径>"
          if (payload.startsWith('update:')) {
            onUpdateReady?.call(payload.substring('update:'.length));
          } else {
            onTap?.call(payload);
          }
        },
      );
      // Android 13+ 需要运行时请求通知权限（低版本自动授予）
      await _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission();
      _ready = true;
    } catch (_) {
      // 初始化失败（无权限/平台不支持/测试环境）不致命：通知功能静默停用
      _ready = false;
    }
  }

  static Future<void> setEnabled(bool v) async {
    _enabled = v;
    final p = await SharedPreferences.getInstance();
    await p.setBool(_prefKey, v);
  }

  /// 弹通知；正在查看的会话跳过（同屏不打扰）
  static Future<void> show(String sessionId, String title, String body) async {
    if (!_ready || !_enabled) return;
    if (viewingSessionId == sessionId) return;
    await _plugin.show(
      sessionId.hashCode & 0x7fffffff,
      title,
      body,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          'harnessgate', // channel：会话事件
          '会话事件',
          channelDescription: '回合完成、等待授权等会话事件提醒',
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
      payload: sessionId,
    );
  }

  /* ---------- 应用更新：后台下载进度 / 下载完成提醒 ---------- */

  /// 后台下载进度常驻通知；[percent] 为 null 表示大小未知（转圈）
  static Future<void> showUpdateProgress(int? percent, String tag) async {
    if (!_ready) return;
    final details = NotificationDetails(
      android: AndroidNotificationDetails(
        'harnessgate_update',
        '应用更新',
        channelDescription: '应用内更新的后台下载与安装提醒',
        importance: Importance.low,
        priority: Priority.low,
        showProgress: percent != null,
        maxProgress: 100,
        progress: percent ?? 0,
        ongoing: true,
        onlyAlertOnce: true,
        autoCancel: false,
      ),
    );
    await _plugin.show(
      _updateId,
      '正在下载更新 $tag',
      percent == null ? '准备中…' : '$percent%',
      details,
    );
  }

  static Future<void> cancelUpdateProgress() async {
    if (!_ready) return;
    await _plugin.cancel(_updateId);
  }

  /// 下载完成、app 不在前台时的高优先级提醒；点它调起安装器
  static Future<void> showUpdateReady(String tag, String apkPath) async {
    if (!_ready) return;
    await _plugin.show(
      _updateId,
      '新版本 $tag 已就绪',
      '点此安装（需在系统弹窗里确认）',
      const NotificationDetails(
        android: AndroidNotificationDetails(
          'harnessgate_update',
          '应用更新',
          channelDescription: '应用内更新的后台下载与安装提醒',
          importance: Importance.high,
          priority: Priority.high,
          autoCancel: true,
        ),
      ),
      payload: 'update:$apkPath',
    );
  }
}
