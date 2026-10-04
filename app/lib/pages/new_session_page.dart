import 'dart:async';
import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';
import 'chat_page.dart';
import 'mcp_page.dart';

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

  // 工作目录补全（服务端 dirs 接口）：输入防抖 250ms 拉候选子目录
  Timer? _dirsDebounce;
  bool _dirsLoading = false;
  bool _cwdExists = true;
  List<Map<String, dynamic>> _dirEntries = const [];

  // MCP 注入选择：null = 未初始化（进页后按各服务器 enabled 预选）
  Set<String>? _mcpPicked;

  @override
  void initState() {
    super.initState();
    _cwd.text = widget.client.defaultCwd;
    _cwd.addListener(_refreshDirs);
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
    WidgetsBinding.instance.addPostFrameCallback((_) => _refreshDirs());
  }

  @override
  void dispose() {
    _dirsDebounce?.cancel();
    _sub?.cancel();
    _cwd.dispose();
    super.dispose();
  }

  /// 输入变化 → 防抖拉目录候选；服务端回显 input，过期响应直接丢弃
  void _refreshDirs() {
    _dirsDebounce?.cancel();
    _dirsDebounce = Timer(const Duration(milliseconds: 250), () async {
      if (!mounted) return;
      setState(() => _dirsLoading = true);
      final forInput = _cwd.text.trim();
      final m = await widget.client.request('dirs', {'type': 'dirs', 'input': forInput});
      if (!mounted) return;
      if (m == null || (m['input'] as String? ?? '') != _cwd.text.trim()) {
        // 断连/超时/过期：保留旧候选，只结束 loading
        setState(() => _dirsLoading = false);
        return;
      }
      setState(() {
        _dirsLoading = false;
        _cwdExists = m['exists'] == true;
        _dirEntries =
            ((m['entries'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
      });
    });
  }

  void _pickDir(String path) {
    _cwd.text = path;
    _cwd.selection = TextSelection.collapsed(offset: path.length);
    // text 变化会触发 _refreshDirs，自动列出该目录的子目录（可继续往下钻）
  }

  /// 历史目录：从已有会话聚合（按最近活动排序去重），加上服务器默认目录
  List<String> get _historyDirs {
    final latest = <String, String>{};
    for (final s in widget.client.sessions.values) {
      final d = s.cwd.trim();
      if (d.isEmpty) continue;
      final at = s.lastActiveAt;
      if (latest[d] == null || at.compareTo(latest[d]!) > 0) latest[d] = at;
    }
    final dirs = latest.keys.toList()..sort((a, b) => latest[b]!.compareTo(latest[a]!));
    final def = widget.client.defaultCwd;
    if (def.isNotEmpty && !dirs.contains(def)) dirs.insert(0, def);
    return dirs.take(8).toList();
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
    widget.client.send(msgCreate(
      _harnessId!,
      cwd: _cwd.text.trim(),
      isolate: _isolate,
      mcpServerIds: (_mcpPicked ?? {}).toList(),
    ));
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
            decoration: InputDecoration(
              hintText: '/root/projects/my-repo',
              border: const OutlineInputBorder(),
              isDense: true,
              suffixIcon: _dirsLoading
                  ? const Padding(
                      padding: EdgeInsets.all(14),
                      child: SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2)),
                    )
                  : null,
            ),
          ),
          if (_cwd.text.trim().isNotEmpty && !_cwdExists)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('目录不存在，创建会话时将自动新建', style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
            ),
          ..._historySection,
          ..._suggestSection,
          const SizedBox(height: 4),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _isolate,
            onChanged: (v) => setState(() => _isolate = v),
            title: const Text('隔离到 git worktree', style: TextStyle(fontSize: 14)),
            subtitle: Text('在独立分支跑，改动不污染主目录（需是含提交的 git 仓库）', style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
          ),
          ..._mcpSection,
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

  /// MCP 注入选择区：FilterChips 勾选；首次按各服务器 enabled 预选
  List<Widget> get _mcpSection {
    final servers = widget.client.mcpServers;
    final picked = _mcpPicked ??= servers.where((s) => s.enabled).map((s) => s.id).toSet();
    return [
      const SizedBox(height: 14),
      Row(
        children: [
          const Text('MCP 服务器', style: TextStyle(fontWeight: FontWeight.w600)),
          const Spacer(),
          IconButton(
            tooltip: '管理 MCP 服务器',
            icon: const Icon(Icons.settings_outlined, size: 18),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => McpPage(client: widget.client)),
            ).then((_) => setState(() {})),   // 管理页增删/改默认后回来刷新
          ),
        ],
      ),
      const SizedBox(height: 6),
      if (servers.isEmpty)
        Text('未配置（点右上管理可添加）', style: TextStyle(fontSize: 11.5, color: Colors.grey[500]))
      else ...[
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final s in servers)
              FilterChip(
                label: Text(s.name, style: const TextStyle(fontSize: 11)),
                selected: picked.contains(s.id),
                showCheckmark: false,
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                onSelected: (v) => setState(() {
                  if (v) {
                    picked.add(s.id);
                  } else {
                    picked.remove(s.id);
                  }
                }),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Text('勾选的将在会话启动时注入（其工具直接出现在 agent 工具列表）', style: TextStyle(fontSize: 11, color: Colors.grey[500])),
      ],
    ];
  }

  /// 历史目录 chips：点按直接填入
  List<Widget> get _historySection {
    final dirs = _historyDirs;
    if (dirs.isEmpty) return const [];
    return [
      const SizedBox(height: 10),
      Text('历史目录', style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
      const SizedBox(height: 6),
      Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final d in dirs)
            ActionChip(
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              label: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 230),
                child: Text(d, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11)),
              ),
              onPressed: () => _pickDir(d),
            ),
        ],
      ),
    ];
  }

  /// 子目录候选：服务端 dirs 接口（输入过滤 + git 标记），点按往下钻
  List<Widget> get _suggestSection {
    if (_dirEntries.isEmpty) return const [];
    const shown = 7;
    final items = _dirEntries.take(shown).toList();
    return [
      const SizedBox(height: 10),
      Text('子目录（点按选择，输入可过滤）', style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
      const SizedBox(height: 4),
      Card(
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            for (final e in items)
              ListTile(
                dense: true,
                visualDensity: VisualDensity.compact,
                leading: Icon(
                  e['git'] == true ? Icons.account_tree : Icons.folder_outlined,
                  size: 18,
                  color: e['git'] == true ? const Color(0xFF3FB950) : Colors.grey[600],
                ),
                title: Text('${e['name']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                subtitle: Text('${e['path']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 10.5, color: Colors.grey[500])),
                onTap: () => _pickDir(e['path'] as String),
              ),
          ],
        ),
      ),
      if (_dirEntries.length > shown)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text('还有 ${_dirEntries.length - shown} 个未显示，继续输入可过滤', style: TextStyle(fontSize: 11, color: Colors.grey[500])),
        ),
    ];
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
