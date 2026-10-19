/**
 * 外部感知 · 自然环境：气象环境感知器（WeatherSensor）
 * 接入 Open-Meteo 实时气象数据，支持高精度温湿度、紫外线、降水感知与感知事件发射。
 */

import { makeEvent, type Salience, type Sensor, type SensoryEvent } from "./types.ts";

export type WeatherSnapshot = {
  city: string;
  latitude: number;
  longitude: number;
  condition: "sunny" | "cloudy" | "rainy" | "humid";
  conditionLabel: string;
  temperature: number; // ℃
  apparentTemperature: number; // ℃
  humidity: number; // 0-100%
  uvIndex: number; // 0-12
  precipitation: number; // mm
  precipitationProbability?: number; // %
  summary: string;
  updatedAt: string;
};

export type WeatherSensorProps = {
  city?: string;
  latitude?: number;
  longitude?: number;
  intervalMs?: number;
  salience?: Salience;
  log?: (msg: string) => void;
};

function mapWmoWeatherCode(code: number): { condition: WeatherSnapshot["condition"]; label: string } {
  if (code === 0) return { condition: "sunny", label: "晴朗" };
  if (code === 1) return { condition: "sunny", label: "晴间多云" };
  if (code === 2) return { condition: "cloudy", label: "多云" };
  if (code === 3) return { condition: "cloudy", label: "阴天" };
  if (code === 45 || code === 48) return { condition: "humid", label: "大雾高湿" };
  if (code >= 51 && code <= 57) return { condition: "rainy", label: "毛毛细雨" };
  if (code >= 61 && code <= 67) return { condition: "rainy", label: "降雨" };
  if (code >= 71 && code <= 77) return { condition: "rainy", label: "降雪" };
  if (code >= 80 && code <= 82) return { condition: "rainy", label: "阵雨" };
  if (code >= 95 && code <= 99) return { condition: "rainy", label: "雷暴天气" };
  return { condition: "cloudy", label: "阴天" };
}

export class WeatherSensor implements Sensor {
  readonly name = "weather-sensor";
  onEvent?: (evt: SensoryEvent) => void;

  private city: string;
  private latitude: number;
  private longitude: number;
  private intervalMs: number;
  private salience: Salience;
  private log: (msg: string) => void;

  private timer: NodeJS.Timeout | null = null;
  private snapshot: WeatherSnapshot | null = null;
  private isFetching = false;

  constructor(props?: WeatherSensorProps) {
    this.city = props?.city?.trim() || "杭州";
    this.latitude = typeof props?.latitude === "number" ? props.latitude : 30.2741;
    this.longitude = typeof props?.longitude === "number" ? props.longitude : 120.1551;
    this.intervalMs = Math.max(60_000, props?.intervalMs ?? 3600_000); // 缺省 1 小时
    this.salience = props?.salience ?? "normal";
    this.log = props?.log ?? ((m) => console.log(m));
  }

  getSnapshot(): WeatherSnapshot | null {
    return this.snapshot;
  }

  async fetchWeather(): Promise<WeatherSnapshot | null> {
    if (this.isFetching) return this.snapshot;
    this.isFetching = true;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${this.latitude}&longitude=${this.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code&hourly=relative_humidity_2m,precipitation_probability,uv_index&timezone=Asia%2FShanghai`;
      const res = await fetch(url, { headers: { "User-Agent": "HarnessGate/0.6.45 (sentinel-weather)" } });
      if (!res.ok) {
        throw new Error(`Open-Meteo HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as any;
      const current = data.current || {};
      const hourly = data.hourly || {};

      const weatherCode = Number(current.weather_code ?? 3);
      const { condition, label } = mapWmoWeatherCode(weatherCode);

      const temp = Number(current.temperature_2m ?? 20);
      const apparentTemp = Number(current.apparent_temperature ?? temp);
      const humidity = Number(current.relative_humidity_2m ?? 60);
      const precip = Number(current.precipitation ?? 0);

      // 从 hourly 中匹配当前小时的 UV 和降水概率
      let uvIndex = 2.5;
      let precipProb = 10;
      const nowIsoHour = new Date().toISOString().slice(0, 13); // "2026-10-16T01" (UTC)
      // hourly.time 包含 "2026-10-16T09:00"（本地时区）
      const localHourPrefix = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
      }).format(new Date()).replace(", ", "T");

      if (Array.isArray(hourly.time)) {
        const idx = hourly.time.findIndex((t: string) => t.startsWith(localHourPrefix));
        if (idx >= 0) {
          if (Array.isArray(hourly.uv_index) && typeof hourly.uv_index[idx] === "number") {
            uvIndex = Number(hourly.uv_index[idx]);
          }
          if (Array.isArray(hourly.precipitation_probability) && typeof hourly.precipitation_probability[idx] === "number") {
            precipProb = Number(hourly.precipitation_probability[idx]);
          }
        }
      }

      const summary = `${this.city}实时${label}，气温 ${temp}℃（体感 ${apparentTemp}℃），湿度 ${humidity}%，紫外线 ${uvIndex.toFixed(1)}${precip > 0 ? `，降水 ${precip}mm` : ""}`;
      const nowIso = new Date().toISOString();

      const prev = this.snapshot;
      this.snapshot = {
        city: this.city,
        latitude: this.latitude,
        longitude: this.longitude,
        condition,
        conditionLabel: label,
        temperature: temp,
        apparentTemperature: apparentTemp,
        humidity,
        uvIndex,
        precipitation: precip,
        precipitationProbability: precipProb,
        summary,
        updatedAt: nowIso,
      };

      // 判断是否触发显著性脉冲事件（首次启动、或天气骤变如转雨/湿度暴增）
      const isFirst = !prev;
      const conditionChanged = prev && prev.condition !== condition;
      const humidityJump = prev && Math.abs(prev.humidity - humidity) >= 15;
      const isSevere = condition === "rainy" && (precip >= 5 || weatherCode >= 80);

      if (isFirst || conditionChanged || humidityJump) {
        const salience = isSevere ? "loud" : this.salience;
        this.onEvent?.(
          makeEvent({
            modality: "custom",
            kind: "weather.observation",
            subject: `weather:${this.city}`,
            summary: `[自然气象] ${summary}`,
            salience,
            payload: { snapshot: this.snapshot },
          }),
        );
      }

      this.log(`[sentinel-weather] 🌤 气象感知更新: ${summary}`);
      return this.snapshot;
    } catch (err) {
      this.log(`[sentinel-weather] 气象获取失败: ${err instanceof Error ? err.message : String(err)}`);
      return this.snapshot;
    } finally {
      this.isFetching = false;
    }
  }

  start(): void {
    if (this.timer) return;
    // 立即执行一次抓取
    this.fetchWeather();
    this.timer = setInterval(() => {
      this.fetchWeather();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
