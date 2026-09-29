import 'package:flutter/material.dart';

import '../core/client.dart';
import '../core/system_overlay.dart';
import '../core/voice.dart';

/// 实时通话页：全屏舞台——状态呼吸灯、实时字幕（你的部分识别 + TA 流式文本）、
/// 挂断键。逻辑全在 VoiceService / 服务端，这里只做展示与生命周期。
class CallPage extends StatefulWidget {
  final GateClient client;
  final String sessionId;
  const CallPage({super.key, required this.client, required this.sessionId});

  @override
  State<CallPage> createState() => _CallPageState();
}

class _CallPageState extends State<CallPage> {
  @override
  void initState() {
    super.initState();
    widget.client.voice.callPageVisible.value = true; // 通话页在前台：悬浮条隐藏
    // 同一会话的通话已在后台进行（从悬浮条回来）则不重拨；否则新发起
    if (widget.client.voice.callSessionId != widget.sessionId) {
      widget.client.voice.startCall(widget.sessionId);
    }
    // 没授悬浮窗权限时提示一次（退到后台就看不到悬浮条了）
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      if (!await SystemOverlay.canOverlay() && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: const Text('退到后台想继续看到通话悬浮条？需开启「显示在其他应用上层」'),
          duration: const Duration(seconds: 6),
          action: SnackBarAction(label: '去开启', onPressed: () => SystemOverlay.requestOverlay()),
        ));
      }
    });
  }

  @override
  void dispose() {
    // 离开页面 ≠ 挂断：通话挂在 VoiceService 上继续，悬浮条随时可回本页
    widget.client.voice.callPageVisible.value = false;
    super.dispose();
  }

  void _hangup() {
    widget.client.voice.endCall();
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.client.voice;
    return Scaffold(
      backgroundColor: const Color(0xFF0B0E14),
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: 24),
            ValueListenableBuilder(
              valueListenable: v.phase,
              builder: (_, phase, __) => _Orb(phase: phase),
            ),
            const SizedBox(height: 16),
            Expanded(
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 20),
                padding: const EdgeInsets.all(12),
                constraints: const BoxConstraints(maxWidth: 560),
                child: ListenableBuilder(
                  listenable: Listenable.merge([
                    v.callLines,
                    v.partial,
                    v.agentBuf,
                    v.phase,
                    v.note,
                  ]),
                    builder: (_, __) {
                      final lines = [
                        ...v.callLines.value,
                        if (v.partial.value.isNotEmpty) '你：${v.partial.value}…',
                        if (v.agentBuf.value.isNotEmpty) 'TA：${v.agentBuf.value}',
                      ];
                      return ListView(
                        children: [
                          for (final l in lines)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 4),
                              child: Text(
                                l,
                                style: TextStyle(
                                  fontSize: 15,
                                  height: 1.7,
                                  color: l.startsWith('你：') ? Colors.blue[200] : Colors.grey[300],
                                ),
                              ),
                            ),
                          if (lines.isEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: Text(
                                v.phase.value == CallPhase.listening ? '已接通，直接说话即可' : (v.note.value.isEmpty ? '…' : v.note.value),
                                textAlign: TextAlign.center,
                                style: TextStyle(fontSize: 13, color: Colors.grey[600]),
                              ),
                            ),
                        ],
                      );
                    },
                  ),
                ),
              ),
              ValueListenableBuilder(
                valueListenable: v.note,
                builder: (_, note, __) => Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: Text(
                    note.isEmpty ? '全双工通话 · 可随时插话 · 挂断自动还原模型' : note,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 12, color: Colors.grey[600]),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              FloatingActionButton.large(
                heroTag: 'hangup',
                backgroundColor: const Color(0xFFF85149),
                onPressed: _hangup,
                child: const Icon(Icons.call_end, size: 34),
              ),
              const SizedBox(height: 32),
            ],
          ),
        ),
    );
  }
}
class _Orb extends StatefulWidget {
  final CallPhase phase;
  const _Orb({required this.phase});
  @override
  State<_Orb> createState() => _OrbState();
}

class _OrbState extends State<_Orb> with SingleTickerProviderStateMixin {
  late final ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..repeat();

  @override
  void dispose() {
    ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final (color, icon) = switch (widget.phase) {
      CallPhase.listening => (const Color(0xFF2EA043), Icons.mic),
      CallPhase.thinking => (const Color(0xFFD29922), Icons.more_horiz),
      CallPhase.speaking => (const Color(0xFF58A6FF), Icons.graphic_eq),
      CallPhase.error => (const Color(0xFFF85149), Icons.warning_amber_rounded),
      CallPhase.idle => (Colors.grey, Icons.phone),
    };
    final pulse = widget.phase == CallPhase.listening || widget.phase == CallPhase.speaking;
    return ScaleTransition(
      scale: pulse ? Tween(begin: 0.96, end: 1.06).animate(CurvedAnimation(parent: ctrl, curve: Curves.easeInOut)) : const AlwaysStoppedAnimation(1.0),
      child: Container(
        width: 108,
        height: 108,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: const Color(0xFF151A23),
          border: Border.all(color: color, width: 2),
          boxShadow: [BoxShadow(color: color.withValues(alpha: 0.25), blurRadius: 30, spreadRadius: 2)],
        ),
        child: Icon(icon, size: 42, color: color),
      ),
    );
  }
}
