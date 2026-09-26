import 'dart:async';
import 'package:flutter/material.dart';
import '../core/config.dart';
import '../core/client.dart';
import 'sessions_page.dart';

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
      if (m['type'] == 'hello' && _busy && mounted) {
        _timeout?.cancel();
        _sub?.cancel();
        _stateSub?.cancel();
        ServerConfig.save(_url.text, _token.text);
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (_) => SessionsPage(client: widget.client)),
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
        setState(() { _busy = false; _error = '连接失败：地址不可达或 token 无效'; });
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
    _timeout = Timer(const Duration(seconds: 12), () {
      if (_busy && mounted) {
        setState(() { _busy = false; _error = '连接超时：地址不可达或 token 无效'; });
      }
    });
  }

  void _connect() {
    final url = _url.text.trim();
    if (!url.startsWith(RegExp(r'https?://'))) {
      setState(() => _error = '地址需以 http:// 或 https:// 开头');
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
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
