import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../core/client.dart';
import '../core/protocol.dart';

/// 聊天页：流式输出、Markdown、工具时间线、权限审批、打断、自动决策切换。
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

  SessionInfo? get _session => widget.client.sessions[widget.sessionId];

  @override
  void initState() {
    super.initState();
    _sub = widget.client.messages.listen(_onMsg);
    // 会话状态变化（运行中/空闲/待审批/收藏）要刷新 AppBar
    _sessSub = widget.client.sessionsChanged.listen((_) {
      if (mounted) setState(() {});
    });
    widget.client.send(msgTranscript(widget.sessionId));
    widget.client.send(msgList());
  }

  @override
  void dispose() {
    _sub?.cancel();
    _sessSub?.cancel();
    super.dispose();
  }

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
          _jumpBottom();
        }
        break;
      case 'error':
        if (sid == null || sid == widget.sessionId) {
          setState(() => _entries.add(Entry(kind: 'error', message: m['message'] as String? ?? '未知错误')));
          _jumpBottom();
        }
        break;
    }
  }

  Entry _entryFrom(Map<String, dynamic> j) => Entry(
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
      );

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
          final idx = id.isEmpty ? -1 : _entries.indexWhere((e) => e.kind == 'tool' && e.toolCallId == id);
          final entry = Entry(kind: 'tool', title: title, toolCallId: id.isEmpty ? null : id, status: (u['status'] ?? 'pending').toString());
          if (idx >= 0) {
            _entries[idx] = entry;
          } else {
            _entries.add(entry);
          }
          _jumpBottom();
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
    _jumpBottom();
  }

  void _jumpBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 120), curve: Curves.easeOut);
    });
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    final s = _session;
    if (s == null || !s.live) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('会话未在运行，点右上「恢复」')));
      return;
    }
    setState(() {
      _entries.add(Entry(kind: 'user', text: text));
      _waiting = true;
    });
    widget.client.send(msgPrompt(widget.sessionId, text));
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
              }
            },
            itemBuilder: (_) => [
              PopupMenuItem(value: 'star', child: Text((s?.starred ?? false) ? '★ 取消收藏' : '☆ 收藏置顶')),
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
            child: ListView.builder(
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
                return _bubble(_entries[i]);
              },
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              child: Row(
                children: [
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

  Widget _bubble(Entry e) {
    switch (e.kind) {
      case 'user':
        return Align(
          alignment: Alignment.centerRight,
          child: Container(
            margin: const EdgeInsets.only(bottom: 10, left: 48),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(color: const Color(0xFF1F2733), borderRadius: BorderRadius.circular(10)),
            child: Text(e.text ?? '', style: const TextStyle(fontSize: 14)),
          ),
        );
      case 'assistant':
        return Container(
          margin: const EdgeInsets.only(bottom: 12, right: 16),
          padding: const EdgeInsets.symmetric(horizontal: 4),
          alignment: Alignment.centerLeft,
          child: MarkdownBody(data: e.text ?? '', selectable: true),
        );
      case 'thought':
        return Container(
          margin: const EdgeInsets.only(bottom: 10, right: 16),
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(border: Border.all(color: Colors.grey.withValues(alpha: 0.25)), borderRadius: BorderRadius.circular(8)),
          child: Text('💭 ${e.text ?? ''}', style: TextStyle(fontSize: 12.5, color: Colors.grey[400])),
        );
      case 'tool':
        return Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            border: Border(left: BorderSide(color: const Color(0xFFD29922).withValues(alpha: 0.8), width: 3)),
            color: Colors.white.withValues(alpha: 0.03),
          ),
          child: Text('🔧 ${e.title ?? ''}  [${e.status ?? ''}]', style: TextStyle(fontSize: 12.5, color: Colors.grey[400])),
        );
      case 'permission':
        return Container(
          margin: const EdgeInsets.only(bottom: 10),
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
        );
      case 'error':
        return Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: const Color(0xFF190D0E),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFFF85149).withValues(alpha: 0.5)),
          ),
          child: Text('✕ ${e.message ?? ''}', style: const TextStyle(fontSize: 12.5, color: Color(0xFFF85149))),
        );
      default:
        return Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(e.text ?? '', style: TextStyle(fontSize: 11.5, color: Colors.grey[600])));
    }
  }
}
