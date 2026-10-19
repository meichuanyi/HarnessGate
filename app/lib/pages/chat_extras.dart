import 'dart:async';

import 'package:flutter/material.dart';
import '../core/client.dart';

/// 📚 全量归档检索：台账窗口（800 条）之外的完整历史也能查。
/// 服务端按关键词过滤 JSONL 归档，返回格式化行。
class ArchiveDialog extends StatefulWidget {
  final GateClient client;
  final String sessionId;
  const ArchiveDialog({super.key, required this.client, required this.sessionId});

  @override
  State<ArchiveDialog> createState() => _ArchiveDialogState();
}

class _ArchiveDialogState extends State<ArchiveDialog> {
  final _q = TextEditingController();
  final _lines = <String>[];
  int _total = 0;
  String _status = '输入关键词查询（空 = 最近 400 条）';
  StreamSubscription<Map<String, dynamic>>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = widget.client.messages.listen((m) {
      if (m['type'] != 'archive-content' || m['sessionId'] != widget.sessionId) return;
      if (!mounted) return;
      _total = (m['total'] as num?)?.toInt() ?? 0;
      _lines
        ..clear()
        ..addAll(((m['lines'] as List<dynamic>?) ?? []).map((e) => e.toString()));
      setState(() => _status = '共 $_total 条命中');
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _q.dispose();
    super.dispose();
  }

  void _query() {
    final q = _q.text.trim();
    setState(() => _status = '查询中…');
    widget.client.send({'type': 'archive', 'sessionId': widget.sessionId, 'q': q});
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('📚 全量归档检索'),
      content: SizedBox(
        width: double.maxFinite,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _q,
                  onSubmitted: (_) => _query(),
                  decoration: const InputDecoration(hintText: '关键词（空 = 最近 400 条）', isDense: true),
                ),
              ),
              const SizedBox(width: 6),
              TextButton(onPressed: _query, child: const Text('查询')),
            ]),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: Text(_status, style: const TextStyle(fontSize: 11, color: Colors.grey)),
            ),
            const SizedBox(height: 6),
            Flexible(
              child: SizedBox(
                width: double.maxFinite,
                child: SingleChildScrollView(
                  child: SelectableText(
                    _lines.isEmpty && _status.startsWith('共 0') ? '（无匹配）' : _lines.join('\n'),
                    style: const TextStyle(fontSize: 11, fontFamily: 'monospace'),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
    );
  }
}

/// ❓ 侧问：会话跑着时临时问别的——fork 当前上下文到临时分身回答，
/// 不打断、不排队、不污染主会话台账。答完 10 分钟后分身自动销毁。
class SideQuestionSheet extends StatefulWidget {
  final GateClient client;
  final String srcId;
  const SideQuestionSheet({super.key, required this.client, required this.srcId});

  @override
  State<SideQuestionSheet> createState() => _SideQuestionSheetState();
}

class _SideQuestionSheetState extends State<SideQuestionSheet> {
  String? _sideId;
  String _status = '分身启动中（fork 当前上下文）… 主会话毫无感知';
  final _items = <(String, String)>[]; // (role, text)  role: q / a
  final _input = TextEditingController();
  final _scroll = ScrollController();
  StreamSubscription<Map<String, dynamic>>? _sub;
  Timer? _refresh;
  int _reqSeq = 0;

  @override
  void initState() {
    super.initState();
    _sub = widget.client.messages.listen((m) {
      if (!mounted) return;
      if (m['type'] == 'side-created') {
        _sideId = m['sessionId'] as String;
        _status = '分身就绪（上下文已继承）';
        _scheduleRefresh();
        if (mounted) setState(() {});
        return;
      }
      if (m['type'] == 'transcript' && m['sessionId'] == _sideId) {
        final entries = (m['entries'] as List<dynamic>? ?? []);
        _items
          ..clear()
          ..addAll(entries.whereType<Map<String, dynamic>>().map((e) {
            final kind = e['kind'] as String? ?? '';
            return (kind == 'user' ? 'q' : 'a', (e['text'] ?? '').toString());
          }).where((x) => x.$2.isNotEmpty));
        _status = '分身在线';
        if (mounted) setState(() {});
        _scrollToEnd();
        return;
      }
      if (m['type'] == 'update' && m['sessionId'] == _sideId) {
        _scheduleRefresh();
      }
    });
    _scheduleRefresh();
  }

  void _scheduleRefresh() {
    _refresh?.cancel();
    _refresh = Timer(const Duration(milliseconds: 800), () {
      if (_sideId != null) {
        final seq = ++_reqSeq;
        widget.client.send({'type': 'transcript', 'sessionId': _sideId, 'limit': 40, 'reqId': 'side-$seq'});
      }
    });
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    _input.clear();
    setState(() => _items.add(('q', text)));
    _scrollToEnd();
    if (_sideId == null) {
      widget.client.send({'type': 'side-question', 'sessionId': widget.srcId, 'text': text});
    } else {
      widget.client.send({'type': 'prompt', 'sessionId': _sideId, 'text': text});
      _scheduleRefresh();
    }
  }

  void _deliverToMain() {
    final lastA = _items.lastWhere((x) => x.$1 == 'a', orElse: () => ('a', ''));
    if (lastA.$2.isEmpty) return;
    widget.client.send({
      'type': 'prompt',
      'sessionId': widget.srcId,
      'text': '（来自侧问，请纳入考虑）\n${lastA.$2.length > 800 ? lastA.$2.substring(0, 800) : lastA.$2}',
    });
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已投递到主会话')));
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    _refresh?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.82),
        decoration: const BoxDecoration(
          color: Color(0xFF0B0D12),
          borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 8, 6),
              child: Row(children: [
                const Text('❓ 侧问', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(_status,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: Colors.grey)),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: _deliverToMain,
                  tooltip: '把最近的侧问回答投递给主会话',
                  icon: const Icon(Icons.move_down_outlined, size: 20),
                ),
              ]),
            ),
            const Divider(height: 1),
            Expanded(
              child: _items.isEmpty
                  ? Center(
                      child: Text(_status, textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, color: Colors.grey)))
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      itemCount: _items.length,
                      itemBuilder: (_, i) {
                        final (role, text) = _items[i];
                        return role == 'q'
                            ? Align(
                                alignment: Alignment.centerRight,
                                child: Container(
                                  margin: const EdgeInsets.symmetric(vertical: 3),
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                  decoration: BoxDecoration(
                                      color: const Color(0xFF16203A), borderRadius: BorderRadius.circular(10)),
                                  child: Text('🙋 $text', style: const TextStyle(fontSize: 12.5)),
                                ),
                              )
                            : Align(
                                alignment: Alignment.centerLeft,
                                child: Container(
                                  margin: const EdgeInsets.symmetric(vertical: 3),
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                  decoration: const BoxDecoration(
                                      border: Border(left: BorderSide(color: Color(0xFF5B9CF8), width: 2))),
                                  child: Text(text, style: const TextStyle(fontSize: 12.5)),
                                ),
                              );
                      },
                    ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
              child: Row(children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    onSubmitted: (_) => _send(),
                    decoration: const InputDecoration(hintText: '问点什么…（不打断主会话）', isDense: true),
                  ),
                ),
                IconButton(onPressed: _send, icon: const Icon(Icons.send, size: 20)),
              ]),
            ),
          ],
        ),
      ),
    );
  }
}
