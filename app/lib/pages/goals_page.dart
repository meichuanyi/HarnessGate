import 'dart:async';
import 'package:flutter/material.dart';
import '../core/client.dart';
import '../core/protocol.dart';

/// 目标看板与生活运转页面
class GoalsPage extends StatefulWidget {
  final GateClient client;
  const GoalsPage({super.key, required this.client});

  @override
  State<GoalsPage> createState() => _GoalsPageState();
}

class _GoalsPageState extends State<GoalsPage> {
  StreamSubscription<Map<String, dynamic>>? _msgSub;
  StreamSubscription<void>? _goalsSub;

  final Set<String> _completingTaskIds = {};
  final Set<String> _reschedulingTaskIds = {};
  final Set<String> _expandedGoalIds = {};
  bool _initialLoaded = false;

  @override
  void initState() {
    super.initState();

    // 监听 WebSocket 的 'goals' 消息以及 Client 中的 goalsChanged 流
    _msgSub = widget.client.messages.listen((m) {
      if (m['type'] == 'goals') {
        _syncExpandedState();
        if (mounted) setState(() {});
      }
    });

    _goalsSub = widget.client.goalsChanged.listen((_) {
      _syncExpandedState();
      if (mounted) setState(() {});
    });

    // 页面挂载时向 WebSocket 发送 { "type": "goals-get" } 拉取初始数据
    _fetchGoals();
  }

  void _syncExpandedState() {
    if (!_initialLoaded && widget.client.goals.isNotEmpty) {
      _initialLoaded = true;
      // 默认展开所有含有任务的目标
      for (final g in widget.client.goals) {
        if (g.linkedTasks.isNotEmpty) {
          _expandedGoalIds.add(g.id);
        }
      }
    }
  }

  void _fetchGoals() {
    widget.client.send(msgGoalsGet());
    // 兼容服务端历史查询
    widget.client.send(msgGoalsList());
  }

  @override
  void dispose() {
    _msgSub?.cancel();
    _goalsSub?.cancel();
    super.dispose();
  }

