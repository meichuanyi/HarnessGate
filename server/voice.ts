/**
 * 语音能力（借鉴 ekko-studio 的架构，代码独立实现；ekko 是 BSL-1.1 协议不可抄）：
 *  - STT：本地 sherpa-onnx 流式 zipformer 中英双语 int8 模型，首次使用自动从 k2-fsa
 *    官方 release 下载（模型本身 Apache-2.0）。零云依赖、零 API key。
 *  - TTS：provider 注册表，先接 edge（微软免费接口，node-edge-tts，同样零 key）。
 *    注意 edge 走原始 PCM 会挂，只能要 MP3——ekko 踩过的坑直接绕开。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

const DATA_DIR = process.env.HG_DATA_DIR ?? join(homedir(), ".harnessgate");
const VOICE_DIR = join(DATA_DIR, "voice");

/** 流式 zipformer 中英双语 int8（mobile 归档只含 int8 文件，347MB 一次性下载；k2-fsa 官方发布） */
const MODEL_ID = "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20-mobile";
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ID}.tar.bz2`;
const MODEL_DIR = join(VOICE_DIR, MODEL_ID);

export const TTS_DEFAULT_VOICE = process.env.HG_TTS_VOICE ?? "zh-CN-XiaoxiaoNeural";

/* ---------------- STT：本地 sherpa-onnx ---------------- */

let recognizer: import("sherpa-onnx-node").OnlineRecognizer | null = null;
/** 下载/初始化单飞：并发请求共用同一个 Promise */
let ensuring: Promise<void> | null = null;
/** 识别请求串行队列：原生模块并发安全不明，排队最稳 */
let queue: Promise<void> = Promise.resolve();

function modelFiles(): { encoder: string; decoder: string; joiner: string; tokens: string } | undefined {
  if (!existsSync(MODEL_DIR)) return undefined;
  const enc = findFile("encoder", ".int8.onnx") ?? findFile("encoder", ".onnx");
  const dec = findFile("decoder", ".onnx");
  const joi = findFile("joiner", ".int8.onnx") ?? findFile("joiner", ".onnx");
  const tok = findFile("tokens", ".txt");
  if (!enc || !dec || !joi || !tok) return undefined;
  return { encoder: enc, decoder: dec, joiner: joi, tokens: tok };
}

function findFile(prefix: string, suffix: string): string | undefined {
  try {
    const hit = readdirSync(MODEL_DIR).find((f) => f.startsWith(prefix) && f.endsWith(suffix));
    return hit ? join(MODEL_DIR, hit) : undefined;
  } catch {
    return undefined;
  }
}

/** 用 curl 下载（天然支持 HTTPS_PROXY 环境变量；没有 curl 或失败再裸 https 兜底） */
function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const curl = spawn("curl", ["-fSL", "--retry", "3", "-o", dest, url], { stdio: ["ignore", "ignore", "inherit"] });
    curl.on("error", () => {
      // 没有 curl：直接放弃（本仓库部署面都有 curl；真没有就提示用户手动放置模型）
      reject(new Error("curl 不可用，请手动下载模型解压到 " + MODEL_DIR));
    });
    curl.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`curl 退出码 ${code}`))));
  });
}

/** 确保模型就位（已就位立即返回；缺则后台下载+解压，单飞） */
export function ensureModel(): Promise<void> {
  if (modelFiles()) return Promise.resolve();
  if (!ensuring) {
    ensuring = (async () => {
      mkdirSync(VOICE_DIR, { recursive: true });
      const archive = join(VOICE_DIR, `${MODEL_ID}.tar.bz2`);
      console.log(`[voice] 本地 STT 模型缺失，开始下载（约 350MB 一次性，走 HTTPS_PROXY 环境代理）: ${MODEL_URL}`);
      await download(MODEL_URL, archive);
      console.log(`[voice] 下载完成，解压…`);
      await new Promise<void>((resolve, reject) => {
        const tar = spawn("tar", ["-xjf", archive, "-C", VOICE_DIR], { stdio: ["ignore", "ignore", "inherit"] });
        tar.on("error", (err) => reject(err));
        tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
      });
      if (!modelFiles()) throw new Error(`模型解压后找不到预期文件，请检查 ${MODEL_DIR}`);
      rmSync(archive, { force: true });
      console.log(`[voice] 模型就绪: ${MODEL_DIR}`);
    })().catch((err) => {
      ensuring = null;   // 失败后允许重试
      throw err;
    });
  }
  return ensuring;
}

function getRecognizer() {
  if (recognizer) return recognizer;
  const files = modelFiles();
  if (!files) throw new Error("STT 模型未就绪");
  const sherpa = req("sherpa-onnx-node") as typeof import("sherpa-onnx-node");
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      modelType: "zipformer",
      numThreads: 2,
      debug: false,
    },
  });
  return recognizer;
}

/** 整段 WAV → 文本。串行执行；尾部补 0.3s 静默帮助流式模型 flush（ekko 验证过的做法） */
export async function transcribeWav(wav: Buffer): Promise<string> {
  const run = async () => {
    const sherpa = req("sherpa-onnx-node") as typeof import("sherpa-onnx-node");
    const tmp = join(tmpdir(), `hg-stt-${randomUUID()}.wav`);
    writeFileSync(tmp, wav);
    try {
      const wave = sherpa.readWave(tmp);
      const rec = getRecognizer();
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
      stream.acceptWaveform({
        sampleRate: wave.sampleRate,
        samples: new Float32Array(Math.round(wave.sampleRate * 0.3)),
      });
      stream.inputFinished();
      while (rec.isReady(stream)) rec.decode(stream);
      return rec.getResult(stream).text?.trim() ?? "";
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* 临时文件清理失败无所谓 */ }
    }
  };
  const result = queue.then(run, run);   // 排队（前一个失败也不阻塞后续）
  queue = result.then(() => undefined, () => undefined);
  return result;
}

export function sttModelReady(): boolean {
  return Boolean(modelFiles());
}

/* ---------------- TTS：provider 注册表 ---------------- */

export interface TtsResult {
  audio: Buffer;
  mime: string;
  provider: string;
}

export interface TtsProvider {
  id: string;
  synthesize(text: string, opts?: { voice?: string }): Promise<TtsResult>;
}

/** 朗读前清理：markdown 语法念出来很难听，代码块整块跳过 */
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|]+/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const edgeProvider: TtsProvider = {
  id: "edge",
  async synthesize(text, opts) {
    const { EdgeTTS } = req("node-edge-tts") as typeof import("node-edge-tts");
    const clean = cleanForSpeech(text).slice(0, 1800);
    if (!clean) throw new Error("没有可朗读的文本");
    const tts = new EdgeTTS({
      voice: opts?.voice || TTS_DEFAULT_VOICE,
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",   // 原始 PCM 在 edge 接口上会挂，固定 MP3
      timeout: 30_000,
    });
    const out = join(tmpdir(), `hg-tts-${randomUUID()}.mp3`);
    try {
      await tts.ttsPromise(clean, out);
      const audio = readFileSync(out);
      return { audio, mime: "audio/mpeg", provider: "edge" };
    } finally {
      try { rmSync(out, { force: true }); } catch { /* 同上 */ }
    }
  },
};

const providers: Record<string, TtsProvider> = { edge: edgeProvider };

export function tts(providerId?: string): TtsProvider {
  return providers[providerId ?? "edge"] ?? edgeProvider;
}
