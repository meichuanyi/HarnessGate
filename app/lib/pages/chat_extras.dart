import 'dart:async';

import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';

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
/// 不打断、不排队、不污染主会话台账。闲置 30 分钟自动回收（问答摘要留痕进主会话）；
/// 重开抽屉按源找回在跑分身（side-find）；投递走 side-deliver 方案C
/// （留痕 + 随主线下一条消息注入模型，不唤醒不插队）。
class SideQuestionSheet extends StatefulWidget {
  final GateClient client;
  final String srcId;
  const SideQuestionSheet({super.key, required this.client, required this.srcId});

  @override
  State<SideQuestionSheet> createState() => _SideQuestionSheetState();
}

class _SideQuestionSheetState extends State<SideQuestionSheet> {
  String? _sideId;
  String _status = '此刻还没有分身——发出第一条问题后才会启动（fork 当前上下文）';
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
      if (m['type'] == 'side-found') {
        // 重开抽屉找回在跑的分身（服务端按 srcId 查 live；没有则 sessionId 为 null）
        final found = m['sessionId'] as String?;
        if (m['srcId'] == widget.srcId && found != null) {
          _sideId = found;
          _status = '已找回在跑的分身，载入对话…';
          setState(() {});
          _scheduleRefresh();
        }
        return;
      }
      if (m['type'] == 'deleted' && _sideId != null && m['sessionId'] == _sideId) {
        // 在跑的分身被回收（闲置自动/别处手动清空）：抽屉回到初始态
        _sideId = null;
        _items.clear();
        _status = '分身已销毁。发出第一条问题后会重新启动（fork 当前上下文）';
        setState(() {});
        return;
      }
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
        if (_status != '生成中…') setState(() => _status = '生成中…');
        _scheduleRefresh();
      }
    });
    // 打开即找回：切走再回来不丢在跑的分身
    widget.client.send({'type': 'side-find', 'srcId': widget.srcId});
  }

  void _scheduleRefresh() {
    _refresh?.cancel();
    // 流式期间去抖 350ms 拉一次台账（800ms 时流式观感明显滞后，与 web 对齐）
    _refresh = Timer(const Duration(milliseconds: 350), () {
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
    // 方案C：留痕进主会话台账 + 内容进待注入队列随主线下一条消息进模型——
    // 不唤醒已停止的主会话、不插队正在跑的回合（此前 prompt 直投会唤醒主会话+烧一个回合）
    widget.client.send({'type': 'side-deliver', 'sessionId': widget.srcId, 'text': lastA.$2});
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('已投递：留痕进主会话，随其下一条消息注入（不打扰当前回合）')));
    }
  }

  void _destroySide() {
    final id = _sideId;
    if (id == null) return;
    // 清空=手动销毁不留痕：不等闲置 30 分钟自动回收（服务端只接受确实是侧问分身的 id）
    widget.client.send({'type': 'side-destroy', 'sessionId': id});
    _sideId = null;
    setState(() {
      _items.clear();
      _status = '分身已销毁。发出第一条问题后会重新启动（fork 当前上下文）';
    });
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
                  tooltip: '留痕进主会话并随其下一条消息注入模型（不打扰当前回合）',
                  icon: const Icon(Icons.move_down_outlined, size: 20),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: _destroySide,
                  tooltip: '立即销毁当前分身（不等闲置 30 分钟自动回收）',
                  icon: const Icon(Icons.delete_outline, size: 20),
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

/// 🛠 会话装备：本会话启用的 MCP 服务与领域技能（对齐网页版装备抽屉）。
/// MCP 注入在会话下次恢复/重启时生效；技能挂载是 harness 级（同 harness 会话共享），保存即差分挂载。
class GearSheet extends StatefulWidget {
  final GateClient client;
  final String sessionId;
  const GearSheet({super.key, required this.client, required this.sessionId});

  @override
  State<GearSheet> createState() => _GearSheetState();
}

class _GearSheetState extends State<GearSheet> {
  bool _tabMcp = true; // true=MCP 服务 false=领域技能
  bool _loading = true;
  List<String> _mcps = [];
  List<String> _skills = [];
  List<Map<String, dynamic>> _allMcps = [];
  List<Map<String, dynamic>> _allSkills = [];
  final _searchCtrl = TextEditingController();
  String _q = ''; // 过滤词：只影响显示，勾选状态不动（与 web 端一致）
  StreamSubscription<Map<String, dynamic>>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = widget.client.messages.listen((m) {
      if (m['type'] != 'session-gear' || m['sessionId'] != widget.sessionId) return;
      if (!mounted) return;
      final lib = ((m['allSkills'] as Map<String, dynamic>? ?? const <String, dynamic>{})['library']
              as List<dynamic>? ??
          const <dynamic>[]);
      setState(() {
        _mcps = ((m['mcpServerIds'] as List<dynamic>? ?? const <dynamic>[])).map((e) => e.toString()).toList();
        _skills = ((m['skillIds'] as List<dynamic>? ?? const <dynamic>[])).map((e) => e.toString()).toList();
        _allMcps = ((m['allMcps'] as List<dynamic>? ?? const <dynamic>[])).whereType<Map<String, dynamic>>().toList();
        _allSkills = lib.whereType<Map<String, dynamic>>().toList();
        _loading = false;
      });
    });
    widget.client.send(msgSessionGearGet(widget.sessionId));
  }

  @override
  void dispose() {
    _sub?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  /// 当前 Tab 过滤后的列表（MCP 按名称/类型/备注，技能按名称/描述；不区分大小写）
  List<Map<String, dynamic>> get _shown => _tabMcp
      ? _allMcps
          .where((m) => _hit([m['name'], m['type'], m['note']]))
          .toList()
      : _allSkills.where((sk) => _hit([sk['name'], sk['description']])).toList();

  bool _hit(List<dynamic> fields) =>
      _q.isEmpty || fields.any((f) => (f ?? '').toString().toLowerCase().contains(_q));

  void _toggle(bool mcp, String id, bool on) {
    setState(() {
      final list = mcp ? _mcps : _skills;
      if (on && !list.contains(id)) {
        list.add(id);
      } else if (!on) {
        list.remove(id);
      }
    });
  }

  void _save() {
    widget.client.send(msgSessionGearSave(widget.sessionId, List.of(_mcps), List.of(_skills)));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('🛠 装备已保存（MCP 下次恢复/重启注入；技能挂载立即生效）')));
      Navigator.pop(context);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
        decoration: const BoxDecoration(
          color: Color(0xFF0B0D12),
          borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 8, 6),
              child: Row(children: [
                const Text('🛠 会话装备', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                const SizedBox(width: 8),
                Text('MCP ${_mcps.length} · 技能 ${_skills.length}',
                    style: const TextStyle(fontSize: 11, color: Colors.grey)),
                const Spacer(),
                TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(children: [
                ChoiceChip(
                  label: Text('🔌 MCP 服务 (${_mcps.length})'),
                  selected: _tabMcp,
                  onSelected: (_) => setState(() => _tabMcp = true),
                ),
                const SizedBox(width: 8),
                ChoiceChip(
                  label: Text('🎯 领域技能 (${_skills.length})'),
                  selected: !_tabMcp,
                  onSelected: (_) => setState(() => _tabMcp = false),
                ),
              ]),
            ),
            const SizedBox(height: 4),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: TextField(
                controller: _searchCtrl,
                onChanged: (v) => setState(() => _q = v.trim()),
                style: const TextStyle(fontSize: 12.5),
                decoration: InputDecoration(
                  isDense: true,
                  hintText: _tabMcp ? '🔍 过滤 MCP（名称/备注）' : '🔍 过滤技能（名称/描述）',
                  hintStyle: const TextStyle(fontSize: 11.5, color: Colors.grey),
                  suffixIcon: _q.isEmpty
                      ? null
                      : GestureDetector(
                          onTap: () {
                            _searchCtrl.clear();
                            setState(() => _q = '');
                          },
                          child: const Icon(Icons.close, size: 15, color: Colors.grey)),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                ),
              ),
            ),
            if (_q.isNotEmpty && !_loading && _shown.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 6, 14, 0),
                child: Text('显示 ${_shown.length}/${(_tabMcp ? _allMcps : _allSkills).length}，未显示项的勾选保持不变',
                    style: const TextStyle(fontSize: 10.5, color: Colors.grey)),
              ),
            Expanded(
              child: _loading
                  ? const Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)))
                  : (_tabMcp ? _allMcps : _allSkills).isEmpty
                      ? Center(
                          child: Text(_tabMcp ? '还没有全局 MCP 服务，到 MCP 管理页添加' : '技能库是空的，到技能页创建',
                              style: const TextStyle(fontSize: 12, color: Colors.grey)))
                      : _shown.isEmpty
                          ? Center(
                              child: Text('没有匹配「$_q」的${_tabMcp ? ' MCP 服务' : '技能'}',
                                  style: const TextStyle(fontSize: 12, color: Colors.grey)))
                          : _tabMcp
                              ? ListView.builder(
                                  itemCount: _shown.length,
                                  itemBuilder: (_, i) {
                                    final m = _shown[i];
                                    final id = (m['id'] ?? '').toString();
                                    return CheckboxListTile(
                                      dense: true,
                                      value: _mcps.contains(id),
                                      onChanged: (v) => _toggle(true, id, v ?? false),
                                      title: Text('${m['name'] ?? id}',
                                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                                      subtitle: Text(
                                          '${m['type'] ?? ''}${m['note'] != null && (m['note'] as String).isNotEmpty ? ' · ${m['note']}' : ''}',
                                          style: const TextStyle(fontSize: 11, color: Colors.grey)),
                                    );
                                  },
                                )
                              : ListView.builder(
                                  itemCount: _shown.length,
                                  itemBuilder: (_, i) {
                                    final sk = _shown[i];
                                    final name = (sk['name'] ?? '').toString();
                                    return CheckboxListTile(
                                      dense: true,
                                      value: _skills.contains(name),
                                      onChanged: (v) => _toggle(false, name, v ?? false),
                                      title: Text(name,
                                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                                      subtitle: Text(
                                          '~${sk['tokens'] ?? '?'} tok${sk['description'] != null && (sk['description'] as String).isNotEmpty ? ' · ${sk['description']}' : ''}',
                                          maxLines: 2,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(fontSize: 11, color: Colors.grey)),
                                    );
                                  },
                                ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Text(
                    'MCP 注入在会话下次恢复/重启时生效；技能挂载是 harness 级（同 harness 的会话共享），保存即差分挂载。',
                    style: TextStyle(fontSize: 10.5, color: Colors.grey)),
                const SizedBox(height: 8),
                FilledButton(onPressed: _loading ? null : _save, child: const Text('保存装备')),
              ]),
            ),
          ],
        ),
      ),
    );
  }
}
