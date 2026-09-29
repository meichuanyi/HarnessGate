import 'client.dart';
import 'notify.dart';
import 'update.dart';

/// 后台下载更新（不阻塞界面）：
/// 发现新版本 → 后台下到缓存并用常驻通知显示进度 → 下载完成时，
/// app 在前台就弹「立即安装」，在后台/锁屏就发一条高优先级通知，点按后调起安装器。
/// 注：安装这一步 Android 必然弹系统安装窗口，无法静默（普通应用权限所限）。
class UpdateManager {
  /// app 是否在前台（由 main 的生命周期回调维护）
  static bool foreground = true;

  /// 包已就绪且 app 在前台时，由 main 注入：弹「立即安装」对话框
  static void Function(AppUpdate u, String path)? onReadyInForeground;

  static bool _downloading = false;
  static int _lastPercent = -2;
  static AppUpdate? _lastUpdate;
  static String? _lastPath;

  static bool get downloading => _downloading;

  /// 后台下载；重复调用只跑一次
  static Future<void> autoDownload(GateClient client, AppUpdate u) async {
    if (_downloading) return;
    _downloading = true;
    _lastPercent = -2;
    _lastUpdate = u;
    try {
      await Notifier.showUpdateProgress(null, u.tag);
      final path = await AppUpdate.download(
        u,
        (done, total) {
          final p = total > 0 ? (done * 100 ~/ total) : -1;
          if (p != _lastPercent) {
            _lastPercent = p;
            Notifier.showUpdateProgress(p < 0 ? null : p, u.tag);
          }
        },
        relayBaseUrl: client.httpBase,
      );
      await Notifier.cancelUpdateProgress();
      _lastPath = path;
      if (foreground) {
        onReadyInForeground?.call(u, path);
      } else {
        await Notifier.showUpdateReady(u.tag, path);
      }
    } catch (_) {
      // 网络中断/中转失败：撤掉进度通知，静默；下次启动会再试
      await Notifier.cancelUpdateProgress();
    } finally {
      _downloading = false;
    }
  }

  /// 点了「新版本已就绪」通知、回到前台后调用：安装最近下好的包
  static void installLast() {
    final u = _lastUpdate;
    final p = _lastPath;
    if (u != null && p != null) onReadyInForeground?.call(u, p);
  }

  static bool get hasReady => _lastPath != null;
}
