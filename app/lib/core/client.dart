import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'protocol.dart';
import 'update.dart';
import 'transcript_cache.dart';
import 'voice.dart';

/// HarnessGate WS 客户端：自动重连 + 消息分发（broadcast 流，页面各自监听）。
class GateClient {
  WebSocketChannel? _ws;
  Timer? _retry;
  bool _closedByUs = false;
  String _url = '';
  String _token = '';

  /// 语音服务（朗读 + 实时通话）：跟着客户端走，识别/TTS 都在服务端
  late final VoiceService voice = VoiceService(this);

  /// 会话台账进程内缓存：重进会话先秒显，后台再刷新
  final transcriptCache = TranscriptCache();

  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  final _stateCtrl =
      StreamController<String>.broadcast(); // idle/connecting/connected/error
  Stream<String> get state => _stateCtrl.stream;

  /// 会话列表快照（hello/session 消息自动维护）
  final Map<String, SessionInfo> sessions = {};
  final _sessionsCtrl = StreamController<void>.broadcast();
  Stream<void> get sessionsChanged => _sessionsCtrl.stream;

  /// 可用 harness（hello 下发，新建会话时选择）
  final Map<String, HarnessInfo> harnesses = {};

  /// 服务端版本与 commit（hello 下发，「关于」页展示）
  String serverVersion = '';
  String serverCommit = '';

  /// 常驻助理会话 id（hello 下发；null = 尚未创建）
  String? assistantSessionId;

  /// 半开死链检测：20s 一发 ping，45s 无任何下行数据（pong 也是数据）即强制重连
  Timer? _heartbeat;

  /// 服务端是否支持心跳（hello 版本门槛判定）
  bool _heartbeatSupported = false;
  DateTime _lastReceived = DateTime.now();

  /// 断线期间待发消息（重连 hello 后补发；上限 50 防爆）
  final List<Map<String, dynamic>> _outbox = [];

  /// 用户当前正在查看的会话 id（ChatPage 维护；通知模块据此跳过同屏打扰）
  String? viewingSessionId;

  /// 圆桌房间快照（hello/room/rooms 消息自动维护）
  final Map<String, RoomInfo> rooms = {};
  final _roomsCtrl = StreamController<void>.broadcast();
  Stream<void> get roomsChanged => _roomsCtrl.stream;

  /// 定时任务快照（schedules 消息维护；schedules-list 主动拉取）
  List<ScheduleInfo> schedules = [];
  final _schedulesCtrl = StreamController<void>.broadcast();
  Stream<void> get schedulesChanged => _schedulesCtrl.stream;

  /// 最近一次工作区报告（workspace 请求/响应）
  List<WorkspaceReport>? workspaceReports;
  final _workspaceCtrl = StreamController<void>.broadcast();
  Stream<void> get workspaceChanged => _workspaceCtrl.stream;
  String defaultCwd = '';

  /// 受管 MCP 服务器（hello/mcp 消息自动维护；新建会话时选择注入哪些）
  List<McpServerInfo> mcpServers = [];
  final _mcpCtrl = StreamController<void>.broadcast();
  Stream<void> get mcpChanged => _mcpCtrl.stream;

  /// 技能快照（hello/skills 消息维护）：主库 + 各 harness 挂载视图
  List<SkillInfo> skillLibrary = [];
  List<SkillMountInfo> skillMounts = [];
  final _skillsCtrl = StreamController<void>.broadcast();
  Stream<void> get skillsChanged => _skillsCtrl.stream;

  bool get connected => _ws != null;

  void connect(String baseUrl, String token) {
    _url = normalizeBaseUrl(baseUrl);
    _token = token.trim();
    _closedByUs = false;
    _doConnect();
  }

  /// 用户输入容错：粘贴网页完整链接（带路径/hash/尾部斜杠）也能用——只保留 协议+主机+端口。
  /// 裸地址默认补 http（局域网填 IP:端口 的场景最多）。
  static String normalizeBaseUrl(String input) {
    final s = input.trim();
    if (s.isEmpty) return '';
    try {
      final u = Uri.parse(s.contains('://') ? s : 'http://$s');
      final port = u.hasPort &&
              !((u.scheme == 'http' && u.port == 80) ||
                  (u.scheme == 'https' && u.port == 443))
          ? ':${u.port}'
          : '';
      return '${u.scheme}://${u.host}$port';
    } catch (_) {
      return s.replaceAll(RegExp(r'/+$'), '');
    }
  }

  /// WebSocket 地址：http(s) 自动转 ws(s)，已填 ws/wss 的原样保留。
  static String buildWsUrl(String baseUrl, String token) {
    var b = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    b = b
        .replaceFirst(RegExp('^https://'), 'wss://')
        .replaceFirst(RegExp('^http://'), 'ws://');
    final query = token.trim().isEmpty
        ? ''
        : '?token=${Uri.encodeComponent(token.trim())}';
    return '$b/ws$query';
  }

