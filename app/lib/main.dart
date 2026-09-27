import 'dart:async';

import 'package:flutter/material.dart';
import 'core/client.dart';
import 'core/notify.dart';
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

class _HarnessGateAppState extends State<HarnessGateApp> {
  late final GateClient client;
  StreamSubscription? _notifySub;

  @override
  void initState() {
    super.initState();
    client = GateClient();
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
    _notifySub?.cancel();
    super.dispose();
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
    );
  }
}
