import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';

/// 工作区：跨 harness 的目录视图——谁在哪个目录干活、改了哪些文件、多会话同碰一文件的冲突归因。
/// 只读监控（请求/响应式，进入与下拉刷新）。
class WorkspacePage extends StatefulWidget {
  final GateClient client;
  const WorkspacePage({super.key, required this.client});

  @override
  State<WorkspacePage> createState() => _WorkspacePageState();
}

class _WorkspacePageState extends State<WorkspacePage> {
  @override
  void initState() {
    super.initState();
    widget.client.workspaceChanged.listen((_) {
      if (mounted) setState(() {});
    });
    widget.client.send(msgWorkspace());
  }

  @override
  Widget build(BuildContext context) {
    final reports = widget.client.workspaceReports;
    return Scaffold(
      appBar: AppBar(
        title: const Text('工作区'),
        actions: [
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: () => widget.client.send(msgWorkspace()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => widget.client.send(msgWorkspace()),
        child: reports == null
            ? ListView(children: const [
                SizedBox(height: 150),
                Center(child: CircularProgressIndicator(strokeWidth: 2)),
              ])
            : reports.isEmpty
                ? ListView(children: [
                    const SizedBox(height: 150),
                    Center(
                      child: Text('还没有活跃工作区\n新建会话并让它干活后，这里会出现目录与文件改动归因',
                          textAlign: TextAlign.center, style: TextStyle(color: Colors.grey[500], fontSize: 13)),
                    ),
                  ])
                : ListView.builder(
                    padding: const EdgeInsets.only(bottom: 88),
                    itemCount: reports.length,
                    itemBuilder: (_, i) => _reportCard(reports[i]),
                  ),
      ),
    );
  }

  Widget _reportCard(WorkspaceReport r) {
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 2),
              child: Row(
                children: [
                  Expanded(
                    child: Text(r.cwd, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                  ),
                  if (r.conflicts > 0)
                    Text('⚠ 冲突 ${r.conflicts}', style: const TextStyle(fontSize: 11, color: Color(0xFFD29922))),
                ],
              ),
            ),
            if (r.note.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
                child: Text(r.note, style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
              ),
            for (final s in r.sessions)
              ListTile(
                dense: true,
                visualDensity: VisualDensity.compact,
                leading: Icon(
                  s.inTurn ? Icons.circle : Icons.circle_outlined,
                  size: 10,
                  color: s.inTurn ? const Color(0xFF3FB950) : (s.live ? const Color(0xFF5B9CF8) : Colors.grey),
                ),
                title: Text(
                  '${s.harnessLabel}${s.inTurn ? "  正在干活" : ""}',
                  style: const TextStyle(fontSize: 12.5),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  [
                    s.mode == 'worktree' ? 'worktree ${s.branch ?? ""}' : '共享目录',
                    if (s.changedCount > 0) '改动 ${s.changedCount} 个文件',
                  ].join(' · '),
                  style: const TextStyle(fontSize: 11),
                ),
              ),
            if (r.files.isNotEmpty) ...[
              const Padding(
                padding: EdgeInsets.fromLTRB(12, 4, 12, 2),
                child: Text('文件（改动归因）', style: TextStyle(fontSize: 11, color: Colors.grey)),
              ),
              for (final f in r.files.take(30))
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 2, 12, 2),
                  child: Row(
                    children: [
                      if (f.conflict)
                        const Padding(padding: EdgeInsets.only(right: 4), child: Text('⚠️', style: TextStyle(fontSize: 11))),
                      Expanded(
                        child: Text(f.rel, maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 11.5, color: f.conflict ? const Color(0xFFD29922) : Colors.grey[400])),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        [f.who.join('+'), '${f.who.length} 次'].where((x) => x.isNotEmpty).join(' · '),
                        style: TextStyle(fontSize: 10.5, color: Colors.grey[600]),
                      ),
                    ],
                  ),
                ),
              if (r.files.length > 30)
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 2, 12, 6),
                  child: Text('…其余 ${r.files.length - 30} 个文件', style: TextStyle(fontSize: 10.5, color: Colors.grey[600])),
                ),
            ],
            const SizedBox(height: 4),
          ],
        ),
      ),
    );
  }
}
