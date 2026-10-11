import 'dart:convert';
import 'dart:io';
import 'package:shared_preferences/shared_preferences.dart';

/// 应用日志：内存环形缓冲（最近 400 条），按需上传到 HarnessGate 服务器定位连接问题。
/// 刻意不落盘、不无限积累：连接类问题现场复现后立即上传即可，崩溃类问题另行处理。
class AppLog {
  AppLog._();
  static final AppLog I = AppLog._();
  static const _maxEntries = 400;
  final List<String> _buf = [];
  String? _device;

  Future<String> deviceId() async {
    if (_device != null) return _device!;
    final p = await SharedPreferences.getInstance();
    var d = p.getString('hg_device');
    if (d == null || d.isEmpty) {
      d = 'dev${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}${(DateTime.now().microsecondsSinceEpoch & 0xFFFFFFF).toRadixString(36)}';
      await p.setString('hg_device', d);
    }
    _device = d;
    return d;
  }

  void log(String line) {
    final t = DateTime.now();
    final stamp =
        '${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')} ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')}';
    _buf.add('$stamp $line');
    if (_buf.length > _maxEntries) _buf.removeRange(0, _buf.length - _maxEntries);
  }

  String dump() => _buf.join('\n');

  /// 上传到 HarnessGate 服务器（POST /applog）。返回服务器保存的文件名，失败返回 null。
  Future<String?> upload(String baseUrl, String token) async {
    try {
      final dev = await deviceId();
      final base = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
      final client = HttpClient();
      final req = await client.postUrl(Uri.parse('$base/applog?device=${Uri.encodeComponent(dev)}'));
      req.headers.set('Authorization', 'Bearer $token');
      req.headers.contentType = ContentType.text;
      req.add(utf8.encode(dump()));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      client.close(force: true);
      if (res.statusCode == 200) {
        log('日志已上传');
        return body;
      }
      log('日志上传失败: HTTP ${res.statusCode}');
      return null;
    } catch (e) {
      log('日志上传异常: $e');
      return null;
    }
  }
}
