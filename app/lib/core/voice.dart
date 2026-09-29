import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:record/record.dart';

import 'client.dart';
import 'protocol.dart';

/// 通话阶段（对齐 web 舞台的 listening/thinking/speaking/error）
enum CallPhase { idle, listening, thinking, speaking, error }

/// 语音服务：消息朗读（voice-tts）与实时通话（voice-live）。
/// 识别、断句、TTS、延迟优化全在服务端；app 只负责采集（流式 PCM）、
/// 播放（队列）、字幕展示和插话检测（AEC 后能量）。
class VoiceService {
  VoiceService(this._c) {
    _sub = _c.messages.listen(_onMsg);
  }

  final GateClient _c;
  late final StreamSubscription _sub;

  /* ================= 消息朗读（voice-tts） ================= */

  final _ttsWaiters = <String, Completer<String?>>{};
  AudioPlayer? _ttsPlayer;
  bool ttsPlaying = false;

  /// 朗读一段文本；再次点击时先停掉上一段
  Future<void> speak(String text) async {
    final clean = cleanForSpeech(text);
    if (clean.isEmpty) return;
    if (ttsPlaying) {
      try {
        await _ttsPlayer?.stop();
      } catch (_) {}
      ttsPlaying = false;
    }
    final reqId = 'tts-${DateTime.now().millisecondsSinceEpoch}';
    final done = Completer<String?>();
    _ttsWaiters[reqId] = done;
    _c.send(msgVoiceTts(reqId, clean));
    final b64 = await done.future.timeout(const Duration(seconds: 45), onTimeout: () => null);
    if (b64 == null || b64.isEmpty) return;
    final f = File('${Directory.systemTemp.path}/hg-tts-$reqId.mp3');
    try {
      await f.writeAsBytes(base64Decode(b64));
      _ttsPlayer ??= AudioPlayer();
      ttsPlaying = true;
      await _ttsPlayer!.setFilePath(f.path);
      await _ttsPlayer!.play();
    } catch (_) {} finally {
      ttsPlaying = false;
      try {
        await f.delete();
      } catch (_) {}
    }
  }

