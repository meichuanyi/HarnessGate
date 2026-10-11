import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:harnessgate/core/client.dart';
import 'package:harnessgate/pages/connect_page.dart';

// 直接 pump ConnectPage 而不是 HarnessGateApp：App 根组件的 initState 里有启动级
// 更新检查的 3s Timer（main.dart），测试结束时会以「pending timers」失败
void main() {
  testWidgets('connect page renders server form', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(
      MaterialApp(home: ConnectPage(client: GateClient())),
    );
    await tester.pump();

    expect(find.text('HarnessGate'), findsOneWidget);
    expect(find.text('连接'), findsOneWidget);
  });
}
