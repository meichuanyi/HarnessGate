import 'package:flutter_test/flutter_test.dart';
import 'package:harnessgate/core/update.dart';

void main() {
  group('版本号比较 compareVersions', () {
    test('高版本为正（跨位进位也要对）', () {
      expect(AppUpdate.compareVersions('0.3.1', '0.3.0'), greaterThan(0));
      expect(AppUpdate.compareVersions('0.10.0', '0.9.9'), greaterThan(0));
      expect(AppUpdate.compareVersions('1.0.0', '0.99.99'), greaterThan(0));
    });
    test('相等为 0（+build 后缀忽略）', () {
      expect(AppUpdate.compareVersions('0.3.0', '0.3.0'), 0);
      expect(AppUpdate.compareVersions('0.3.0+3', '0.3.0'), 0);
    });
    test('低版本为负', () {
      expect(AppUpdate.compareVersions('0.2.9', '0.3.0'), lessThan(0));
    });
  });

  test('check() 能完整走一遍 GitHub API（best-effort：断网时只验不抛异常）', () async {
    final r = await AppUpdate.check(manual: true).timeout(const Duration(seconds: 20));
    expect(r.update != null || r.message != null, isTrue, reason: '要么拿到更新，要么有可读的原因');
  }, timeout: const Timeout(Duration(seconds: 30)));
}
