import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/client.dart';
import '../core/protocol.dart';

/// 聊天页：流式输出、Markdown、工具时间线（含入参/输出详情）、思考折叠、权限审批、
/// 打断、自动决策切换、附件发送、模型/模式下拉、对话内搜索与定位、我的发言索引、
/// 决策记录/改动文件面板、接续到新会话、回到底部。
class ChatPage extends StatefulWidget {
  final GateClient client;
  final String sessionId;
  const ChatPage({super.key, required this.client, required this.sessionId});

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _entries = <Entry>[];
  final _input = TextEditingController();
  final _scroll = ScrollController();
  StreamSubscription? _sub;
  StreamSubscription? _sessSub;
  bool _waiting = false;
  bool _streaming = false;
  int? _highlightIndex; // 搜索/我的发言定位后的高亮条目
  Timer? _highlightTimer;

  /// 待发送附件（选好的图片，base64）
  final _pendingAtt = <({String name, String mimeType, String base64})>[];

  /// session-detail 数据（决策记录/改动文件面板共用，ValueNotifier 驱动 sheet 刷新）
  final _detail = ValueNotifier<Map<String, dynamic>?>(null);

  SessionInfo? get _session => widget.client.sessions[widget.sessionId];

  @override
  void initState() {
    super.initState();
    _sub = widget.client.messages.listen(_onMsg);
    // 会话状态变化（运行中/空闲/待审批/收藏/配置）要刷新 AppBar 与配置项
    _sessSub = widget.client.sessionsChanged.listen((_) {
      if (mounted) setState(() {});
    });
    _scroll.addListener(() {
      if (mounted) setState(() {}); // 只为刷新「回到底部」按钮可见性
    });
    widget.client.send(msgTranscript(widget.sessionId));
    widget.client.send(msgList());
  }

  @override
  void dispose() {
    _sub?.cancel();
    _sessSub?.cancel();
    _highlightTimer?.cancel();
    _detail.dispose();
    super.dispose();
  }

  /* ---------- 滚动：智能跟随 + 回到底部 ---------- */

  /// 贴底判定：用于流式输出时自动跟随——用户上翻历史时不打扰
  bool get _nearBottom =>
      !_scroll.hasClients || (_scroll.position.maxScrollExtent - _scroll.position.pixels) < 220;
  bool get _showBackToBottom =>
      _scroll.hasClients && (_scroll.position.maxScrollExtent - _scroll.position.pixels) > 400;

