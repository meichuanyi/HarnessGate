/** sherpa-onnx-node 不带类型声明，这里只声明 HarnessGate 用到的最小面 */
declare module "sherpa-onnx-node" {
  export interface OnlineStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
    inputFinished(): void;
  }
  export interface OnlineRecognizerResult {
    text?: string;
  }
  export interface OnlineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      modelType?: string;
      numThreads?: number;
      debug?: boolean;
    };
  }
  export class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    getResult(stream: OnlineStream): OnlineRecognizerResult;
  }
  export function readWave(filename: string): { samples: Float32Array; sampleRate: number };
}
