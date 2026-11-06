import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 应用内自更新：查最新版本清单 → 与本地版本比较 → 下载 APK → 调起系统安装。
///
/// 版本即 git tag（v0.3.0 ↔ pubspec 0.3.0）。更新源两级（2026-11-06 迁移）：
/// 主 = HG 服务器 /release-apk-meta（服务器读 NAS alist /shares/harnessgate/latest.json，
/// APK 经 /release-apk 中转下载，服务器 sha256 校验后落缓存）；兜底 = GitHub Release
/// 匿名 API（meichuanyi 账号风控期间 404，解封后恢复）。发布：APK + latest.json 传 NAS
/// /root/shares/harnessgate（即 alist /shares/harnessgate）。
class AppUpdate {
  static const repo = 'meichuanyi/HarnessGate';

  /// 已成功调起安装器的最新 tag（去 v）。发布方 pubspec 漏升版本时，APK 的 versionName
  /// 会落后于 tag，check() 会永远判「有更新」→ 无限下载。用这个记住「这个 tag 已经装过」，
  /// 打断循环；真正出了更新的 tag 仍然正常提示。
  static const _kAppliedTag = 'hg_applied_update_tag';

  /// Release tag（含 v 前缀，如 v0.3.0）
  final String tag;

  /// APK 资产字节数（本地已缓存同尺寸文件即视为下载完成，跳过重复下载）
  final int sizeBytes;

  /// Release 标题
  final String name;

  /// 更新日志（Release body）
  final String notes;

  /// APK 下载地址（browser_download_url）
  final Uri apkUrl;

  const AppUpdate(
      {required this.tag,
      required this.name,
      required this.notes,
      required this.apkUrl,
      this.sizeBytes = 0});