  void _jumpBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 150), curve: Curves.easeOut);
      }
    });
  }

  /// 新内容到达：贴底才跟随；翻历史时只刷新不抢滚动
  void _autoFollow() {
    if (_nearBottom) _jumpBottom();
  }

  /// 近似定位到第 index 条（惰性列表无精确锚点，按比例滚动；命中条目高亮 2.5s）
  void _jumpToIndex(int index) {
    setState(() => _highlightIndex = index);
    _highlightTimer?.cancel();
    _highlightTimer = Timer(const Duration(milliseconds: 2500), () {
      if (mounted) setState(() => _highlightIndex = null);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final target = _scroll.position.maxScrollExtent * (index / _entries.length.clamp(1, 1 << 30));
      _scroll.animateTo(target.clamp(0.0, _scroll.position.maxScrollExtent),
          duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
    });
  }

  /* ---------- 消息处理 ---------- */

  void _onMsg(Map<String, dynamic> m) {
    final sid = m['sessionId'] as String?;
    switch (m['type']) {
      case 'transcript':
        if (sid == widget.sessionId && m['entries'] is List) {
          setState(() {
            _entries
              ..clear()
              ..addAll((m['entries'] as List).whereType<Map<String, dynamic>>().map(_entryFrom));
          });
          _jumpBottom();
        }
        break;
      case 'update':
        if (sid == widget.sessionId) _applyUpdate(m['update'] as Map<String, dynamic>? ?? {});
        break;
      case 'turn_end':
        if (sid == widget.sessionId) setState(() { _waiting = false; _streaming = false; });
        break;
      case 'permission':
        if (sid == widget.sessionId) {
          setState(() => _entries.add(Entry(
            kind: 'permission',
            title: m['title'] as String? ?? '工具调用',
            requestId: m['requestId'] as String?,
            options: ((m['options'] as List<dynamic>?) ?? [])
                .map((o) => (optionId: o['optionId'] as String, name: o['name'] as String))
                .toList(),
          )));
          _autoFollow();
        }
        break;
      case 'error':
        if (sid == null || sid == widget.sessionId) {
          setState(() => _entries.add(Entry(kind: 'error', message: m['message'] as String? ?? '未知错误')));
          _autoFollow();
        }
        break;
      case 'handoff_done':
        // 接续完成：跳转到新会话（替换当前页，返回键回到列表）
        if (m['from'] == widget.sessionId && m['to'] is String) {
          final to = m['to'] as String;
          Navigator.of(context).pushReplacement(
            MaterialPageRoute(builder: (_) => ChatPage(client: widget.client, sessionId: to)),
          );
        }
        break;
      case 'session-detail':
        if (sid == widget.sessionId) _detail.value = m;
        break;
    }
  }

  Entry _entryFrom(Map<String, dynamic> j) {
    final atts = (j['attachments'] as List<dynamic>?)?.whereType<Map<String, dynamic>>().toList();
    return Entry(
      kind: j['kind'] as String? ?? 'log',
      text: j['text'] as String?,
      title: j['title'] as String?,
      status: j['status'] as String?,
      toolCallId: j['toolCallId'] as String?,
      message: j['message'] as String?,
      answered: j['answered'] as String?,
      requestId: j['requestId'] as String?,
      options: (j['options'] as List<dynamic>?)
          ?.map((o) => (optionId: o['optionId'] as String, name: o['name'] as String))
          .toList(),
      detail: (j['detail'] as String?)?.isEmpty == true ? null : j['detail'] as String?,
      output: (j['output'] as String?)?.isEmpty == true ? null : j['output'] as String?,
      attachmentName: atts == null || atts.isEmpty ? null : atts.first['name'] as String?,
    );
  }

  /// ACP content 形态摊平成文本（与 server textOf 同语义）
  static String _textOf(dynamic v) {
    if (v == null) return '';
    if (v is String) return v;
    if (v is List) return v.map(_textOf).where((s) => s.isNotEmpty).join('\n');
    if (v is Map) {
      final text = v['text'];
      if (text is String) return text;
      if (v.containsKey('content')) return _textOf(v['content']);
      try { return jsonEncode(v); } catch (_) { return ''; }
    }
    return v.toString();
  }

  void _applyUpdate(Map<String, dynamic> u) {
    final kind = u['sessionUpdate'] as String? ?? '';
    final content = u['content'] as Map<String, dynamic>?;
    setState(() {
      switch (kind) {
        case 'agent_message_chunk':
          if (content?['type'] == 'text' && content?['text'] is String) {
            _appendStream('assistant', content!['text'] as String);
            _waiting = false;
          }
          break;
        case 'agent_thought_chunk':
          if (content?['type'] == 'text' && content?['text'] is String) {
            _appendStream('thought', content!['text'] as String);
          }
          break;
        case 'tool_call':
        case 'tool_call_update':
          _streaming = false;
          final id = (u['toolCallId'] ?? u['id'] ?? '').toString();
          final title = (u['title'] ?? u['name'] ?? u['toolName'] ?? '工具').toString();
          final detail = _textOf(u['rawInput'] ?? u['input']);
          final output = _textOf(u['rawOutput'] ?? u['output']);
          final idx = id.isEmpty ? -1 : _entries.indexWhere((e) => e.kind == 'tool' && e.toolCallId == id);
          final entry = Entry(
            kind: 'tool',
            title: title,
            toolCallId: id.isEmpty ? null : id,
            status: (u['status'] ?? 'pending').toString(),
            detail: detail.isEmpty || detail == '{}' ? null : (detail.length > 2000 ? '${detail.substring(0, 2000)}…' : detail),
            output: output.isEmpty ? null : (output.length > 2000 ? '${output.substring(0, 2000)}…' : output),
          );
          if (idx >= 0) {
            final old = _entries[idx];
            _entries[idx] = entry.copyWith(
              detail: entry.detail ?? old.detail, // update 阶段往往只有输出，保留入参
              title: title == '工具' ? old.title : null,
            );
          } else {
            _entries.add(entry);
          }
          _autoFollow();
          break;
        case 'hg_error':
          _entries.add(Entry(kind: 'error', message: u['message'] as String? ?? ''));
          break;
      }
    });
  }

  /// 流式追加：同 kind 的最后一条未收尾则续写
  void _appendStream(String kind, String text) {
    final last = _entries.isEmpty ? null : _entries.last;
    if (last != null && last.kind == kind && _streaming && last.text != null) {
      _entries[_entries.length - 1] = Entry(kind: kind, text: last.text! + text);
    } else {
      _streaming = true;
      _entries.add(Entry(kind: kind, text: text));
    }
    _autoFollow();
  }

  /* ---------- 发送（含附件） ---------- */

  Future<void> _pickImage() async {
    final p = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 70);
    if (p == null) return;
    final bytes = await p.readAsBytes();
    final mime = p.mimeType ?? 'image/png';
    setState(() => _pendingAtt.add((name: p.name.isEmpty ? '图片' : p.name, mimeType: mime, base64: base64Encode(bytes))));
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty && _pendingAtt.isEmpty) return;
    final s = _session;
    if (s == null || !s.live) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('会话未在运行，点右上「恢复」')));
      return;
    }
    widget.client.send(msgPromptWithAttachments(
      widget.sessionId,
      text,
      attachments: _pendingAtt.toList(),
    ));
    setState(() {
      _entries.add(Entry(
        kind: 'user',
        text: text.isEmpty ? '（图片）' : text,
        attachmentName: _pendingAtt.isEmpty ? null : _pendingAtt.first.name,
      ));
      _waiting = true;
      _pendingAtt.clear();
    });
    _input.clear();
    _jumpBottom();
  }

  void _approve(String requestId, String optionId) {
    widget.client.send(msgPermission(widget.sessionId, requestId, optionId));
    setState(() {
      final i = _entries.lastIndexWhere((e) => e.kind == 'permission' && e.requestId == requestId);
      if (i >= 0) _entries[i] = Entry(kind: 'permission', title: _entries[i].title, answered: '已发送');
    });
  }

  void _changeAutoApprove(String? level) {
    if (level != null) widget.client.send(msgSetAutoApprove(widget.sessionId, level));
  }

  void _toggleStar() {
    final s = _session;
    if (s == null) return;
    final v = !(s.starred ?? false);
    widget.client.send(msgStar(s.id, v));
    widget.client.sessions[s.id] = s.copyWith(starred: v);
    setState(() {});
  }

  /* ---------- 搜索 / 我的发言 ---------- */

  void _openSearch() {
    final q = TextEditingController();
    int pos = -1;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: StatefulBuilder(
          builder: (_, setSheet) {
            final hits = <int>[
              for (var i = 0; i < _entries.length; i++)
                if (q.text.trim().isNotEmpty &&
                    ((_entries[i].text ?? '') + (_entries[i].title ?? '') + (_entries[i].message ?? ''))
                        .toLowerCase()
                        .contains(q.text.trim().toLowerCase()))
                  i,
            ];
            void go(int delta) {
              if (hits.isEmpty) return;
              setSheet(() => pos = (pos < 0 ? 0 : (pos + delta + hits.length) % hits.length));
              _jumpToIndex(hits[pos]);
            }

            return SafeArea(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
                    child: Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: q,
                            autofocus: true,
                            decoration: const InputDecoration(hintText: '搜索对话内容…', isDense: true, border: OutlineInputBorder()),
                            onChanged: (_) => setSheet(() => pos = -1),
                          ),
                        ),
                        IconButton(onPressed: () => go(-1), icon: const Icon(Icons.keyboard_arrow_up)),
                        IconButton(onPressed: () => go(1), icon: const Icon(Icons.keyboard_arrow_down)),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Text(
                      hits.isEmpty ? '（无命中）' : '命中 ${hits.length} 条${pos >= 0 ? ' · 第 ${pos + 1} 条' : ''}',
                      style: TextStyle(fontSize: 12, color: Colors.grey[500]),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  void _openMyMessages() {
    final mine = <int>[for (var i = 0; i < _entries.length; i++) if (_entries[i].kind == 'user') i];
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(padding: const EdgeInsets.all(10), child: Text('我的发言（${mine.length}）', style: const TextStyle(fontWeight: FontWeight.w600))),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: mine.length,
                itemBuilder: (_, k) {
                  final i = mine[k];
                  final t = (_entries[i].text ?? '').replaceAll('\n', ' ');
                  return ListTile(
                    dense: true,
                    leading: Text('${k + 1}', style: TextStyle(fontSize: 11, color: Colors.grey[500])),
                    title: Text(t.isEmpty ? '（附件）' : (t.length > 60 ? '${t.substring(0, 60)}…' : t), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                    onTap: () {
                      Navigator.pop(ctx);
                      _jumpToIndex(i);
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /* ---------- 模型/模式配置 ---------- */

  void _openConfig() {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) {
        final s = _session;
        if (s == null) return const Center(child: Text('会话不存在'));
        // 排除 mode 类配置（与 web 一致：有 modes 时 mode 类 config 不重复显示）
        final hasModes = (s.modes?.availableModeIds ?? []).isNotEmpty;
        final opts = s.configOptions.where((o) => o.options.isNotEmpty && !(hasModes && (o.name ?? '').toLowerCase().contains('mode'))).toList();
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(padding: EdgeInsets.all(10), child: Text('模型与配置（对后续回合生效）', style: TextStyle(fontWeight: FontWeight.w600))),
              if (opts.isEmpty && !hasModes)
                Padding(padding: const EdgeInsets.all(10), child: Text('这个 harness 没有上报可切换配置', style: TextStyle(color: Colors.grey[500]))),
              for (final o in opts)
                ListTile(
                  dense: true,
                  title: Text(o.name ?? o.id, style: const TextStyle(fontSize: 13.5)),
                  subtitle: DropdownButton<String>(
                    isDense: true,
                    value: o.options.any((v) => v.value == o.currentValue) ? o.currentValue : null,
                    hint: const Text('选择', style: TextStyle(fontSize: 12)),
                    items: [for (final v in o.options) DropdownMenuItem(value: v.value, child: Text(v.name ?? v.value, style: const TextStyle(fontSize: 12.5)))],
                    onChanged: (v) {
                      if (v == null) return;
                      widget.client.send(msgConfig(widget.sessionId, o.id, v));
                      Navigator.pop(ctx);
                      ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('${o.name ?? o.id} → $v')));
                    },
                  ),
                ),
              if (hasModes)
                ListTile(
                  dense: true,
                  title: const Text('权限模式', style: TextStyle(fontSize: 13.5)),
                  subtitle: DropdownButton<String>(
                    isDense: true,
                    value: s.modes!.currentModeId,
                    items: [for (final id in s.modes!.availableModeIds) DropdownMenuItem(value: id, child: Text(id, style: const TextStyle(fontSize: 12.5)))],
                    onChanged: (v) {
                      if (v == null) return;
                      widget.client.send(msgMode(widget.sessionId, v));
                      Navigator.pop(ctx);
                      ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('模式 → $v')));
                    },
                  ),
                ),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
  }

  /* ---------- 决策记录 / 改动文件 ---------- */

  void _openDetail({required bool decisions}) {
    _detail.value = null;
    widget.client.send(msgSessionDetail(widget.sessionId));
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => FractionallySizedBox(
        heightFactor: 0.75,
        child: ValueListenableBuilder<Map<String, dynamic>?>(
          valueListenable: _detail,
          builder: (_, v, __) {
            if (v == null) {
              return const Center(child: Column(mainAxisSize: MainAxisSize.min, children: [CircularProgressIndicator(), SizedBox(height: 10), Text('加载中…')]));
            }
            if (decisions) {
              final list = (v['decisions'] as List<dynamic>? ?? []).whereType<Map<String, dynamic>>().toList();
              return Column(
                children: [
                  Padding(padding: const EdgeInsets.all(10), child: Text('决策记录（${list.length}）', style: const TextStyle(fontWeight: FontWeight.w600))),
                  Expanded(
                    child: list.isEmpty
                        ? Center(child: Text('还没有权限决策记录', style: TextStyle(color: Colors.grey[500])))
                        : ListView.builder(
                            itemCount: list.length,
                            itemBuilder: (_, i) {
                              final d = list[i];
                              final chosen = d['held'] == true ? '⚠ 拦截（等人工）' : (d['chosen'] as String? ?? '（等待审批）');
                              return ListTile(
                                dense: true,
                                title: Text('${d['danger'] == true ? '⚠️ ' : ''}${d['title'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                                subtitle: Text(
                                  '$chosen · ${d['auto'] == true ? '自动' : '人工'}${d['reason'] != null ? ' · ${d['reason']}' : ''}',
                                  style: const TextStyle(fontSize: 11.5),
                                  maxLines: 2, overflow: TextOverflow.ellipsis,
                                ),
                                trailing: Text(_shortTs(d['ts'] as String?), style: TextStyle(fontSize: 10.5, color: Colors.grey[500])),
                              );
                            },
                          ),
                  ),
                ],
              );
            }
            final list = (v['changes'] as List<dynamic>? ?? []).whereType<Map<String, dynamic>>().toList();
            return Column(
              children: [
                Padding(padding: const EdgeInsets.all(10), child: Text('改动文件（${list.length}${v['git'] == true ? ' · git' : ' · 台账'}）', style: const TextStyle(fontWeight: FontWeight.w600))),
                Expanded(
                  child: list.isEmpty
                      ? Center(child: Text('本会话没有改动记录', style: TextStyle(color: Colors.grey[500])))
                      : ListView.builder(
                          itemCount: list.length,
                          itemBuilder: (_, i) {
                            final f = list[i];
                            final size = (f['size'] as num?)?.toInt() ?? 0;
                            return ListTile(
                              dense: true,
                              leading: const Icon(Icons.description_outlined, size: 18),
                              title: Text(f['path'] as String? ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                              subtitle: Text(size > 1048576 ? '${(size / 1048576).toStringAsFixed(1)}MB' : '${(size / 1024).round()}KB', style: const TextStyle(fontSize: 11)),
                              trailing: IconButton(
                                icon: const Icon(Icons.download, size: 18),
                                tooltip: '下载',
                                onPressed: () => _download(f['path'] as String? ?? ''),
                              ),
                            );
                          },
                        ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  static String _shortTs(String? iso) {
    final t = DateTime.tryParse(iso ?? '');
    return t == null ? '' : '${t.month}/${t.day} ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  }

  Future<void> _download(String path) async {
    if (path.isEmpty) return;
    final url = Uri.parse(widget.client.downloadUrl(widget.sessionId, path));
    try {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('打开下载失败：$e')));
    }
  }

  /* ---------- 会话操作 ---------- */

  Future<void> _confirmDelete() async {
    final s = _session;
    if (s == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除会话'),
        content: Text('删除「${s.title?.isNotEmpty == true ? s.title : s.id}」？该操作不可撤销。'),
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
    if (ok == true) {
      widget.client.send(msgDelete(widget.sessionId));
      if (mounted) Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _session;
    final inTurn = s?.inTurn == true;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s?.title?.isNotEmpty == true ? s!.title! : '会话', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16)),
            Text('${s?.harnessLabel ?? ''} · ${s?.cwd ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w400)),
          ],
        ),
        actions: [
          IconButton(
            tooltip: '搜索对话内容',
            icon: const Icon(Icons.search, size: 20),
            onPressed: _openSearch,
          ),
          if (inTurn)
            IconButton(
              tooltip: '打断当前回合',
              icon: const Icon(Icons.stop_circle_outlined, color: Color(0xFFF85149)),
              onPressed: () => widget.client.send(msgInterrupt(widget.sessionId)),
            )
          else if (s != null && !s.live && s.resumable)
            IconButton(
              tooltip: '恢复会话',
              icon: const Icon(Icons.play_circle_outline, color: Color(0xFF3FB950)),
              onPressed: () => widget.client.send(msgResume(widget.sessionId)),
            ),
          PopupMenuButton<String>(
            onSelected: _changeAutoApprove,
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'off', child: Text('自动决策：人工审批')),
              PopupMenuItem(value: 'readonly', child: Text('自动决策：只读自动')),
              PopupMenuItem(value: 'all', child: Text('自动决策：全自动')),
            ],
            icon: Icon(Icons.shield_outlined, color: s?.autoApprove == 'all' ? const Color(0xFF3FB950) : null),
          ),
          PopupMenuButton<String>(
            onSelected: (v) {
              switch (v) {
                case 'star': _toggleStar(); break;
                case 'stop': widget.client.send(msgClose(widget.sessionId)); break;
                case 'resume': widget.client.send(msgResume(widget.sessionId)); break;
                case 'delete': _confirmDelete(); break;
                case 'config': _openConfig(); break;
                case 'search': _openSearch(); break;
                case 'mine': _openMyMessages(); break;
                case 'decisions': _openDetail(decisions: true); break;
                case 'changes': _openDetail(decisions: false); break;
                case 'handoff':
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('正在把历史复制到新会话…')));
                  widget.client.send(msgHandoff(widget.sessionId));
                  break;
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'config', child: Text('模型与配置')),
              const PopupMenuItem(value: 'search', child: Text('搜索对话')),
              const PopupMenuItem(value: 'mine', child: Text('我的发言')),
              const PopupMenuItem(value: 'decisions', child: Text('🧾 决策记录')),
              const PopupMenuItem(value: 'changes', child: Text('📄 改动文件')),
              PopupMenuItem(value: 'star', child: Text((s?.starred ?? false) ? '★ 取消收藏' : '☆ 收藏置顶')),
              const PopupMenuItem(value: 'handoff', child: Text('➡️ 接续到新会话')),
              if (s?.live == true) const PopupMenuItem(value: 'stop', child: Text('停止进程')),
              if (s != null && !s.live && s.resumable) const PopupMenuItem(value: 'resume', child: Text('恢复会话')),
              const PopupMenuItem(value: 'delete', child: Text('删除会话', style: TextStyle(color: Color(0xFFF85149)))),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: Stack(
              children: [
                ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  itemCount: _entries.length + (_waiting ? 1 : 0),
                  itemBuilder: (_, i) {
                    if (i >= _entries.length) {
                      return const Padding(
                        padding: EdgeInsets.all(10),
                        child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
                      );
                    }
                    return _bubble(_entries[i], i);
                  },
                ),
                if (_showBackToBottom)
                  Positioned(
                    right: 12,
                    bottom: 12,
                    child: FloatingActionButton.small(
                      heroTag: 'toBottom',
                      tooltip: '回到底部（最新消息）',
                      onPressed: _jumpBottom,
                      child: const Icon(Icons.arrow_downward, size: 18),
                    ),
                  ),
              ],
            ),
          ),
          if (_pendingAtt.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 2, 12, 0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Wrap(
                  spacing: 6,
                  children: [
                    for (final a in _pendingAtt)
                      InputChip(
                        label: Text('🖼 ${a.name}', style: const TextStyle(fontSize: 12)),
                        onDeleted: () => setState(() => _pendingAtt.remove(a)),
                      ),
                  ],
                ),
              ),
            ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              child: Row(
                children: [
                  IconButton(
                    tooltip: '添加图片附件',
                    icon: const Icon(Icons.attach_file, size: 20),
                    onPressed: _pickImage,
                  ),
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      onSubmitted: (_) => _send(),
                      decoration: InputDecoration(
                        hintText: s?.live == true ? '说点什么…' : '会话未运行（右上可恢复）',
                        isDense: true,
                        border: const OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _send,
                    icon: const Icon(Icons.send, size: 20),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _bubble(Entry e, int index) {
    final highlighted = _highlightIndex == index;
    Widget wrap(Widget child, {EdgeInsetsGeometry margin = const EdgeInsets.only(bottom: 10)}) => Container(
          margin: margin,
          decoration: highlighted
              ? BoxDecoration(
                  color: const Color(0xFFF5B942).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFFF5B942).withValues(alpha: 0.6)),
                )
              : null,
          child: child,
        );
    switch (e.kind) {
      case 'user':
        return wrap(
          Align(
            alignment: Alignment.centerRight,
            child: Container(
              margin: const EdgeInsets.only(left: 48),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(color: const Color(0xFF1F2733), borderRadius: BorderRadius.circular(10)),
              child: Text(e.text ?? '', style: const TextStyle(fontSize: 14)),
            ),
          ),
        );
      case 'assistant':
        return wrap(
          Container(
            margin: const EdgeInsets.only(right: 16),
            padding: const EdgeInsets.symmetric(horizontal: 4),
            alignment: Alignment.centerLeft,
            child: MarkdownBody(data: e.text ?? '', selectable: true),
          ),
          margin: const EdgeInsets.only(bottom: 12, right: 16),
        );
      case 'thought':
        return wrap(
          Theme(
            data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              dense: true,
              initiallyExpanded: false,
              title: Text('💭 思考过程', style: TextStyle(fontSize: 12, color: Colors.grey[400])),
              children: [
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(e.text ?? '', style: TextStyle(fontSize: 12, color: Colors.grey[400])),
                ),
              ],
            ),
          ),
        );
      case 'tool':
        final hasDetail = (e.detail?.isNotEmpty ?? false) || (e.output?.isNotEmpty ?? false);
        return wrap(
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: const Color(0xFFD29922).withValues(alpha: 0.8), width: 3)),
              color: Colors.white.withValues(alpha: 0.03),
            ),
            child: hasDetail
                ? Theme(
                    data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                    child: ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      dense: true,
                      title: Text('🔧 ${e.title ?? ''}  [${e.status ?? ''}]',
                          style: TextStyle(fontSize: 12.5, color: Colors.grey[400])),
                      children: [
                        if (e.detail?.isNotEmpty ?? false)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Align(alignment: Alignment.centerLeft, child: Text('入参', style: TextStyle(fontSize: 10.5, color: Colors.grey[600]))),
                          ),
                        if (e.detail?.isNotEmpty ?? false)
                          Container(
                            constraints: const BoxConstraints(maxHeight: 220),
                            width: double.infinity,
                            child: SingleChildScrollView(child: SelectableText(e.detail ?? '', style: TextStyle(fontSize: 11, color: Colors.grey[500]))),
                          ),
                        if (e.output?.isNotEmpty ?? false)
                          Padding(
                            padding: const EdgeInsets.only(top: 4, bottom: 4),
                            child: Align(alignment: Alignment.centerLeft, child: Text('输出', style: TextStyle(fontSize: 10.5, color: Colors.grey[600]))),
                          ),
                        if (e.output?.isNotEmpty ?? false)
                          Container(
                            constraints: const BoxConstraints(maxHeight: 300),
                            width: double.infinity,
                            child: SingleChildScrollView(child: SelectableText(e.output ?? '', style: TextStyle(fontSize: 11, color: Colors.grey[500]))),
                          ),
                      ],
                    ),
                  )
                : Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text('🔧 ${e.title ?? ''}  [${e.status ?? ''}]', style: TextStyle(fontSize: 12.5, color: Colors.grey[400])),
                  ),
          ),
          margin: const EdgeInsets.only(bottom: 8),
        );
      case 'permission':
        return wrap(
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              border: Border.all(color: const Color(0xFFD29922)),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('🔐 需要授权：${e.title ?? ''}', style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                if (e.answered == null && (e.options?.isNotEmpty ?? false)) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    children: (e.options!).map((o) => FilledButton.tonal(
                      onPressed: e.requestId != null ? () => _approve(e.requestId!, o.optionId) : null,
                      child: Text(o.name, style: const TextStyle(fontSize: 12.5)),
                    )).toList(),
                  ),
                ] else
                  Padding(padding: const EdgeInsets.only(top: 6), child: Text('已处理', style: TextStyle(fontSize: 12, color: Colors.grey[500]))),
              ],
            ),
          ),
        );
      case 'error':
        return wrap(
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: const Color(0xFF190D0E),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFF85149).withValues(alpha: 0.5)),
            ),
            child: Text('✕ ${e.message ?? ''}', style: const TextStyle(fontSize: 12.5, color: Color(0xFFF85149))),
          ),
        );
      default:
        return wrap(Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(e.text ?? '', style: TextStyle(fontSize: 11.5, color: Colors.grey[600]))));
    }
  }
}
