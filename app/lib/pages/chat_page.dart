import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:image_picker/image_picker.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:url_launcher/url_launcher.dart';
import '../core/client.dart';
import '../core/md_style.dart';
import '../core/protocol.dart';
import 'call_page.dart';

/// 聊天页：流式输出、Markdown、工具时间线（含入参/输出详情）、思考折叠、权限审批、
/// 打断、自动决策切换、附件发送、模型/模式下拉、对话内搜索与定位、我的发言索引、
/// 决策记录/改动文件面板、接续到新会话、回到底部。
class ChatPage extends StatefulWidget {
  final GateClient client;
  final String sessionId;
  const ChatPage({super.key, required this.client, required this.sessionId});

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _entries = <Entry>[];
  final _input = TextEditingController();
  final _scroll = ScrollController();
  StreamSubscription? _sub;
  StreamSubscription? _sessSub;
  bool _waiting = false;
  bool _streaming = false;
  int? _highlightIndex; // 搜索/我的发言定位后的高亮条目
  Timer? _highlightTimer;

  /// 待发送附件（选好的图片，base64）
  final _pendingAtt = <({String name, String mimeType, String base64})>[];

  /* ---------- 语音输入（系统 SpeechRecognizer，中文优先） ---------- */
  final _speech = stt.SpeechToText();
  bool _speechReady = false;
  bool _listening = false;
  String _preVoice = ''; // 开始听之前输入框已有的内容，识别文本接在后面
  static const _systemCh = MethodChannel('harnessgate/system');

  Future<void> _openSystemSettings(String method) async {
    try {
      await _systemCh.invokeMethod(method);
    } catch (_) {/* 打不开就算了，SnackBar 里已有文字指引 */}
  }