  void _completeTask(String taskId, {String? goalId}) {
    if (_completingTaskIds.contains(taskId)) return;
    setState(() => _completingTaskIds.add(taskId));

    widget.client.send(msgGoalTaskComplete(taskId, goalId: goalId));
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(goalId != null ? '✓ 任务已打勾，目标进度推进中' : '✓ 任务已完成打勾'),
        duration: const Duration(seconds: 2),
      ),
    );

    // 4秒后自动移除完成保护状态以允许重试
    Future.delayed(const Duration(seconds: 4), () {
      if (mounted) {
        setState(() => _completingTaskIds.remove(taskId));
      }
    });
  }

  void _rescheduleTask(
    String taskId, {
    String? dueDate,
    String? startTime,
    String? label,
  }) {
    if (_reschedulingTaskIds.contains(taskId)) return;
    setState(() => _reschedulingTaskIds.add(taskId));

    widget.client.send(
      msgGoalTaskReschedule(taskId, dueDate: dueDate, startTime: startTime),
    );
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(label ?? '⚡ 已执行推演处方：任务日程已顺延校准'),
        duration: const Duration(seconds: 3),
      ),
    );

    Future.delayed(const Duration(seconds: 4), () {
      if (mounted) {
        setState(() => _reschedulingTaskIds.remove(taskId));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final lifeTasks = widget.client.lifeTasks;
    final goals = widget.client.goals;

    return Scaffold(
      backgroundColor: const Color(0xFF0B0D12),
      appBar: AppBar(
        title: const Text('目标与生活运转'),
        backgroundColor: const Color(0xFF12151C),
        surfaceTintColor: Colors.transparent,
        actions: [
          IconButton(
            tooltip: '刷新看板',
            icon: const Icon(Icons.refresh, size: 20),
            onPressed: () {
              _fetchGoals();
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('已向服务器请求刷新目标看板...'),
                  duration: Duration(milliseconds: 1200),
                ),
              );
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          _fetchGoals();
          await Future.delayed(const Duration(milliseconds: 800));
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 88),
          children: [
            // 顶部：「☕ 今日生活与日常运转 (Life Ops)」卡片列表
            _buildLifeOpsSection(lifeTasks),

            const SizedBox(height: 20),

            // 下方：「🎯 目标推进与罗盘」卡片列表
            _buildGoalsSection(goals),
          ],
        ),
      ),
    );
  }

  /// 顶部：「☕ 今日生活与日常运转 (Life Ops)」卡片列表
  Widget _buildLifeOpsSection(List<MindwtrTaskInfo> lifeTasks) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF12151C),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF21262D)),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.coffee_rounded, size: 20, color: Color(0xFFD29922)),
              const SizedBox(width: 8),
              const Expanded(
                child: Text(
                  '☕ 今日生活与日常运转 (Life Ops)',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFF171B24),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFF30363D)),
                ),
                child: Text(
                  '${lifeTasks.length} 项待办',
                  style: TextStyle(fontSize: 11, color: Colors.grey[400]),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (lifeTasks.isEmpty)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 20),
              alignment: Alignment.center,
              child: Text(
                '暂无待办琐事，生活运转平稳 ☕',
                style: TextStyle(fontSize: 13, color: Colors.grey[500]),
              ),
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: lifeTasks.length,
              separatorBuilder: (_, __) => const Divider(
                color: Color(0xFF21262D),
                height: 18,
                thickness: 0.8,
              ),
              itemBuilder: (_, i) {
                final t = lifeTasks[i];
                return _buildTaskItem(t);
              },
            ),
        ],
      ),
    );
  }

  /// 单个待办任务条目展示
  Widget _buildTaskItem(MindwtrTaskInfo t, {String? goalId}) {
    final isCompleting = _completingTaskIds.contains(t.id);
    final hasPrescription = t.prescription != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 打勾完成按钮
            Padding(
              padding: const EdgeInsets.only(top: 2, right: 8),
              child: isCompleting
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Color(0xFF3FB950),
                      ),
                    )
                  : InkWell(
                      onTap: () => _completeTask(t.id, goalId: goalId),
                      borderRadius: BorderRadius.circular(6),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFF171B24),
                          border: Border.all(color: const Color(0xFF30363D)),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.check, size: 14, color: Color(0xFF3FB950)),
                            SizedBox(width: 4),
                            Text(
                              '完成',
                              style: TextStyle(
                                fontSize: 11.5,
                                color: Color(0xFF3FB950),
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
            ),
            // 待办标题
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t.title,
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w500,
                      color: Colors.white,
                      height: 1.3,
                    ),
                  ),
                  if (t.notes != null && t.notes!.trim().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text(
                        t.notes!.trim(),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, color: Colors.grey[400]),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            // 时间与标签展示
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                if (t.timeLabel.isNotEmpty)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.access_time, size: 12, color: Colors.grey[400]),
                      const SizedBox(width: 3),
                      Text(
                        t.timeLabel,
                        style: TextStyle(fontSize: 11, color: Colors.grey[400]),
                      ),
                    ],
                  ),
                if (t.tags.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Wrap(
                      spacing: 4,
                      children: t.tags.take(2).map((tag) {
                        final tagText = tag.replaceFirst(RegExp(r'^#'), '');
                        return Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
                          decoration: BoxDecoration(
                            color: const Color(0xFF171B24),
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(color: const Color(0xFF30363D)),
                          ),
                          child: Text(
                            tagText,
                            style: TextStyle(fontSize: 10, color: Colors.grey[300]),
                          ),
                        );
                      }).toList(),
                    ),
                  ),
              ],
            ),
          ],
        ),
        // 如果存在 t.prescription，渲染精致推演处方卡
        if (hasPrescription)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: _buildPrescriptionCard(t.id, t.prescription!),
          ),
      ],
    );
  }

  /// 精致推演处方卡
  Widget _buildPrescriptionCard(String taskId, SpeculativePrescriptionInfo p) {
    final (badgeColor, badgeText) = p.statusBadge;
    final isRescheduling = _reschedulingTaskIds.contains(taskId);

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: const Color(0xFF171B24),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: p.status == 'warning'
              ? const Color(0xFFD29922).withValues(alpha: 0.5)
              : const Color(0xFF30363D),
        ),
      ),
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 状态徽标与摘要
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: badgeColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: badgeColor.withValues(alpha: 0.4)),
                ),
                child: Text(
                  badgeText,
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                    color: badgeColor,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  p.summary,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: Colors.white,
                  ),
                ),
              ),
            ],
          ),

          // 感知证据链与上下文记忆
          if (p.evidencePerceptions.isNotEmpty || p.evidenceMemories.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final perc in p.evidencePerceptions)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('• ', style: TextStyle(fontSize: 11, color: Colors.grey[500])),
                          Expanded(
                            child: Text(
                              perc,
                              style: TextStyle(fontSize: 11, color: Colors.grey[300], height: 1.3),
                            ),
                          ),
                        ],
                      ),
                    ),
                  for (final mem in p.evidenceMemories)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('• ', style: TextStyle(fontSize: 11, color: Colors.grey[500])),
                          Expanded(
                            child: Text(
                              mem,
                              style: TextStyle(fontSize: 11, color: Colors.grey[400], height: 1.3),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ],

          // 处方行动按钮：若有 actionType == "reschedule_task"，提供一键顺延按钮
          if (p.actions.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: p.actions.map((act) {
                if (act.actionType == 'reschedule_task') {
                  final dueDate = act.payload['dueDate'] as String?;
                  final startTime = act.payload['startTime'] as String?;

                  return InkWell(
                    onTap: isRescheduling
                        ? null
                        : () => _rescheduleTask(
                              taskId,
                              dueDate: dueDate,
                              startTime: startTime,
                              label: '⚡ 已顺延校准日程：${act.label}',
                            ),
                    borderRadius: BorderRadius.circular(6),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        color: const Color(0xFF1F2E4A),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0xFF5B9CF8).withValues(alpha: 0.5)),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (isRescheduling)
                            const SizedBox(
                              width: 12,
                              height: 12,
                              child: CircularProgressIndicator(
                                strokeWidth: 1.8,
                                color: Color(0xFF5B9CF8),
                              ),
                            )
                          else
                            const Icon(
                              Icons.update_rounded,
                              size: 13,
                              color: Color(0xFF5B9CF8),
                            ),
                          const SizedBox(width: 4),
                          Text(
                            act.label.isNotEmpty ? act.label : '一键顺延',
                            style: const TextStyle(
                              fontSize: 11.5,
                              color: Color(0xFF5B9CF8),
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                } else {
                  return Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF12151C),
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(color: const Color(0xFF30363D)),
                    ),
                    child: Text(
                      act.label,
                      style: TextStyle(fontSize: 11, color: Colors.grey[300]),
                    ),
                  );
                }
              }).toList(),
            ),
          ],
        ],
      ),
    );
  }

  /// 下方：「🎯 目标推进与罗盘」卡片列表
  Widget _buildGoalsSection(List<GoalInfo> goals) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.track_changes, size: 20, color: Color(0xFF5B9CF8)),
            const SizedBox(width: 8),
            const Expanded(
              child: Text(
                '🎯 目标推进与罗盘',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: Colors.white,
                ),
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: const Color(0xFF171B24),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFF30363D)),
              ),
              child: Text(
                '${goals.length} 个目标',
                style: TextStyle(fontSize: 11, color: Colors.grey[400]),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (goals.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 26, horizontal: 16),
            decoration: BoxDecoration(
              color: const Color(0xFF12151C),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFF21262D)),
            ),
            alignment: Alignment.center,
            child: Text(
              '还没有设定宏观目标\n在思源罗盘或网页端确立目标，前瞻推演将在此汇聚',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: Colors.grey[500], height: 1.5),
            ),
          )
        else
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: goals.length,
            separatorBuilder: (_, __) => const SizedBox(height: 12),
            itemBuilder: (_, i) {
              final g = goals[i];
              return _buildGoalCard(g);
            },
          ),
      ],
    );
  }

  /// 单个目标卡片
  Widget _buildGoalCard(GoalInfo g) {
    final (statusColor, statusLabel) = g.statusPill;
    final progressInt = g.progress.clamp(0.0, 100.0).round();
    final isExpanded = _expandedGoalIds.contains(g.id);
    final linkedTasks = g.linkedTasks;
    final hasTasks = linkedTasks.isNotEmpty;

    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF12151C),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF21262D)),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 目标分类、状态、进度百分比
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFF171B24),
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: const Color(0xFF30363D)),
                ),
                child: Text(
                  g.categoryLabel,
                  style: const TextStyle(fontSize: 11, color: Colors.white70),
                ),
              ),
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: statusColor.withValues(alpha: 0.3)),
                ),
                child: Text(
                  statusLabel,
                  style: TextStyle(fontSize: 11, color: statusColor, fontWeight: FontWeight.w600),
                ),
              ),
              const Spacer(),
              Text(
                '$progressInt%',
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF5B9CF8),
                ),
              ),
            ],
          ),

          const SizedBox(height: 10),

          // 目标标题
          Text(
            g.title,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: Colors.white,
            ),
          ),

          if (g.description != null && g.description!.trim().isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              g.description!.trim(),
              style: TextStyle(
                fontSize: 12.5,
                color: Colors.grey[400],
                height: 1.4,
              ),
            ),
          ],

          const SizedBox(height: 10),

          // 进度条 (progress %)
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: (g.progress / 100.0).clamp(0.0, 1.0),
              minHeight: 6,
              backgroundColor: const Color(0xFF171B24),
              valueColor: AlwaysStoppedAnimation(
                g.progress >= 100 ? const Color(0xFF3FB950) : const Color(0xFF5B9CF8),
              ),
            ),
          ),

          const SizedBox(height: 8),

          // 截止时间与工作目录元信息
          Row(
            children: [
              if (g.deadline != null && g.deadline!.isNotEmpty) ...[
                Text(
                  '截止: ${g.deadline!.split("T").first}',
                  style: TextStyle(fontSize: 11, color: Colors.grey[400]),
                ),
                const SizedBox(width: 8),
              ],
              if (g.cwd != null && g.cwd!.isNotEmpty)
                Expanded(
                  child: Text(
                    '目录: ${g.cwd}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      color: Colors.grey[500],
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
            ],
          ),

          // 前瞻推演最新产物
          if (g.lastSpeculatedResult != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                color: const Color(0xFF171B24),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: const Color(0xFF21262D)),
              ),
              child: Row(
                children: [
                  Icon(
                    g.lastSpeculatedResult!.ok ? Icons.check_circle_outline : Icons.error_outline,
                    size: 13,
                    color: g.lastSpeculatedResult!.ok
                        ? const Color(0xFF3FB950)
                        : const Color(0xFFF85149),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '前瞻推演${g.lastSpeculatedResult!.ok ? "通过" : "预警"}: ${g.lastSpeculatedResult!.summary ?? (g.lastSpeculatedResult!.ok ? "沙箱试错完毕" : "发现落差")}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, color: Colors.grey[300]),
                    ),
                  ),
                ],
              ),
            ),
          ],

          // 关联任务展开区 (linkedTasks)
          if (hasTasks) ...[
            const SizedBox(height: 10),
            const Divider(color: Color(0xFF21262D), height: 1),
            const SizedBox(height: 8),
            InkWell(
              onTap: () {
                setState(() {
                  if (isExpanded) {
                    _expandedGoalIds.remove(g.id);
                  } else {
                    _expandedGoalIds.add(g.id);
                  }
                });
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    const Icon(Icons.link, size: 14, color: Color(0xFF5B9CF8)),
                    const SizedBox(width: 5),
                    Text(
                      '关联支撑任务 (${linkedTasks.length})',
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF5B9CF8),
                      ),
                    ),
                    const Spacer(),
                    Icon(
                      isExpanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                      size: 18,
                      color: Colors.grey[400],
                    ),
                  ],
                ),
              ),
            ),
            if (isExpanded) ...[
              const SizedBox(height: 6),
              ListView.separated(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: linkedTasks.length,
                separatorBuilder: (_, __) => const Divider(
                  color: Color(0xFF21262D),
                  height: 14,
                  thickness: 0.6,
                ),
                itemBuilder: (_, j) {
                  final t = linkedTasks[j];
                  return _buildTaskItem(t, goalId: g.id);
                },
              ),
            ],
          ],
        ],
      ),
    );
  }
}
