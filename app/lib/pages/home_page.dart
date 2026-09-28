import 'dart:async';

import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/update.dart';
import 'profile_page.dart';
import 'roundtable_page.dart';
import 'sessions_page.dart';
import 'starred_page.dart';

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
    // 启动静默检查一次应用更新（GitHub Release），有新版再弹窗
    Timer(const Duration(seconds: 3), () async {
      final r = await AppUpdate.check();
      if (r.update != null && mounted) _offerUpdate(r.update!);
    });
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
              runUpdateFlow(context, widget.client, u);
            },
            child: const Text('下载更新'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          SessionsPage(client: widget.client),
          StarredPage(client: widget.client),
          RoundtablePage(client: widget.client),
          ProfilePage(client: widget.client),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        height: 64,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.forum_outlined), selectedIcon: Icon(Icons.forum), label: '会话'),
          NavigationDestination(icon: Icon(Icons.star_outline), selectedIcon: Icon(Icons.star), label: '收藏'),
          NavigationDestination(icon: Icon(Icons.groups_outlined), selectedIcon: Icon(Icons.groups), label: '圆桌'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: '我的'),
        ],
      ),
    );
  }
}
