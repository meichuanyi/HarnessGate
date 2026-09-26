/// WS 协议类型（与服务端 server/types.ts 对齐的移动端子集）。
/// APP 只做手机场景核心：会话列表 + 聊天 + 审批；编排/管理留给网页。
library;

// ---------- 服务端 → 客户端 ----------

class ConfigOption {
  final String id;
  final String? name;
  final String? currentValue;
  final List<({String value, String? name})> options;
  ConfigOption({required this.id, this.name, this.currentValue, this.options = const []});

  factory ConfigOption.fromJson(Map<String, dynamic> j) => ConfigOption(
        id: j['id'] as String,
        name: j['name'] as String?,
        currentValue: j['currentValue'] as String?,
        options: ((j['options'] as List<dynamic>?) ?? [])
            .map((o) => (value: o['value'] as String, name: o['name'] as String?))
            .toList(),
      );
}

class SessionInfo {
  final String id;
  final String harnessId;
  final String harnessLabel;
  final String cwd;
  final String status; // starting/ready/awaiting/saved/error/stopped
  final bool live;
  final bool resumable;
  final bool? inTurn;
  final bool? starred;
  final String? title;
  final String? autoApprove; // off/readonly/all
  final String? roomId;
  final String? error;
  final String lastActiveAt;
  final List<ConfigOption> configOptions;
  final PendingPermission? pendingPermission;

  SessionInfo({
    required this.id,
    required this.harnessId,
    required this.harnessLabel,
    required this.cwd,
    required this.status,
    required this.live,
    required this.resumable,
    this.inTurn,
    this.starred,
    this.title,
    this.autoApprove,
    this.roomId,
    this.error,
    required this.lastActiveAt,
    this.configOptions = const [],
    this.pendingPermission,
  });

