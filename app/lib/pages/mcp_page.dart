import 'dart:async';
import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';

/// MCP 服务器管理：列表 + 新增/编辑（底部表单）+ 删除。
/// 配置存在服务端（~/.harnessgate/mcp.json），新建会话时按需勾选注入。
class McpPage extends StatefulWidget {
  final GateClient client;
  const McpPage({super.key, required this.client});

  @override
  State<McpPage> createState() => _McpPageState();
}

class _McpPageState extends State<McpPage> {
  StreamSubscription? _errSub;

  @override
  void initState() {
    super.initState();
    widget.client.send(msgMcpList()); // hello 已带，这里兜底刷新一次
    // 保存校验失败等服务端 error：弹 SnackBar（表单已关，不改回显）
    _errSub = widget.client.messages.listen((m) {
      if (m['type'] == 'error' && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${m['message'] ?? '操作失败'}')));
      }
    });
  }

  @override
  void dispose() {
    _errSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('MCP 服务器')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(null),
        icon: const Icon(Icons.add, size: 20),
        label: const Text('添加'),
      ),
      body: StreamBuilder<void>(
        stream: widget.client.mcpChanged,
        builder: (_, __) {
          final servers = widget.client.mcpServers;
          if (servers.isEmpty) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.hub_outlined, size: 42, color: Colors.grey[600]),
                  const SizedBox(height: 10),
                  const Text('还没有配置 MCP 服务器', style: TextStyle(fontSize: 13.5)),
                  const SizedBox(height: 6),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 40),
                    child: Text(
                      '配置后可在新建会话时勾选注入，工具会出现在该会话的 agent 里',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 11.5, color: Colors.grey[500]),
                    ),
                  ),
                ],
              ),
            );
          }
          return ListView(
            padding: const EdgeInsets.all(12),
            children: [
              for (final s in servers)
                Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    leading: Icon(
                      s.type == 'stdio' ? Icons.terminal : Icons.cloud_outlined,
                      size: 22,
                      color: s.enabled ? const Color(0xFF5B9CF8) : Colors.grey[600],
                    ),
                    title: Text(s.name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                    subtitle: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${s.type} · ${s.summary}',
                            maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: Colors.grey[500])),
                        if (s.note != null && s.note!.isNotEmpty)
                          Text(s.note!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 10.5, color: Colors.grey[600])),
                      ],
                    ),
                    trailing: PopupMenuButton<String>(
                      onSelected: (v) {
                        if (v == 'edit') _edit(s);
                        if (v == 'delete') _confirmDelete(s);
                        if (v == 'toggle') widget.client.send(msgMcpSave(_copyWith(s, enabled: !s.enabled)));
                      },
                      itemBuilder: (_) => [
                        PopupMenuItem(value: 'toggle', child: Text(s.enabled ? '新建会话默认不勾选' : '设为新建会话默认勾选')),
                        const PopupMenuItem(value: 'edit', child: Text('编辑')),
                        const PopupMenuItem(value: 'delete', child: Text('删除')),
                      ],
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  McpServerInfo _copyWith(McpServerInfo s, {bool? enabled}) => McpServerInfo(
        id: s.id,
        name: s.name,
        type: s.type,
        command: s.command,
        args: s.args,
        env: s.env,
        url: s.url,
        headers: s.headers,
        enabled: enabled ?? s.enabled,
        note: s.note,
      );

  void _confirmDelete(McpServerInfo s) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('删除 ${s.name}？'),
        content: const Text('已存档会话不受影响（恢复时自动跳过）；只是新建会话不能再选它。', style: TextStyle(fontSize: 13)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              widget.client.send(msgMcpDelete(s.id));
              Navigator.pop(ctx);
            },
            child: const Text('删除'),
          ),
        ],
      ),
    );
  }

  void _edit(McpServerInfo? s) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _McpEditSheet(client: widget.client, initial: s),
    );
  }
}

class _McpEditSheet extends StatefulWidget {
  final GateClient client;
  final McpServerInfo? initial;
  const _McpEditSheet({required this.client, this.initial});

  @override
  State<_McpEditSheet> createState() => _McpEditSheetState();
}

