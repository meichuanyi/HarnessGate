import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:harnessgate/main.dart';

void main() {
  testWidgets('connect page renders server form', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const HarnessGateApp());
    await tester.pump();

    expect(find.text('HarnessGate'), findsOneWidget);
    expect(find.text('连接'), findsOneWidget);
  });
}
