import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'protocol.dart';

/// HarnessGate WS 客户端：自动重连 + 消息分发（broadcast 流，页面各自监听）。
class GateClient {
  WebSocketChannel? _ws;
  Timer? _retry;
  bool _closedByUs = false;
  String _url = '';
  String _token = '';

  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  final _stateCtrl = StreamController<String>.broadcast(); // idle/connecting/connected/error
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
  String defaultCwd = '';

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
      final port = u.hasPort && !((u.scheme == 'http' && u.port == 80) || (u.scheme == 'https' && u.port == 443))
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
    b = b.replaceFirst(RegExp('^https://'), 'wss://').replaceFirst(RegExp('^http://'), 'ws://');
    final query = token.trim().isEmpty ? '' : '?token=${Uri.encodeComponent(token.trim())}';
    return '$b/ws$query';
  }

  /// 会话改动文件的下载链接（http 直链，带 token；改动面板点击下载用）
  String downloadUrl(String sessionId, String path) {
    final base = _url.replaceFirst('wss://', 'https://').replaceFirst('ws://', 'http://');
    final q = _token.isEmpty ? '' : '&token=${Uri.encodeComponent(_token)}';
    return '$base/download?session=${Uri.encodeComponent(sessionId)}&path=${Uri.encodeComponent(path)}$q';
  }

  /// http(s) 形式的服务地址（APP 更新中转下载用）
  String get httpBase => _url.replaceFirst('wss://', 'https://').replaceFirst('ws://', 'http://');

  /// 带 token 的 query（中转下载鉴权用）
  String get tokenQuery => _token.isEmpty ? '' : 'token=${Uri.encodeComponent(_token)}';

  void _doConnect() {
    if (_url.isEmpty) return;
    _stateCtrl.add('connecting');
    try {
      final ws = WebSocketChannel.connect(Uri.parse(buildWsUrl(_url, _token)));
      _ws = ws;
      ws.stream.listen(
        (data) {
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
          if (!_closedByUs) {
            _stateCtrl.add('error');
            _scheduleRetry();
          } else {
            _stateCtrl.add('idle');
          }
        },
        onError: (_) {
          _ws = null;
          _stateCtrl.add('error');
          _scheduleRetry();
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
      serverVersion = m['version'] as String? ?? '';
      serverCommit = m['commit'] as String? ?? '';
      changed = true;
    } else if (m['type'] == 'session' && m['session'] is Map<String, dynamic>) {
      final s = SessionInfo.fromJson(m['session'] as Map<String, dynamic>);
      sessions[s.id] = s;
      changed = true;
    } else if (m['type'] == 'deleted' && m['sessionId'] is String) {
      sessions.remove(m['sessionId']);
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
    // 未连接：hello 到来后由 UI 重新拉取；这里静默丢弃（与网页端行为一致）
  }

  void dispose() {
    _closedByUs = true;
    _retry?.cancel();
    _ws?.sink.close();
    _messages.close();
    _stateCtrl.close();
    _sessionsCtrl.close();
  }
}
