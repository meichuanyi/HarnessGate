/**
 * 实时语音通话（全双工管道）：麦克风 PCM 恒开流式识别 + 静音自动断句提交 +
 * harness 流式回复按句 TTS 排队回推 + 插话（barge-in）。
 * 延迟三杠杆内建：接通自动切快速模型/最低 effort（挂断还原）、一次性语音模式设定。
 */
import type { OnlineRecognizer, OnlineStream } from "sherpa-onnx-node";
import type { HarnessSession } from "./session.ts";
import { ensureModel, getRecognizer, tts, cleanForSpeech } from "./voice.ts";

const SAMPLE_RATE = 16_000;
/** 说到一半停静多久算说完（ekko 同参数量级：它 700ms） */
const SILENCE_COMMIT_MS = 650;
/** 单段最长：超了强制提交，防止一句长不停 */
const MAX_SEGMENT_MS = 15_000;
/** 语音能量门槛（RMS）：低于它算静音 */
const RMS_SPEECH = 0.008;
/** TTS 并发合成数 */
const TTS_CONCURRENCY = 3;
/** 提交后这么久还没等到第一个字，念一句「正在处理」 */
const MURMUR_AFTER_MS = 12_000;
/** 自动选「快速模型」的名单特征 */
const FAST_MODEL = /flash|haiku|mini|air|nano|instant|lite|speed/i;
const LOW_EFFORT = /low|min|off|none|fast|quick/i;

/** 把一段 16k 单声道 Float32 PCM 编成 WAV（audio 直传模式下发给 harness） */
function encodeWav(chunks: Float32Array[], sampleRate: number): Buffer {
  let n = 0;
  for (const c of chunks) n += c.length;
  const data = Buffer.alloc(n * 2);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i] ?? 0));
      data.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, o);
      o += 2;
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const SETUP_PROMPT = [
  "【语音通话模式】接下来的对话会被直接朗读给用户：每轮先给一句话结论，最多再补充两句；",
  "不使用 markdown 列表、标题和代码块；不要输出思考过程；用户打断后就停下等新指令。",
  "明白请只回「好」。",
].join("");

export interface VoiceLiveEvents {
  partial(text: string): void;
  user(text: string): void;
  audio(seq: number, audioB64: string, mime: string): void;
  phase(phase: VoicePhase, note?: string): void;
}

export type VoicePhase = "listening" | "thinking" | "speaking" | "done" | "error";

export class VoiceLive {
  private rec!: OnlineRecognizer;
  private stream!: OnlineStream;
  private speechStarted = false;
  private lastVoiceAt = 0;
  private segStartAt = 0;
  private lastPartial = "";
  /** 当前这句的原始 PCM 片段（audio 直传模式用；按静音断句累积、提交后清空） */
  private segChunks: Float32Array[] = [];
  /** TTS 分句队列 */
  private buf = "";
  private nextSeq = 1;
  private sendSeq = 1;
  private ready = new Map<number, { audio: string; mime: string }>();
  private synthCount = 0;
  private turnActive = false;
  private muted = false;
  private murmurTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreCfg: Array<{ configId: string; value: string }> = [];
  private stopped = false;

  constructor(
    readonly session: HarnessSession,
    private readonly ev: VoiceLiveEvents,
    private readonly opts: { model?: string; cancelOnBarge?: boolean; mode?: "stt" | "audio"; transcribe?: boolean } = {},
  ) {}

  get sessionId(): string {
    return this.session.id;
  }

  async start(): Promise<void> {
    await ensureModel();
    this.rec = getRecognizer();
    this.stream = this.rec.createStream();
    await this.applyFastConfig();
    this.turnActive = true;   // 设定回合：回复「好」兼作接通提示音
    this.armMurmur();
    void this.session.prompt(SETUP_PROMPT).catch(() => this.ev.phase("error", "发送语音模式设定失败"));
    this.ev.phase("listening", "已接通");
  }

