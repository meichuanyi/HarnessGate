import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';

/// 定时任务：查看/立即运行/删除。创建与编辑仍是网页端的多步表单（蒸馏/分段等重交互）。
class SchedulesPage extends StatefulWidget {
  final GateClient client;
  const SchedulesPage({super.key, required this.client});

  @override
  State<SchedulesPage> createState() => _SchedulesPageState();
}

class _SchedulesPageState extends State<SchedulesPage> {
  @override
  void initState() {
    super.initState();
    widget.client.schedulesChanged.listen((_) {
      if (mounted) setState(() {});
    });
    widget.client.send(msgSchedulesList());
  }

  void _run(ScheduleInfo s) {
    widget.client.send(msgScheduleRun(s.id));
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已触发「${s.name}」立即运行')));
    // 稍后刷新状态（running/lastRunAt 由服务端广播回来）
    Future.delayed(const Duration(seconds: 2), () => widget.client.send(msgSchedulesList()));
  }

  Future<void> _confirmDelete(ScheduleInfo s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除定时任务'),
        content: Text('删除「${s.name}」？历史产物与自动工作区目录会一并清除，不可恢复。'),
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
      widget.client.send(msgScheduleDelete(s.id));
      Future.delayed(const Duration(milliseconds: 800), () => widget.client.send(msgSchedulesList()));
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = widget.client.schedules;
    return Scaffold(
      appBar: AppBar(
        title: Text('定时（${list.length}）'),
        actions: [
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: () => widget.client.send(msgSchedulesList()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => widget.client.send(msgSchedulesList()),
        child: list.isEmpty
            ? ListView(children: [
                const SizedBox(height: 150),
                Center(
                  child: Text(
                    '还没有定时任务\n创建/编辑请在网页端「定时」页操作，这里可查看与立即运行',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey[500], fontSize: 13),
                  ),
                ),
              ])
            : ListView.builder(
                padding: const EdgeInsets.only(bottom: 88),
                itemCount: list.length,
                itemBuilder: (_, i) {
                  final s = list[i];
                  final statusColor = s.lastStatus == 'error' || s.lastStatus == 'timeout' || s.lastStatus == 'contract-fail'
                      ? const Color(0xFFF85149)
                      : s.lastStatus == 'ok'
                          ? const Color(0xFF3FB950)
                          : Colors.grey;
                  return ListTile(
                    leading: s.running
                        ? const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2))
                        : Icon(Icons.schedule, size: 20, color: s.enabled ? const Color(0xFF3FB950) : Colors.grey),
                    title: Row(
                      children: [
                        Expanded(
                          child: Text(s.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 14, color: s.enabled ? null : Colors.grey)),
                        ),
                        if (!s.enabled)
                          const Padding(padding: EdgeInsets.only(left: 6), child: Text('已停用', style: TextStyle(fontSize: 10.5, color: Colors.grey))),
                      ],
                    ),
                    subtitle: Text(
                      [
                        s.cadenceDesc,
                        if (s.nextFireAt != null) '下次 ${s.nextFireAt!.substring(5, 16).replaceFirst("T", " ")}',
                        if (s.lastRunAt != null)
                          '上次 ${s.lastStatusLabel ?? ""}',
                        if (s.consecutiveFailures > 0) '⚠ 连续失败 ${s.consecutiveFailures}',
                      ].where((x) => x.isNotEmpty).join(' · '),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, color: statusColor == Colors.grey ? Colors.grey[500] : null),
                    ),
                    isThreeLine: false,
                    trailing: PopupMenuButton<String>(
                      icon: const Icon(Icons.more_vert, size: 20),
                      onSelected: (v) {
                        if (v == 'run') _run(s);
                        if (v == 'delete') _confirmDelete(s);
                      },
                      itemBuilder: (_) => [
                        const PopupMenuItem(value: 'run', child: Text('▶ 立即运行')),
                        const PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Color(0xFFF85149)))),
                      ],
                    ),
                    onTap: () => _showDetail(s),
                  );
                },
              ),
      ),
    );
  }

  void _showDetail(ScheduleInfo s) {
    showModalBottomSheet<void>(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text(s.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Text(
                [
                  s.cadenceDesc,
                  'harness: ${s.harnessId}',
                  if (s.cwd != null && s.cwd!.isNotEmpty) '目录: ${s.cwd}',
                  if (s.outputFile != null) '产物: ${s.outputFile}',
                  if (s.lastError != null) '上次错误: ${s.lastError}',
                ].join('\n'),
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Text(
                'Prompt：${s.promptTemplate.isEmpty ? "（空）" : (s.promptTemplate.length > 300 ? "${s.promptTemplate.substring(0, 300)}…" : s.promptTemplate)}',
                style: const TextStyle(fontSize: 12.5),
              ),
            ),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
  }
}