class _McpEditSheetState extends State<_McpEditSheet> {
  late final TextEditingController _name = TextEditingController(text: widget.initial?.name ?? '');
  late final TextEditingController _command = TextEditingController(text: widget.initial?.command ?? '');
  late final TextEditingController _args = TextEditingController(text: widget.initial?.args.join(' '));
  // env/headers 用「KEY=VALUE 每行一个」编辑，够用且免动态行控件
  late final TextEditingController _env = TextEditingController(
      text: [for (final e in widget.initial?.env ?? const <({String name, String value})>[]) '${e.name}=${e.value}'].join('\n'));
  late final TextEditingController _url = TextEditingController(text: widget.initial?.url ?? '');
  late final TextEditingController _headers = TextEditingController(
      text: [for (final h in widget.initial?.headers ?? const <({String name, String value})>[]) '${h.name}: ${h.value}'].join('\n'));
  late final TextEditingController _note = TextEditingController(text: widget.initial?.note ?? '');
  String _type = 'stdio';
  bool _enabled = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _type = widget.initial?.type ?? 'stdio';
    _enabled = widget.initial?.enabled ?? true;
  }

  @override
  void dispose() {
    _name.dispose();
    _command.dispose();
    _args.dispose();
    _env.dispose();
    _url.dispose();
    _headers.dispose();
    _note.dispose();
    super.dispose();
  }

  void _save() {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'name 不能为空');
      return;
    }
    // 参数按空白切（简单够用；带空格的参数暂不支持）
    final args = _args.text.trim().isEmpty ? const <String>[] : _args.text.trim().split(RegExp(r'\s+'));
    final env = <({String name, String value})>[];
    for (final line in _env.text.split('\n')) {
      final l = line.trim();
      if (l.isEmpty) continue;
      final i = l.indexOf('=');
      if (i <= 0) {
        setState(() => _error = 'env 每行格式：KEY=VALUE（出错行：$l）');
        return;
      }
      env.add((name: l.substring(0, i), value: l.substring(i + 1)));
    }
    final headers = <({String name, String value})>[];
    for (final line in _headers.text.split('\n')) {
      final l = line.trim();
      if (l.isEmpty) continue;
      final i = l.indexOf(':');
      if (i <= 0) {
        setState(() => _error = 'headers 每行格式：Name: Value（出错行：$l）');
        return;
      }
      headers.add((name: l.substring(0, i).trim(), value: l.substring(i + 1).trim()));
    }
    widget.client.send(msgMcpSave(McpServerInfo(
      id: widget.initial?.id ?? '',
      name: name,
      type: _type,
      command: _command.text.trim(),
      args: args,
      env: env,
      url: _url.text.trim(),
      headers: headers,
      enabled: _enabled,
      note: _note.text.trim(),
    )));
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(widget.initial == null ? '添加 MCP 服务器' : '编辑 ${widget.initial!.name}',
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
            const SizedBox(height: 12),
            Row(
              children: [
                const Text('类型', style: TextStyle(fontSize: 13)),
                const SizedBox(width: 12),
                SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'stdio', label: Text('stdio', style: TextStyle(fontSize: 12))),
                    ButtonSegment(value: 'http', label: Text('http', style: TextStyle(fontSize: 12))),
                    ButtonSegment(value: 'sse', label: Text('sse', style: TextStyle(fontSize: 12))),
                  ],
                  selected: {_type},
                  onSelectionChanged: (v) => setState(() => _type = v.first),
                  showSelectedIcon: false,
                ),
              ],
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _name,
              decoration: const InputDecoration(
                labelText: '名称（agent 侧标识，字母/数字/._-）',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 10),
            if (_type == 'stdio') ...[
              TextField(
                controller: _command,
                decoration: const InputDecoration(
                  labelText: 'command（可执行文件，建议绝对路径）',
                  hintText: '/usr/local/bin/my-mcp-server',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _args,
                decoration: const InputDecoration(
                  labelText: '参数（空白分隔）',
                  hintText: '--port 8080 --verbose',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _env,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: '环境变量（每行 KEY=VALUE）',
                  hintText: 'API_KEY=xxx',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ] else ...[
              TextField(
                controller: _url,
                decoration: const InputDecoration(
                  labelText: 'url',
                  hintText: 'https://mcp.example.com/sse',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _headers,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: '请求头（每行 Name: Value）',
                  hintText: 'Authorization: Bearer xxx',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ],
            const SizedBox(height: 10),
            TextField(
              controller: _note,
              decoration: const InputDecoration(
                labelText: '备注（可选）',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              value: _enabled,
              onChanged: (v) => setState(() => _enabled = v),
              title: const Text('新建会话默认勾选', style: TextStyle(fontSize: 13.5)),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(_error!, style: const TextStyle(color: Color(0xFFF85149), fontSize: 12.5)),
              ),
            SizedBox(
              height: 44,
              width: double.infinity,
              child: FilledButton(onPressed: _save, child: const Text('保存')),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
