import 'dart:async';

import 'package:flutter/material.dart';
import 'core/client.dart';
import 'core/notify.dart';
import 'core/system_overlay.dart';
import 'core/update.dart';
import 'core/update_manager.dart';
import 'core/voice.dart';
import 'pages/call_overlay.dart';
import 'pages/call_page.dart';
import 'pages/chat_page.dart';
import 'pages/connect_page.dart';

final navigatorKey = GlobalKey<NavigatorState>();

void main() {
  runApp(const HarnessGateApp());
}

class HarnessGateApp extends StatefulWidget {
  const HarnessGateApp({super.key});
  @override
  State<HarnessGateApp> createState() => _HarnessGateAppState();
}

class _HarnessGateAppState extends State<HarnessGateApp> with WidgetsBindingObserver {
  late final GateClient client;
  StreamSubscription? _notifySub;

  // 系统悬浮条状态：通话中退到后台时显示原生悬浮条；回前台/挂断时收起
  bool _foreground = true;
  bool _overlayService = false;
  bool _overlayVisible = false;
  String _lastTitle = '';
  String _lastPhase = '';
  bool _pendingOpenCall = false; // 点了系统悬浮条：回到前台后跳到通话页
  bool _pendingInstall = false; // 点了「新版本已就绪」通知：回到前台后弹安装

  @override
  void initState() {
    super.initState();
    client = GateClient();
    WidgetsBinding.instance.addObserver(this);
    SystemOverlay.bind(
      onHangup: () => client.voice.endCall(),
      // 原生已把 app 拉回前台；这里标记一下，回前台后跳到通话页（正开着通话页则不重复压栈）
      onTap: () => _pendingOpenCall = true,
    );
    client.voice.callStartedAt.addListener(_syncSystemOverlay);
    client.voice.phase.addListener(_syncSystemOverlay);
    client.sessionsChanged.listen((_) => _syncSystemOverlay()); // 标题可能稍后才回来
    Notifier.onTap = (sid) {
      // 点通知直达对应会话
      navigatorKey.currentState?.push(
        MaterialPageRoute(builder: (_) => ChatPage(client: client, sessionId: sid)),
      );
    };
    Notifier.init();
    // 后台下载的更新包就绪：前台直接弹安装；点「已就绪」通知则回前台再弹
    UpdateManager.onReadyInForeground = _showInstallDialog;
    Notifier.onUpdateReady = (_) => _pendingInstall = true;
    // 会话事件 → 本地通知：回合完成 / 等待授权（正在看的会话由 Notifier 内部跳过）
    _notifySub = client.messages.listen((m) {
      final sid = m['sessionId'] as String?;
      if (sid == null) return;
      if (m['type'] == 'turn_end') {
        final s = client.sessions[sid];
        Notifier.show(sid, '✅ 回合完成', s?.title?.isNotEmpty == true ? s!.title! : sid);
      } else if (m['type'] == 'permission') {
        Notifier.show(sid, '🔐 等待授权', m['title'] as String? ?? '有操作在等你决定');
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    client.voice.callStartedAt.removeListener(_syncSystemOverlay);
    client.voice.phase.removeListener(_syncSystemOverlay);
    _notifySub?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) {
      _foreground = true;
    } else if (s == AppLifecycleState.paused || s == AppLifecycleState.hidden) {
      _foreground = false;
    } else {
      return; // inactive（权限弹窗/下拉通知栏等）：不切换悬浮条，避免闪烁
    }
    UpdateManager.foreground = _foreground;
    _syncSystemOverlay();
    if (s == AppLifecycleState.resumed) {
      _openCallIfNeeded();
      if (_pendingInstall) {
        _pendingInstall = false;
        UpdateManager.installLast();
      }
    }
  }

  /// 「新版本已下载」：前台弹确认，确认后调起系统安装器
  Future<void> _showInstallDialog(AppUpdate u, String path) async {
    final ctx = navigatorKey.currentState?.overlay?.context;
    if (ctx == null || !ctx.mounted) return;
    final go = await showDialog<bool>(
      context: ctx,
      builder: (_) => AlertDialog(
        title: Text('新版本 ${u.tag} 已下载'),
        content: Text(
          '点「安装」调起系统安装器（Android 必须由你在系统弹窗里确认，无法静默安装）。'
          '${u.notes.trim().isEmpty ? '' : '\n\n${u.notes.trim().split('\n').take(6).join('\n')}'}',
          maxLines: 10,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 13),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('稍后')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('安装')),
        ],
      ),
    );
    if (go == true) {
      final r = await AppUpdate.install(path);
      if (!r.ok && ctx.mounted) {
        ScaffoldMessenger.of(ctx).showSnackBar(
          SnackBar(content: Text('无法调起安装：${r.message}（若未授权「安装未知应用」，可到「我的」页重试）')),
        );
      }
    }
  }

  /// 点系统悬浮条回到前台后，跳到通话页（已经在通话页则不重复压栈）
  void _openCallIfNeeded() {
    if (!_pendingOpenCall) return;
    _pendingOpenCall = false;
    final sid = client.voice.callSessionId;
    if (sid == null || client.voice.callPageVisible.value) return;
    navigatorKey.currentState?.push(
      MaterialPageRoute(builder: (_) => CallPage(client: client, sessionId: sid)),
    );
  }

  static String _phaseName(CallPhase p) => switch (p) {
        CallPhase.listening => 'listening',
        CallPhase.thinking => 'thinking',
        CallPhase.speaking => 'speaking',
        CallPhase.error => 'error',
        CallPhase.idle => 'idle',
      };

  String _callTitle(String sid) {
    final t = client.sessions[sid]?.title;
    return (t != null && t.isNotEmpty) ? t : (sid.isEmpty ? '会话' : sid);
  }

  /// 把「是否在通话 / 是否前台」同步到原生系统悬浮条
  Future<void> _syncSystemOverlay() async {
    final v = client.voice;
    final started = v.callStartedAt.value;
    if (started == null) {
      if (_overlayVisible) {
        _overlayVisible = false;
        await SystemOverlay.setVisible(false);
      }
      if (_overlayService) {
        _overlayService = false;
        _lastTitle = '';
        _lastPhase = '';
        await SystemOverlay.stopService();
      }
      return;
    }
    final title = _callTitle(v.callSessionId ?? '');
    final phase = _phaseName(v.phase.value);
    if (!_overlayService) {
      _overlayService = true;
      _lastTitle = title;
      _lastPhase = phase;
      await SystemOverlay.startService(
        title: title,
        phase: phase,
        startedAtMs: started.millisecondsSinceEpoch,
      );
    } else if (title != _lastTitle || phase != _lastPhase) {
      _lastTitle = title;
      _lastPhase = phase;
      await SystemOverlay.update(title: title, phase: phase);
    }
    final wantVisible = !_foreground;
    if (wantVisible != _overlayVisible) {
      _overlayVisible = wantVisible;
      await SystemOverlay.setVisible(wantVisible);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'HarnessGate',
      navigatorKey: navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF0B0D12),
        appBarTheme: const AppBarTheme(backgroundColor: Color(0xFF12151C), surfaceTintColor: Colors.transparent),
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF5B9CF8), brightness: Brightness.dark),
      ),
      home: ConnectPage(client: client),
      // 全局悬浮通话条：通话中最小化通话页后，任何页面顶部可回通话/挂断
      builder: (_, child) => CallOverlay(client: client, child: child ?? const SizedBox.shrink()),
    );
  }
}
