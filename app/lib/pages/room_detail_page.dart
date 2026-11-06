import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../core/client.dart';
import '../core/md_style.dart';
import '../core/math_markdown.dart';
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
  final _topicInput = TextEditingController();
  int _topicRounds = 1;
  DateTime _lastFetch = DateTime.fromMillisecondsSinceEpoch(0);

  RoomInfo? get _room => widget.client.rooms[widget.roomId];

  /// 拉房间全量（hello/rooms 列表只发摘要，历史发言稿只能经 room-get 拿）。
  /// 3s 节流：rooms 整表广播后各房间回退为摘要态，这里会被密集触发，防风暴。
  void _fetchFull() {
    final now = DateTime.now();
    if (now.difference(_lastFetch).inSeconds < 3) return;
    _lastFetch = now;
    widget.client.send(msgRoomGet(widget.roomId));
  }

  @override
  void initState() {
    super.initState();
    // 打开详情先拉一次全量：摘要态没有发言稿，不拉的话历史圆桌恒显示「还没有发言」
    _fetchFull();
    // 订阅广播：room 消息到达时 roomsChanged 会触发；这里再听 messages 兜底滚动到底
    _sub = widget.client.roomsChanged.listen((_) {
      if (!mounted) return;
      // rooms 列表广播会把房间重置回摘要态（turns 空、turnCount>0）——检测到就重拉全量，
      // 否则直播看完的发言稿会被别人建新圆桌等动作当场抹掉
      final r = _room;
      if (r != null && r.turns.isEmpty && (r.turnCount ?? 0) > 0) _fetchFull();
      setState(_stickBottom);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _stickBottom());
  }

  @override
  void dispose() {
    _sub?.cancel();
    _scroll.dispose();
    _topicInput.dispose();
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

  Future<void> _confirmMerge() async {
    final r = _room;
    if (r == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('🔗 合并到主目录'),
        content: const Text('把工作队各任务的产物合并回主工作目录（完成后圆桌标记为已合并）。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('合并')),
        ],
      ),
    );
    if (ok == true) widget.client.send(msgCrewMerge(widget.roomId));
  }

  void _addTopic() {
    final t = _topicInput.text.trim();
    if (t.isEmpty) return;
    _topicInput.clear();
    widget.client.send(msgRoomTopic(widget.roomId, t, rounds: _topicRounds));
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
          // 切换并行/串行：作用于下一轮发言方式
          if (r.status != 'running')
            IconButton(
              tooltip: r.mode == 'parallel' ? '当前并行 · 切为串行（下一轮生效）' : '当前串行 · 切为并行（下一轮生效）',
              icon: Icon(r.mode == 'parallel' ? Icons.call_split : Icons.linear_scale, size: 20),
              onPressed: () =>
                  widget.client.send(msgRoomMode(widget.roomId, r.mode == 'parallel' ? 'sequential' : 'parallel')),
            ),
          // 断点续跑：停止/出错且未到终态（讨论从第一个未完成轮继续；工作队保留任务板）
          if (r.status == 'stopped' || r.status == 'error')
            IconButton(
              tooltip: r.isCrew ? '保留任务板继续：被打断的任务退回待办' : '从第一个未完成的轮继续（残缺发言会重说）',
              icon: const Icon(Icons.play_circle_outline, color: Color(0xFF3FB950)),
              onPressed: () => widget.client.send(msgRoomRun(widget.roomId)),
            ),
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
            child: r.isCrew && r.crewTasks.isNotEmpty
                ? _crewBoard(r)
                : r.turns.isEmpty
                    ? Center(child: Text('还没有发言', style: TextStyle(color: Colors.grey[500])))
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                        itemCount: r.turns.length,
                        itemBuilder: (_, i) => _turnCard(r.turns[i]),
                      ),
          ),
          // 底部操作条：讨论圆桌=追加议题；工作队=合并到主目录（讨论进行中服务端会拒绝追加）
          const Divider(height: 1),
          if (r.isCrew)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
              child: SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: r.status == 'running' ? null : _confirmMerge,
                  icon: const Icon(Icons.merge_type, size: 18),
                  label: const Text('🔗 合并到主目录'),
                ),
              ),
            )
          else if (r.status != 'running')
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              child: Row(children: [
                Expanded(
                  child: TextField(
                    controller: _topicInput,
                    onSubmitted: (_) => _addTopic(),
                    decoration: const InputDecoration(
                        isDense: true, hintText: '追加议题…（同一批成员继续讨论）'),
                  ),
                ),
                const SizedBox(width: 8),
                DropdownButton<int>(
                  value: _topicRounds,
                  underline: const SizedBox.shrink(),
                  items: [for (var n = 1; n <= 5; n++) DropdownMenuItem(value: n, child: Text('$n 轮'))],
                  onChanged: (v) => setState(() => _topicRounds = v ?? 1),
                ),
                const SizedBox(width: 4),
                IconButton(onPressed: _addTopic, icon: const Icon(Icons.send, size: 20)),
              ]),
            ),
        ],
      ),
    );
  }

  /// 工作队任务板：按 status 动态分列（摘要态就带 title/status/assignee 轻字段，
  /// 不依赖 room-get 全量）。列顺序按服务端下发顺序，任务卡显示标题+负责人。
  Widget _crewBoard(RoomInfo r) {
    final cols = <String, List<CrewTaskInfo>>{};
    for (final t in r.crewTasks) {
      cols.putIfAbsent(t.status, () => []).add(t);
    }
    const statusCn = {
      'pending': '待认领', 'in_progress': '进行中', 'review': '评审中',
      'done': '已完成', 'error': '出错', 'merged': '已合并',
    };
    final entries = cols.entries.toList();
    return ListView(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
      children: [
        Text('🧰 ${r.crewTasks.length} 个任务 · 按状态分列',
            style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
        const SizedBox(height: 8),
        for (final e in entries) ...[
          Container(
            margin: const EdgeInsets.only(bottom: 6),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: Colors.grey[850],
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              '${statusCn[e.key] ?? e.key}（${e.value.length}）',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
            ),
          ),
          for (final t in e.value)
            Container(
              margin: const EdgeInsets.only(left: 10, bottom: 6),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                border: Border(left: BorderSide(width: 3, color: _crewStatusColor(e.key))),
                borderRadius: BorderRadius.circular(4),
                color: Colors.grey[900],
              ),
              child: Row(children: [
                Expanded(child: Text(t.title.isEmpty ? t.id : t.title, style: const TextStyle(fontSize: 13))),
                if (t.assignee?.isNotEmpty == true)
                  Text(t.assignee!, style: TextStyle(fontSize: 11, color: Colors.grey[500])),
              ]),
            ),
        ],
      ],
    );
  }

  Color _crewStatusColor(String s) => switch (s) {
        'done' => const Color(0xFF3FB950),
        'merged' => const Color(0xFF5B9CF8),
        'review' => const Color(0xFFD29922),
        'in_progress' => const Color(0xFF58A6FF),
        'error' => const Color(0xFFF85149),
        _ => Colors.grey,
      };

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
            data: t.reply.isEmpty ? "（无输出）" : t.reply,
            selectable: true,
            styleSheet: hgMarkdownStyle(context).copyWith(p: const TextStyle(fontSize: 13)),
            inlineSyntaxes: [BlockMathSyntax(), InlineMathSyntax()],
            builders: {
              "latex_inline": MathElementBuilder(baseStyle: const TextStyle(fontSize: 13)),
              "latex_block": MathElementBuilder(baseStyle: const TextStyle(fontSize: 14), isBlock: true),
            },
          ),
        ],
      ),
    );
  }
}
