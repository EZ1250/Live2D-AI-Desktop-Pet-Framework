/**
 * weatherTools.ts — 查天气（供 AI 工具 weather_get 使用）
 *
 * 走 **Open-Meteo**：免费、不需要 API Key、不需要注册，所以框架里不用加任何天气配置项，
 * 开箱即用（符合"不含本机信息、填进去就能跑"的原则）。
 *
 * 两步：地理编码（城市名 → 经纬度）→ 预报。
 * **故意不做 IP 定位**：那会把用户位置发给第三方，而且经常定位到隔壁城市；
 * 宁可让 AI 先问一句"哪个城市"，也不要猜错。
 *
 * 纯 Node 标准库实现（https），无第三方依赖。所有失败都返回中文说明，绝不抛异常
 * —— 它返回的那句话会直接被用户看到。
 */
import * as https from 'https';

interface GeoResult {
  name: string;
  admin1: string;
  country: string;
  latitude: number;
  longitude: number;
}

interface ForecastResponse {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    precipitation: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
  };
}

function isValidNumberInRange(value: unknown, min: number, max: number): boolean {
  if (typeof value !== 'number') return false;
  return value >= min && value <= max;
}

async function requestJson(urlStr: string): Promise<{ success: true; data: any } | { success: false; message: string }> {
  return new Promise((resolve) => {
    const parsedUrl = new URL(urlStr);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: 15000,
    };

    let buffer = Buffer.alloc(0);
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        resolve({ success: false, message: `请求失败 (${res.statusCode})` });
        return;
      }

      res.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength > 512 * 1024) {
          req.destroy();
          resolve({ success: false, message: '响应数据过大，请稍后再试' });
        }
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(buffer.toString());
          resolve({ success: true, data: json });
        } catch {
          resolve({ success: false, message: '解析响应数据失败，请重试' });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, message: '请求超时，请检查网络连接' });
    });

    req.on('error', (err) => {
      resolve({ success: false, message: `网络错误：${err.message}` });
    });

    req.end();
  });
}

function wmoCodeToText(code: number): string {
  switch (code) {
    case 0: return '晴';
    case 1: return '多云间晴';
    case 2: return '多云';
    case 3: return '阴';
    case 45:
    case 48: return '雾';
    case 51: return '毛毛雨';
    case 53: return '毛毛雨';
    case 55: return '毛毛雨';
    case 56:
    case 57: return '冻毛毛雨';
    case 61: return '小雨';
    case 63: return '中雨';
    case 65: return '大雨';
    case 66:
    case 67: return '冻雨';
    case 71: return '小雪';
    case 73: return '中雪';
    case 75: return '大雪';
    case 77: return '雪粒';
    case 80: return '阵雨';
    case 81: return '阵雨';
    case 82: return '阵雨';
    case 85:
    case 86: return '阵雪';
    case 95: return '雷阵雨';
    case 96:
    case 99: return '雷阵雨伴冰雹';
    default: return `天气码 ${code}`;
  }
}

function formatDate(dateStr: string, index: number): string {
  const target = new Date(dateStr);

  if (index === 0) return '今天';
  if (index === 1) return '明天';

  const month = target.getMonth() + 1;
  const day = target.getDate();
  return `${month}月${day}日`;
}

export interface WeatherArgs {
  city?: unknown;
  days?: unknown;
}

export async function weatherGet(args: WeatherArgs): Promise<string> {
  // 缺参数和超长要分开说：都回同一句会让"名字太长"看起来像"没填"
  if (typeof args.city !== 'string' || args.city.trim() === '') {
    return '要查天气得先告诉我城市名（例如「杭州」）。';
  }
  if (args.city.trim().length > 40) {
    return '城市名太长了（上限 40 字），给个简短的地名就行。';
  }

  const cityName = args.city.trim();

  // 校验并处理 days 参数
  let forecastDays = 3;
  if (typeof args.days === 'number' && isValidNumberInRange(args.days, 1, 7)) {
    forecastDays = Math.floor(args.days);
  }

  // 第一步：地理编码
  const geoRes = await requestJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=zh&format=json`
  );

  if (!geoRes.success) {
    return geoRes.message;
  }

  const geoData = geoRes.data;

  if (!Array.isArray(geoData.results) || geoData.results.length === 0) {
    return `没找到这个城市：${cityName}，换个说法试试（例如「杭州」而不是「杭洲」）。`;
  }

  const result = geoData.results[0] as GeoResult;

  const lat = result.latitude;
  const lon = result.longitude;
  const displayName = `${result.name}（${result.admin1}，${result.country}）`;

  // 第二步：获取天气预报
  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${forecastDays}`;

  const forecastRes = await requestJson(forecastUrl);

  if (!forecastRes.success) {
    return forecastRes.message;
  }

  const forecastData = forecastRes.data as ForecastResponse;

  const current = forecastData.current;
  const daily = forecastData.daily;

  const currentDesc = wmoCodeToText(current.weather_code);

  let output = `${displayName}：现在 ${current.temperature_2m.toFixed(1)}°C，体感 ${current.apparent_temperature.toFixed(1)}°C，${currentDesc}，湿度 ${Math.round(current.relative_humidity_2m)}%，风速 ${current.wind_speed_10m.toFixed(1)} m/s\n\n`;

  for (let i = 0; i < daily.time.length; i++) {
    const dateLabel = formatDate(daily.time[i], i);
    const minTemp = daily.temperature_2m_min[i];
    const maxTemp = daily.temperature_2m_max[i];
    const code = daily.weather_code[i];
    const prob = daily.precipitation_probability_max[i];

    const desc = wmoCodeToText(code);

    output += `${dateLabel.padEnd(8)} ${minTemp.toFixed(1)}~${maxTemp.toFixed(1)}°C  ${desc.padEnd(6)}  降水概率 ${prob}%\n`;
  }

  return output.trim();
}
