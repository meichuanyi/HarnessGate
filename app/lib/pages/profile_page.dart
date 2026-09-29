import 'dart:async';

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../core/client.dart';
import '../core/notify.dart';
import '../core/system_overlay.dart';
import '../core/update.dart';

/// 更新下载+安装完整流程（HomePage 更新弹窗与「我的」页共用）
Future<void> runUpdateFlow(BuildContext context, GateClient client, AppUpdate u) async {
  final progress = ValueNotifier<(int, int)>((0, 0));
  unawaited(showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => PopScope(
      canPop: false,
      child: AlertDialog(
        title: Text('正在下载 ${u.tag}'),
        content: ValueListenableBuilder<(int, int)>(
          valueListenable: progress,
          builder: (_, v, __) {
            final (done, total) = v;
            return Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                LinearProgressIndicator(value: total > 0 ? done / total : null),
                const SizedBox(height: 8),
                Text(
                  total > 0
                      ? '${(done / 1048576).toStringAsFixed(1)} / ${(total / 1048576).toStringAsFixed(1)} MB（服务器中转）'
                      : '连接中…',
                  style: const TextStyle(fontSize: 12),
                ),
              ],
            );
          },
        ),
      ),
    ),
  ));
  try {
    final path = await AppUpdate.download(
      u,
      (done, total) => progress.value = (done, total),
      relayBaseUrl: client.httpBase,
    );
    progress.dispose();
    if (!context.mounted) return;
    Navigator.of(context).pop();
    await _installWithRetry(context, u.tag, path);
  } catch (e) {
    progress.dispose();
    if (!context.mounted) return;
    Navigator.of(context).pop();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('下载失败：$e')));
  }
}

Future<void> _installWithRetry(BuildContext context, String tag, String path) async {
  while (context.mounted) {
    final r = await AppUpdate.install(path);
    if (!context.mounted) return;
    if (r.ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已交给系统安装器；若首次安装，请在弹出的页面允许「安装未知应用」')),
      );
      return;
    }
    final retry = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('无法调起安装（$tag）'),
        content: Text('常见原因：未授予「安装未知应用」权限。\n请在系统设置里允许本应用安装应用后，点「重试安装」（已下载的安装包不会重新下载）。\n\n安装器返回：${r.message}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('稍后')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('重试安装')),
        ],
      ),
    );
    if (retry != true) return;
  }
}

/// 我的：版本信息、应用内更新、通知开关——原先塞在会话页 AppBar 弹层里的东西集中到这里。
class ProfilePage extends StatefulWidget {
  final GateClient client;
  const ProfilePage({super.key, required this.client});

  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> with WidgetsBindingObserver {
  String _appVersion = '…';
  bool _canOverlay = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    PackageInfo.fromPlatform().then((i) {
      if (mounted) setState(() => _appVersion = 'v${i.version}');
    });
    _refreshOverlayPerm();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _refreshOverlayPerm(); // 从系统设置页回来重新判定
  }

  Future<void> _refreshOverlayPerm() async {
    final v = await SystemOverlay.canOverlay();
    if (mounted) setState(() => _canOverlay = v);
  }

  Future<void> _manualCheck() async {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('正在检查更新…'), duration: Duration(seconds: 1)));
    final r = await AppUpdate.check(manual: true);
    if (!mounted) return;
    if (r.update != null) {
      _offerUpdate(r.update!);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r.message ?? '已是最新')));
    }
  }

  void _offerUpdate(AppUpdate u) {
    showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('发现新版本 ${u.tag}'),
        content: Text(
          u.notes.trim().isEmpty ? '（这个版本没有更新说明）' : u.notes.trim().split('\n').take(8).join('\n'),
          maxLines: 12,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 13),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('稍后')),
          FilledButton(
            onPressed: () {
              Navigator.pop(context);
              _downloadAndInstall(u);
            },
            child: const Text('下载更新'),
          ),
        ],
      ),
    );
  }

  Future<void> _downloadAndInstall(AppUpdate u) async {
    if (!mounted) return;
    await runUpdateFlow(context, widget.client, u);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.client;
    return Scaffold(
      appBar: AppBar(title: const Text('我的')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          // 连接信息卡片
          Card(
            margin: const EdgeInsets.only(bottom: 12),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
              child: Column(
                children: [
                  const ListTile(
                    leading: Icon(Icons.bolt, color: Color(0xFF5B9CF8)),
                    title: Text('HarnessGate', style: TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: Text('远程驱动服务器上的编码 agent', style: TextStyle(fontSize: 12)),
                  ),
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.phone_android, size: 20),
                    title: const Text('APP 版本', style: TextStyle(fontSize: 13.5)),
                    trailing: Text(_appVersion, style: TextStyle(fontSize: 12.5, color: Colors.grey[400])),
                  ),
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.dns, size: 20),
                    title: const Text('服务器版本', style: TextStyle(fontSize: 13.5)),
                    trailing: Text(
                      c.serverVersion.isEmpty ? '未连接' : 'v${c.serverVersion} · ${c.serverCommit}',
                      style: TextStyle(fontSize: 12, color: Colors.grey[400]),
                    ),
                  ),
                ],
              ),
            ),
          ),
          // 通知
          Card(
            margin: const EdgeInsets.only(bottom: 12),
            child: SwitchListTile(
              secondary: const Icon(Icons.notifications_outlined),
              title: const Text('会话事件通知', style: TextStyle(fontSize: 14)),
              subtitle: const Text('回合完成 / 等待授权时提醒（APP 存活期间）', style: TextStyle(fontSize: 11.5)),
              value: Notifier.enabled,
              onChanged: (v) async {
                await Notifier.setEnabled(v);
                setState(() {});
                if (v) await Notifier.init();
              },
            ),
          ),
          // 通话系统悬浮窗权限
          Card(
            margin: const EdgeInsets.only(bottom: 12),
            child: ListTile(
              leading: const Icon(Icons.picture_in_picture_alt_outlined),
              title: const Text('通话系统悬浮窗', style: TextStyle(fontSize: 14)),
              subtitle: Text(
                _canOverlay
                    ? '已授权：通话退到后台/其他应用时也能看到悬浮条'
                    : '未授权：通话退到后台不显示悬浮条（前台内的悬浮条不受影响）',
                style: const TextStyle(fontSize: 11.5),
              ),
              trailing: _canOverlay
                  ? const Icon(Icons.check_circle, color: Color(0xFF2EA043), size: 20)
                  : const TextButton(onPressed: SystemOverlay.requestOverlay, child: Text('去授权')),
              onTap: _canOverlay ? null : () => SystemOverlay.requestOverlay(),
            ),
          ),
          // 更新
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: FilledButton.tonalIcon(
              icon: const Icon(Icons.system_update, size: 18),
              label: const Text('检查更新'),
              onPressed: _manualCheck,
            ),
          ),
          const SizedBox(height: 14),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              '更新走服务器中转下载（快），签名一致可直接覆盖安装。',
              style: TextStyle(fontSize: 11.5, color: Colors.grey[600]),
            ),
          ),
        ],
      ),
    );
  }
}