  /// 会话改动文件的下载链接（http 直链，带 token；改动面板点击下载用）
  String downloadUrl(String sessionId, String path) {
    final base = _url
        .replaceFirst('wss://', 'https://')
        .replaceFirst('ws://', 'http://');
    final q = _token.isEmpty ? '' : '&token=${Uri.encodeComponent(_token)}';
    return '$base/download?session=${Uri.encodeComponent(sessionId)}&path=${Uri.encodeComponent(path)}$q';
  }

  /// http(s) 形式的服务地址（APP 更新中转下载用）
  String get httpBase =>
      _url.replaceFirst('wss://', 'https://').replaceFirst('ws://', 'http://');

  /// 带 token 的 query（中转下载鉴权用）
  String get tokenQuery =>
      _token.isEmpty ? '' : 'token=${Uri.encodeComponent(_token)}';

  void _doConnect() {
    if (_url.isEmpty) return;
    _stateCtrl.add('connecting');
    try {
      // 连接必须带硬超时：WS 升级被网络中间设备挂起时 pending 永不触发事件，
      // 没有超时就永远不会自动重试（用户实测：浏览器通、APP 死等的根因）
      final ws = IOWebSocketChannel.connect(
        Uri.parse(buildWsUrl(_url, _token)),
        connectTimeout: const Duration(seconds: 10),
      );
      _ws = ws;
      _startHeartbeat();
      ws.stream.listen(
        (data) {
          _lastReceived = DateTime.now();
          _stateCtrl.add('connected');
          _retry?.cancel();
          try {
            final m = jsonDecode(data as String) as Map<String, dynamic>;
            _applySessions(m);
            _messages.add(m);
          } catch (_) {}
        },
        onDone: () {
          _ws = null;
          _stopHeartbeat();
          if (!_closedByUs) {
            _stateCtrl.add('error');
            _scheduleRetry();
          } else {
            _stateCtrl.add('idle');
          }
        },
        onError: (_) {
          _ws = null;
          _stopHeartbeat();
          _stateCtrl.add('error');
          _scheduleRetry(); // 4s 后再试——网络恢复瞬间自动接上（含连接超时/握手失败）
        },
      );
    } catch (e) {
      _stateCtrl.add('error');
      _scheduleRetry();
    }
  }