  /// 检查更新：有新版本返回 update；已是最新/失败/无 APK 时 update 为空，
  /// [manual] = true 时把原因放进 message（弹窗展示），静默检查则全部无声。
  /// 更新源已迁 alist（2026-11-06）：主通道经 HG 服务器中转 /release-apk-meta
  /// （服务器读 NAS alist 清单，公网手机也够得着，清单带更新日志）；GitHub
  /// 匿名直连降为兜底——meichuanyi 账号 2026-10-24 被风控期间匿名 API 必 404。
  static Future<({AppUpdate? update, String? message})> check(
      {bool manual = false, String? relayBaseUrl, String? token}) async {
    String? current;
    try {
      current = (await PackageInfo.fromPlatform()).version;
    } catch (_) {/* 取不到本地版本：按无更新处理 */}

    // 主通道：经 HG 服务器中转（服务器读 alist 清单）
    final relay = await _checkViaRelay(relayBaseUrl, token, current, manual);
    if (relay != null) return relay;

    // 兜底：GitHub 匿名直连（未配服务器时唯一通道；风控期间匿名必 404，解封后恢复）
    http.Response res;
    try {
      res = await http.get(
        Uri.https('api.github.com', '/repos/$repo/releases/latest'),
        headers: {'Accept': 'application/vnd.github+json'},
      ).timeout(const Duration(seconds: 15));
    } catch (e) {
      return (update: null, message: manual ? '连不上更新服务器，GitHub 也不可达（$e）' : null);
    }
    if (res.statusCode != 200) {
      return (
        update: null,
        message: manual ? 'GitHub API ${res.statusCode}（限流？稍后再试）' : null
      );
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
    for (final a in (j['assets'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()) {
      if ((a['name'] as String? ?? '').endsWith('-android.apk')) {
        apk = a;
        break;
      }
    }
    if (apk == null) {
      return (
        update: null,
        message: manual ? 'Release $tag 没有 Android APK 产物' : null
      );
    }

    final latest = tag.replaceFirst('v', '');
    if (current != null && compareVersions(latest, current) <= 0) {
      return (update: null, message: manual ? '已是最新（v$current）' : null);
    }
    // 这个 tag 已经装过（哪怕 APK 里的 versionName 因发布疏漏没跟上）→ 不再重复提示
    try {
      final applied = (await SharedPreferences.getInstance())
              .getString(_kAppliedTag) ??
          '';
      if (applied.isNotEmpty && applied == latest) {
        return (
          update: null,
          message: manual ? '已安装 $tag（本机版本号 $current，可能是发布时版本号未同步）' : null
        );
      }
    } catch (_) {/* 读不到偏好：按未装过处理 */}
    return (
      update: AppUpdate(
        tag: tag,
        name: j['name'] as String? ?? tag,
        notes: j['body'] as String? ?? '',
        apkUrl: Uri.parse(apk['browser_download_url'] as String),
        sizeBytes: (apk['size'] as num?)?.toInt() ?? 0,
      ),
      message: null,
    );
  }

  /// 主通道：经服务器查最新版本（/release-apk-meta，服务器读 alist 清单）。
  /// 失败返回 null，调用方走 GitHub 兜底。
  static Future<({AppUpdate? update, String? message})?> _checkViaRelay(
      String? relayBase, String? token, String? current, bool manual) async {
    if (relayBase == null || relayBase.isEmpty) return null;
    final base = relayBase.replaceAll(RegExp(r'/+$'), '');
    final tq = (token != null && token.trim().isNotEmpty)
        ? 'token=${Uri.encodeComponent(token.trim())}'
        : '';
    try {
      final res = await http
          .get(Uri.parse('$base/release-apk-meta${tq.isEmpty ? '' : '?$tq'}'))
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) {
        return (update: null,
            message: manual ? '服务器查询更新失败（HTTP ${res.statusCode}）' : null);
      }
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final tag = j['tag'] as String?;
      if (tag == null) {
        return (update: null, message: manual ? '服务器上还没有发布版本' : null);
      }
      final latest = tag.replaceFirst('v', '');
      if (current != null && compareVersions(latest, current) <= 0) {
        return (update: null, message: manual ? '已是最新（v$current）' : null);
      }
      final applied =
          (await SharedPreferences.getInstance()).getString(_kAppliedTag) ?? '';
      if (applied.isNotEmpty && applied == latest) {
        return (update: null, message: manual ? '已安装 $tag' : null);
      }
      return (
        update: AppUpdate(
          tag: tag,
          name: j['apkName'] as String? ?? tag,
          notes: (j['notes'] as String?) ?? '（经服务器中转检查）',
          // 下载走中转并带上 token（中转需要鉴权；alist 只在服务器所在内网可达）
          apkUrl: Uri.parse(
              '$base/release-apk?tag=$tag${tq.isEmpty ? '' : '&$tq'}'),
          sizeBytes: (j['size'] as num?)?.toInt() ?? 0,
        ),
        message: null,
      );
    } catch (_) {
      return null;   // 中转失败：走 GitHub 兜底
    }
  }

  /// 下载 APK 到应用缓存目录，返回文件路径。[onProgress] 汇报字节进度（done, total）。
  /// [relayBaseUrl] 非空时优先走服务器中转（手机直连 GitHub 慢），失败自动回退 GitHub 直链。
  /// [token] 拼进中转 URL——中转需要鉴权，缺 token 会 4401 后白白回退直连。
  static Future<String> download(
    AppUpdate u,
    void Function(int done, int total) onProgress, {
    String? relayBaseUrl,
    String? token,
  }) async {
    final fileName = 'harnessgate-${u.tag}.apk';
    // 之前下载过且大小吻合 → 直接复用（点"更新"不再重复下载）
    final cached = File('${Directory.systemTemp.path}/$fileName');
    if (u.sizeBytes > 0 &&
        cached.existsSync() &&
        cached.lengthSync() == u.sizeBytes) {
      onProgress(u.sizeBytes, u.sizeBytes);
      return cached.path;
    }

    final urls = <Uri>[
      if (relayBaseUrl != null && relayBaseUrl.isNotEmpty)
        Uri.parse('$relayBaseUrl/release-apk?tag=${u.tag}'
            '${token != null && token.trim().isNotEmpty ? '&token=${Uri.encodeComponent(token.trim())}' : ''}'),
      u.apkUrl,
    ];
    Object? lastErr;
    for (final url in urls) {
      try {
        return await _downloadFrom(url, onProgress, fileName: '$fileName.part');
      } catch (e) {
        lastErr = e; // 中转失败（服务器离线/缓存未就绪）→ 试下一个源
      }
    }
    throw lastErr ?? '下载失败';
  }

  static Future<String> _downloadFrom(
      Uri url, void Function(int, int) onProgress,
      {required String fileName}) async {
    final client = http.Client();
    try {
      final res = await client
          .send(http.Request('GET', url))
          .timeout(const Duration(minutes: 10));
      if (res.statusCode != 200) {
        throw HttpException('HTTP ${res.statusCode}');
      }
      final total = res.contentLength ?? 0;
      // 写 .part 成功后改名——中断的半截不会被误当成完整安装包
      final file = File('${Directory.systemTemp.path}/$fileName.part');
      final sink = file.openWrite();
      var done = 0;
      await for (final chunk in res.stream) {
        sink.add(chunk);
        done += chunk.length;
        onProgress(done, total);
      }
      await sink.flush();
      await sink.close();
      final finalPath = '${Directory.systemTemp.path}/$fileName';
      file.renameSync(finalPath);
      return finalPath;
    } finally {
      client.close();
    }
  }

  /// 调起系统安装器（Android 8+ 首次需要授予「安装未知应用」权限，系统会引导）。
  /// 返回 ok=false 时通常是未授权，UI 应给出重试入口（授权回来后点重试即可，不必重新下载）。
  /// [tag] 传入时，调起成功后记为「已安装」，用于打断版本号不同步导致的无限更新循环。
  static Future<({bool ok, String message})> install(String apkPath,
      {String? tag}) async {
    final r = await OpenFilex.open(apkPath,
        type: 'application/vnd.android.package-archive');
    final ok = r.type == ResultType.done;
    if (ok && tag != null && tag.isNotEmpty) {
      try {
        final p = await SharedPreferences.getInstance();
        await p.setString(_kAppliedTag, tag.replaceFirst('v', ''));
      } catch (_) {/* 记不上也不影响安装 */}
    }
    return (ok: ok, message: r.message);
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
