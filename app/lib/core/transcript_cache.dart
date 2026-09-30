import 'protocol.dart';

/// 会话台账的进程内缓存：按 sessionId 记住"最近一次渲染出来的条目"。
/// 重进会话时先秒显缓存，再向服务端拉最新并覆盖——不用每次都等网络往返 + 解析。
/// 只缓存最近 [maxSessions] 个会话（LRU），避免长时间使用后无限占用内存。
class TranscriptCache {
  TranscriptCache({this.maxSessions = 8});
  final int maxSessions;
  final _map = <String, List<Entry>>{};

  /// 取缓存并把该会话移到队尾（最近使用）
  List<Entry>? get(String sessionId) {
    final v = _map.remove(sessionId);
    if (v != null) _map[sessionId] = v;
    return v;
  }

  bool has(String sessionId) => _map.containsKey(sessionId);

  void put(String sessionId, List<Entry> entries) {
    _map.remove(sessionId);
    _map[sessionId] = List<Entry>.of(entries); // 拷贝，避免外部继续改动影响缓存
    while (_map.length > maxSessions) {
      _map.remove(_map.keys.first);
    }
  }

  void remove(String sessionId) => _map.remove(sessionId);
  void clear() => _map.clear();
}
