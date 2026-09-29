/// WS 协议类型（与服务端 server/types.ts 对齐的移动端子集）。
/// APP 只做手机场景核心：会话列表 + 聊天 + 审批；编排/管理留给网页。
library;

import 'package:flutter/material.dart';

// ---------- 服务端 → 客户端 ----------

/// 会话状态胶囊（颜色 + 文案）——会话列表与对话页 AppBar 共用（对齐 web 的 pill 语义）
(Color, String) pillOfSession(SessionInfo s) {
  if (s.status == 'ready') {
    return s.inTurn == true
        ? (const Color(0xFF3FB950), '运行中')
        : (const Color(0xFF5B9CF8), '空闲');
  }
  switch (s.status) {
    case 'starting': return (const Color(0xFFD29922), '启动中');
    case 'awaiting': return (const Color(0xFFD29922), '待审批');
    case 'error': return (const Color(0xFFF85149), '出错');
    default: return (Colors.grey, '已存档');
  }
}

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
  final ModesInfo? modes;

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
    this.modes,
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
        modes: j['modes'] == null ? null : ModesInfo.fromJson(j['modes'] as Map<String, dynamic>),
      );

  SessionInfo copyWith({String? status, bool? live, bool? inTurn, String? autoApprove, bool? starred, PendingPermission? pendingPermission, String? error, List<ConfigOption>? configOptions, ModesInfo? modes, String? currentModeId}) =>
      SessionInfo(
        id: id, harnessId: harnessId, harnessLabel: harnessLabel, cwd: cwd,
        status: status ?? this.status, live: live ?? this.live, resumable: resumable,
        inTurn: inTurn ?? this.inTurn, starred: starred ?? this.starred,
        title: title, autoApprove: autoApprove ?? this.autoApprove, roomId: roomId,
        error: error ?? this.error, lastActiveAt: lastActiveAt,
        configOptions: configOptions ?? this.configOptions,
        pendingPermission: pendingPermission ?? this.pendingPermission,
        modes: currentModeId != null && modes == null
            ? ModesInfo(currentModeId: currentModeId, availableModeIds: this.modes?.availableModeIds ?? const [])
            : modes ?? this.modes,
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
  /// 工具入参/输出详情（tool_call 的 input 与 tool_call_update 的 output，超长截断）
  final String? detail;
  final String? output;
  /// 附件名（user 消息带图时显示气泡缩略提示）
  final String? attachmentName;
  Entry({
    required this.kind,
    this.text,
    this.title,
    this.status,
    this.toolCallId,
    this.message,
    this.answered,
    this.requestId,
    this.options,
    this.detail,
    this.output,
    this.attachmentName,
  });
  Entry copyWith({String? title, String? status, String? detail, String? output}) => Entry(
        kind: kind, text: text, title: title ?? this.title, status: status ?? this.status,
        toolCallId: toolCallId, message: message, answered: answered, requestId: requestId,
        options: options, detail: detail ?? this.detail, output: output ?? this.output,
        attachmentName: attachmentName,
      );
}

