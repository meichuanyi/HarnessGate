import 'dart:async';
import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';
import 'chat_page.dart';

/// 新建会话：选 harness → 填工作目录（可勾选 git worktree 隔离）→ 创建后自动进入对话。
class NewSessionPage extends StatefulWidget {
  final GateClient client;
  const NewSessionPage({super.key, required this.client});

  @override
  State<NewSessionPage> createState() => _NewSessionPageState();
}

class _NewSessionPageState extends State<NewSessionPage> {
  final _cwd = TextEditingController();
  String? _harnessId;
  bool _isolate = false;
  bool _creating = false;
  String? _error;
  StreamSubscription? _sub;

  @override
  void initState() {
    super.initState();
    _cwd.text = widget.client.defaultCwd;
    // 创建后服务端广播一条新 id 的 session（status=starting），据此进入对话
    final known = widget.client.sessions.keys.toSet();
    _sub = widget.client.messages.listen((m) {
      if (m['type'] == 'session' && m['session'] is Map<String, dynamic>) {
        final s = SessionInfo.fromJson(m['session'] as Map<String, dynamic>);
        if (!known.contains(s.id) && _creating && mounted) {
          _sub?.cancel();
          Navigator.of(context).pushReplacement(
            MaterialPageRoute(builder: (_) => ChatPage(client: widget.client, sessionId: s.id)),
          );
        }
      }
      if (m['type'] == 'error' && _creating && mounted) {
        setState(() {
          _creating = false;
          _error = m['message'] as String? ?? '创建失败';
        });
      }
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _cwd.dispose();
    super.dispose();
  }

  List<HarnessInfo> get _harnesses {
    final list = widget.client.harnesses.values.toList();
    list.sort((a, b) {
      final ap = a.probedOk ? 0 : (a.available ? 1 : 2);
      final bp = b.probedOk ? 0 : (b.available ? 1 : 2);
      return ap.compareTo(bp) != 0 ? ap.compareTo(bp) : a.label.compareTo(b.label);
    });
    return list;
  }

  void _create() {
    if (_harnessId == null) {
      setState(() => _error = '请先选择一个 harness');
      return;
    }
    if (_cwd.text.trim().isEmpty) {
      setState(() => _error = '工作目录不能为空');
      return;
    }
    setState(() { _creating = true; _error = null; });
    widget.client.send(msgCreate(_harnessId!, cwd: _cwd.text.trim(), isolate: _isolate));
    // 服务端异常（如未知 harness）会回 error；这里兜底超时
    Timer(const Duration(seconds: 15), () {
      if (_creating && mounted) setState(() { _creating = false; _error = '创建超时，请检查服务器日志'; });
    });
  }

  @override
  Widget build(BuildContext context) {
    final harnesses = _harnesses;
    return Scaffold(
      appBar: AppBar(title: const Text('新建会话')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('选择 harness', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          if (harnesses.isEmpty)
            Text('未获取到 harness 列表（连接服务器后可用）', style: TextStyle(color: Colors.grey[500], fontSize: 12.5))
          else
            ...harnesses.map(_harnessTile),
          const SizedBox(height: 20),
          const Text('工作目录', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          TextField(
            controller: _cwd,
            decoration: const InputDecoration(
              hintText: '/root/projects/my-repo',
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
          const SizedBox(height: 4),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _isolate,
            onChanged: (v) => setState(() => _isolate = v),
            title: const Text('隔离到 git worktree', style: TextStyle(fontSize: 14)),
            subtitle: Text('在独立分支跑，改动不污染主目录（需是含提交的 git 仓库）', style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 4),
              child: Text(_error!, style: const TextStyle(color: Color(0xFFF85149), fontSize: 12.5)),
            ),
          const SizedBox(height: 12),
          SizedBox(
            height: 46,
            child: FilledButton(
              onPressed: _creating ? null : _create,
              child: _creating
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('创建并开始'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _harnessTile(HarnessInfo h) {
    final selected = _harnessId == h.id;
    final (Color c, String tag) = h.probedOk
        ? (const Color(0xFF3FB950), '探活通过')
        : h.available
            ? (const Color(0xFF5B9CF8), '已安装')
            : (const Color(0xFF8B949E), h.state == 'needs-download' ? '需下载' : '不可用');
    return Card(
      margin: const EdgeInsets.only(bottom: 6),
      color: selected ? const Color(0xFF16203A) : null,
      child: ListTile(
        dense: true,
        leading: Icon(selected ? Icons.radio_button_checked : Icons.radio_button_unchecked, size: 20, color: selected ? const Color(0xFF5B9CF8) : null),
        title: Row(
          children: [
            Flexible(child: Text(h.label, maxLines: 1, overflow: TextOverflow.ellipsis)),
            if (h.experimental)
              const Padding(padding: EdgeInsets.only(left: 6), child: Text('实验', style: TextStyle(fontSize: 10, color: Color(0xFFD29922)))),
          ],
        ),
        subtitle: Text(tag, style: TextStyle(fontSize: 11.5, color: c)),
        onTap: () => setState(() => _harnessId = h.id),
      ),
    );
  }
}
