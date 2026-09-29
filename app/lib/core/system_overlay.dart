import 'package:flutter/services.dart';

/// 通话系统悬浮条（原生 WindowManager，覆盖在其他应用之上）。
///
/// 需要「显示在其他应用上层」权限；无权限时服务仍可运行（通话保活），只是不画悬浮条。
/// 悬浮条本身的时长走秒、拖动、挂断按钮都在原生侧；挂断/点按通过 [bind] 回传给 Dart。
class SystemOverlay {
  static const _ch = MethodChannel('harnessgate/system');

  /// 是否已授予悬浮窗权限
  static Future<bool> canOverlay() async {
    try {
      return await _ch.invokeMethod<bool>('canOverlay') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 跳系统设置页请求悬浮窗权限
  static Future<void> requestOverlay() async {
    try {
      await _ch.invokeMethod('requestOverlay');
    } catch (_) {}
  }

  /// 启动通话前台服务（含悬浮条，初始隐藏）；同时把标题/阶段/开始时间交给原生
  static Future<void> startService({
    required String title,
    required String phase,
    required int startedAtMs,
  }) async {
    try {
      await _ch.invokeMethod('startCallOverlay', {
        'title': title,
        'phase': phase,
        'startedAtMs': startedAtMs,
      });
    } catch (_) {}
  }

  /// 悬浮条显隐（前台隐藏、退到后台显示）
  static Future<void> setVisible(bool visible) async {
    try {
      await _ch.invokeMethod(visible ? 'showCallOverlay' : 'hideCallOverlay');
    } catch (_) {}
  }

  /// 更新悬浮条文字/状态点
  static Future<void> update({String? title, String? phase}) async {
    try {
      await _ch.invokeMethod('updateCallOverlay', {'title': title, 'phase': phase});
    } catch (_) {}
  }

  /// 停止前台服务并移除悬浮条
  static Future<void> stopService() async {
    try {
      await _ch.invokeMethod('stopCallOverlay');
    } catch (_) {}
  }

  /// 注册原生回传：挂断键 / 点击悬浮条
  static void bind({void Function()? onHangup, void Function()? onTap}) {
    _ch.setMethodCallHandler((call) async {
      if (call.method == 'onCallOverlayHangup') {
        onHangup?.call();
      } else if (call.method == 'onCallOverlayTap') {
        onTap?.call();
      }
      return null;
    });
  }
}