  /// 朗读前清理：markdown 念出来难听，代码块跳过（与服务端 cleanForSpeech 同规则）
  static String cleanForSpeech(String text) {
    return text
        .replaceAllMapped(RegExp(r'```[\s\S]*?```'), (_) => '（代码略）')
        .replaceAllMapped(RegExp(r'`([^`]+)`'), (m) => m.group(1) ?? '')
        .replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), '')
        .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]*\)'), (m) => m.group(1) ?? '')
        .replaceAll(RegExp(r'^#{1,6}\s+', multiLine: true), '')
        .replaceAll(RegExp(r'[*_~>|]+'), '')
        .replaceAll(RegExp(r'\n{2,}'), '\n')
        .trim();
  }

  /* ================= 实时通话（voice-live） ================= */

  final rec = AudioRecorder();
  AudioPlayer? _callPlayer;
  StreamSubscription? _recSub;
  final _acc = <int>[];
  final _callQueue = <String>[];
  bool _callPlaying = false;
  int _bargeHot = 0;
  String? callSessionId;

  final phase = ValueNotifier<CallPhase>(CallPhase.idle);
  final note = ValueNotifier<String>('');
  final partial = ValueNotifier<String>('');
  final agentBuf = ValueNotifier<String>('');
  final callLines = ValueNotifier<List<String>>(const []);

  bool get inCall => callSessionId != null;

  /// 发起通话。麦克风权限由 record 插件顺带申请。
  Future<bool> startCall(String sessionId) async {
    if (inCall) return false;
    try {
      if (!await rec.hasPermission()) return false;
    } catch (_) {
      return false;
    }
    callSessionId = sessionId;
    partial.value = '';
    agentBuf.value = '';
    callLines.value = const [];
    phase.value = CallPhase.listening;
    note.value = '连接中…（接通自动切快速模型，挂断还原）';
    _c.send(msgVoiceLiveStart(sessionId));
    _callPlayer ??= AudioPlayer();
    _callPlayer!.processingStateStream.listen((st) {
      if (st == ProcessingState.completed) {
        _callPlaying = false;
        _playNext();
      }
    });
    final stream = await rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
      // voiceCommunication = 系统级 AEC/NS：免提插话检测靠它
      androidConfig: AndroidRecordConfig(audioSource: AndroidAudioSource.voiceCommunication),
    ));
    _recSub = stream.listen(_onPcm, onError: (_) {});
    return true;
  }

  Future<void> endCall() async {
    if (callSessionId == null) return;
    callSessionId = null;
    try {
      await _recSub?.cancel();
    } catch (_) {}
    _recSub = null;
    try {
      await rec.stop();
    } catch (_) {}
    _stopPlayback();
    _c.send(msgVoiceLiveStop());
    phase.value = CallPhase.idle;
    note.value = '';
  }

  void _onPcm(Uint8List data) {
    if (callSessionId == null) return;
    _acc.addAll(data);
    while (_acc.length >= 3200) {
      // 3200 字节 = 1600 样本 = 100ms @16k 单声道 s16le
      final frame = Uint8List.fromList(_acc.sublist(0, 3200));
      _acc.removeRange(0, 3200);
      _handleFrame(frame);
    }
  }

  void _handleFrame(Uint8List frame) {
    // 插话检测：正在播 TA 的语音时，AEC 之后仍有持续高能量 = 用户在说话
    final bd = ByteData.sublistView(frame);
    var energy = 0.0;
    for (var i = 0; i + 1 < frame.length; i += 2) {
      final v = bd.getInt16(i, Endian.little) / 32768.0;
      energy += v * v;
    }
    final rms = sqrt(energy / (frame.length / 2));
    if (_callPlaying && rms > 0.022) {
      if (++_bargeHot >= 2) {
        _bargeHot = 0;
        barge();
        return;
      }
    } else {
      _bargeHot = 0;
    }
    _c.send(msgVoiceLiveChunk(base64Encode(frame)));
  }

  void barge() {
    _stopPlayback();
    _c.send(msgVoiceLiveBarge());
    phase.value = CallPhase.listening;
    note.value = '已打断播放，请讲';
  }

  Future<void> _enqueueAudio(String b64, String mime) async {
    if (callSessionId == null || b64.isEmpty) return;
    try {
      final ext = mime.contains('wav') ? 'wav' : 'mp3';
      final f = File('${Directory.systemTemp.path}/hg-call-${DateTime.now().microsecondsSinceEpoch}.$ext');
      await f.writeAsBytes(base64Decode(b64));
      _callQueue.add(f.path);
      _playNext();
    } catch (_) {}
  }

  Future<void> _playNext() async {
    if (callSessionId == null || _callPlaying || _callQueue.isEmpty) return;
    _callPlaying = true;
    final p = _callPlayer!;
    try {
      await p.setFilePath(_callQueue.removeAt(0));
      await p.play();
    } catch (_) {
      _callPlaying = false;
      _playNext();
    }
  }

  void _stopPlayback() {
    _callQueue.clear();
    try {
      _callPlayer?.stop();
    } catch (_) {}
    _callPlaying = false;
  }

  /* ================= 服务端消息 ================= */

  void _onMsg(Map<String, dynamic> m) {
    switch (m['type'] as String?) {
      case 'voice-tts-result':
        final reqId = m['reqId'] as String?;
        final c = reqId == null ? null : _ttsWaiters.remove(reqId);
        if (c != null && !c.isCompleted) {
          c.complete(m['error'] != null ? null : m['audio'] as String?);
        }
        break;
      case 'voice-live-partial':
        partial.value = m['text'] as String? ?? '';
        break;
      case 'voice-live-user':
        callLines.value = [...callLines.value, '你：${m['text'] ?? ''}'];
        partial.value = '';
        agentBuf.value = '';
        break;
      case 'voice-live-agent-audio':
        _enqueueAudio(m['audio'] as String? ?? '', m['mime'] as String? ?? 'audio/mpeg');
        break;
      case 'voice-live-phase':
        phase.value = switch (m['phase']) {
          'thinking' => CallPhase.thinking,
          'speaking' => CallPhase.speaking,
          'error' => CallPhase.error,
          'done' => CallPhase.idle,
          _ => CallPhase.listening,
        };
        final n = m['note'] as String?;
        if (n != null && n.isNotEmpty) note.value = n;
        break;
      case 'update':
        // 通话字幕：搭车 agent 流式文本（与服务端同时广播给 web）
        if (callSessionId != null && m['sessionId'] == callSessionId) {
          final u = m['update'] as Map<String, dynamic>?;
          if (u?['sessionUpdate'] == 'agent_message_chunk') {
            final t = (u!['content'] as Map<String, dynamic>?)?['text'] as String?;
            if (t != null && t.isNotEmpty) agentBuf.value += t;
          }
        }
        break;
    }
  }

  Future<void> dispose() async {
    await _sub.cancel();
    await endCall();
    try {
      await _ttsPlayer?.dispose();
    } catch (_) {}
    try {
      await _callPlayer?.dispose();
    } catch (_) {}
    try {
      await rec.dispose();
    } catch (_) {}
  }
}
