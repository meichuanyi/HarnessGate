import 'dart:async';

import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';
import 'chat_page.dart';
import 'new_session_page.dart';

/// 会话列表的一个 harness 分组（对齐 web 侧栏的树形结构）
class SessionGroup {
  final String harnessId;
  final String label;
  final String latestActive;
  final int liveCount;
  final List<SessionInfo> sessions;
  final bool collapsed;
  const SessionGroup({
    required this.harnessId,
    required this.label,
    required this.latestActive,
    required this.liveCount,
    required this.sessions,
    required this.collapsed,
  });
}

/// 会话列表：收藏置顶 → 最近活跃；状态胶囊（运行中/空闲/待审批/已归档/出错）。
/// 分组/过滤/相对时间做成静态纯函数，单测直接覆盖。
class SessionsPage extends StatefulWidget {
  final GateClient client;
  const SessionsPage({super.key, required this.client});

  /// 按 harness 分组（对齐 web 侧栏的树）：组间按最近活跃排，组内收藏置顶 → 最近活跃。
  /// 过滤词命中 标题/cwd/id/harness label 任一即保留。
  static List<SessionGroup> groupSessions(List<SessionInfo> all,
      {String filter = '', Set<String> collapsed = const {}}) {
    final q = filter.trim().toLowerCase();
    bool hit(SessionInfo s) =>
        q.isEmpty ||
        (s.title ?? '').toLowerCase().contains(q) ||
        s.cwd.toLowerCase().contains(q) ||
        s.id.toLowerCase().contains(q) ||
        s.harnessLabel.toLowerCase().contains(q) ||
        s.tags.any((t) => t.toLowerCase().contains(q));
    final byHarness = <String, List<SessionInfo>>{};
    for (final s in all.where(hit)) {
      byHarness.putIfAbsent(s.harnessId, () => []).add(s);
    }
    String maxActive(List<SessionInfo> l) {
      var max = '';
      for (final s in l) {
        if (s.lastActiveAt.compareTo(max) > 0) max = s.lastActiveAt;
      }
      return max;
    }

    final groups = byHarness.entries.map((e) {
      final list = e.value.toList()
        ..sort((a, b) {
          final as = (a.starred ?? false) ? 1 : 0;
          final bs = (b.starred ?? false) ? 1 : 0;
          if (as != bs) return bs - as;
          return b.lastActiveAt.compareTo(a.lastActiveAt);
        });
      return SessionGroup(
        harnessId: e.key,
        label: list.first.harnessLabel,
        latestActive: maxActive(list),
        liveCount: list.where((s) => s.live).length,
        sessions: list,
        collapsed: collapsed.contains(e.key),
      );
    }).toList()
      ..sort((a, b) => b.latestActive.compareTo(a.latestActive));
    return groups;
  }

  /// ISO 时间 → 相对时间（列表行展示）
  static String timeAgo(String iso) {
    final t = DateTime.tryParse(iso);
    if (t == null) return '';
    final d = DateTime.now().difference(t);
    if (d.inMinutes < 1) return '刚刚';
    if (d.inMinutes < 60) return '${d.inMinutes} 分钟前';
    if (d.inHours < 24) return '${d.inHours} 小时前';
    if (d.inDays < 30) return '${d.inDays} 天前';
    return '${t.month}/${t.day}';
  }

  @override
  State<SessionsPage> createState() => _SessionsPageState();
}

class _SessionsPageState extends State<SessionsPage> {
  final _collapsed = <String>{}; // 折叠起来的 harnessId（内存态，与 web 一致）
  final _filter = TextEditingController();
  bool _starredOnly = false; // 只看收藏（原独立收藏页收编为过滤开关）

  @override
  void initState() {
    super.initState();
    widget.client.sessionsChanged.listen((_) {
      if (mounted) setState(() {});
    });
    widget.client.send(msgList());
  }

  (Color, String) _pill(SessionInfo s) => pillOfSession(s);

  void _toggleStar(SessionInfo s) {
    widget.client.send(msgStar(s.id, !(s.starred ?? false)));
    // 乐观更新：服务端广播到达后 sessionsChanged 会再刷一次
    widget.client.sessions[s.id] = s.copyWith(starred: !(s.starred ?? false));
    setState(() {});
  }