/// 会话权限模式（server SessionInfo.modes）
class ModesInfo {
  final String? currentModeId;
  final List<String> availableModeIds;
  ModesInfo({this.currentModeId, this.availableModeIds = const []});
  factory ModesInfo.fromJson(Map<String, dynamic> j) => ModesInfo(
        currentModeId: j['currentModeId'] as String?,
        availableModeIds: ((j['availableModes'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map((m) => m['id'] as String)
            .toList(),
      );
}

/// 圆桌房间（server Room 的移动端子集：列表/详情/停止够用，建房间仍在网页端）
class RoomTurnInfo {
  final int round;
  final String harnessLabel;
  final String reply;
  final String kind; // member/host/review
  final String? hostRole; // opening/round-summary/final
  final String? ts;
  final num? score;
  final String? crewTaskId;
  RoomTurnInfo({required this.round, required this.harnessLabel, required this.reply, required this.kind, this.hostRole, this.ts, this.score, this.crewTaskId});

  factory RoomTurnInfo.fromJson(Map<String, dynamic> j) => RoomTurnInfo(
        round: (j['round'] as num?)?.toInt() ?? 0,
        harnessLabel: j['harnessLabel'] as String? ?? '',
        reply: j['reply'] as String? ?? '',
        kind: j['kind'] as String? ?? 'member',
        hostRole: j['hostRole'] as String?,
        ts: j['ts'] as String?,
        score: j['score'] as num?,
        crewTaskId: j['crewTaskId'] as String?,
      );
}

class RoomMemberInfo {
  final String sessionId;
  final String harnessLabel;
  RoomMemberInfo({required this.sessionId, required this.harnessLabel});
  factory RoomMemberInfo.fromJson(Map<String, dynamic> j) => RoomMemberInfo(
        sessionId: j['sessionId'] as String? ?? '',
        harnessLabel: j['harnessLabel'] as String? ?? j['harnessId'] as String? ?? '',
      );
}

class RoomInfo {
  final String id;
  final String topic;
  final String status; // idle/running/done/error/stopped
  final String mode; // parallel/sequential
  final int rounds;
  final bool writeAllowed;
  final bool isCrew;
  final String? hostLabel;
  final String? error;
  final String updatedAt;
  final List<RoomMemberInfo> members;
  final List<RoomTurnInfo> turns;

  RoomInfo({
    required this.id,
    required this.topic,
    required this.status,
    required this.mode,
    required this.rounds,
    required this.writeAllowed,
    required this.isCrew,
    this.hostLabel,
    this.error,
    required this.updatedAt,
    this.members = const [],
    this.turns = const [],
  });

  factory RoomInfo.fromJson(Map<String, dynamic> j) => RoomInfo(
        id: j['id'] as String,
        topic: j['topic'] as String? ?? '',
        status: j['status'] as String? ?? 'idle',
        mode: j['mode'] as String? ?? 'parallel',
        rounds: (j['rounds'] as num?)?.toInt() ?? 0,
        writeAllowed: j['writeAllowed'] as bool? ?? false,
        isCrew: j['crew'] != null,
        hostLabel: j['host'] == null ? null : (j['host'] as Map<String, dynamic>)['harnessLabel'] as String?,
        error: j['error'] as String?,
        updatedAt: j['updatedAt'] as String? ?? '',
        members: ((j['memberInfo'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(RoomMemberInfo.fromJson).toList(),
        turns: ((j['turns'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(RoomTurnInfo.fromJson).toList(),
      );

  /// 状态胶囊（颜色 + 文案，对齐 web ROOM_STATUS）
  (Color, String) get pill {
    switch (status) {
      case 'running': return (const Color(0xFF3FB950), '讨论中');
      case 'done': return (const Color(0xFF5B9CF8), '已完成');
      case 'idle': return (const Color(0xFFD29922), '待开始');
      case 'error': return (const Color(0xFFF85149), '出错');
      default: return (Colors.grey, '已停止');
    }
  }
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
/// 接续：把历史复制进一个新会话继续跑（server 回 handoff_done）
Map<String, dynamic> msgHandoff(String sessionId) => {'type': 'handoff', 'sessionId': sessionId};
Map<String, dynamic> msgMode(String sessionId, String modeId) =>
    {'type': 'mode', 'sessionId': sessionId, 'modeId': modeId};
/// 带附件发消息：图片走 base64（mimeType: image/png|jpeg…，文本附件直接拼进 text 由调用方处理）
Map<String, dynamic> msgPromptWithAttachments(String sessionId, String text,
        {List<({String name, String mimeType, String base64})> attachments = const []}) =>
    {
      'type': 'prompt',
      'sessionId': sessionId,
      'text': text,
      if (attachments.isNotEmpty)
        'attachments': [
          for (final a in attachments) {'name': a.name, 'mimeType': a.mimeType, 'data': a.base64},
        ],
    };
/// 单会话详情：决策记录 + 改动文件（server 回 session-detail）
Map<String, dynamic> msgSessionDetail(String sessionId) => {'type': 'session-detail', 'sessionId': sessionId};
/// 停止圆桌房间
Map<String, dynamic> msgRoomStop(String roomId) => {'type': 'room-stop', 'roomId': roomId};

/// 定时任务：列表 / 立即运行 / 删除（创建与编辑在网页端）
Map<String, dynamic> msgSchedulesList() => {'type': 'schedules-list'};
Map<String, dynamic> msgScheduleRun(String id) => {'type': 'schedule-run', 'id': id};
Map<String, dynamic> msgScheduleDelete(String id) => {'type': 'schedule-delete', 'id': id};
/// 工作区报告（跨 harness 会话与文件改动归因）
Map<String, dynamic> msgWorkspace() => {'type': 'workspace'};

/// 定时任务（server Schedule 的移动端子集）
class ScheduleInfo {
  final String id;
  final String name;
  final bool enabled;
  final String harnessId;
  final String cadenceDesc;
  final String? cwd;
  final String promptTemplate;
  final String? outputFile;
  final bool running;
  final String? nextFireAt;
  final String? lastRunAt;
  final String? lastStatus;
  final String? lastSessionId;
  final int consecutiveFailures;
  final String? lastError;

  ScheduleInfo({
    required this.id,
    required this.name,
    required this.enabled,
    required this.harnessId,
    required this.cadenceDesc,
    this.cwd,
    required this.promptTemplate,
    this.outputFile,
    required this.running,
    this.nextFireAt,
    this.lastRunAt,
    this.lastStatus,
    this.lastSessionId,
    required this.consecutiveFailures,
    this.lastError,
  });

  static String cadenceDescOf(Map<String, dynamic> c) {
    String wd(List<dynamic> days) => days.map((d) => "日一二三四五六"[d as int]).join("/");
    switch (c['type']) {
      case 'daily': return '每天 ${c['at']}';
      case 'interval': return '每 ${c['everyMinutes']} 分钟';
      case 'weekly': return '每周${wd((c['days'] as List<dynamic>?) ?? [])} ${c['at']}';
      case 'cron': return 'cron: ${c['expr']}';
    }
    return '?';
  }

  /// 上次运行状态文案（对齐 web LAST_STATUS）
  String? get lastStatusLabel => switch (lastStatus) {
        'ok' => '✓ 成功',
        'error' => '✕ 出错',
        'contract-fail' => '✕ 契约未满足',
        'timeout' => '⏱ 超时',
        'skipped-running' => '跳过（上次仍在跑）',
        'missing-files' => '✕ 缺前置文件',
        _ => null,
      };

  factory ScheduleInfo.fromJson(Map<String, dynamic> j) {
    final st = (j['state'] as Map<String, dynamic>?) ?? const {};
    final contract = (j['contract'] as Map<String, dynamic>?);
    return ScheduleInfo(
      id: j['id'] as String,
      name: j['name'] as String? ?? '(未命名)',
      enabled: j['enabled'] as bool? ?? false,
      harnessId: j['harnessId'] as String? ?? '',
      cadenceDesc: j['cadence'] is Map<String, dynamic> ? cadenceDescOf(j['cadence'] as Map<String, dynamic>) : '?',
      cwd: j['cwd'] as String?,
      promptTemplate: j['promptTemplate'] as String? ?? '',
      outputFile: contract?['outputFile'] as String?,
      running: st['running'] as bool? ?? false,
      nextFireAt: st['nextFireAt'] as String?,
      lastRunAt: st['lastRunAt'] as String?,
      lastStatus: st['lastStatus'] as String?,
      lastSessionId: st['lastSessionId'] as String?,
      consecutiveFailures: (st['consecutiveFailures'] as num?)?.toInt() ?? 0,
      lastError: st['lastError'] as String?,
    );
  }
}

/// 工作区报告（server WorkspaceReport 子集）
class WsSession {
  final String id;
  final String harnessLabel;
  final bool live;
  final bool inTurn;
  final String mode; // shared/worktree
  final String? branch;
  final int changedCount;
  final String? diffStat;
  WsSession({required this.id, required this.harnessLabel, required this.live, required this.inTurn, required this.mode, this.branch, required this.changedCount, this.diffStat});

  factory WsSession.fromJson(Map<String, dynamic> j) => WsSession(
        id: j['id'] as String? ?? '',
        harnessLabel: j['harnessLabel'] as String? ?? '',
        live: j['live'] as bool? ?? false,
        inTurn: j['inTurn'] as bool? ?? false,
        mode: j['mode'] as String? ?? 'shared',
        branch: j['branch'] as String?,
        changedCount: ((j['changedFiles'] as List<dynamic>?) ?? []).length,
        diffStat: j['diffStat'] as String?,
      );
}

class WsFile {
  final String rel;
  final String lastTs;
  final bool conflict;
  final List<String> who;
  WsFile({required this.rel, required this.lastTs, required this.conflict, required this.who});

  factory WsFile.fromJson(Map<String, dynamic> j) => WsFile(
        rel: j['rel'] as String? ?? '',
        lastTs: j['lastTs'] as String? ?? '',
        conflict: j['conflict'] as bool? ?? false,
        who: ((j['touches'] as List<dynamic>?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map((t) => t['harnessId'] as String? ?? '')
            .where((x) => x.isNotEmpty)
            .toSet()
            .toList(),
      );
}

class WorkspaceReport {
  final String cwd;
  final String note;
  final int conflicts;
  final List<WsSession> sessions;
  final List<WsFile> files;
  WorkspaceReport({required this.cwd, required this.note, required this.conflicts, required this.sessions, required this.files});

  factory WorkspaceReport.fromJson(Map<String, dynamic> j) => WorkspaceReport(
        cwd: j['cwd'] as String? ?? '',
        note: j['note'] as String? ?? '',
        conflicts: (j['conflicts'] as num?)?.toInt() ?? 0,
        sessions: ((j['sessions'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(WsSession.fromJson).toList(),
        files: ((j['files'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(WsFile.fromJson).toList(),
      );
}

// ---------- 语音（识别与合成都在服务端，app 只采集/播放） ----------
/// 文字转语音（server 回 voice-tts-result）
Map<String, dynamic> msgVoiceTts(String reqId, String text) => {'type': 'voice-tts', 'reqId': reqId, 'text': text};
/// 实时通话四件套：start 绑定会话；chunk = base64(PCM s16le/16k/单声道 ~100ms)
Map<String, dynamic> msgVoiceLiveStart(String sessionId) => {'type': 'voice-live-start', 'sessionId': sessionId};
Map<String, dynamic> msgVoiceLiveChunk(String pcmBase64) => {'type': 'voice-live-chunk', 'pcm': pcmBase64};
Map<String, dynamic> msgVoiceLiveBarge() => {'type': 'voice-live-barge'};
Map<String, dynamic> msgVoiceLiveStop() => {'type': 'voice-live-stop'};
Map<String, dynamic> msgCreate(String harnessId, {String? cwd, bool? isolate, Map<String, String>? vars}) => {
      'type': 'create',
      'harnessId': harnessId,
      if (cwd != null && cwd.isNotEmpty) 'cwd': cwd,
      if (isolate != null) 'isolate': isolate,
      if (vars != null && vars.isNotEmpty) 'vars': vars,
    };