  void _scheduleRetry() {
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 4), _doConnect);
  }

  void _applySessions(Map<String, dynamic> m) {
    var changed = false;
    if (m['type'] == 'hello') {
      sessions
        ..clear()
        ..addEntries(((m['sessions'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map((j) => MapEntry(j['id'] as String, SessionInfo.fromJson(j))));
      harnesses
        ..clear()
        ..addEntries(((m['harnesses'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map((j) => MapEntry(j['id'] as String, HarnessInfo.fromJson(j))));
      defaultCwd = m['defaultCwd'] as String? ?? '';
      mcpServers = ((m['mcpServers'] as List<dynamic>?) ?? [])
          .whereType<Map<String, dynamic>>()
          .map(McpServerInfo.fromJson)
          .toList();
      _mcpCtrl.add(null);
      final sk = m['skills'];
      if (sk is Map<String, dynamic>) {
        skillLibrary = ((sk['library'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map(SkillInfo.fromJson)
            .toList();
        skillMounts = ((sk['mounts'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map(SkillMountInfo.fromJson)
            .toList();
        _skillsCtrl.add(null);
      }
      serverVersion = m['version'] as String? ?? '';
      assistantSessionId = m['assistantSessionId'] as String?;

      // 心跳需要服务端 pong 支持（≥0.6.25）；旧服务端会对 ping 回"未知消息类型"错误，
      // 所以低版本服务端直接禁用心跳（宁缺死链检测，不刷错误）
      _heartbeatSupported = serverVersion.isEmpty
          ? false
          : AppUpdate.compareVersions(serverVersion, '0.6.25') >= 0;

      // 重连后补发断线期间的消息（hello 之后发，服务端已就绪）
      if (_outbox.isNotEmpty) {
        for (final om in _outbox.take(50)) {
          try {
            _ws?.sink.add(jsonEncode(om));
          } catch (_) {}
        }
        _outbox.clear();
      }
      serverCommit = m['commit'] as String? ?? '';
      rooms
        ..clear()
        ..addEntries(((m['rooms'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map((j) => MapEntry(j['id'] as String, RoomInfo.fromJson(j))));
      _roomsCtrl.add(null);
      changed = true;
    } else if (m['type'] == 'room' && m['room'] is Map<String, dynamic>) {
      final r = RoomInfo.fromJson(m['room'] as Map<String, dynamic>);
      rooms[r.id] = r;
      _roomsCtrl.add(null);
    } else if (m['type'] == 'schedules' && m['schedules'] is List) {
      schedules = (m['schedules'] as List<dynamic>)
          .whereType<Map<String, dynamic>>()
          .map(ScheduleInfo.fromJson)
          .toList();
      _schedulesCtrl.add(null);
    } else if (m['type'] == 'workspace' && m['reports'] is List) {
      workspaceReports = (m['reports'] as List<dynamic>)
          .whereType<Map<String, dynamic>>()
          .map(WorkspaceReport.fromJson)
          .toList();
      _workspaceCtrl.add(null);
    } else if (m['type'] == 'rooms' && m['rooms'] is List) {
      rooms
        ..clear()
        ..addEntries((m['rooms'] as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .map((j) => MapEntry((j)['id'] as String, RoomInfo.fromJson(j))));
      _roomsCtrl.add(null);
    } else if (m['type'] == 'skills' && m['library'] is List) {
      skillLibrary = ((m['library'] as List<dynamic>?) ?? [])
          .whereType<Map<String, dynamic>>()
          .map(SkillInfo.fromJson)
          .toList();
      skillMounts = ((m['mounts'] as List<dynamic>?) ?? [])
          .whereType<Map<String, dynamic>>()
          .map(SkillMountInfo.fromJson)
          .toList();
      _skillsCtrl.add(null);
    } else if (m['type'] == 'mcp' && m['servers'] is List) {
      mcpServers = (m['servers'] as List<dynamic>)
          .whereType<Map<String, dynamic>>()
          .map(McpServerInfo.fromJson)
          .toList();
      _mcpCtrl.add(null);
    } else if (m['type'] == 'session' && m['session'] is Map<String, dynamic>) {
      final s = SessionInfo.fromJson(m['session'] as Map<String, dynamic>);
      sessions[s.id] = s;
      // 助理会话可能被「换芯重建」（删旧建新）：跟随广播保持入口指向最新
      if (s.assistant) assistantSessionId = s.id;
      changed = true;
    } else if (m['type'] == 'deleted' && m['sessionId'] is String) {
      sessions.remove(m['sessionId']);
      if (m['sessionId'] == assistantSessionId) assistantSessionId = null;
      changed = true;
    }
    if (changed) _sessionsCtrl.add(null);
  }

  void send(Map<String, dynamic> msg) {
    final ws = _ws;
    if (ws != null) {
      try {
        ws.sink.add(jsonEncode(msg));
        return;
      } catch (_) {}
    }
    // 未连接：入队暂存（hello 后补发），不再静默丢弃——半开/断线窗口发的消息
    // 就是之前「助理不响应」的元凶
    if (msg['type'] != 'ping' && _outbox.length < 50) _outbox.add(msg);
  }

  /// 半开心跳：20s 发 ping；45s 无任何下行数据视为死链，强制断开触发重连
  void _startHeartbeat() {
    _heartbeat?.cancel();
    _lastReceived = DateTime.now();
    _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
      if (_ws == null || !_heartbeatSupported) return;
      final silent = DateTime.now().difference(_lastReceived);
      if (silent.inSeconds > 45) {
        try {
          _ws?.sink.close();
        } catch (_) {}
        _ws = null;
        return; // onDone 走重连
      }
      try {
        _ws?.sink.add(jsonEncode({'type': 'ping'}));
      } catch (_) {}
    });
  }

  void _stopHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = null;
  }

  int _reqSeq = 0;

  /// reqId 关联的请求-响应：发送 msg（自动附 reqId），等待同 type+reqId 的回复。
  /// 超时/断连返回 null，调用方按「无数据」降级（如目录补全静默不显示）
  Future<Map<String, dynamic>?> request(
    String respType,
    Map<String, dynamic> msg, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final reqId = 'app-${DateTime.now().microsecondsSinceEpoch}-${_reqSeq++}';
    final resp = Completer<Map<String, dynamic>?>();
    StreamSubscription? sub;
    sub = messages.listen((m) {
      if (m['type'] == respType && m['reqId'] == reqId && !resp.isCompleted) {
        resp.complete(m);
      }
    });
    send({...msg, 'reqId': reqId});
    try {
      return await resp.future.timeout(timeout);
    } on TimeoutException {
      return null;
    } finally {
      await sub.cancel();
    }
  }

  void dispose() {
    _closedByUs = true;
    _retry?.cancel();
    _ws?.sink.close();
    voice.dispose();
    _messages.close();
    _stateCtrl.close();
    _sessionsCtrl.close();
  }
}
