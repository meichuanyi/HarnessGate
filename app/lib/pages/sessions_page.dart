import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';
import 'chat_page.dart';
import 'new_session_page.dart';

/// 会话列表：收藏置顶 → 最近活跃；状态胶囊（运行中/空闲/待审批/已存档/出错）。
class SessionsPage extends StatefulWidget {
  final GateClient client;
  const SessionsPage({super.key, required this.client});

  @override
  State<SessionsPage> createState() => _SessionsPageState();
}

class _SessionsPageState extends State<SessionsPage> {
  @override
  void initState() {
    super.initState();
    widget.client.sessionsChanged.listen((_) {
      if (mounted) setState(() {});
    });
    widget.client.send(msgList());
  }

  List<SessionInfo> get _sorted {
    final list = widget.client.sessions.values.toList();
    list.sort((a, b) {
      final as = (a.starred ?? false) ? 1 : 0;
      final bs = (b.starred ?? false) ? 1 : 0;
      if (as != bs) return bs - as;
      return b.lastActiveAt.compareTo(a.lastActiveAt);
    });
    return list;
  }

  (Color, String) _pill(SessionInfo s) {
    if (s.status == 'ready') {
      return s.inTurn == true
          ? (const Color(0xFF3FB950), '运行中')
          : (const Color(0xFF5B9CF8), '空闲');
    }
    switch (s.status) {
      case 'starting': return (const Color(0xFFD29922), '启动中');
      case 'awaiting': return (const Color(0xFFD29922), '待审批');
      case 'error': return (const Color(0xFFF85149), '出错');
      default: return (Colors.grey, '已存档');
    }
  }

  void _toggleStar(SessionInfo s) {
    widget.client.send(msgStar(s.id, !(s.starred ?? false)));
    // 乐观更新：服务端广播到达后 sessionsChanged 会再刷一次
    widget.client.sessions[s.id] = s.copyWith(starred: !(s.starred ?? false));
    setState(() {});
  }

  Future<void> _confirmDelete(SessionInfo s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除会话'),
        content: Text('删除「${s.title?.isNotEmpty == true ? s.title : s.id}」？\n该操作不可撤销，会话记录与台账将一并清除。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFF85149)),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok == true) widget.client.send(msgDelete(s.id));
  }

  @override
  Widget build(BuildContext context) {
    final sessions = _sorted;
    return Scaffold(
      appBar: AppBar(
        title: const Text('会话'),
        actions: [
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: () => widget.client.send(msgList()),
          ),
          StreamBuilder<String>(
            stream: widget.client.state,
            initialData: 'idle',
            builder: (_, snap) {
              final st = snap.data ?? 'idle';
              return Padding(
                padding: const EdgeInsets.only(right: 12),
                child: Icon(Icons.circle, size: 10, color: st == 'connected' ? const Color(0xFF3FB950) : const Color(0xFFD29922)),
              );
            },
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => NewSessionPage(client: widget.client)),
        ),
        icon: const Icon(Icons.add),
        label: const Text('新建会话'),
      ),
      body: RefreshIndicator(
        onRefresh: () async => widget.client.send(msgList()),
        child: sessions.isEmpty
            ? ListView(
                children: [
                  const SizedBox(height: 160),
                  Center(child: Text('还没有会话\n点右下「新建会话」，或在网页端创建后下拉刷新', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey[500]))),
                ],
              )
            : ListView.builder(
                padding: const EdgeInsets.only(bottom: 88),
                itemCount: sessions.length,
                itemBuilder: (_, i) {
                  final s = sessions[i];
                  final (color, label) = _pill(s);
                  return ListTile(
                    leading: Container(
                      width: 10, height: 10,
                      margin: const EdgeInsets.only(left: 4, top: 6),
                      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                    ),
                    title: Row(
                      children: [
                        if (s.starred ?? false)
                          const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.star, size: 15, color: Color(0xFFF5B942))),
                        Expanded(
                          child: Text(
                            s.title?.isNotEmpty == true ? s.title! : '(无标题)',
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                    subtitle: Text('${s.harnessLabel} · $label · ${s.cwd.split('/').last}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatPage(client: widget.client, sessionId: s.id))),
                    trailing: PopupMenuButton<String>(
                      icon: const Icon(Icons.more_vert, size: 20),
                      onSelected: (v) {
                        switch (v) {
                          case 'star': _toggleStar(s); break;
                          case 'resume': widget.client.send(msgResume(s.id)); break;
                          case 'stop': widget.client.send(msgClose(s.id)); break;
                          case 'delete': _confirmDelete(s); break;
                        }
                      },
                      itemBuilder: (_) => [
                        PopupMenuItem(value: 'star', child: Text((s.starred ?? false) ? '取消收藏' : '收藏置顶')),
                        if (!s.live && s.resumable) const PopupMenuItem(value: 'resume', child: Text('恢复会话')),
                        if (s.live) const PopupMenuItem(value: 'stop', child: Text('停止进程')),
                        const PopupMenuItem(value: 'delete', child: Text('删除会话', style: TextStyle(color: Color(0xFFF85149)))),
                      ],
                    ),
                  );
                },
              ),
      ),
    );
  }
}