  factory SessionInfo.fromJson(Map<String, dynamic> j) => SessionInfo(
        id: j['id'] as String,
        harnessId: j['harnessId'] as String,
        harnessLabel: j['harnessLabel'] as String? ?? '',
        cwd: j['cwd'] as String? ?? '',
        status: j['status'] as String? ?? 'saved',
        live: j['live'] as bool? ?? false,
        resumable: j['resumable'] as bool? ?? false,
        inTurn: j['inTurn'] as bool?,
        starred: j['starred'] as bool?,
        title: j['title'] as String?,
        autoApprove: j['autoApprove'] as String?,
        roomId: j['roomId'] as String?,
        error: j['error'] as String?,
        lastActiveAt: j['lastActiveAt'] as String? ?? '',
        configOptions: ((j['configOptions'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map(ConfigOption.fromJson)
            .toList(),
        pendingPermission: j['pendingPermission'] == null
            ? null
            : PendingPermission.fromJson(j['pendingPermission'] as Map<String, dynamic>),
      );

  SessionInfo copyWith({String? status, bool? live, bool? inTurn, String? autoApprove, bool? starred, PendingPermission? pendingPermission, String? error, List<ConfigOption>? configOptions}) =>
      SessionInfo(
        id: id, harnessId: harnessId, harnessLabel: harnessLabel, cwd: cwd,
        status: status ?? this.status, live: live ?? this.live, resumable: resumable,
        inTurn: inTurn ?? this.inTurn, starred: starred ?? this.starred,
        title: title, autoApprove: autoApprove ?? this.autoApprove, roomId: roomId,
        error: error ?? this.error, lastActiveAt: lastActiveAt,
        configOptions: configOptions ?? this.configOptions,
        pendingPermission: pendingPermission ?? this.pendingPermission,
      );
}

class PendingPermission {
  final String requestId;
  final String title;
  final List<({String optionId, String name})> options;
  PendingPermission({required this.requestId, required this.title, required this.options});

  factory PendingPermission.fromJson(Map<String, dynamic> j) => PendingPermission(
        requestId: j['requestId'] as String,
        title: j['title'] as String? ?? '',
        options: ((j['options'] as List<dynamic>?) ?? [])
            .map((o) => (optionId: o['optionId'] as String, name: o['name'] as String))
            .toList(),
      );
}

/// 可用的 harness（hello 下发，用于新建会话时选择）
class HarnessInfo {
  final String id;
  final String label;
  final bool available;
  final String? state; // probed-ok/installed/needs-download/missing/blocked…
  final String? note;
  final bool experimental;
  final List<String> extraAgents;
  final List<ConfigOption> configs;
  HarnessInfo({
    required this.id,
    required this.label,
    required this.available,
    this.state,
    this.note,
    this.experimental = false,
    this.extraAgents = const [],
    this.configs = const [],
  });

  /// 探活通过（可用且真跑通过一次对话）
  bool get probedOk => available && state == 'probed-ok';

  factory HarnessInfo.fromJson(Map<String, dynamic> j) => HarnessInfo(
        id: j['id'] as String,
        label: j['label'] as String? ?? j['id'] as String,
        available: j['available'] as bool? ?? false,
        state: j['state'] as String?,
        note: j['note'] as String?,
        experimental: j['experimental'] as bool? ?? false,
        extraAgents: ((j['extraAgents'] as List<dynamic>?) ?? []).whereType<String>().toList(),
        configs: ((j['configs'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map(ConfigOption.fromJson)
            .toList(),
      );
}

/// 台账条目（transcript 与实时 update 共用一套渲染）
class Entry {
  final String kind; // user/assistant/thought/tool/permission/error/log
  final String? text;
  final String? title; // tool/permission 用
  final String? status; // tool 用
  final String? toolCallId; // tool 用（更新时按 id 原地替换，避免重复行）
  final String? message; // error 用
  final String? answered; // permission 已答复
  final String? requestId; // 待审批
  final List<({String optionId, String name})>? options;
  Entry({required this.kind, this.text, this.title, this.status, this.toolCallId, this.message, this.answered, this.requestId, this.options});
}

// ---------- 客户端 → 服务端（构造原始 JSON map）----------

Map<String, dynamic> msgList() => {'type': 'list'};
Map<String, dynamic> msgPrompt(String sessionId, String text) => {'type': 'prompt', 'sessionId': sessionId, 'text': text};
Map<String, dynamic> msgTranscript(String sessionId) => {'type': 'transcript', 'sessionId': sessionId};
Map<String, dynamic> msgPermission(String sessionId, String requestId, String optionId) =>
    {'type': 'permission', 'sessionId': sessionId, 'requestId': requestId, 'optionId': optionId};
Map<String, dynamic> msgInterrupt(String sessionId) => {'type': 'interrupt', 'sessionId': sessionId};
Map<String, dynamic> msgResume(String sessionId) => {'type': 'resume', 'sessionId': sessionId};
Map<String, dynamic> msgClose(String sessionId) => {'type': 'close', 'sessionId': sessionId};
Map<String, dynamic> msgSetAutoApprove(String sessionId, String level) =>
    {'type': 'set-auto-approve', 'sessionId': sessionId, 'level': level};
Map<String, dynamic> msgConfig(String sessionId, String configId, String value) =>
    {'type': 'config', 'sessionId': sessionId, 'configId': configId, 'value': value};
Map<String, dynamic> msgStar(String sessionId, bool starred) =>
    {'type': 'star', 'sessionId': sessionId, 'starred': starred};
Map<String, dynamic> msgDelete(String sessionId) => {'type': 'delete', 'sessionId': sessionId};
Map<String, dynamic> msgCreate(String harnessId, {String? cwd, bool? isolate, Map<String, String>? vars}) => {
      'type': 'create',
      'harnessId': harnessId,
      if (cwd != null && cwd.isNotEmpty) 'cwd': cwd,
      if (isolate != null) 'isolate': isolate,
      if (vars != null && vars.isNotEmpty) 'vars': vars,
    };
