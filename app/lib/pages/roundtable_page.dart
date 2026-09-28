import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';
import 'room_detail_page.dart';

/// 圆桌列表：状态胶囊（讨论中/已完成/待开始/出错/已停止），点入详情实时看讨论。
/// 新建圆桌仍是网页端的多步向导（选成员/模式/轮数），手机端专注查看与停止。
class RoundtablePage extends StatefulWidget {
  final GateClient client;
  const RoundtablePage({super.key, required this.client});

  @override
  State<RoundtablePage> createState() => _RoundtablePageState();
}

class _RoundtablePageState extends State<RoundtablePage> {
  @override
  void initState() {
    super.initState();
    widget.client.roomsChanged.listen((_) {
      if (mounted) setState(() {});
    });
    widget.client.send(msgList()); // 触发 hello 刷新，rooms 随之更新
  }

  Future<void> _confirmStop(String id, String topic) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('停止圆桌'),
        content: Text('停止「${topic.isEmpty ? id : topic}」？\n已产生的讨论内容会保留，房间转为已停止。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFF85149)),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('停止'),
          ),
        ],
      ),
    );
    if (ok == true) widget.client.send(msgRoomStop(id));
  }

  @override
  Widget build(BuildContext context) {
    final list = widget.client.rooms.values.toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return Scaffold(
      appBar: AppBar(title: Text('圆桌（${list.length}）')),
      body: RefreshIndicator(
        onRefresh: () async => widget.client.send(msgList()),
        child: list.isEmpty
            ? ListView(children: [
                const SizedBox(height: 150),
                Center(
                  child: Text(
                    '还没有圆桌房间\n新建圆桌请在网页端操作；这里实时查看讨论与停止',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey[500], fontSize: 13),
                  ),
                ),
              ])
            : ListView.builder(
                padding: const EdgeInsets.only(bottom: 88),
                itemCount: list.length,
                itemBuilder: (_, i) {
                  final r = list[i];
                  final (color, label) = r.pill;
                  return ListTile(
                    leading: Container(
                      width: 10, height: 10,
                      margin: const EdgeInsets.only(left: 4, top: 6),
                      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                    ),
                    title: Row(
                      children: [
                        if (r.isCrew)
                          const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.construction, size: 14, color: Color(0xFFD29922))),
                        Expanded(
                          child: Text(r.topic.isEmpty ? '(无议题)' : r.topic,
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                        ),
                      ],
                    ),
                    subtitle: Text(
                      '$label · ${r.turns.length} 条发言 · ${r.members.length} 成员${r.error != null ? ' · ${r.error}' : ''}',
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12),
                    ),
                    trailing: r.status == 'running'
                        ? IconButton(
                            tooltip: '停止圆桌',
                            icon: const Icon(Icons.stop_circle_outlined, size: 20, color: Color(0xFFF85149)),
                            onPressed: () => _confirmStop(r.id, r.topic),
                          )
                        : null,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => RoomDetailPage(client: widget.client, roomId: r.id)),
                    ),
                  );
                },
              ),
      ),
    );
  }
}
