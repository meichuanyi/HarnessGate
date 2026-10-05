import 'dart:async';
import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';

/// 技能管理：主库（~/.harnessgate/skills）+ 按 harness 软链挂载。
/// 成本模型：常驻系统提示词的只有 name+description——「装在库里」不占 token，「挂载中」才占。
class SkillsPage extends StatefulWidget {
  final GateClient client;
  const SkillsPage({super.key, required this.client});

  @override
  State<SkillsPage> createState() => _SkillsPageState();
}

class _SkillsPageState extends State<SkillsPage> {
  StreamSubscription? _errSub;

  @override
  void initState() {
    super.initState();
    widget.client.send(msgSkills()); // hello 已带，这里兜底刷新
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
      appBar: AppBar(title: const Text('技能')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(null),
        icon: const Icon(Icons.add, size: 20),
        label: const Text('新建'),
      ),
      body: StreamBuilder<void>(
        stream: widget.client.skillsChanged,
        builder: (_, __) {
          final library = widget.client.skillLibrary;
          final mounts = widget.client.skillMounts;
          final manageable = mounts.map((m) => m.harnessId).toList();
          return ListView(
            padding: const EdgeInsets.all(12),
            children: [
              ..._harnessSummary(mounts),
              const SizedBox(height: 10),
              const Text('主库', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
              const SizedBox(height: 4),
              Text('装在库里不占 token；挂载后其名称+描述进入 harness 的系统提示词',
                  style: TextStyle(fontSize: 11, color: Colors.grey[500])),
              const SizedBox(height: 8),
              if (library.isEmpty)
                Card(
                  margin: EdgeInsets.zero,
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Text('库里还没有技能，点右下角「新建」创建一个（SKILL.md 格式，挂载后即可被 harness 使用）',
                        style: TextStyle(fontSize: 12.5, color: Colors.grey[500])),
                  ),
                )
              else
                for (final s in library) _libraryTile(s, manageable),
              const SizedBox(height: 14),
              ..._nativeSections(mounts),
            ],
          );
        },
      ),
    );
  }

  List<Widget> _harnessSummary(List<SkillMountInfo> mounts) {
    if (mounts.isEmpty) return const [];
    return [
      Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Column(
            children: [
              for (final m in mounts)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Row(
                    children: [
                      Icon(Icons.hub_outlined, size: 15, color: m.totalTokens > 1500 ? const Color(0xFFD29922) : const Color(0xFF3FB950)),
                      const SizedBox(width: 6),
                      Text(m.harnessId, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                      const SizedBox(width: 8),
                      Text('挂载 ${m.skills.where((s) => !s.native).length} · 原生 ${m.skills.where((s) => s.native).length} 个',
                          style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
                      const Spacer(),
                      Text('常驻 ≈${m.totalTokens} token',
                          style: TextStyle(
                            fontSize: 11.5,
                            color: m.totalTokens > 1500 ? const Color(0xFFD29922) : Colors.grey[500],
                          )),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    ];
  }

  Widget _libraryTile(SkillInfo s, List<String> manageable) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(s.mountedOn.isEmpty ? Icons.inventory_2_outlined : Icons.extension,
                size: 20, color: s.mountedOn.isEmpty ? Colors.grey[600] : const Color(0xFF5B9CF8)),
            Text('≈${s.tokens}', style: TextStyle(fontSize: 9, color: Colors.grey[500])),
          ],
        ),
        title: Text(s.name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (s.description.isNotEmpty)
              Text(s.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: Colors.grey[400])),
            const SizedBox(height: 3),
            Wrap(
              spacing: 5,
              children: [
                for (final h in s.mountedOn)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(color: const Color(0xFF16203A), borderRadius: BorderRadius.circular(4)),
                    child: Text('↗ $h', style: const TextStyle(fontSize: 10, color: Color(0xFF5B9CF8))),
                  ),
                if (s.mountedOn.isEmpty)
                  Text('未挂载（不占 token）', style: TextStyle(fontSize: 10, color: Colors.grey[600])),
              ],
            ),
          ],
        ),
        isThreeLine: true,
        trailing: PopupMenuButton<String>(
          onSelected: (v) {
            if (v == 'edit') _edit(s);
            if (v == 'delete') _confirmDelete(s);
            if (v.startsWith('mount:')) widget.client.send(msgSkillsMount(s.name, v.substring(6), true));
            if (v.startsWith('unmount:')) widget.client.send(msgSkillsMount(s.name, v.substring(8), false));
          },
          itemBuilder: (_) => [
            for (final h in manageable.where((h) => !s.mountedOn.contains(h)))
              PopupMenuItem(value: 'mount:$h', child: Text('挂载到 $h')),
            for (final h in s.mountedOn)
              PopupMenuItem(value: 'unmount:$h', child: Text('从 $h 卸载')),
            const PopupMenuItem(value: 'edit', child: Text('编辑')),
            const PopupMenuItem(value: 'delete', child: Text('删除（进回收站）')),
          ],
        ),
      ),
    );
  }

  List<Widget> _nativeSections(List<SkillMountInfo> mounts) {
    final withNative = mounts.where((m) => m.skills.any((s) => s.native)).toList();
    if (withNative.isEmpty) return const [];
    return [
      const Text('harness 自带（原生，只读）', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
      const SizedBox(height: 4),
      Text('这些是 harness 目录里已存在的技能，不归主库管；点按可查看内容',
          style: TextStyle(fontSize: 11, color: Colors.grey[500])),
      const SizedBox(height: 8),
      for (final m in withNative)
        Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${m.harnessId} · ${m.skills.where((s) => s.native).length} 个', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final s in m.skills.where((s) => s.native))
                      ActionChip(
                        visualDensity: VisualDensity.compact,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        label: Text(s.name, style: const TextStyle(fontSize: 11)),
                        onPressed: () => _viewNative(s.name, m.harnessId),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
    ];
  }

  void _viewNative(String name, String harnessId) async {
    final m = await widget.client.request(
      'skills-content',
      msgSkillsRead(name, nativeHarness: harnessId),
      timeout: const Duration(seconds: 8),
    );
    if (!mounted) return;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => FractionallySizedBox(
        heightFactor: 0.8,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(10),
              child: Text('$harnessId · $name', style: const TextStyle(fontWeight: FontWeight.w600)),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                child: Text((m?['content'] as String?) ?? '（读取失败）', style: const TextStyle(fontSize: 12, fontFamily: 'monospace')),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _confirmDelete(SkillInfo s) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('删除 ${s.name}？'),
        content: const Text('会先从所有 harness 卸载，文件进服务器回收站（skills.trash，可手工找回）。', style: TextStyle(fontSize: 13)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              widget.client.send(msgSkillsDelete(s.name));
              Navigator.pop(ctx);
            },
            child: const Text('删除'),
          ),
        ],
      ),
    );
  }

  void _edit(SkillInfo? s) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _SkillEditSheet(client: widget.client, initial: s),
    );
  }
}

