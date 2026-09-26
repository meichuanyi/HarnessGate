import 'package:shared_preferences/shared_preferences.dart';

/// 服务器配置（地址 + token），本地持久化。
class ServerConfig {
  static const kUrl = 'hg_server_url';
  static const kToken = 'hg_token';

  static Future<({String url, String token})> load() async {
    final p = await SharedPreferences.getInstance();
    return (url: p.getString(kUrl) ?? '', token: p.getString(kToken) ?? '');
  }

  static Future<void> save(String url, String token) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(kUrl, url.trim());
    await p.setString(kToken, token.trim());
  }
}
