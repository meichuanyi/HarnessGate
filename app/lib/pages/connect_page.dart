import 'dart:async';
import 'package:flutter/material.dart';
import '../core/config.dart';
import '../core/applog.dart';
import '../core/client.dart';
import 'home_page.dart';

/// 首启配置页：填服务器地址（https://host:port）与 token，验证通过进入会话列表。
class ConnectPage extends StatefulWidget {
  final GateClient client;
  const ConnectPage({super.key, required this.client});

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  final _url = TextEditingController();
  final _token = TextEditingController();
  String? _error;
  bool _busy = false;
  StreamSubscription? _sub;
  StreamSubscription? _stateSub;
  Timer? _timeout;

  @override
  void initState() {
    super.initState();
    _sub = widget.client.messages.listen((m) {
      // hello 到了就放行——不管 12s 定时器有没有先到（公网冷隧道握手实测 55~95s，
      // 定时器先判「超时」把 _busy 置 false，此后 hello 一直被这个条件挡在门外，
      // 出现「明明连上了、界面就是进不去」）
      if (m['type'] == 'hello' && mounted) {
        _timeout?.cancel();
        _sub?.cancel();
        _stateSub?.cancel();
        ServerConfig.save(_url.text, _token.text);
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (_) => HomePage(client: widget.client)),
        );
      }
      if (m['type'] == 'error' && _busy && mounted) {
        _timeout?.cancel();
        setState(() { _busy = false; _error = m['message'] as String? ?? '连接失败'; });
      }
    });
    // WS 层失败（地址不通/认证被拒）也要把按钮解冻，否则页面卡死
    _stateSub = widget.client.state.listen((st) {
      if (st == 'error' && _busy && mounted) {
        _timeout?.cancel();
        final why = widget.client.lastError;
        setState(() {
          _busy = false;
          _error = '连接失败：${why.isNotEmpty ? why : '地址不可达或 token 无效'}';
        });
      }
    });
    // 已有配置：直连并跳过本页
    ServerConfig.load().then((c) {
      _url.text = c.url;
      _token.text = c.token;
      if (c.url.isNotEmpty) _startConnect();
    });
  }

  @override
  void dispose() {
    _timeout?.cancel();
    _sub?.cancel();
    _stateSub?.cancel();
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  void _startConnect() {
    setState(() { _busy = true; _error = null; });
    widget.client.connect(_url.text.trim(), _token.text);
    _timeout?.cancel();
    // 12s 不再判死刑（公网冷隧道握手实测 55~95s 也能成功）：只提示慢，连接继续；
    // 真失败由 WS 层的 error 回调解冻按钮
    _timeout = Timer(const Duration(seconds: 12), () {
      if (_busy && mounted) {
        setState(() { _error = '还没连上，正在自动重试…（公网握手慢时最长见过 90 秒）'; });
      }
    });
  }

  void _showLog(BuildContext context) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('应用日志（最近 400 条）'),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: SelectableText(
              AppLog.I.dump(),
              style: const TextStyle(fontSize: 11, fontFamily: 'monospace'),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              final c = await ServerConfig.load();
              final r = await AppLog.I.upload(c.url, c.token);
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r == null ? '上传失败' : '已上传')));
              }
            },
            child: const Text('上传到服务器'),
          ),
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
        ],
      ),
    );
  }

  void _connect() {
    final url = _url.text.trim();
    // http/https/ws/wss 或裸域名/局域网 IP 都行——scheme 归一化在 client 侧做
    final ok = RegExp(r'^(https?|wss?)://').hasMatch(url) ||
        (url.contains('.') && !url.contains(' '));
    if (!ok) {
      setState(() => _error = '地址格式不对：https://… / ws://… / 裸域名 / 局域网IP:端口');
      return;
    }
    _startConnect();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.center, colors: [Color(0xFF16203A), Color(0xFF0B0D12)]),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(28),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text('⚡', style: TextStyle(fontSize: 52)),
                  const SizedBox(height: 8),
                  const Text('HarnessGate', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text('连接你的服务器', style: TextStyle(fontSize: 13, color: Colors.grey[400])),
                  const SizedBox(height: 32),
                  TextField(
                    controller: _url,
                    keyboardType: TextInputType.url,
                    decoration: InputDecoration(
                      labelText: '服务器地址',
                      hintText: 'https://harnessgate.example.com',
                      border: const OutlineInputBorder(),
                      isDense: true,
                      filled: true,
                      fillColor: Colors.white.withValues(alpha: 0.06),
                    ),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _token,
                    obscureText: true,
                    decoration: InputDecoration(
                      labelText: '访问 token（未开认证可留空）',
                      border: const OutlineInputBorder(),
                      isDense: true,
                      filled: true,
                      fillColor: Colors.white.withValues(alpha: 0.06),
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Text(_error!, style: const TextStyle(color: Color(0xFFF85149), fontSize: 12.5)),
                    ),
                  SizedBox(
                    width: double.infinity,
                    height: 46,
                    child: FilledButton(
                      onPressed: _busy ? null : _connect,
                      child: _busy
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('连接'),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      TextButton(
                        onPressed: () => _showLog(context),
                        child: const Text('📋 查看日志', style: TextStyle(fontSize: 12)),
                      ),
                      TextButton(
                        onPressed: () async {
                          final c = await ServerConfig.load();
                          final r = await AppLog.I.upload(c.url, c.token);
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r == null ? '上传失败' : '日志已上传到服务器')));
                          }
                        },
                        child: const Text('⬆ 上传日志到服务器', style: TextStyle(fontSize: 12)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
