import 'dart:async';

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../core/client.dart';
import '../core/protocol.dart';
import '../core/update.dart';
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
        s.harnessLabel.toLowerCase().contains(q);
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

  @override
  void initState() {
    super.initState();
    widget.client.sessionsChanged.listen((_) {
      if (mounted) setState(() {});
    });
    widget.client.send(msgList());
    // 启动静默检查一次应用更新（GitHub Release），有新版再弹窗
    Future.delayed(const Duration(seconds: 3), _silentUpdateCheck);
  }

  /* ---------- 应用自更新（GitHub Release → APK） ---------- */

  Future<void> _silentUpdateCheck() async {
    final r = await AppUpdate.check();
    if (!mounted || r.update == null) return;
    _offerUpdate(r.update!);
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
              _downloadAndInstall(u);
            },
            child: const Text('下载更新'),
          ),
        ],
      ),
    );
  }

  Future<void> _manualCheck() async {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('正在检查更新…'), duration: Duration(seconds: 1)));
    final r = await AppUpdate.check(manual: true);
    if (!mounted) return;
    if (r.update != null) {
      _offerUpdate(r.update!);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r.message ?? '已是最新')));
    }
  }

  Future<void> _downloadAndInstall(AppUpdate u) async {
    final progress = ValueNotifier<(int, int)>((0, 0));
    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => PopScope(
          canPop: false,
          child: AlertDialog(
            title: Text('正在下载 ${u.tag}'),
            content: ValueListenableBuilder<(int, int)>(
              valueListenable: progress,
              builder: (_, v, __) {
                final (done, total) = v;
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    LinearProgressIndicator(value: total > 0 ? done / total : null),
                    const SizedBox(height: 8),
                    Text(
                      total > 0
                          ? '${(done / 1048576).toStringAsFixed(1)} / ${(total / 1048576).toStringAsFixed(1)} MB'
                          : '连接中…',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
    try {
      final path = await AppUpdate.download(
        u,
        (done, total) => progress.value = (done, total),
        relayBaseUrl: widget.client.httpBase, // 服务器中转优先（手机直连 GitHub 慢），失败回退直链
      );
      progress.dispose();
      if (!mounted) return;
      Navigator.of(context).pop(); // 关进度框
      final msg = await AppUpdate.install(path);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg.isEmpty ? '已交给系统安装器' : '安装器：$msg')),
      );
    } catch (e) {
      progress.dispose();
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('下载失败：$e')));
    }
  }

  Future<void> _about() async {
    final info = await PackageInfo.fromPlatform();
    if (!mounted) return;
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const ListTile(leading: Icon(Icons.bolt), title: Text('HarnessGate'), subtitle: Text('远程驱动服务器上的编码 agent')),
            ListTile(
              leading: const Icon(Icons.phone_android, size: 20),
              title: const Text('APP 版本'),
              subtitle: Text('v${info.version}'),
            ),
            ListTile(
              leading: const Icon(Icons.dns, size: 20),
              title: const Text('服务器版本'),
              subtitle: Text(widget.client.serverVersion.isEmpty ? '（未连接）' : 'v${widget.client.serverVersion} · ${widget.client.serverCommit}'),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: FilledButton.tonalIcon(
                icon: const Icon(Icons.system_update, size: 18),
                label: const Text('检查更新'),
                onPressed: () {
                  Navigator.pop(ctx);
                  _manualCheck();
                },
              ),
            ),
          ],
        ),
      ),
    );
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
    return Scaffold(
      appBar: AppBar(
        title: const Text('会话'),
        actions: [
          IconButton(
            tooltip: '关于与更新',
            icon: const Icon(Icons.info_outline, size: 20),
            onPressed: _about,
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
                    : IconButton(icon: const Icon(Icons.close, size: 16), onPressed: () { _filter.clear(); setState(() {}); }),
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
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

  Widget _buildGroupedList() {
    final all = widget.client.sessions.values.toList();
    final groups = SessionsPage.groupSessions(all, filter: _filter.text, collapsed: _collapsed);
    if (groups.isEmpty) {
      return ListView(children: [
        const SizedBox(height: 140),
        Center(child: Text(all.isEmpty ? '还没有会话\n点右下「新建会话」，或在网页端创建后下拉刷新' : '没有匹配的会话', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey[500]))),
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
      itemCount: items.length,
      itemBuilder: (_, i) {
        final (type, data) = items[i];
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
                  Icon(g.collapsed ? Icons.expand_more : Icons.expand_less, size: 20, color: Colors.grey[500]),
                  const SizedBox(width: 4),
                  Expanded(child: Text(g.label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5))),
                  if (g.liveCount > 0)
                    Padding(padding: const EdgeInsets.only(right: 6), child: Text('${g.liveCount} 活跃', style: const TextStyle(fontSize: 11, color: Color(0xFF3FB950)))),
                  Text('${g.sessions.length}', style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
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
          subtitle: Text('$label · ${SessionsPage.timeAgo(s.lastActiveAt)} · ${s.cwd.split('/').last.isEmpty ? s.cwd : s.cwd.split('/').last}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
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
    );
  }
}
