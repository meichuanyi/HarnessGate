import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'config.dart';

/// ```mermaid 代码块 → 交互图（对齐 web 端 Mermaid 可视化）。
///
/// flutter_markdown 的 code builder 拿不到语言标记，走与数学公式同款的前置提取模式：
/// chat_page 先 extractMermaid 把块从正文剥出（正文留一行提示），图按原顺序附在消息尾部。
/// 渲染复用服务端自托管的 mermaid.min.js（web/static/vendor，/static 公开无需鉴权）：
/// 拉一次缓存到临时目录，每个图写一个内联 HTML（同目录引用 js），WebView loadFile——
/// 零外网依赖、http 明文问题走 APP 自己的 http 栈（manifest 已开 cleartext）。
class MermaidView extends StatefulWidget {
  final String code;
  const MermaidView({super.key, required this.code});
  @override
  State<MermaidView> createState() => _MermaidViewState();
}

class _MermaidViewState extends State<MermaidView> {
  static String? _jsCache; // 内存缓存：js 源码（进程级一份）
  String? _htmlPath;
  String? _error;
  late final WebViewController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0D1117));
    _prepare();
  }

  Future<void> _prepare() async {
    try {
      final js = _jsCache ?? await _fetchJs();
      _jsCache = js;
      final dir = Directory('${Directory.systemTemp.path}/hg-mermaid');
      await dir.create(recursive: true);
      final jsFile = File('${dir.path}/mermaid.min.js');
      if (!await jsFile.exists()) await jsFile.writeAsString(js);
      // 图内容进 hash 文件名：同一图只写一次，聊天回滚重渲染零开销
      final name = widget.code.hashCode.toRadixString(36);
      final html = File('${dir.path}/$name.html');
      if (!await html.exists()) {
        await html.writeAsString(_html(widget.code));
      }
      await _ctrl.loadFile(html.path);
      if (mounted) setState(() => _htmlPath = html.path);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<String> _fetchJs() async {
    final p = await SharedPreferences.getInstance();
    final url = (p.getString(ServerConfig.kUrl) ?? '').replaceAll(RegExp(r'/+$'), '');
    if (url.isEmpty) throw Exception('未配置服务器地址');
    final res = await http.get(Uri.parse('$url/static/vendor/mermaid/mermaid.min.js'))
        .timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('拉取 mermaid.min.js 失败: HTTP ${res.statusCode}');
    return res.body;
  }

  String _html(String code) => '''
<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:6px;background:#0D1117;overflow:auto}
svg{max-width:100%;height:auto}</style></head>
<body><div id="g">渲染中…</div>
<script src="mermaid.min.js"></script>
<script>
const code = ${_jsString(code)};
mermaid.initialize({ startOnLoad:false, theme:'dark', themeVariables:{ background:'#0D1117', primaryColor:'#1f6feb', primaryTextColor:'#e6edf3', lineColor:'#8b949e' } });
mermaid.render('m1', code).then(r => { document.getElementById('g').innerHTML = r.svg; })
  .catch(e => { document.getElementById('g').textContent = '图表渲染失败: ' + e; });
</script></body></html>''';

  /// Dart 没有内置 JSON.stringify——手写转义嵌入 <script>
  String _jsString(String s) {
    final b = StringBuffer('"');
    for (final c in s.codeUnits) {
      if (c == 0x22) {
        b.write(r'\"');
      } else if (c == 0x5C) {
        b.write(r'\\');
      } else if (c == 0x0A) {
        b.write(r'\n');
      } else if (c == 0x0D) {
        b.write(r'\r');
      } else if (c < 0x20) {
        b.write('\\u${c.toRadixString(16).padLeft(4, '0')}');
      } else if (c == 0x3C || c == 0x3E) {
        b.write('\\u${c.toRadixString(16).padLeft(4, '0')}');   // 防 </script> 截断
      } else {
        b.writeCharCode(c);
      }
    }
    return '$b"';
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(border: Border.all(color: const Color(0xFFD29922)), borderRadius: BorderRadius.circular(8)),
        child: Text('📊 图表不可用：$_error', style: const TextStyle(fontSize: 11.5, color: Color(0xFFD29922))),
      );
    }
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      height: 260,
      decoration: BoxDecoration(
        border: Border.all(color: const Color(0xFF30363D)),
        borderRadius: BorderRadius.circular(8),
      ),
      clipBehavior: Clip.antiAlias,
      child: _htmlPath == null
          ? const Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))
          : WebViewWidget(controller: _ctrl),
    );
  }
}

/// 从 markdown 正文剥出 mermaid 块（与 web 端渲染分工一致：图在消息尾部按序展示）
@immutable
class MermaidExtract {
  final String text;
  final List<String> blocks;
  const MermaidExtract(this.text, this.blocks);
}

MermaidExtract extractMermaid(String src) {
  final blocks = <String>[];
  // ```mermaid ... ``` 围栏（允许结尾 ``` 前有空白；流式未闭合块也先渲染，后续增量会重建）
  final out = src.replaceAllMapped(RegExp(r'```mermaid[ \t]*\r?\n([\s\S]*?)(```|$)'), (m) {
    final code = (m.group(1) ?? '').trim();
    if (code.isEmpty) return m.group(0) ?? '';
    blocks.add(code);
    return '📊 图 ${blocks.length} 见下方';
  });
  return MermaidExtract(out, blocks);
}

@visibleForTesting
int mermaidBlockCount(String src) => extractMermaid(src).blocks.length;