  /// error_permission 多半不是本应用没权限，而是系统「语音识别服务」自身没有麦克风权限
  /// （插件官方 issue #641）。这里给出可操作的自救指引。
  Future<void> _onSpeechError(SpeechRecognitionError e) async {
    if (!mounted) return;
    if (e.permanent) setState(() => _listening = false);
    var hasMic = true;
    try {
      hasMic = await _speech.hasPermission;
    } catch (_) {}
    if (!mounted) return;
    final isPerm = e.errorMsg.contains('permission');
    final msg = isPerm
        ? (hasMic
            ? '系统语音识别服务没有麦克风权限：请在设置里给它开启麦克风'
            : '本应用没有麦克风权限，请在系统设置中允许')
        : '语音识别出错：${e.errorMsg}';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 8),
        content: Text(msg),
        action: isPerm
            ? SnackBarAction(
                label: '去设置',
                onPressed: () => _openSystemSettings(
                    hasMic ? 'openSpeechServiceSettings' : 'openAppSettings'),
              )
            : null,
      ),
    );
  }

  Future<void> _toggleVoice() async {
    if (_listening) {
      await _speech.stop();
      if (mounted) setState(() => _listening = false);
      return;
    }
    if (!_speechReady) {
      bool ok = false;
      try {
        ok = await _speech.initialize(
          onError: _onSpeechError,
          onStatus: (s) {
            if (s == 'done' || s == 'notListening') {
              if (mounted && _listening) setState(() => _listening = false);
            }
          },
        );
      } catch (_) {
        ok = false;
      }
      if (!ok) {
        final denied = !await _speech.hasPermission;
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(denied
                  ? '麦克风权限被拒，请在系统设置中允许本应用使用麦克风'
                  : '此设备没有可用的语音识别引擎（可在系统设置中安装/启用语音输入服务）'),
            ),
          );
        }
        return;
      }
      _speechReady = true;
    }
    _preVoice = _input.text;
    setState(() => _listening = true);
    // 语言包查询在部分 ROM 上会走「广播问 Google」而挂住，绝不能阻塞 listen，
    // 因此加超时兜底，查不到就用设备默认语言。
    String? localeId;
    try {
      final locales = await _speech.locales().timeout(const Duration(milliseconds: 1500));
      final zh = locales
          .where((l) => l.localeId.toLowerCase().startsWith('zh'))
          .toList();
      if (zh.isNotEmpty) {
        localeId = zh
            .firstWhere(
              (l) => l.localeId.toLowerCase().replaceAll('-', '_').startsWith('zh_cn'),
              orElse: () => zh.first,
            )
            .localeId;
      }
    } catch (_) {
      localeId = null;
    }
    try {
      await _speech.listen(
        onResult: (r) {
          if (!mounted) return;
          setState(() {
            _input.text = _preVoice + (_preVoice.isEmpty ? '' : ' ') + r.recognizedWords;
            _input.selection = TextSelection.collapsed(offset: _input.text.length);
          });
        },
        listenOptions: stt.SpeechListenOptions(
          partialResults: true,
          listenMode: stt.ListenMode.dictation,
          localeId: localeId,
          listenFor: const Duration(seconds: 60),
          pauseFor: const Duration(seconds: 5),
        ),
      );
    } catch (_) {
      if (mounted) setState(() => _listening = false);
    }
  }

  /// session-detail 数据（决策记录/改动文件面板共用，ValueNotifier 驱动 sheet 刷新）
  final _detail = ValueNotifier<Map<String, dynamic>?>(null);

  SessionInfo? get _session => widget.client.sessions[widget.sessionId];

  @override
  void initState() {
    super.initState();
    widget.client.viewingSessionId = widget.sessionId; // 正在看的会话不弹通知
    _sub = widget.client.messages.listen(_onMsg);
    // 会话状态变化（运行中/空闲/待审批/收藏/配置）要刷新 AppBar 与配置项。
    // 注意：不再发 msgList()——hello 已带会话快照，更新由广播驱动；转场期间一次全量
    // session 广播会触发整页重建，正是「内容先出现又闪没」的元凶之一。
    _sessSub = widget.client.sessionsChanged.listen((_) {
      if (mounted) setState(() {});
    });
    // 回底按钮可见性走 ValueNotifier 局部刷新——滚动监听里整页 setState 会把
    // 大列表的每次滚动都变成全量重建（转场期掉帧/闪白的另一元凶）
    _scroll.addListener(() {
      _showBackBtn.value = _scroll.hasClients &&
          (_scroll.position.maxScrollExtent - _scroll.position.pixels) > 400;
    });
    // 进程内缓存：先把上次渲染的台账秒显出来，再向服务端拉最新覆盖——不必每次点会话都从头加载
    final cached = widget.client.transcriptCache.get(widget.sessionId);
    if (cached != null && cached.isNotEmpty) {
      _entries
        ..clear()
        ..addAll(cached);
      _transcriptLoaded = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });
    }
    widget.client.send(msgTranscript(widget.sessionId, limit: _windowSize));
  }

  /// 向上翻更早一窗（在顶部按钮/滚动到顶时调用）
  void _loadEarlier() {
    if (_loadingEarlier || _windowStart <= 0) return;
    setState(() => _loadingEarlier = true);
    widget.client.send(msgTranscript(widget.sessionId, before: _windowStart, limit: _windowSize));
  }

  @override
  void dispose() {
    _speech.cancel();
    if (widget.client.viewingSessionId == widget.sessionId) {
      widget.client.viewingSessionId = null;
    }
    _sub?.cancel();
    _sessSub?.cancel();
    _highlightTimer?.cancel();
    _detail.dispose();
    _showBackBtn.dispose();
    // 把当前渲染的台账写回缓存（下次进这个会话秒显）。空列表不覆盖已有缓存。
    if (_entries.isNotEmpty) widget.client.transcriptCache.put(widget.sessionId, _entries);
    super.dispose();
  }

  /// 回底按钮可见性（ValueNotifier：滚动时局部刷新，不整页 setState）
  final _showBackBtn = ValueNotifier<bool>(false);
  bool _transcriptLoaded = false;
  /// 台账窗口：只拉最近 N 条，进入大会话不再一次性解析 1.5MB；上滑可「加载更早」
  static const _windowSize = 80;
  int _windowStart = 0; // entries[0] 在整份台账中的下标
  int _total = 0; // 台账总条数
  bool _loadingEarlier = false;
  bool get _hasEarlier => _windowStart > 0;

  /* ---------- 滚动：智能跟随 + 回到底部 ---------- */

  /// 贴底判定：用于流式输出时自动跟随——用户上翻历史时不打扰
  bool get _nearBottom =>
      !_scroll.hasClients || (_scroll.position.maxScrollExtent - _scroll.position.pixels) < 220;

  void _jumpBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 150), curve: Curves.easeOut);
      }
    });
  }

  /// 新内容到达：贴底才跟随；翻历史时只刷新不抢滚动
  void _autoFollow() {
    if (_nearBottom) _jumpBottom();
  }

  /// 近似定位到第 index 条（惰性列表无精确锚点，按比例滚动；命中条目高亮 2.5s）
  void _jumpToIndex(int index) {
    setState(() => _highlightIndex = index);
    _highlightTimer?.cancel();
    _highlightTimer = Timer(const Duration(milliseconds: 2500), () {
      if (mounted) setState(() => _highlightIndex = null);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final target = _scroll.position.maxScrollExtent * (index / _entries.length.clamp(1, 1 << 30));
      _scroll.animateTo(target.clamp(0.0, _scroll.position.maxScrollExtent),
          duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
    });
  }

  /* ---------- 消息处理 ---------- */

  void _onMsg(Map<String, dynamic> m) {
    final sid = m['sessionId'] as String?;
    switch (m['type']) {
      case 'transcript':
        if (sid == widget.sessionId && m['entries'] is List) {
          final fresh = (m['entries'] as List).whereType<Map<String, dynamic>>().map(_entryFrom).toList();
          final start = (m['start'] as num?)?.toInt() ?? 0;
          final total = (m['total'] as num?)?.toInt() ?? fresh.length;
          // 更早的一窗（前插）：返回窗口正好接到当前窗口前面
          if (_loadingEarlier && _windowStart > 0 && start + fresh.length == _windowStart && start < _windowStart) {
            setState(() {
              _entries.insertAll(0, fresh);
              _windowStart = start;
              _total = total;
              _loadingEarlier = false;
            });
            break;
          }
          // 重复 transcript（重连/重进）防护：条目没变就不重灌——重灌会闪屏且打断滚动位置
          if (_transcriptLoaded &&
              fresh.length == _entries.length &&
              (fresh.isEmpty || fresh.last.text == _entries.last.text)) {
            _windowStart = start;
            _total = total;
            if (_loadingEarlier) setState(() => _loadingEarlier = false);
            break;
          }
          setState(() {
            _entries
              ..clear()
              ..addAll(fresh);
            _transcriptLoaded = true;
            _windowStart = start;
            _total = total;
            _loadingEarlier = false;
          });
          widget.client.transcriptCache.put(widget.sessionId, _entries);
          // 首次加载直接落底（animateTo 会与页面转场/手势竞争，表现为"划一下才出现"）
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
          });
        }
        break;
      case 'update':
        if (sid == widget.sessionId) _applyUpdate(m['update'] as Map<String, dynamic>? ?? {});
        break;
      case 'turn_end':
        if (sid == widget.sessionId) setState(() { _waiting = false; _streaming = false; });
        break;
      case 'voice-live-user':
        // 通话里用户说的话同样属于该会话台账：同步进对话时间线，
        // 否则通话期间会话页只剩 TA 的回复，要退出重进才看得到自己说的。
        // 该消息不带 sessionId，用当前通话的 callSessionId 判断归属于哪个会话。
        if (widget.client.voice.callSessionId == widget.sessionId) {
          final text = m['text'] as String? ?? '';
          if (text.isNotEmpty) {
            setState(() => _entries.add(Entry(kind: 'user', text: text)));
            _autoFollow();
          }
        }
        break;
      case 'permission':
        if (sid == widget.sessionId) {
          setState(() => _entries.add(Entry(
            kind: 'permission',
            title: m['title'] as String? ?? '工具调用',
            requestId: m['requestId'] as String?,
            options: ((m['options'] as List<dynamic>?) ?? [])
                .map((o) => (optionId: o['optionId'] as String, name: o['name'] as String))
                .toList(),
          )));
          _autoFollow();
        }
        break;
      case 'error':
        if (sid == null || sid == widget.sessionId) {
          setState(() => _entries.add(Entry(kind: 'error', message: m['message'] as String? ?? '未知错误')));
          _autoFollow();
        }
        break;
      case 'handoff_done':
        // 接续完成：跳转到新会话（替换当前页，返回键回到列表）
        if (m['from'] == widget.sessionId && m['to'] is String) {
          final to = m['to'] as String;
          Navigator.of(context).pushReplacement(
            MaterialPageRoute(builder: (_) => ChatPage(client: widget.client, sessionId: to)),
          );
        }
        break;
      case 'session-detail':
        if (sid == widget.sessionId) _detail.value = m;
        break;
    }
  }

  Entry _entryFrom(Map<String, dynamic> j) {
    final atts = (j['attachments'] as List<dynamic>?)?.whereType<Map<String, dynamic>>().toList();
    return Entry(
      kind: j['kind'] as String? ?? 'log',
      text: j['text'] as String?,
      title: j['title'] as String?,
      status: j['status'] as String?,
      toolCallId: j['toolCallId'] as String?,
      message: j['message'] as String?,
      answered: j['answered'] as String?,
      requestId: j['requestId'] as String?,
      options: (j['options'] as List<dynamic>?)
          ?.map((o) => (optionId: o['optionId'] as String, name: o['name'] as String))
          .toList(),
      detail: (j['detail'] as String?)?.isEmpty == true ? null : j['detail'] as String?,
      output: (j['output'] as String?)?.isEmpty == true ? null : j['output'] as String?,
      attachmentName: atts == null || atts.isEmpty ? null : atts.first['name'] as String?,
    );
  }

  /// ACP content 形态摊平成文本（与 server textOf 同语义）
  static String _textOf(dynamic v) {
    if (v == null) return '';
    if (v is String) return v;
    if (v is List) return v.map(_textOf).where((s) => s.isNotEmpty).join('\n');
    if (v is Map) {
      final text = v['text'];
      if (text is String) return text;
      if (v.containsKey('content')) return _textOf(v['content']);
      try { return jsonEncode(v); } catch (_) { return ''; }
    }
    return v.toString();
  }

  void _applyUpdate(Map<String, dynamic> u) {
    final kind = u['sessionUpdate'] as String? ?? '';
    final content = u['content'] as Map<String, dynamic>?;
    setState(() {
      switch (kind) {
        case 'agent_message_chunk':
          if (content?['type'] == 'text' && content?['text'] is String) {
            _appendStream('assistant', content!['text'] as String);
            _waiting = false;
          }
          break;
        case 'agent_thought_chunk':
          if (content?['type'] == 'text' && content?['text'] is String) {
            _appendStream('thought', content!['text'] as String);
          }
          break;
        case 'tool_call':
        case 'tool_call_update':
          _streaming = false;
          final id = (u['toolCallId'] ?? u['id'] ?? '').toString();
          final title = (u['title'] ?? u['name'] ?? u['toolName'] ?? '工具').toString();
          final detail = _textOf(u['rawInput'] ?? u['input']);
          final output = _textOf(u['rawOutput'] ?? u['output']);
          final idx = id.isEmpty ? -1 : _entries.indexWhere((e) => e.kind == 'tool' && e.toolCallId == id);
          final entry = Entry(
            kind: 'tool',
            title: title,
            toolCallId: id.isEmpty ? null : id,
            status: (u['status'] ?? 'pending').toString(),
            detail: detail.isEmpty || detail == '{}' ? null : (detail.length > 2000 ? '${detail.substring(0, 2000)}…' : detail),
            output: output.isEmpty ? null : (output.length > 2000 ? '${output.substring(0, 2000)}…' : output),
          );
          if (idx >= 0) {
            final old = _entries[idx];
            _entries[idx] = entry.copyWith(
              detail: entry.detail ?? old.detail, // update 阶段往往只有输出，保留入参
              title: title == '工具' ? old.title : null,
            );
          } else {
            _entries.add(entry);
          }
          _autoFollow();
          break;
        case 'hg_error':
          _entries.add(Entry(kind: 'error', message: u['message'] as String? ?? ''));
          break;
      }
    });
  }

  /// 流式追加：同 kind 的最后一条未收尾则续写
  void _appendStream(String kind, String text) {
    final last = _entries.isEmpty ? null : _entries.last;
    if (last != null && last.kind == kind && _streaming && last.text != null) {
      _entries[_entries.length - 1] = Entry(kind: kind, text: last.text! + text);
    } else {
      _streaming = true;
      _entries.add(Entry(kind: kind, text: text));
    }
    _autoFollow();
  }

  /* ---------- 发送（含附件） ---------- */

  Future<void> _pickImage() async {
    final p = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 70);
    if (p == null) return;
    final bytes = await p.readAsBytes();
    final mime = p.mimeType ?? 'image/png';
    setState(() => _pendingAtt.add((name: p.name.isEmpty ? '图片' : p.name, mimeType: mime, base64: base64Encode(bytes))));
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty && _pendingAtt.isEmpty) return;
    final s = _session;
    if (s == null || !s.live) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('会话未在运行，点右上「恢复」')));
      return;
    }
    widget.client.send(msgPromptWithAttachments(
      widget.sessionId,
      text,
      attachments: _pendingAtt.toList(),
    ));
    setState(() {
      _entries.add(Entry(
        kind: 'user',
        text: text.isEmpty ? '（图片）' : text,
        attachmentName: _pendingAtt.isEmpty ? null : _pendingAtt.first.name,
      ));
      _waiting = true;
      _pendingAtt.clear();
    });
    _input.clear();
    _jumpBottom();
  }

  void _approve(String requestId, String optionId) {
    widget.client.send(msgPermission(widget.sessionId, requestId, optionId));
    setState(() {
      final i = _entries.lastIndexWhere((e) => e.kind == 'permission' && e.requestId == requestId);
      if (i >= 0) _entries[i] = Entry(kind: 'permission', title: _entries[i].title, answered: '已发送');
    });
  }

  void _changeAutoApprove(String? level) {
    if (level != null) widget.client.send(msgSetAutoApprove(widget.sessionId, level));
  }

  void _toggleStar() {
    final s = _session;
    if (s == null) return;
    final v = !(s.starred ?? false);
    widget.client.send(msgStar(s.id, v));
    widget.client.sessions[s.id] = s.copyWith(starred: v);
    setState(() {});
  }

  /* ---------- 搜索 / 我的发言 ---------- */

  void _openSearch() {
    final q = TextEditingController();
    int pos = -1;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: StatefulBuilder(
          builder: (_, setSheet) {
            final hits = <int>[
              for (var i = 0; i < _entries.length; i++)
                if (q.text.trim().isNotEmpty &&
                    ((_entries[i].text ?? '') + (_entries[i].title ?? '') + (_entries[i].message ?? ''))
                        .toLowerCase()
                        .contains(q.text.trim().toLowerCase()))
                  i,
            ];
            void go(int delta) {
              if (hits.isEmpty) return;
              setSheet(() => pos = (pos < 0 ? 0 : (pos + delta + hits.length) % hits.length));
              _jumpToIndex(hits[pos]);
            }

            return SafeArea(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
                    child: Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: q,
                            autofocus: true,
                            decoration: const InputDecoration(hintText: '搜索对话内容…', isDense: true, border: OutlineInputBorder()),
                            onChanged: (_) => setSheet(() => pos = -1),
                          ),
                        ),
                        IconButton(onPressed: () => go(-1), icon: const Icon(Icons.keyboard_arrow_up)),
                        IconButton(onPressed: () => go(1), icon: const Icon(Icons.keyboard_arrow_down)),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Text(
                      hits.isEmpty ? '（无命中）' : '命中 ${hits.length} 条${pos >= 0 ? ' · 第 ${pos + 1} 条' : ''}',
                      style: TextStyle(fontSize: 12, color: Colors.grey[500]),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  void _openMyMessages() {
    final mine = <int>[for (var i = 0; i < _entries.length; i++) if (_entries[i].kind == 'user') i];
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(padding: const EdgeInsets.all(10), child: Text('我的发言（${mine.length}）', style: const TextStyle(fontWeight: FontWeight.w600))),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: mine.length,
                itemBuilder: (_, k) {
                  final i = mine[k];
                  final t = (_entries[i].text ?? '').replaceAll('\n', ' ');
                  return ListTile(
                    dense: true,
                    leading: Text('${k + 1}', style: TextStyle(fontSize: 11, color: Colors.grey[500])),
                    title: Text(t.isEmpty ? '（附件）' : (t.length > 60 ? '${t.substring(0, 60)}…' : t), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                    onTap: () {
                      Navigator.pop(ctx);
                      _jumpToIndex(i);
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /* ---------- 模型/模式配置 ---------- */

  void _openConfig() {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) {
        final s = _session;
        if (s == null) return const Center(child: Text('会话不存在'));
        // 排除 mode 类配置（与 web 一致：有 modes 时 mode 类 config 不重复显示）
        final hasModes = (s.modes?.availableModeIds ?? []).isNotEmpty;
        final opts = s.configOptions.where((o) => o.options.isNotEmpty && !(hasModes && (o.name ?? '').toLowerCase().contains('mode'))).toList();
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(padding: EdgeInsets.all(10), child: Text('模型与配置（对后续回合生效）', style: TextStyle(fontWeight: FontWeight.w600))),
              if (opts.isEmpty && !hasModes)
                Padding(padding: const EdgeInsets.all(10), child: Text('这个 harness 没有上报可切换配置', style: TextStyle(color: Colors.grey[500]))),
              for (final o in opts)
                ListTile(
                  dense: true,
                  title: Text(o.name ?? o.id, style: const TextStyle(fontSize: 13.5)),
                  subtitle: DropdownButton<String>(
                    isDense: true,
                    value: o.options.any((v) => v.value == o.currentValue) ? o.currentValue : null,
                    hint: const Text('选择', style: TextStyle(fontSize: 12)),
                    items: [for (final v in o.options) DropdownMenuItem(value: v.value, child: Text(v.name ?? v.value, style: const TextStyle(fontSize: 12.5)))],
                    onChanged: (v) {
                      if (v == null) return;
                      widget.client.send(msgConfig(widget.sessionId, o.id, v));
                      Navigator.pop(ctx);
                      ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('${o.name ?? o.id} → $v')));
                    },
                  ),
                ),
              if (hasModes)
                ListTile(
                  dense: true,
                  title: const Text('权限模式', style: TextStyle(fontSize: 13.5)),
                  subtitle: DropdownButton<String>(
                    isDense: true,
                    value: s.modes!.currentModeId,
                    items: [for (final id in s.modes!.availableModeIds) DropdownMenuItem(value: id, child: Text(id, style: const TextStyle(fontSize: 12.5)))],
                    onChanged: (v) {
                      if (v == null) return;
                      widget.client.send(msgMode(widget.sessionId, v));
                      Navigator.pop(ctx);
                      ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('模式 → $v')));
                    },
                  ),
                ),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
  }

  /* ---------- 决策记录 / 改动文件 ---------- */

  void _openDetail({required bool decisions}) {
    _detail.value = null;
    widget.client.send(msgSessionDetail(widget.sessionId));
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => FractionallySizedBox(
        heightFactor: 0.75,
        child: ValueListenableBuilder<Map<String, dynamic>?>(
          valueListenable: _detail,
          builder: (_, v, __) {
            if (v == null) {
              return const Center(child: Column(mainAxisSize: MainAxisSize.min, children: [CircularProgressIndicator(), SizedBox(height: 10), Text('加载中…')]));
            }
            if (decisions) {
              final list = (v['decisions'] as List<dynamic>? ?? []).whereType<Map<String, dynamic>>().toList();
              return Column(
                children: [
                  Padding(padding: const EdgeInsets.all(10), child: Text('决策记录（${list.length}）', style: const TextStyle(fontWeight: FontWeight.w600))),
                  Expanded(
                    child: list.isEmpty
                        ? Center(child: Text('还没有权限决策记录', style: TextStyle(color: Colors.grey[500])))
                        : ListView.builder(
                            itemCount: list.length,
                            itemBuilder: (_, i) {
                              final d = list[i];
                              final chosen = d['held'] == true ? '⚠ 拦截（等人工）' : (d['chosen'] as String? ?? '（等待审批）');
                              return ListTile(
                                dense: true,
                                title: Text('${d['danger'] == true ? '⚠️ ' : ''}${d['title'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                                subtitle: Text(
                                  '$chosen · ${d['auto'] == true ? '自动' : '人工'}${d['reason'] != null ? ' · ${d['reason']}' : ''}',
                                  style: const TextStyle(fontSize: 11.5),
                                  maxLines: 2, overflow: TextOverflow.ellipsis,
                                ),
                                trailing: Text(_shortTs(d['ts'] as String?), style: TextStyle(fontSize: 10.5, color: Colors.grey[500])),
                              );
                            },
                          ),
                  ),
                ],
              );
            }
            final list = (v['changes'] as List<dynamic>? ?? []).whereType<Map<String, dynamic>>().toList();
            return Column(
              children: [
                Padding(padding: const EdgeInsets.all(10), child: Text('改动文件（${list.length}${v['git'] == true ? ' · git' : ' · 台账'}）', style: const TextStyle(fontWeight: FontWeight.w600))),
                Expanded(
                  child: list.isEmpty
                      ? Center(child: Text('本会话没有改动记录', style: TextStyle(color: Colors.grey[500])))
                      : ListView.builder(
                          itemCount: list.length,
                          itemBuilder: (_, i) {
                            final f = list[i];
                            final size = (f['size'] as num?)?.toInt() ?? 0;
                            return ListTile(
                              dense: true,
                              leading: const Icon(Icons.description_outlined, size: 18),
                              title: Text(f['path'] as String? ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                              subtitle: Text(size > 1048576 ? '${(size / 1048576).toStringAsFixed(1)}MB' : '${(size / 1024).round()}KB', style: const TextStyle(fontSize: 11)),
                              trailing: IconButton(
                                icon: const Icon(Icons.download, size: 18),
                                tooltip: '下载',
                                onPressed: () => _download(f['path'] as String? ?? ''),
                              ),
                            );
                          },
                        ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  static String _shortTs(String? iso) {
    final t = DateTime.tryParse(iso ?? '');
    return t == null ? '' : '${t.month}/${t.day} ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  }

  Future<void> _download(String path) async {
    if (path.isEmpty) return;
    final url = Uri.parse(widget.client.downloadUrl(widget.sessionId, path));
    try {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('打开下载失败：$e')));
    }
  }

  /* ---------- 会话操作 ---------- */

  Future<void> _confirmDelete() async {
    final s = _session;
    if (s == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除会话'),
        content: Text('删除「${s.title?.isNotEmpty == true ? s.title : s.id}」？该操作不可撤销。'),
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
      widget.client.transcriptCache.remove(widget.sessionId);
      widget.client.send(msgDelete(widget.sessionId));
      if (mounted) Navigator.of(context).pop();
    }
  }

  /// 状态胶囊（运行中/空闲/待审批/已存档…）——不用点开任何东西就能看到会话当前状态
  Widget _statusPill(SessionInfo? s) {
    if (s == null) return const SizedBox.shrink();
    final (color, label) = pillOfSession(s);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Text(label, style: TextStyle(fontSize: 10.5, color: color, fontWeight: FontWeight.w600)),
    );
  }

  /// 拨号前选语音模式：转文字（默认）/ 直传音频（仅 harness 支持时可选）+ 是否本地记账
  Future<void> _openCallDialog() async {
    final canAudio = _session?.promptAudio == true;
    var mode = 'stt';
    var transcribe = false;
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) {
          Widget opt(String val, String title, String sub, {bool enabled = true}) {
            final sel = mode == val;
            return ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              enabled: enabled,
              leading: Icon(sel ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                  color: enabled ? const Color(0xFF5B9CF8) : Colors.grey),
              title: Text(title, style: const TextStyle(fontSize: 14)),
              subtitle: Text(sub, style: const TextStyle(fontSize: 11.5)),
              onTap: enabled ? () => setLocal(() => mode = val) : null,
            );
          }

          return AlertDialog(
            title: const Text('📞 语音通话'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                opt('stt', '转文字', '本地识别成文字再发给它'),
                opt('audio', '直传音频', canAudio ? '把这句音频原样发给它' : '当前 harness 不支持', enabled: canAudio),
                if (mode == 'audio')
                  CheckboxListTile(
                    dense: true,
                    contentPadding: const EdgeInsets.only(left: 24),
                    controlAffinity: ListTileControlAffinity.leading,
                    value: transcribe,
                    title: const Text('仍本地转写并记进会话台账', style: TextStyle(fontSize: 13)),
                    onChanged: (v) => setLocal(() => transcribe = v ?? false),
                  ),
              ],
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
              FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('开始通话')),
            ],
          );
        },
      ),
    );
    if (go == true && mounted) {
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => CallPage(client: widget.client, sessionId: widget.sessionId, mode: mode, transcribe: transcribe),
        ),
      );
    }
  }

  /// 当前模型 chip：AppBar 一眼可见（对齐 web 顶栏模型选择器），点按打开模型/配置面板
  Widget _modelChip(SessionInfo? s) {
    final hasModes = (s?.modes?.availableModeIds ?? []).isNotEmpty;
    ConfigOption? modelCfg;
    for (final o in s?.configOptions ?? const <ConfigOption>[]) {
      if (o.options.isEmpty) continue;
      if (hasModes && (o.name ?? '').toLowerCase().contains('mode')) continue;
      modelCfg = o;
      break;
    }
    if (modelCfg == null) return const SizedBox.shrink();
    String curName = modelCfg.currentValue ?? modelCfg.id;
    for (final o in modelCfg.options) {
      if (o.value == modelCfg.currentValue) curName = o.name ?? o.value;
    }
    final short = curName.length > 10 ? '${curName.substring(0, 10)}…' : curName;
    return ActionChip(
      tooltip: '模型：$curName（点按切换）',
      visualDensity: VisualDensity.compact,
      avatar: const Icon(Icons.memory, size: 14, color: Color(0xFF5B9CF8)),
      label: Text(short, style: const TextStyle(fontSize: 11)),
      onPressed: _openConfig,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = _session;
    final inTurn = s?.inTurn == true;
    // 自动决策档位：图标颜色 + 图标下的文字直接显示当前档位，不用点开菜单猜
    final aa = s?.autoApprove ?? 'off';
    final (aaColor, aaIcon, aaLabel) = switch (aa) {
      'all' => (const Color(0xFF3FB950), Icons.shield, '全自动'),
      'readonly' => (const Color(0xFFD29922), Icons.shield_outlined, '只读'),
      _ => (Colors.grey, Icons.shield_outlined, '人工'),
    };
    PopupMenuEntry<String> aaItem(String value, String label) => PopupMenuItem<String>(
          value: value,
          child: Row(
            children: [
              SizedBox(
                width: 22,
                child: aa == value ? Icon(Icons.check, size: 15, color: aaColor) : null,
              ),
              Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  color: aa == value ? aaColor : null,
                  fontWeight: aa == value ? FontWeight.w600 : null,
                ),
              ),
            ],
          ),
        );
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            _statusPill(s),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(s?.title?.isNotEmpty == true ? s!.title! : '会话', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16)),
                  Text('${s?.harnessLabel ?? ''} · ${s?.cwd ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w400)),
                ],
              ),
            ),
          ],
        ),
        actions: [
          if (s?.live == true)
            IconButton(
              tooltip: '实时语音通话（可插话；挂断自动还原模型）',
              icon: const Icon(Icons.phone_in_talk, size: 21, color: Color(0xFF3FB950)),
              onPressed: _openCallDialog,
            ),
          _modelChip(s),
          IconButton(
            tooltip: '搜索对话内容',
            icon: const Icon(Icons.search, size: 20),
            onPressed: _openSearch,
          ),
          if (inTurn)
            IconButton(
              tooltip: '打断当前回合',
              icon: const Icon(Icons.stop_circle_outlined, color: Color(0xFFF85149)),
              onPressed: () => widget.client.send(msgInterrupt(widget.sessionId)),
            )
          else if (s != null && !s.live && s.resumable)
            IconButton(
              tooltip: '恢复会话',
              icon: const Icon(Icons.play_circle_outline, color: Color(0xFF3FB950)),
              onPressed: () => widget.client.send(msgResume(widget.sessionId)),
            ),
          PopupMenuButton<String>(
            onSelected: _changeAutoApprove,
            tooltip: '自动决策档位（当前：$aaLabel）',
            icon: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(aaIcon, size: 20, color: aaColor),
                Text(aaLabel, style: TextStyle(fontSize: 8.5, height: 1.1, color: aaColor)),
              ],
            ),
            itemBuilder: (_) => [
              aaItem('off', '人工审批'),
              aaItem('readonly', '只读自动'),
              aaItem('all', '全自动'),
            ],
          ),
          PopupMenuButton<String>(
            onSelected: (v) {
              switch (v) {
                case 'star': _toggleStar(); break;
                case 'stop': widget.client.send(msgClose(widget.sessionId)); break;
                case 'resume': widget.client.send(msgResume(widget.sessionId)); break;
                case 'delete': _confirmDelete(); break;
                case 'config': _openConfig(); break;
                case 'search': _openSearch(); break;
                case 'mine': _openMyMessages(); break;
                case 'decisions': _openDetail(decisions: true); break;
                case 'changes': _openDetail(decisions: false); break;
                case 'handoff':
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('正在把历史复制到新会话…')));
                  widget.client.send(msgHandoff(widget.sessionId));
                  break;
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'config', child: Text('模型与配置')),
              const PopupMenuItem(value: 'search', child: Text('搜索对话')),
              const PopupMenuItem(value: 'mine', child: Text('我的发言')),
              const PopupMenuItem(value: 'decisions', child: Text('🧾 决策记录')),
              const PopupMenuItem(value: 'changes', child: Text('📄 改动文件')),
              PopupMenuItem(value: 'star', child: Text((s?.starred ?? false) ? '★ 取消收藏' : '☆ 收藏置顶')),
              const PopupMenuItem(value: 'handoff', child: Text('➡️ 接续到新会话')),
              if (s?.live == true) const PopupMenuItem(value: 'stop', child: Text('停止进程')),
              if (s != null && !s.live && s.resumable) const PopupMenuItem(value: 'resume', child: Text('恢复会话')),
              const PopupMenuItem(value: 'delete', child: Text('删除会话', style: TextStyle(color: Color(0xFFF85149)))),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: Stack(
              children: [
                ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  // 转圈只在「已发出消息但还没任何输出」时出现；开始流式（思考/正文）即隐藏
                  itemCount: (_hasEarlier ? 1 : 0) + _entries.length + (_waiting && !_streaming ? 1 : 0),
                  itemBuilder: (_, i) {
                    if (_hasEarlier && i == 0) return _loadEarlierRow();
                    final idx = i - (_hasEarlier ? 1 : 0);
                    if (idx >= _entries.length) {
                      return const Padding(
                        padding: EdgeInsets.all(10),
                        child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
                      );
                    }
                    return _bubble(_entries[idx], idx);
                  },
                ),
                // 局部刷新：滚动不触发整页 setState（修转场闪白/掉帧）
                ValueListenableBuilder<bool>(
                  valueListenable: _showBackBtn,
                  builder: (_, show, __) => show
                      ? Positioned(
                          right: 12,
                          bottom: 12,
                          child: FloatingActionButton.small(
                            heroTag: 'toBottom',
                            tooltip: '回到底部（最新消息）',
                            onPressed: _jumpBottom,
                            child: const Icon(Icons.arrow_downward, size: 18),
                          ),
                        )
                      : const SizedBox.shrink(),
                ),
              ],
            ),
          ),
          if (_pendingAtt.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 2, 12, 0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Wrap(
                  spacing: 6,
                  children: [
                    for (final a in _pendingAtt)
                      InputChip(
                        label: Text('🖼 ${a.name}', style: const TextStyle(fontSize: 12)),
                        onDeleted: () => setState(() => _pendingAtt.remove(a)),
                      ),
                  ],
                ),
              ),
            ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              child: Row(
                children: [
                  IconButton(
                    tooltip: '添加图片附件',
                    icon: const Icon(Icons.attach_file, size: 20),
                    onPressed: _pickImage,
                  ),
                  IconButton(
                    tooltip: _listening ? '停止语音输入' : '语音输入',
                    icon: Icon(
                      _listening ? Icons.mic : Icons.mic_none,
                      size: 22,
                      color: _listening ? const Color(0xFFF85149) : null,
                    ),
                    onPressed: _toggleVoice,
                  ),
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      onSubmitted: (_) => _send(),
                      decoration: InputDecoration(
                        hintText: _listening
                            ? '🎙 正在听…（点麦克风结束）'
                            : s?.live == true
                                ? '说点什么…'
                                : '会话未运行（右上可恢复）',
                        isDense: true,
                        border: const OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _send,
                    icon: const Icon(Icons.send, size: 20),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 列表顶部的「加载更早」入口（窗口模式下前面还有更早的台账）
  Widget _loadEarlierRow() {
    final remain = (_total - _entries.length).clamp(0, 1 << 30);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Center(
        child: _loadingEarlier
            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
            : TextButton.icon(
                onPressed: _loadEarlier,
                icon: const Icon(Icons.history, size: 16),
                label: Text('加载更早的对话${remain > 0 ? "（还有 $remain 条）" : ""}', style: const TextStyle(fontSize: 12.5)),
              ),
      ),
    );
  }

  Widget _bubble(Entry e, int index) {
    final highlighted = _highlightIndex == index;
    Widget wrap(Widget child, {EdgeInsetsGeometry margin = const EdgeInsets.only(bottom: 10)}) => Container(
          margin: margin,
          decoration: highlighted
              ? BoxDecoration(
                  color: const Color(0xFFF5B942).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFFF5B942).withValues(alpha: 0.6)),
                )
              : null,
          child: child,
        );
    switch (e.kind) {
      case 'user':
        return wrap(
          Align(
            alignment: Alignment.centerRight,
            child: Container(
              margin: const EdgeInsets.only(left: 48),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(color: const Color(0xFF1F2733), borderRadius: BorderRadius.circular(10)),
              child: Text(e.text ?? '', style: const TextStyle(fontSize: 14)),
            ),
          ),
        );
      case 'assistant':
        return wrap(
          Container(
            margin: const EdgeInsets.only(right: 16),
            padding: const EdgeInsets.symmetric(horizontal: 4),
            alignment: Alignment.centerLeft,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                MarkdownBody(data: e.text ?? '', selectable: true, styleSheet: hgMarkdownStyle(context)),
                if ((e.text ?? '').trim().isNotEmpty)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: () => widget.client.voice.speak(e.text ?? ''),
                      icon: const Icon(Icons.volume_up, size: 14),
                      label: const Text('朗读', style: TextStyle(fontSize: 12)),
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        foregroundColor: Colors.grey[500],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          margin: const EdgeInsets.only(bottom: 12, right: 16),
        );
      case 'thought':
        // 正在思考：实时展开流式内容（对齐 web）；结束后转折叠块省空间
        final thinking = _streaming && index == _entries.length - 1;
        if (thinking) {
          return wrap(
            Container(
              margin: const EdgeInsets.only(bottom: 10, right: 16),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                border: Border.all(color: Colors.grey.withValues(alpha: 0.25)),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('💭 思考中…', style: TextStyle(fontSize: 11.5, color: Colors.grey[500])),
                  const SizedBox(height: 4),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 260),
                    child: SingleChildScrollView(
                      child: Text(e.text ?? '', style: TextStyle(fontSize: 12.5, color: Colors.grey[400])),
                    ),
                  ),
                ],
              ),
            ),
          );
        }
        return wrap(
          Theme(
            data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              dense: true,
              initiallyExpanded: false,
              title: Text('💭 思考过程', style: TextStyle(fontSize: 12, color: Colors.grey[400])),
              children: [
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(e.text ?? '', style: TextStyle(fontSize: 12, color: Colors.grey[400])),
                ),
              ],
            ),
          ),
        );
      case 'tool':
        final hasDetail = (e.detail?.isNotEmpty ?? false) || (e.output?.isNotEmpty ?? false);
        return wrap(
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: const Color(0xFFD29922).withValues(alpha: 0.8), width: 3)),
              color: Colors.white.withValues(alpha: 0.03),
            ),
            child: hasDetail
                ? Theme(
                    data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                    child: ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      dense: true,
                      title: Text('🔧 ${e.title ?? ''}  [${e.status ?? ''}]',
                          style: TextStyle(fontSize: 12.5, color: Colors.grey[400])),
                      children: [
                        if (e.detail?.isNotEmpty ?? false)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Align(alignment: Alignment.centerLeft, child: Text('入参', style: TextStyle(fontSize: 10.5, color: Colors.grey[600]))),
                          ),
                        if (e.detail?.isNotEmpty ?? false)
                          Container(
                            constraints: const BoxConstraints(maxHeight: 220),
                            width: double.infinity,
                            child: SingleChildScrollView(child: SelectableText(e.detail ?? '', style: TextStyle(fontSize: 11, color: Colors.grey[500]))),
                          ),
                        if (e.output?.isNotEmpty ?? false)
                          Padding(
                            padding: const EdgeInsets.only(top: 4, bottom: 4),
                            child: Align(alignment: Alignment.centerLeft, child: Text('输出', style: TextStyle(fontSize: 10.5, color: Colors.grey[600]))),
                          ),
                        if (e.output?.isNotEmpty ?? false)
                          Container(
                            constraints: const BoxConstraints(maxHeight: 300),
                            width: double.infinity,
                            child: SingleChildScrollView(child: SelectableText(e.output ?? '', style: TextStyle(fontSize: 11, color: Colors.grey[500]))),
                          ),
                      ],
                    ),
                  )
                : Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text('🔧 ${e.title ?? ''}  [${e.status ?? ''}]', style: TextStyle(fontSize: 12.5, color: Colors.grey[400])),
                  ),
          ),
          margin: const EdgeInsets.only(bottom: 8),
        );
      case 'permission':
        return wrap(
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              border: Border.all(color: const Color(0xFFD29922)),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('🔐 需要授权：${e.title ?? ''}', style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                if (e.answered == null && (e.options?.isNotEmpty ?? false)) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    children: (e.options!).map((o) => FilledButton.tonal(
                      onPressed: e.requestId != null ? () => _approve(e.requestId!, o.optionId) : null,
                      child: Text(o.name, style: const TextStyle(fontSize: 12.5)),
                    )).toList(),
                  ),
                ] else
                  Padding(padding: const EdgeInsets.only(top: 6), child: Text('已处理', style: TextStyle(fontSize: 12, color: Colors.grey[500]))),
              ],
            ),
          ),
        );
      case 'error':
        return wrap(
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: const Color(0xFF190D0E),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFF85149).withValues(alpha: 0.5)),
            ),
            child: Text('✕ ${e.message ?? ''}', style: const TextStyle(fontSize: 12.5, color: Color(0xFFF85149))),
          ),
        );
      default:
        return wrap(Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(e.text ?? '', style: TextStyle(fontSize: 11.5, color: Colors.grey[600]))));
    }
  }
}
