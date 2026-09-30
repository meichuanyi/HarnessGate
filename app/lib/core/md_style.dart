import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

/// 深色主题下的 markdown 样式。
/// flutter_markdown 的默认样式写死了浅色引用块（`Colors.blue.shade100` 底 + 浅色字，看不清），
/// 链接色也是暗蓝；这里统一改成深色可读的配色。
MarkdownStyleSheet hgMarkdownStyle(BuildContext context) {
  final base = MarkdownStyleSheet.fromTheme(Theme.of(context));
  return base.copyWith(
    // 链接：亮蓝 + 下划线
    a: const TextStyle(color: Color(0xFF6CB6FF), decoration: TextDecoration.underline),
    // 行内代码：深底浅字
    code: base.code?.copyWith(
      backgroundColor: const Color(0xFF1B2230),
      color: const Color(0xFFE6EDF3),
    ),
    // 代码块：深底 + 细边框
    codeblockDecoration: BoxDecoration(
      color: const Color(0xFF151A23),
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: const Color(0xFF2A3242)),
    ),
    // 引用块：原来是淡蓝底 + 浅字；改成深底浅字
    blockquote: const TextStyle(color: Color(0xFFC9D1D9)),
    blockquoteDecoration: BoxDecoration(
      color: const Color(0xFF1B2230),
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: const Color(0xFF2A3242)),
    ),
    horizontalRuleDecoration: const BoxDecoration(
      border: Border(top: BorderSide(color: Color(0xFF2A3242), width: 1)),
    ),
  );
}
