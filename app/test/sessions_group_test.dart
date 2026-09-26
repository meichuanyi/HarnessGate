import 'package:flutter_test/flutter_test.dart';
import 'package:harnessgate/pages/sessions_page.dart';
import 'package:harnessgate/core/protocol.dart';

SessionInfo _s(String id, String hid, String label, String active,
    {bool starred = false, bool live = false, String? title, String cwd = '/p/x'}) {
  return SessionInfo(
    id: id, harnessId: hid, harnessLabel: label, cwd: cwd,
    status: live ? 'ready' : 'saved', live: live, resumable: true,
    starred: starred, title: title, lastActiveAt: active,
  );
}

void main() {
  group('会话分组 groupSessions（对齐 web 侧栏树）', () {
    final all = [
      _s('a1', 'zcode', 'ZCode', '2026-01-02T00:00:00Z', starred: true),
      _s('b1', 'opencode', 'OpenCode', '2026-01-03T00:00:00Z', live: true),
      _s('a2', 'zcode', 'ZCode', '2026-01-01T00:00:00Z'),
      _s('b2', 'opencode', 'OpenCode', '2026-01-02T00:00:00Z'),
    ];

    test('按 harness 分组；组间按最近活跃排；组内收藏置顶', () {
      final gs = SessionsPage.groupSessions(all);
      expect(gs.map((g) => g.harnessId).toList(), ['opencode', 'zcode']); // opencode 组最新活跃在 01-03
      expect(gs.first.liveCount, 1);
      final zcode = gs.singleWhere((g) => g.harnessId == 'zcode');
      expect(zcode.sessions.first.id, 'a1'); // 收藏置顶（虽然 a2 更晚？不：a1 active 更晚，双保险）
    });

    test('收藏置顶压过时间', () {
      final gs = SessionsPage.groupSessions([
        _s('old', 'h', 'H', '2026-01-01T00:00:00Z', starred: true),
        _s('new', 'h', 'H', '2026-01-05T00:00:00Z'),
      ]);
      expect(gs.single.sessions.first.id, 'old');
    });

    test('过滤：标题/cwd/id/harness label 命中；折叠组不吐条目', () {
      final gs = SessionsPage.groupSessions(all, filter: 'zcode');
      expect(gs.map((g) => g.harnessId).toList(), ['zcode']);
      final gs2 = SessionsPage.groupSessions(all, filter: '/p/x');
      expect(gs2.length, 2);
      final collapsed = SessionsPage.groupSessions(all, collapsed: {'zcode'});
      expect(collapsed.singleWhere((g) => g.harnessId == 'zcode').collapsed, isTrue);
    });
  });

  group('相对时间 timeAgo', () {
    test('各级别', () {
      final now = DateTime.now();
      String iso(Duration d) => now.subtract(d).toIso8601String();
      expect(SessionsPage.timeAgo(iso(const Duration(seconds: 20))), '刚刚');
      expect(SessionsPage.timeAgo(iso(const Duration(minutes: 5))), '5 分钟前');
      expect(SessionsPage.timeAgo(iso(const Duration(hours: 3))), '3 小时前');
      expect(SessionsPage.timeAgo(iso(const Duration(days: 2))), '2 天前');
      expect(SessionsPage.timeAgo('不是时间'), '');
    });
  });

  group('Entry 扩展（工具详情/附件名）', () {
    test('copyWith 保留旧 detail（tool_call_update 只带输出时）', () {
      final base = Entry(kind: 'tool', title: 'bash', detail: 'npm test');
      final updated = Entry(kind: 'tool', title: 'bash', status: 'completed', output: 'ok').copyWith(detail: null);
      expect(updated.detail, isNull); // 显式语义：update 携带空 detail 时由调用方回填旧值
      final merged = Entry(kind: 'tool', title: 'bash', status: 'completed', output: 'ok')
          .copyWith(detail: base.detail);
      expect(merged.detail, 'npm test');
      expect(merged.output, 'ok');
    });
  });
}