class _SkillEditSheet extends StatefulWidget {
  final GateClient client;
  final SkillInfo? initial;
  const _SkillEditSheet({required this.client, this.initial});

  @override
  State<_SkillEditSheet> createState() => _SkillEditSheetState();
}

class _SkillEditSheetState extends State<_SkillEditSheet> {
  late final TextEditingController _name = TextEditingController(text: widget.initial?.name ?? '');
  // 编辑已有 skill 时读全文填进正文框
  late final TextEditingController _desc = TextEditingController(text: widget.initial?.description ?? '');
  late final TextEditingController _body = TextEditingController();
  String? _error;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    final init = widget.initial;
    if (init != null) {
      widget.client.request('skills-content', msgSkillsRead(init.name), timeout: const Duration(seconds: 8)).then((m) {
        if (!mounted) return;
        final content = m?['content'] as String? ?? '';
        // 剥掉 frontmatter，只留正文
        final body = content.replaceFirst(RegExp(r'^---\r?\n[\s\S]*?\r?\n---\r?\n?'), '');
        _body.text = body.trim();
        setState(() => _loaded = true);
      });
    } else {
      _loaded = true;
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    _body.dispose();
    super.dispose();
  }

  void _save() {
    final name = _name.text.trim();
    final desc = _desc.text.trim();
    if (name.isEmpty) {
      setState(() => _error = '名称不能为空');
      return;
    }
    if (desc.isEmpty) {
      setState(() => _error = 'description 不能为空——它是模型决定用不用这个技能的唯一依据');
      return;
    }
    widget.client.send(msgSkillsSave(
      name,
      desc,
      _body.text,
      renameFrom: widget.initial != null && widget.initial!.name != name ? widget.initial!.name : null,
    ));
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
            Text(widget.initial == null ? '新建技能' : '编辑 ${widget.initial!.name}',
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
            const SizedBox(height: 12),
            TextField(
              controller: _name,
              decoration: const InputDecoration(
                labelText: '名称（字母/数字/._-，也是目录名）',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _desc,
              maxLines: 3,
              maxLength: 600,
              decoration: InputDecoration(
                labelText: '描述（常驻系统提示词，越短越省 token）',
                helperText: '当前 ≈${(_name.text.length + _desc.text.length + 2) ~/ 3} token',
                helperStyle: const TextStyle(fontSize: 11),
                border: const OutlineInputBorder(),
                isDense: true,
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _body,
              maxLines: 8,
              decoration: const InputDecoration(
                labelText: '正文（SKILL.md 主体，只在技能被使用时才进入上下文）',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(_error!, style: const TextStyle(color: Color(0xFFF85149), fontSize: 12.5)),
              ),
            const SizedBox(height: 10),
            SizedBox(
              height: 44,
              width: double.infinity,
              child: FilledButton(
                onPressed: _loaded ? _save : null,
                child: _loaded ? const Text('保存到主库') : const Text('读取中…'),
              ),
            ),
            const SizedBox(height: 8),
            const Text('保存后需在列表里挂载到 harness 才生效；改动对新会话生效',
                style: TextStyle(fontSize: 11, color: Color(0xFF8B949E))),
          ],
        ),
      ),
    );
  }
}
