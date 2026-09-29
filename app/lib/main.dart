import 'dart:async';

import 'package:flutter/material.dart';
import 'core/client.dart';
import 'core/notify.dart';
import 'core/system_overlay.dart';
import 'core/voice.dart';
import 'pages/call_overlay.dart';
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

  @override
  void initState() {
    super.initState();
    client = GateClient();
    WidgetsBinding.instance.addObserver(this);
    SystemOverlay.bind(
      onHangup: () => client.voice.endCall(),
      onTap: () {}, // 原生已把 app 拉回前台，回前台后由 didChangeAppLifecycleState 收起悬浮条
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
    _syncSystemOverlay();
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
