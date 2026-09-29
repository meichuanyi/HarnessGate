import 'dart:async';

import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/update.dart';
import '../core/update_manager.dart';
import 'profile_page.dart';
import 'roundtable_page.dart';
import 'schedules_page.dart';
import 'workspace_page.dart';
import 'sessions_page.dart';

/// 主框架：底部导航三栏（会话 / 收藏 / 我的），IndexedStack 保留各栏滚动与筛选状态。
class HomePage extends StatefulWidget {
  final GateClient client;
  const HomePage({super.key, required this.client});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    // 启动静默检查一次应用更新（GitHub Release）；有新版直接后台下载，不弹阻塞对话框
    Timer(const Duration(seconds: 3), () async {
      final r = await AppUpdate.check();
      if (r.update != null) await UpdateManager.autoDownload(widget.client, r.update!);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          SessionsPage(client: widget.client),
          RoundtablePage(client: widget.client),
          SchedulesPage(client: widget.client),
          WorkspacePage(client: widget.client),
          ProfilePage(client: widget.client),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        height: 64,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.forum_outlined), selectedIcon: Icon(Icons.forum), label: '会话'),
          NavigationDestination(icon: Icon(Icons.groups_outlined), selectedIcon: Icon(Icons.groups), label: '圆桌'),
          NavigationDestination(icon: Icon(Icons.schedule_outlined), selectedIcon: Icon(Icons.schedule), label: '定时'),
          NavigationDestination(icon: Icon(Icons.workspaces_outlined), selectedIcon: Icon(Icons.workspaces), label: '工作区'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: '我的'),
        ],
      ),
    );
  }
}
