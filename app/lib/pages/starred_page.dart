import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';
import 'chat_page.dart';
import 'sessions_page.dart';

/// 收藏页：跨所有 harness 的收藏会话（★ 置顶需求的独立入口，对齐 web 收藏抽屉）。
class StarredPage extends StatefulWidget {
  final GateClient client;
  const StarredPage({super.key, required this.client});

  @override
  State<StarredPage> createState() => _StarredPageState();
}

class _StarredPageState extends State<StarredPage> {
  @override
  void initState() {
    super.initState();
    widget.client.sessionsChanged.listen((_) {
      if (mounted) setState(() {});
    });
    widget.client.send(msgList());
  }

  void _unstar(SessionInfo s) {
    widget.client.send(msgStar(s.id, false));
    widget.client.sessions[s.id] = s.copyWith(starred: false);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final list = widget.client.sessions.values.where((s) => s.starred ?? false).toList()
      ..sort((a, b) => b.lastActiveAt.compareTo(a.lastActiveAt));
    return Scaffold(
      appBar: AppBar(
        title: Text('收藏（${list.length}）'),
        actions: [
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: () => widget.client.send(msgList()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => widget.client.send(msgList()),
        child: list.isEmpty
            ? ListView(children: [
                const SizedBox(height: 150),
                    Center(
                      child: Text(
                        '还没有收藏的会话\n在「会话」列表点会话右侧 ⋮ → 收藏置顶',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.grey[500], fontSize: 13),
                      ),
                    ),
              ])
            : ListView.builder(
                padding: const EdgeInsets.only(bottom: 88),
                itemCount: list.length,
                itemBuilder: (_, i) {
                  final s = list[i];
                  final (color, label) = pillOfSession(s);
                  return ListTile(
                    leading: Container(
                      width: 10, height: 10,
                      margin: const EdgeInsets.only(left: 4, top: 6),
                      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                    ),
                    title: Row(
                      children: [
                        const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.star, size: 15, color: Color(0xFFF5B942))),
                        Expanded(
                          child: Text(s.title?.isNotEmpty == true ? s.title! : '(无标题)',
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                        ),
                      ],
                    ),
                    subtitle: Text(
                      '${s.harnessLabel} · $label · ${SessionsPage.timeAgo(s.lastActiveAt)}',
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12),
                    ),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => ChatPage(client: widget.client, sessionId: s.id)),
                    ),
                    trailing: IconButton(
                      tooltip: '取消收藏',
                      icon: const Icon(Icons.star, size: 18, color: Color(0xFFF5B942)),
                      onPressed: () => _unstar(s),
                    ),
                  );
                },
              ),
      ),
    );
  }
}
