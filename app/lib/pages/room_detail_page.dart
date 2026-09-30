import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../core/client.dart';
import '../core/md_style.dart';
import '../core/protocol.dart';

/// 圆桌房间详情：头部状态卡 + 发言时间线（主持人横跨整行、成员逐条、评分徽标），实时刷新。
class RoomDetailPage extends StatefulWidget {
  final GateClient client;
  final String roomId;
  const RoomDetailPage({super.key, required this.client, required this.roomId});

  @override
  State<RoomDetailPage> createState() => _RoomDetailPageState();
}

class _RoomDetailPageState extends State<RoomDetailPage> {
  StreamSubscription? _sub;
  final _scroll = ScrollController();

  RoomInfo? get _room => widget.client.rooms[widget.roomId];

  @override
  void initState() {
    super.initState();
    // 订阅广播：room 消息到达时 roomsChanged 会触发；这里再听 messages 兜底滚动到底
    _sub = widget.client.roomsChanged.listen((_) {
      if (mounted) setState(_stickBottom);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _stickBottom());
  }

  @override
  void dispose() {
    _sub?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  /// 新发言时贴底（用户上翻则不打扰）
  void _stickBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      if (_scroll.position.maxScrollExtent - _scroll.position.pixels < 300) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  Future<void> _confirmStop() async {
    final r = _room;
    if (r == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('停止圆桌'),
        content: Text('停止「${r.topic.isEmpty ? r.id : r.topic}」？已产生的讨论内容会保留。'),
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
    if (ok == true) widget.client.send(msgRoomStop(widget.roomId));
  }

  @override
  Widget build(BuildContext context) {
    final r = _room;
    if (r == null) {
      return const Scaffold(body: Center(child: Text('房间不存在或已被删除')));
    }
    final (pillColor, pillLabel) = r.pill;
    final memberNames = r.members.map((m) => m.harnessLabel).where((s) => s.isNotEmpty).join(' / ');
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: pillColor.withValues(alpha: 0.13),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: pillColor.withValues(alpha: 0.5)),
              ),
              child: Text(pillLabel, style: TextStyle(fontSize: 10.5, color: pillColor, fontWeight: FontWeight.w600)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(r.topic.isEmpty ? r.id : r.topic,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15)),
            ),
          ],
        ),
        actions: [
          if (r.status == 'running')
            IconButton(
              tooltip: '停止圆桌',
              icon: const Icon(Icons.stop_circle_outlined, color: Color(0xFFF85149)),
              onPressed: _confirmStop,
            ),
        ],
      ),
      body: Column(
        children: [
          // 信息条
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                [
                  if (r.isCrew) '工作队',
                  r.mode == 'sequential' ? '串行' : '并行',
                  '${r.rounds == 0 ? "不限" : r.rounds} 轮',
                  if (r.hostLabel != null) '主持 ${r.hostLabel}',
                  if (memberNames.isNotEmpty) memberNames,
                  if (!r.writeAllowed) '只读',
                ].join(' · '),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11.5, color: Colors.grey[500]),
              ),
            ),
          ),
          if (r.error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('✕ ${r.error}', style: const TextStyle(fontSize: 12, color: Color(0xFFF85149))),
              ),
            ),
          Expanded(
            child: r.turns.isEmpty
                ? Center(child: Text('还没有发言', style: TextStyle(color: Colors.grey[500])))
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                    itemCount: r.turns.length,
                    itemBuilder: (_, i) => _turnCard(r.turns[i]),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _turnCard(RoomTurnInfo t) {
    final isHost = t.kind == 'host';
    final hostRole = switch (t.hostRole) {
      'opening' => '开场拆题',
      'round-summary' => '轮间小结',
      'final' => '最终汇总',
      _ => '主持人',
    };
    final head = isHost
        ? '👑 $hostRole · ${t.harnessLabel}'
        : '第 ${t.round} 轮 · ${t.harnessLabel}';
    return Container(
      margin: EdgeInsets.only(bottom: 10, left: isHost ? 0 : 18),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: isHost ? const Color(0xFF1A2334) : Colors.white.withValues(alpha: 0.03),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: isHost ? const Color(0xFF2A4A7A) : Colors.grey.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(head,
                    style: TextStyle(
                      fontSize: 11.5,
                      color: isHost ? const Color(0xFF5B9CF8) : Colors.grey[500],
                      fontWeight: isHost ? FontWeight.w600 : FontWeight.w400,
                    )),
              ),
              if (t.score != null)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: const Color(0xFFD29922).withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text('⭐ ${t.score}', style: const TextStyle(fontSize: 10.5, color: Color(0xFFD29922))),
                ),
            ],
          ),
          const SizedBox(height: 6),
          MarkdownBody(
            data: t.reply.isEmpty ? '（无输出）' : t.reply,
            selectable: true,
            styleSheet: hgMarkdownStyle(context).copyWith(p: const TextStyle(fontSize: 13)),
          ),
        ],
      ),
    );
  }
}
