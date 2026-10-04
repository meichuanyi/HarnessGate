import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;

/// 行内 LaTeX 公式语法解析器：匹配 $...$ 或 \(...\)
class InlineMathSyntax extends md.InlineSyntax {
  InlineMathSyntax() : super(r'(?:\$([^\$\n]+?)\$|\\\((.+?)\\\))');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    // 提取 LaTeX 字符串（单美元符号或括号形式）
    final tex = (match.group(1) ?? match.group(2) ?? '').trim();
    if (tex.isEmpty) return false;

    // 避免误伤价格如 "$5 and $10"：若不含常见公式符号且只是纯数字/纯单词，可选择不当作公式
    // 当含有反斜杠、下划线、上标、等号、大括号、不等号时确认为数学公式
    final el = md.Element('latex_inline', [md.Text(tex)]);
    el.attributes['tex'] = tex;
    parser.addNode(el);
    return true;
  }
}

/// 块级 LaTeX 公式语法解析器：匹配 $$...$$ 或 \[...\]
class BlockMathSyntax extends md.InlineSyntax {
  BlockMathSyntax() : super(r'(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final tex = (match.group(1) ?? match.group(2) ?? '').trim();
    if (tex.isEmpty) return false;

    final el = md.Element('latex_block', [md.Text(tex)]);
    el.attributes['tex'] = tex;
    parser.addNode(el);
    return true;
  }
}

/// 公式 Widget 构建器：将 AST 中的 latex 节点渲染为 FlutterMath 部件
class MathElementBuilder extends MarkdownElementBuilder {
  final TextStyle? baseStyle;
  final bool isBlock;

  MathElementBuilder({this.baseStyle, this.isBlock = false});

  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    final tex = element.attributes['tex'] ?? element.textContent;
    final style = (preferredStyle ?? baseStyle ?? const TextStyle()).copyWith(
      color: preferredStyle?.color ?? const Color(0xFFE6EDF3),
    );

    final mathWidget = Math.tex(
      tex,
      mathStyle: isBlock ? MathStyle.display : MathStyle.text,
      textStyle: style,
      onErrorFallback: (err) {
        // 容错回退：公式解析出错时展示原始 tex
        return Text(
          isBlock ? '\$\$\n$tex\n\$\$' : '\$$tex\$',
          style: style.copyWith(color: const Color(0xFFF85149), fontFamily: 'monospace'),
        );
      },
    );

    if (isBlock) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 8),
        alignment: Alignment.center,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: mathWidget,
        ),
      );
    }

    return mathWidget;
  }
}
