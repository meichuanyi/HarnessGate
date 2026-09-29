import 'dart:async';

import 'package:flutter/material.dart';

import '../core/client.dart';
import '../core/voice.dart';
import 'call_page.dart';

/// 全局悬浮通话条：通话进行中且通话页不在前台时，顶部悬浮显示
/// 状态呼吸点 + 会话名 + 通话时长 + 回到通话 / 挂断。挂在 MaterialApp.builder，
/// 任何页面（列表/对话/其他栏目）都覆盖——边通话边看别的会话。
class CallOverlay extends StatefulWidget {
  final GateClient client;
  final Widget child;
  const CallOverlay({super.key, required this.client, required this.child});

  @override
  State<CallOverlay> createState() => _CallOverlayState();
}

class _CallOverlayState extends State<CallOverlay> {
  Timer? _ticker; // 每秒重建刷新通话时长

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  void _ensureTicker(bool need) {
    if (need && _ticker == null) {
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!need) {
      _ticker?.cancel();
      _ticker = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.client.voice;
    // 同时监听「是否在通话」与「通话页是否在前台」：两者任一变化都要立即显隐悬浮条
    return ListenableBuilder(
      listenable: Listenable.merge([v.callStartedAt, v.callPageVisible]),
      builder: (_, __) {
        final started = v.callStartedAt.value;
        final show = started != null && !v.callPageVisible.value;
        _ensureTicker(show);
        if (started == null || !show) return widget.child;
        final dur = DateTime.now().difference(started);
        final mm = (dur.inMinutes % 60).toString().padLeft(2, '0');
        final ss = (dur.inSeconds % 60).toString().padLeft(2, '0');
        final sid = v.callSessionId ?? '';
        final s = widget.client.sessions[sid];
        final title = s?.title?.isNotEmpty == true ? s!.title! : sid;
        return Stack(
          children: [
            Positioned.fill(child: widget.child),
            SafeArea(
              child: Align(
                alignment: Alignment.topCenter,
                child: Padding(
                  padding: const EdgeInsets.only(top: 6, left: 10, right: 10),
                  child: Material(
                    elevation: 6,
                    borderRadius: BorderRadius.circular(999),
                    color: const Color(0xFF16202E),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(999),
                      onTap: () => Navigator.of(context, rootNavigator: true).push(
                        MaterialPageRoute(builder: (_) => CallPage(client: widget.client, sessionId: sid)),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            ValueListenableBuilder<CallPhase>(
                              valueListenable: v.phase,
                              builder: (_, phase, __) {
                                final color = switch (phase) {
                                  CallPhase.listening => const Color(0xFF2EA043),
                                  CallPhase.speaking => const Color(0xFF58A6FF),
                                  CallPhase.thinking => const Color(0xFFD29922),
                                  CallPhase.error => const Color(0xFFF85149),
                                  CallPhase.idle => Colors.grey,
                                };
                                return Container(
                                  width: 9,
                                  height: 9,
                                  decoration: BoxDecoration(
                                    color: color,
                                    shape: BoxShape.circle,
                                    boxShadow: [BoxShadow(color: color.withValues(alpha: 0.6), blurRadius: 8)],
                                  ),
                                );
                              },
                            ),
                            const SizedBox(width: 8),
                            ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 180),
                              child: Text(
                                '通话中 $mm:$ss · ${title.length > 14 ? '${title.substring(0, 14)}…' : title}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 12.5, color: Color(0xFFE8EBF1)),
                              ),
                            ),
                            const SizedBox(width: 4),
                            IconButton(
                              tooltip: '挂断',
                              visualDensity: VisualDensity.compact,
                              icon: const Icon(Icons.call_end, size: 18, color: Color(0xFFF85149)),
                              onPressed: () => v.endCall(),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}
