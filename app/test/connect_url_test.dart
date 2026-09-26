import 'package:flutter_test/flutter_test.dart';
import 'package:harnessgate/core/client.dart';

void main() {
  group('服务器地址容错 normalizeBaseUrl', () {
    test('粘贴网页完整链接（带 hash 路由）只保留 协议+主机+端口', () {
      expect(
        GateClient.normalizeBaseUrl('https://harnessgate.meichuan.cloud/#/s/594b8cec'),
        'https://harnessgate.meichuan.cloud',
      );
      expect(
        GateClient.normalizeBaseUrl('http://192.168.1.5:9830/some/path/'),
        'http://192.168.1.5:9830',
      );
    });
    test('裸地址补 http；尾部斜杠剥掉', () {
      expect(GateClient.normalizeBaseUrl('harnessgate.meichuan.cloud'), 'http://harnessgate.meichuan.cloud');
      expect(GateClient.normalizeBaseUrl('http://192.168.1.5:9830/'), 'http://192.168.1.5:9830');
    });
    test('默认端口省略（80/443）', () {
      expect(GateClient.normalizeBaseUrl('https://host:443/x'), 'https://host');
      expect(GateClient.normalizeBaseUrl('http://host:80'), 'http://host');
    });
  });

  group('WebSocket 地址构造 buildWsUrl', () {
    test('http(s) 自动转 ws(s)——v0.3.1 连接失败的根因', () {
      expect(
        GateClient.buildWsUrl('https://harnessgate.meichuan.cloud', ''),
        'wss://harnessgate.meichuan.cloud/ws',
      );
      expect(
        GateClient.buildWsUrl('http://192.168.1.5:9830', ''),
        'ws://192.168.1.5:9830/ws',
      );
    });
    test('已填 ws/wss 的原样保留；token 进 query', () {
      expect(GateClient.buildWsUrl('wss://harnessgate.meichuan.cloud', 'abc'), 'wss://harnessgate.meichuan.cloud/ws?token=abc');
    });
  });
}
