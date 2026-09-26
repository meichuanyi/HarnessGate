import 'package:flutter/material.dart';
import 'core/client.dart';
import 'pages/connect_page.dart';

void main() {
  runApp(const HarnessGateApp());
}

class HarnessGateApp extends StatelessWidget {
  const HarnessGateApp({super.key});

  @override
  Widget build(BuildContext context) {
    final client = GateClient();
    return MaterialApp(
      title: 'HarnessGate',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF0B0D12),
        appBarTheme: const AppBarTheme(backgroundColor: Color(0xFF12151C), surfaceTintColor: Colors.transparent),
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF5B9CF8), brightness: Brightness.dark),
      ),
      home: ConnectPage(client: client),
    );
  }
}
