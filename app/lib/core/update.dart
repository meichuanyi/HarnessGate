import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// 应用内自更新：查 GitHub 最新 Release → 与本地版本比较 → 下载 APK → 调起系统安装。
///
/// 版本即 git tag（v0.3.0 ↔ pubspec 0.3.0），CI 打 tag 时构建 APK 附到 Release。
/// 匿名调 GitHub API（公开仓库，限流 60 次/h/IP，启动静默检查一次 + 手动检查足够）。
class AppUpdate {
  static const repo = 'meichuanyi/HarnessGate';

  /// Release tag（含 v 前缀，如 v0.3.0）
  final String tag;
  /// Release 标题
  final String name;
  /// 更新日志（Release body）
  final String notes;
  /// APK 下载地址（browser_download_url）
  final Uri apkUrl;

  const AppUpdate({required this.tag, required this.name, required this.notes, required this.apkUrl});

  /// 检查更新：有新版本返回 update；已是最新/失败/无 APK 时 update 为空，
  /// [manual] = true 时把原因放进 message（弹窗展示），静默检查则全部无声。
  static Future<({AppUpdate? update, String? message})> check({bool manual = false}) async {
    String? current;
    try {
      current = (await PackageInfo.fromPlatform()).version;
    } catch (_) {/* 取不到本地版本：按无更新处理 */}

    http.Response res;
    try {
      res = await http
          .get(
            Uri.https('api.github.com', '/repos/$repo/releases/latest'),
            headers: {'Accept': 'application/vnd.github+json'},
          )
          .timeout(const Duration(seconds: 15));
    } catch (e) {
      return (update: null, message: manual ? '连不上 GitHub（$e）' : null);
    }
    if (res.statusCode != 200) {
      return (update: null, message: manual ? 'GitHub API ${res.statusCode}（限流？稍后再试）' : null);
    }

    Map<String, dynamic> j;
    try {
      j = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      return (update: null, message: manual ? 'Release 信息解析失败' : null);
    }
    final tag = j['tag_name'] as String?;
    if (tag == null) {
      return (update: null, message: manual ? '还没有发布过 Release' : null);
    }
    // 找 APK 产物（CI 命名 harnessgate-vX.Y.Z-android.apk）
    Map<String, dynamic>? apk;
    for (final a in (j['assets'] as List<dynamic>? ?? []).whereType<Map<String, dynamic>>()) {
      if ((a['name'] as String? ?? '').endsWith('-android.apk')) {
        apk = a;
        break;
      }
    }
    if (apk == null) {
      return (update: null, message: manual ? 'Release $tag 没有 Android APK 产物' : null);
    }

    final latest = tag.replaceFirst('v', '');
    if (current != null && compareVersions(latest, current) <= 0) {
      return (update: null, message: manual ? '已是最新（v$current）' : null);
    }
    return (
      update: AppUpdate(
        tag: tag,
        name: j['name'] as String? ?? tag,
        notes: j['body'] as String? ?? '',
        apkUrl: Uri.parse(apk['browser_download_url'] as String),
      ),
      message: null,
    );
  }

  /// 下载 APK 到应用缓存目录，返回文件路径。[onProgress] 汇报字节进度（done, total）。
  /// [relayBaseUrl] 非空时优先走服务器中转（手机直连 GitHub 慢），失败自动回退 GitHub 直链。
  static Future<String> download(
    AppUpdate u,
    void Function(int done, int total) onProgress, {
    String? relayBaseUrl,
  }) async {
    final urls = <Uri>[
      if (relayBaseUrl != null && relayBaseUrl.isNotEmpty)
        Uri.parse('$relayBaseUrl/release-apk?tag=${u.tag}'),
      u.apkUrl,
    ];
    Object? lastErr;
    for (final url in urls) {
      try {
        return await _downloadFrom(url, onProgress, fileName: 'harnessgate-${u.tag}.apk');
      } catch (e) {
        lastErr = e; // 中转失败（服务器离线/缓存未就绪）→ 试下一个源
      }
    }
    throw lastErr ?? '下载失败';
  }

  static Future<String> _downloadFrom(Uri url, void Function(int, int) onProgress, {required String fileName}) async {
    final client = http.Client();
    try {
      final res = await client.send(http.Request('GET', url)).timeout(const Duration(minutes: 5));
      if (res.statusCode != 200) {
        throw HttpException('HTTP ${res.statusCode}');
      }
      final total = res.contentLength ?? 0;
      final file = File('${Directory.systemTemp.path}/$fileName');
      final sink = file.openWrite();
      var done = 0;
      await for (final chunk in res.stream) {
        sink.add(chunk);
        done += chunk.length;
        onProgress(done, total);
      }
      await sink.flush();
      await sink.close();
      return file.path;
    } finally {
      client.close();
    }
  }

  /// 调起系统安装器（Android 8+ 首次需要授予「安装未知应用」权限，系统会自行引导）。
  static Future<String> install(String apkPath) async {
    final r = await OpenFilex.open(apkPath, type: 'application/vnd.android.package-archive');
    return r.message;
  }

  /// 版本号数字段比较（忽略 +build/-pre 后缀）：a<b 负、相等 0、a>b 正。
  static int compareVersions(String a, String b) {
    int num(String s) => int.tryParse(s) ?? 0;
    List<int> parts(String v) {
      final nums = v.split(RegExp(r'[+/-]'))[0].split('.');
      return [for (var i = 0; i < 3; i++) i < nums.length ? num(nums[i]) : 0];
    }
    final pa = parts(a);
    final pb = parts(b);
    for (var i = 0; i < 3; i++) {
      if (pa[i] != pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }
}
