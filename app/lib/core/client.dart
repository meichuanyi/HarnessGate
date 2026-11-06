import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'protocol.dart';
import 'applog.dart';
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

  /// 目标推进与生活运转快照（hello / goals 消息自动维护）
  List<GoalInfo> goals = [];
  List<MindwtrTaskInfo> lifeTasks = [];
  final _goalsCtrl = StreamController<void>.broadcast();
  Stream<void> get goalsChanged => _goalsCtrl.stream;

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
    AppLog.I.log('connect: host=${Uri.parse(_url).host} token=${_token.isEmpty ? '无' : '有'}');
    _doConnect();
  }

  /// 用户输入容错：粘贴网页完整链接（带路径/hash/尾部斜杠）也能用——只保留 协议+主机+端口。
  /// 裸地址按主机类型补协议：本机/内网 IP → http（无证书场景）；
  /// 公网域名 → https（443/TLS 全链路验证过通）。之前一律补 http，
  /// 公网域名会落到 ws://80 明文链路——服务器侧通，但手机运营商网络常把明文
  /// WebSocket 拦成黑洞，表现为「连接发起后永远等不到任何回调」。
  static String normalizeBaseUrl(String input) {
    final s = input.trim();
    if (s.isEmpty) return '';
    try {
      final hasScheme = s.contains('://');
      final u = Uri.parse(hasScheme ? s : 'http://$s');
      var scheme = u.scheme;
      if (!hasScheme) {
        final h = u.host;
        final isLocal = h == 'localhost' ||
            h.startsWith('127.') ||
            h.startsWith('192.168.') ||
            h.startsWith('10.') ||
            h.startsWith('fe80:') ||
            h.endsWith('.local') ||
            RegExp(r'^172\.(1[6-9]|2\d|3[01])\.').hasMatch(h);
        // 公网域名带非 443 端口多半是直连源站（无 TLS），也按 http 走
        final tlsOk = !isLocal && (!u.hasPort || u.port == 443);
        scheme = tlsOk ? 'https' : 'http';
      }
      final port = u.hasPort &&
              !((scheme == 'http' && u.port == 80) ||
                  (scheme == 'https' && u.port == 443))
          ? ':${u.port}'
          : '';
      return '$scheme://${u.host}$port';
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

  /// 原始 token（更新检查/下载走服务器中转时拼鉴权用）
  String get token => _token;

  void _doConnect() {
    if (_url.isEmpty) return;
    _attemptN++;
    final wsUrl = buildWsUrl(_url, _token);
    _connectStartedAt = DateTime.now();
    // 日志里绝不落 token 明文；带序号和完整 ws 地址，才能看出 scheme/端口/重试节奏
    AppLog.I.log(
        'ws connecting #$_attemptN → ${wsUrl.replaceAll(RegExp(r'token=[^&]+'), 'token=***')}');
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
      // 包内 connectTimeout 实测在部分手机网络下不回调（日志只有 connecting 一行、
      // 无 error 无重试）——自己再兜一层看门狗，12s 没握手成功就强制掐掉重来
      _handshakeDone = false;
      _connectWatch?.cancel();
      _connectWatch = Timer(const Duration(seconds: 12), () {
        if (_handshakeDone || _ws == null) return;
        AppLog.I.log('ws 连接 12s 无进展（网络拦截/服务器不可达/明文 WS 被丢包），强制重试');
        _lastError = '连接超时：服务器不可达，或当前网络拦截了这个连接';
        _ws = null;
        _stopHeartbeat();
        _stateCtrl.add('error');
        _scheduleRetry();
      });
      ws.stream.listen(
        (data) {
          if (!_handshakeDone) {
            _handshakeDone = true;
            _connectWatch?.cancel();
            _backoffN = 0;
            final ms = DateTime.now().difference(_connectStartedAt).inMilliseconds;
            AppLog.I.log('ws connected（握手 $ms ms，第 $_attemptN 次尝试）');
          }
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
          final code = _ws?.closeCode;
          AppLog.I.log('ws 连接关闭（code ${code ?? '?'}）');
          _connectWatch?.cancel();
          _ws = null;
          _stopHeartbeat();
          if (!_closedByUs) {
            if (code != null && code != 1000 && code != 1005) {
              _lastError = code == 4401
                  ? '服务端拒绝（4401）：token 缺失或不正确'
                  : '连接被服务端关闭（code $code）';
              AppLog.I.log(_lastError);
            }
            _stateCtrl.add('error');
            _scheduleRetry();
          } else {
            _stateCtrl.add('idle');
          }
        },
        onError: (e) {
          AppLog.I.log('ws error: $e');
          _lastError = e
              .toString()
              .split('\n')
              .first
              .replaceFirst(RegExp(r'^\w+Exception:\s*'), '');
          _connectWatch?.cancel();
          _ws = null;
          _stopHeartbeat();
          _stateCtrl.add('error');
          _scheduleRetry(); // 4s 后再试——网络恢复瞬间自动接上（含连接超时/握手失败）
        },
      );
    } catch (e) {
      _lastError = e.toString().split('\n').first;
      _stateCtrl.add('error');
      _scheduleRetry();
    }
  }

  /// 最近一次连接失败的原因（connect 页直接展示，别再只给笼统的「连接失败」）
  String _lastError = '';
  String get lastError => _lastError;

  /// 握手看门狗：包内 connectTimeout 在部分网络下不回调（真机日志实证），自己兜底
  Timer? _connectWatch;
  bool _handshakeDone = false;

  /// 断线重连退避：4s → 7s → 12s → 20s → 30s 封顶（连上即归零）——
  /// 服务器/网络真不可达时不再每 4s 干嚎一枪，省电也不刷日志
  int _backoffN = 0;
  int _attemptN = 0;
  DateTime _connectStartedAt = DateTime.now();
  static const _backoffSecs = [4, 7, 12, 20, 30];

  void _scheduleRetry() {
    _retry?.cancel();
    final d = Duration(seconds: _backoffSecs[_backoffN.clamp(0, _backoffSecs.length - 1)]);
    _backoffN++;
    AppLog.I.log('ws 将在 ${d.inSeconds}s 后重试（已失败 $_backoffN 次）');
    _retry = Timer(d, _doConnect);
  }

  void _applySessions(Map<String, dynamic> m) {
    var changed = false;
    if (m['type'] == 'hello') {
      // 服务端版本/提交进日志：排查「APP 连的是哪台/哪版」时不用猜
      AppLog.I.log(
          'hello: server v${m['version'] ?? '?'} ${m['commit'] ?? ''}，会话 ${(m['sessions'] as List<dynamic>?)?.length ?? 0} 个');
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
      // hello 附带 goals/lifeTasks 快照（服务端 mindwtrPayloadSync）——此前被丢弃，目标页
      // 全靠主动拉 goals-list 兜底；接上后断线重连/首连目标页即时有数据
      if (m['goals'] is List) {
        goals = (m['goals'] as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .map(GoalInfo.fromJson)
            .toList();
      }
      if (m['lifeTasks'] is List) {
        lifeTasks = (m['lifeTasks'] as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .map(MindwtrTaskInfo.fromJson)
            .toList();
      }
      _goalsCtrl.add(null);
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
    } else if (m['type'] == 'goals') {
      if (m['goals'] is List) {
        goals = (m['goals'] as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .map(GoalInfo.fromJson)
            .toList();
      }
      if (m['lifeTasks'] is List) {
        lifeTasks = (m['lifeTasks'] as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .map(MindwtrTaskInfo.fromJson)
            .toList();
      } else {
        lifeTasks = [];
      }
      _goalsCtrl.add(null);
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
    if (changed) {
      AppLog.I.log('sessions 同步: ${sessions.length} 个');
      _sessionsCtrl.add(null);
    }
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
        AppLog.I.log('心跳判死：${silent.inSeconds}s 未收到任何消息（半开连接），断开重连');
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
    _connectWatch?.cancel();
    _ws?.sink.close();
    voice.dispose();
    _messages.close();
    _stateCtrl.close();
    _sessionsCtrl.close();
    _goalsCtrl.close();
  }

  /// 「服务器配置」入口用：断开 + 停重连，但保留消息/状态流。
  /// dispose 是终局——控制器关了，回连后服务器的 hello 再也送不进页面，
  /// 连接页只能干等 12s 超时（齿轮进连接页后必卡死的根因）；软复位才能原地回来。
  void softReset() {
    _closedByUs = true;
    _retry?.cancel();
    _connectWatch?.cancel();
    _stopHeartbeat();
    try {
      _ws?.sink.close();
    } catch (_) {}
    _ws = null;
  }
}