  /** 喂一帧 PCM s16le 单声道；持续解码 + 静音断句 */
  feedChunk(pcm: Buffer): void {
    if (this.stopped || !this.stream) return;
    const n = pcm.length >> 1;
    const samples = new Float32Array(n);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      samples[i] = v;
      energy += v * v;
    }
    this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    while (this.rec.isReady(this.stream)) this.rec.decode(this.stream);
    const text = this.rec.getResult(this.stream).text ?? "";
    const rms = Math.sqrt(energy / Math.max(1, n));
    const now = Date.now();
    if (rms >= RMS_SPEECH) {
      this.lastVoiceAt = now;
      if (!this.speechStarted) {
        this.speechStarted = true;
        this.segStartAt = now;
      }
    }
    if (this.speechStarted) this.segChunks.push(samples.slice()); // 累积整句 PCM（audio 直传用）
    if (text && text !== this.lastPartial) {
      this.lastPartial = text;
      if (!this.muted) this.ev.partial(text);
    }
    if (this.speechStarted && this.lastPartial) {
      const silentFor = now - this.lastVoiceAt;
      if (silentFor >= SILENCE_COMMIT_MS || now - this.segStartAt > MAX_SEGMENT_MS) this.commit();
    }
  }

  /** 用户静音收尾 → 提交整句并驱动会话 */
  private commit(): void {
    const text = this.lastPartial.trim();
    const chunks = this.segChunks;
    this.segChunks = [];
    this.stream = this.rec.createStream();
    this.speechStarted = false;
    this.lastPartial = "";
    if (!text) return;
    this.muted = false;   // 新一轮：解除插话静音
    this.ev.user(text);
    this.ev.phase("thinking");
    this.turnActive = true;
    this.armMurmur();
    // 直传音频：harness 声明支持且本句有 PCM 时，把整句音频作为 audio ContentBlock 发过去；
    // 否则退回文本（本地识别结果）。本地识别始终在跑（断句 + 字幕 + 可选记账）。
    const useAudio = this.opts.mode === "audio" && this.session.canPromptAudio() && chunks.length > 0;
    const send = async () => {
      // 自然轮转：上一回合还没跑完时，用户又说了一句——先取消旧的再发新的
      if (this.session.info().inTurn) {
        try { await this.session.cancelTurn("voice-turn-taking"); } catch { /* 取消失败也照发 */ }
      }
      if (useAudio) {
        const wav = encodeWav(chunks, SAMPLE_RATE);
        await this.session
          .promptAudio(wav, "audio/wav", this.opts.transcribe ? text : undefined)
          .catch(() => this.ev.phase("error", "发送失败"));
      } else {
        await this.session.prompt(text).catch(() => this.ev.phase("error", "发送失败"));
      }
    };
    void send();
  }

  /** 插话：立即停播（默认不取消回合；cancelOnBarge 打开则连回合一起取消） */
  barge(): void {
    this.muted = true;
    this.ready.clear();
    this.sendSeq = this.nextSeq;   // 丢弃所有在途/待发的音频
    if (this.opts.cancelOnBarge && this.turnActive) {
      void this.session.cancelTurn("voice-barge").catch(() => {});
    }
    this.ev.phase("listening", "已停播，请讲");
  }

  /** tap 自 makeHooks 的 session/update（index.ts 侧按 sessionId 分发） */
  onUpdate(update: { sessionUpdate?: string; content?: { type?: string; text?: string } }): void {
    if (this.stopped) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      this.clearMurmur();
      this.pushText(update.content.text ?? "");
    }
  }

  /** tap 自 makeHooks 的 turn 结束 */
  onTurnEnd(): void {
    if (this.stopped) return;
    this.turnActive = false;
    this.clearMurmur();
    if (this.buf.trim()) {
      this.enqueue(this.buf);
      this.buf = "";
    }
    // 音频队列放完再回 listening；直接切也行（orb 状态略跳）
    this.ev.phase("listening");
  }

  /** 挂断：还原模型/effort 配置，清计时器 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearMurmur();
    for (const { configId, value } of this.restoreCfg) {
      try { await this.session.setConfigOption(configId, value); } catch { /* 还原尽力而为 */ }
    }
    this.ev.phase("done");
  }

  /* ---------- 文本 → 分句 → TTS 队列 → 顺序回推 ---------- */

  private pushText(t: string): void {
    this.buf += t;
    for (;;) {
      const m = this.buf.match(/^[^。！？!?…\n]*[。！？!?…\n]/);
      if (m && m[0].trim().length >= 4) {
        this.enqueue(m[0]);
        this.buf = this.buf.slice(m[0].length);
      } else break;
    }
    if (this.buf.length > 80) {
      this.enqueue(this.buf);
      this.buf = "";
    }
  }

  private enqueue(raw: string): void {
    if (this.muted) return;
    const text = cleanForSpeech(raw).trim();
    if (!text) return;
    const seq = this.nextSeq++;
    this.synthCount++;
    this.ev.phase("speaking");
    void tts("edge")
      .synthesize(text)
      .then((r) => {
        this.ready.set(seq, { audio: r.audio.toString("base64"), mime: r.mime });
      })
      .catch(() => {
        this.ready.set(seq, { audio: "", mime: "" });   // 失败占位，别堵队列
      })
      .finally(() => {
        this.synthCount--;
        this.pump();
      });
  }

  private pump(): void {
    while (this.ready.has(this.sendSeq)) {
      const r = this.ready.get(this.sendSeq)!;
      this.ready.delete(this.sendSeq);
      this.sendSeq++;
      if (!this.muted && r.audio) this.ev.audio(this.sendSeq - 1, r.audio, r.mime);
    }
  }

  /* ---------- 延迟杠杆：快速模型 + 最低 effort ---------- */

  private async applyFastConfig(): Promise<void> {
    const opts = this.session.info().configOptions ?? [];
    for (const o of opts) {
      if (!o.options?.length) continue;
      const isModel = o.category === "model" || /model/i.test(o.id);
      const isEffort = !isModel && /effort|reasoning|think/i.test(`${o.id} ${o.name ?? ""}`);
      if (!isModel && !isEffort) continue;
      const target = isModel
        ? (this.opts.model && o.options.find((x) => x.value === this.opts.model)?.value)
          || o.options.find((x) => FAST_MODEL.test(x.value) && x.value !== o.currentValue)?.value
        : o.options.find((x) => LOW_EFFORT.test(x.value) && x.value !== o.currentValue)?.value;
      if (!target || target === o.currentValue) continue;
      try {
        await this.session.setConfigOption(o.id, target);
        this.restoreCfg.push({ configId: o.id, value: o.currentValue ?? "" });
        console.log(`[voice-live] 通话配置: ${o.id} ${o.currentValue ?? "(默认)"} → ${target}（挂断还原）`);
      } catch (err) {
        console.warn(`[voice-live] 切换 ${o.id} 失败（忽略）:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /* ---------- 思考太久的播报 ---------- */

  private armMurmur(): void {
    this.clearMurmur();
    this.murmurTimer = setTimeout(() => {
      if (!this.stopped && this.turnActive) this.enqueue("正在处理，请稍等。");
    }, MURMUR_AFTER_MS);
  }

  private clearMurmur(): void {
    if (this.murmurTimer) {
      clearTimeout(this.murmurTimer);
      this.murmurTimer = null;
    }
  }
}