  Future<void> _editTags(SessionInfo s) async {
    final ctrl = TextEditingController(text: s.tags.join(', '));
    final tags = await showDialog<List<String>>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('编辑标签'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: '标签（逗号分隔，留空清空）',
            hintText: '如: 重构, anki, 长期任务',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              final list = ctrl.text
                  .split(RegExp(r'[,，]'))
                  .map((t) => t.trim())
                  .where((t) => t.isNotEmpty)
                  .take(20)
                  .toList();
              Navigator.pop(context, list);
            },
            child: const Text('保存'),
          ),
        ],
      ),
    );
    if (tags == null) return;
    widget.client.send(msgSetTags(s.id, tags));
    widget.client.sessions[s.id] = s.copyWith(tags: tags);
    setState(() {});
  }

  Future<void> _confirmDelete(SessionInfo s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除会话'),
        content: Text(
            '删除「${s.title?.isNotEmpty == true ? s.title : s.id}」？\n该操作不可撤销，会话记录与台账将一并清除。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFF85149)),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok == true) {
      widget.client.transcriptCache.remove(s.id);
      widget.client.send(msgDelete(s.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('会话'),
        actions: [
          IconButton(
            tooltip: _starredOnly ? '显示全部会话' : '只看收藏',
            icon: Icon(
              _starredOnly ? Icons.star : Icons.star_outline,
              size: 20,
              color: _starredOnly ? const Color(0xFFF5B942) : null,
            ),
            onPressed: () => setState(() => _starredOnly = !_starredOnly),
          ),
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
                child: Icon(Icons.circle,
                    size: 10,
                    color: st == 'connected'
                        ? const Color(0xFF3FB950)
                        : const Color(0xFFD29922)),
              );
            },
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute(
              builder: (_) => NewSessionPage(client: widget.client)),
        ),
        icon: const Icon(Icons.add),
        label: const Text('新建会话'),
      ),
      body: Column(
        children: [
          // 过滤框：按标题/目录/id/harness 过滤（与 web 侧栏过滤一致）
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 2),
            child: TextField(
              controller: _filter,
              decoration: InputDecoration(
                hintText: '过滤会话（标题 / 目录 / id / harness）…',
                isDense: true,
                prefixIcon: const Icon(Icons.search, size: 18),
                suffixIcon: _filter.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.close, size: 16),
                        onPressed: () {
                          _filter.clear();
                          setState(() {});
                        }),
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
          _tagChipsRow(),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async => widget.client.send(msgList()),
              child: _buildGroupedList(),
            ),
          ),
        ],
      ),
    );
  }

  /// 常驻助理入口：hello 的 assistantSessionId 驱动；无则一键创建（assistant-ensure）
  Widget _assistantHeader() {
    final aid = widget.client.assistantSessionId;
    final s = aid != null ? widget.client.sessions[aid] : null;
    final live = s?.live ?? false;
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 4),
      color: const Color(0xFF16202E),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () {
          if (aid != null) {
            Navigator.of(context).push(MaterialPageRoute(
                builder: (_) =>
                    ChatPage(client: widget.client, sessionId: aid)));
          } else {
            widget.client.send(msgAssistantEnsure());
            ScaffoldMessenger.of(context)
                .showSnackBar(const SnackBar(content: Text('正在创建助理会话…')));
          }
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(
            children: [
              Icon(Icons.auto_awesome,
                  size: 22,
                  color:
                      live ? const Color(0xFF3FB950) : const Color(0xFF5B9CF8)),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('助理',
                        style: TextStyle(
                            fontWeight: FontWeight.w600, fontSize: 14.5)),
                    Text(
                      aid == null
                          ? '点此创建常驻助理（永不回收，带长期记忆）'
                          : (live ? '在线 · 直接说话' : '休息中 · 进入自动唤醒'),
                      style: TextStyle(fontSize: 11.5, color: Colors.grey[500]),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, size: 20, color: Colors.grey),
            ],
          ),
        ),
      ),
    );
  }

  /// 标签快筛：全库标签按出现次数排序，点选=过滤框填入该标签（再点取消）
  Widget _tagChipsRow() {
    final counts = <String, int>{};
    for (final s in widget.client.sessions.values) {
      for (final t in s.tags) {
        counts[t] = (counts[t] ?? 0) + 1;
      }
    }
    if (counts.isEmpty) return const SizedBox.shrink();
    final tags = counts.keys.toList()
      ..sort((a, b) {
        final byCount = (counts[b] ?? 0).compareTo(counts[a] ?? 0);
        return byCount != 0 ? byCount : a.compareTo(b);
      });
    final active = _filter.text.trim();
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
      child: SizedBox(
        height: 34,
        child: ListView(
          scrollDirection: Axis.horizontal,
          children: [
            for (final t in tags)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: ChoiceChip(
                  label: Text('$t ${counts[t]}',
                      style: const TextStyle(fontSize: 11.5)),
                  selected: active == t,
                  visualDensity: VisualDensity.compact,
                  onSelected: (_) =>
                      setState(() => _filter.text = active == t ? '' : t),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildGroupedList() {
    final all = widget.client.sessions.values
        .where((s) => !_starredOnly || (s.starred ?? false))
        .toList();
    final groups = SessionsPage.groupSessions(all,
        filter: _filter.text, collapsed: _collapsed);
    if (groups.isEmpty) {
      return ListView(children: [
        _assistantHeader(),
        const SizedBox(height: 140),
        Center(
            child: Text(
                all.isEmpty ? '还没有会话\n点右下「新建会话」，或在网页端创建后下拉刷新' : '没有匹配的会话',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey[500]))),
      ]);
    }
    // 组头 + 组内条目摊平成一个列表（ListView.builder 惰性渲染）
    final items = <(int, dynamic)>[];
    for (final g in groups) {
      items.add((0, g));
      if (!g.collapsed) {
        for (final s in g.sessions) {
          items.add((1, s));
        }
      }
    }
    return ListView.builder(
      padding: const EdgeInsets.only(bottom: 88),
      itemCount: items.length + 1,
      itemBuilder: (_, i) {
        if (i == 0) return _assistantHeader();
        final (type, data) = items[i - 1];
        if (type == 0) {
          final g = data as SessionGroup;
          return InkWell(
            onTap: () => setState(() {
              if (_collapsed.contains(g.harnessId)) {
                _collapsed.remove(g.harnessId);
              } else {
                _collapsed.add(g.harnessId);
              }
            }),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 12, 6),
              child: Row(
                children: [
                  Icon(g.collapsed ? Icons.expand_more : Icons.expand_less,
                      size: 20, color: Colors.grey[500]),
                  const SizedBox(width: 4),
                  Expanded(
                      child: Text(g.label,
                          style: const TextStyle(
                              fontWeight: FontWeight.w600, fontSize: 13.5))),
                  if (g.liveCount > 0)
                    Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: Text('${g.liveCount} 活跃',
                            style: const TextStyle(
                                fontSize: 11, color: Color(0xFF3FB950)))),
                  Text('${g.sessions.length}',
                      style:
                          TextStyle(fontSize: 11.5, color: Colors.grey[500])),
                ],
              ),
            ),
          );
        }
        final s = data as SessionInfo;
        final (color, label) = _pill(s);
        return ListTile(
          dense: true,
          visualDensity: VisualDensity.compact,
          leading: Container(
            width: 10,
            height: 10,
            margin: const EdgeInsets.only(left: 4, top: 6),
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          title: Row(
            children: [
              if (s.starred ?? false)
                const Padding(
                    padding: EdgeInsets.only(right: 4),
                    child:
                        Icon(Icons.star, size: 15, color: Color(0xFFF5B942))),
              Expanded(
                child: Text(
                  s.title?.isNotEmpty == true ? s.title! : '(无标题)',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              for (final t in s.tags.take(3))
                GestureDetector(
                  onTap: () {
                    _filter.text = t;
                    setState(() {});
                  },
                  child: Container(
                    margin: const EdgeInsets.only(left: 4),
                    padding:
                        const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                      border:
                          Border.all(color: Colors.grey.withValues(alpha: 0.4)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(t,
                        style:
                            TextStyle(fontSize: 9.5, color: Colors.grey[500])),
                  ),
                ),
            ],
          ),
          subtitle: Text(
              '$label · ${SessionsPage.timeAgo(s.lastActiveAt)} · ${s.cwd.split('/').last.isEmpty ? s.cwd : s.cwd.split('/').last}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12)),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) =>
                  ChatPage(client: widget.client, sessionId: s.id))),
          trailing: PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert, size: 20),
            onSelected: (v) {
              switch (v) {
                case 'star':
                  _toggleStar(s);
                  break;
                case 'tags':
                  _editTags(s);
                  break;
                case 'resume':
                  widget.client.send(msgResume(s.id));
                  break;
                case 'stop':
                  widget.client.send(msgClose(s.id));
                  break;
                case 'delete':
                  _confirmDelete(s);
                  break;
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'tags', child: Text('🏷 编辑标签')),
              PopupMenuItem(
                  value: 'star',
                  child: Text((s.starred ?? false) ? '取消收藏' : '收藏置顶')),
              if (!s.live && s.resumable)
                const PopupMenuItem(value: 'resume', child: Text('恢复会话')),
              if (s.live)
                const PopupMenuItem(value: 'stop', child: Text('停止进程')),
              const PopupMenuItem(
                  value: 'delete',
                  child:
                      Text('删除会话', style: TextStyle(color: Color(0xFFF85149)))),
            ],
          ),
        );
      },
    );
  }
}
