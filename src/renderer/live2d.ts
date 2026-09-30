/**
 * live2d.ts — Pet 渲染辅助层
 *
 * ⚠ 本文件是【普通全局脚本】：不 import / 不 export，页面以
 *    <script src="./live2d.js"> 顺序加载（tsc 直出同名 JS 即可运行；
 *    未来接打包器亦无需改动）。对外只挂一个全局：window.PetLive2d。
 *
 * 职责：三种渲染形态的挂载与销毁：
 *   - moc3       → PIXI + pixi-live2d（Live2DModel.from(model3.json)）
 *                 运行库三件套与版本/来源/许可/兼容处理见 ./lib/VERSIONS.md：
 *                 PixiJS 8.14.0（MIT）+ untitled-pixi-live2d-engine 1.4.0（Cubism 3/4/5）
 *                 + 官方 Live2D Cubism Core 5.0（最高 moc3 v5）。
 *                 老栈（Pixi 6.5.10 + cubism4 0.4.0 + Core 4.2）也能跑：本文件按 PIXI.VERSION 自动分流。
 *   - portrait   → <img src=png> + JS 待机呼吸/浮动（CSS transform）
 *   - placeholder→ 占位图形（moc3 运行时缺失/加载失败时的底线可视）
 *
 * 依赖脚本（必须在此文件之前加载，顺序固定）：
 *   ./lib/pixi.min.js → window.PIXI
 *   ./lib/live2dcubismcore.min.js → window.Live2DCubismCore
 *   ./lib/live2d-engine.min.js → window.PIXI.live2d（untitled-pixi-live2d-engine 的浏览器构建）
 * 任一缺失时 isLive2DAvailable() 为 false，调用方自动走降级路径。
 *
 * 帧驱动：三种 handle 都暴露 update(nowSec, deltaSec)，由 renderer.ts 的
 * 统一 requestAnimationFrame 主循环（~60fps 节流 + 页面隐藏暂停）调用；
 * 本层不自起 RAF，避免多循环互相打架。
 */
(() => {
  /** 内部宽松类型别名（对外 API 见 window.PetLive2d） */
  type Any = any;

  interface RenderHandle {
    kind: 'moc3' | 'portrait' | 'placeholder';
    /** 每帧回调（renderer 统一驱动）；不需要动画的实现可不提供 */
    update?(nowSec: number, deltaSec: number): void;
    /**
     * 播放动作分组（renderer 右键菜单调用）：
     *  - moc3 优先播 model3.json 真实 Motions 组（wave/Idle 等）；
     *    组不存在时（如当前资产无 wave）退化为内部 CSS/变换“摇摆”手势。
     *  - portrait 用 JS 摇摆动画模拟挥手；Idle/其余 = 取消手势回待机。
     */
    playMotion?(group: string): void;
    /** 应用/清除表情（moc3 有 Expressions 才有效；null = 恢复默认） */
    setExpression?(name: string | null): void;
    /** 当前模型可用表情名（无表情能力返回空数组） */
    listExpressions?(): string[];
    /** 设置视线目标：nx/ny ∈ [-1,1]，向右/向上为正；0 = 归位 */
    setGaze?(nx: number, ny: number): void;
    /** 滚轮缩放：dir=+1 放大 / -1 缩小（档位 1.08^n，0=fit 基准） */
    zoom?(dir: number): void;
    /**
     * 角色在窗口中的实际可见范围（相对窗口顶部的 px）。
     * 主进程据此把对话气泡贴在"角色头顶上方"，而不是贴在窗口顶边——
     * 模型窗口顶部通常有一大段是透明的，按窗口顶边摆会离角色很远或被判成"放不下"。
     */
    bounds?(): { top: number; height: number } | null;
    /**
     * 全身 / 半身取景切换：
     *  - 'full'：现在的行为，整只角色缩放到窗口里（看得见脚）
     *  - 'half'：放大并整体下移一点，取"头 + 上半身"（战斗立绘那种感觉），脚会被裁掉
     * 骨骼追踪 / 表情追踪接入后，这个取景只影响相机（缩放与位移），不影响任何参数映射。
     */
    setFraming?(mode: 'full' | 'half'): void;
    /**
     * 推进一帧追踪数据（骨骼 / 眼 / 嘴）。底层不绑摄像头，只吃这一帧参数；
     * 缺哪个参数就只驱动存在的那些（降级不报错），层过期后自动回到鼠标跟随。
     */
    applyTrackingFrame?(frame: TrackingFrame): void;
    /** 语音口型：驱动嘴部参数，TTL 由调用方按音频/文本长度给 */
    applySpeech?(mouth: { openY?: number; form?: number }, ttlMs?: number): void;
    /** 情绪 → 表情（用 window.PetEmotion 的模糊匹配挑表情；模型没有对应表情就返回 null 保持原样）
     *  第二参数是模型预设点名（pet-model.json 的 emotionMap），给了且真实存在就优先用 */
    applyEmotionLabel?(label: string, expressionName?: string): string | null;
    /** 追踪层状态（调试/状态展示） */
    trackingStatus?(): { sources: string[]; lastSource: string; lastFrameAgoMs: number | null };
    /** 清空追踪/语音层 */
    clearTrackingLayer?(): void;
    /** 换一套参数映射（pet-model.json 的 parameterMap）；返回生效后的表 */
    setParameterMap?(map: Record<string, string> | null | undefined): Record<string, string>;
    /** 当前参数映射 + 各参数是否存在（设置页展示"这个模型缺什么参数"） */
    parameterInfo?(): { ids: Record<string, string>; present: Record<string, boolean> };
    /** 调试用：moc3 挂载内部状态（尺寸/缩放/画布像素/参数容器形态），换运行库时排障用 */
    debug?(): Any;
    /** 刷新命中遮罩（点击穿透用）；返回是否成功 */
    refreshHitMask?(): boolean;
    /** 客户端坐标是否命中角色；ok=false 表示暂无可靠数据（调用方不应拦截鼠标） */
    hitTest?(clientX: number, clientY: number): { ok: boolean; hit: boolean };
    /** 模型内容包围盒实测（遍历绘制网格顶点）：判断画布尺寸是否与实际内容相符 */
    contentBounds?(): Any;
    /** 命中遮罩统计（不透明像素数与归一化包围盒）：客观验证遮罩是否真有内容 */
    hitMaskStats?(): { available: boolean; opaque: number; bbox: [number, number, number, number] | null; ageMs: number | null };
    destroy(): void;
  }

  /** 当前取景模式（两个渲染分支共用）；半身 = 放大 + 下移，只动相机不动模型参数 */
  type FramingMode = 'full' | 'half';
  let framingMode: FramingMode = 'full';
  /** 当前设备像素比（下限 1）。画布创建与每帧重适配共用，故放模块作用域。 */
  const dpr = (): number => Math.max(1, window.devicePixelRatio || 1);
  const HALF_ZOOM = 2.5; // 半身放大倍率：参考图是"胸像特写"（头到上胸填满窗口），≈1/0.4
  const HALF_SHIFT_RATIO = 0.28; // 半身下移量（占模型高度的比例）：把头顶顶到窗口上沿附近
  // 立绘专用（缩放锚点在头顶，见 CSS）：只要一点点下移，头顶就贴上窗口上沿
  const HALF_SHIFT_RATIO_PORTRAIT = 0.05;

  /** 取景缩放系数（乘在 fit 基准上） */
  function framingZoom(): number {
    return framingMode === 'half' ? HALF_ZOOM : 1;
  }
  function framingShiftPx(modelHeightPx: number): number {
    return framingMode === 'half' ? modelHeightPx * HALF_SHIFT_RATIO : 0;
  }
  /**
   * 半身时视线增益要降下来：取景放大了，同样的鼠标位移换算到参数上会过冲
  * （half 预设使用较小的视线幅度）。
   */
  function framingGazeGain(): number {
    // 半身放大 2.5 倍后，同样的视线偏移在屏幕上被放大 2.5 倍 → 增益降到 0.42，避免"眼珠飞出去"
    return framingMode === 'half' ? 0.42 : 1;
  }

  /* ================================================================
     追踪参数层（骨骼追踪 / 表情追踪 / 语音口型的统一入口）
     - 底层**不直接绑摄像头**，只接受"一帧参数"（TrackingFrame）；
     - 分层权重混合：基座（待机呼吸 + 鼠标视线）→ 追踪层 → 语音口型，缺哪层就自动降级；
     - 每层带 TTL，超时权重线性衰减到 0（设备掉了 / 没数据时自然回到鼠标跟随，不报错）。
     ================================================================ */

  /** 一帧追踪输入；全部字段可选，缺什么就用基座的值 */
  interface TrackingFrame {
    t?: number;
    source?: 'webcam' | 'external' | 'none';
    /** 头部骨骼：yaw=左右转头、pitch=抬头低头、roll=歪头，归一化到 [-1,1] */
    head?: { yaw?: number; pitch?: number; roll?: number };
    /** 眼睛：眨眼量（0=睁 1=闭）与眼球位移 [-1,1] */
    eyes?: { blinkL?: number; blinkR?: number; eyeBallX?: number; eyeBallY?: number };
    /** 嘴：张口量 [0,1] 与口型 [-1,1]（语音口型也走这里） */
    mouth?: { openY?: number; form?: number };
    /** 表情/情绪：只需给标签，映射成模型表情由调用方处理 */
    emotion?: { label: string; confidence?: number };
  }

  /** 混合器里一层参数的存活状态 */
  interface MixerLayer {
    params: Record<string, number>;
    /** 初始权重（0~1） */
    weight: number;
    /** 存活时长（ms）；到期后权重按剩余时间线性衰减到 0 */
    ttlMs: number;
    expiresAt: number;
  }

  /**
   * 逻辑参数名（驱动层只用这 9 个）。
   * 模型实际参数 ID 允许通过 pet-model.json 的 parameterMap 覆盖，用于命名不标准的模型。
   */
  type ParamKey =
    | 'angleX' | 'angleY' | 'angleZ'
    | 'eyeLOpen' | 'eyeROpen'
    | 'eyeBallX' | 'eyeBallY'
    | 'mouthOpenY' | 'mouthForm';

  /** parameterMap 里常见的写法 → 逻辑名（大小写/下划线都不敏感，尽量少让用户踩坑） */
  const PARAM_ALIASES: Record<string, ParamKey> = {
    anglex: 'angleX', angle_x: 'angleX', headx: 'angleX', headangle_x: 'angleX',
    angley: 'angleY', angle_y: 'angleY', heady: 'angleY', headangle_y: 'angleY',
    anglez: 'angleZ', angle_z: 'angleZ', headz: 'angleZ', headangle_z: 'angleZ',
    eyelopen: 'eyeLOpen', eye_l_open: 'eyeLOpen', eyelid_l: 'eyeLOpen',
    eyeropen: 'eyeROpen', eye_r_open: 'eyeROpen', eyelid_r: 'eyeROpen',
    eyeballx: 'eyeBallX', eye_ball_x: 'eyeBallX', gazex: 'eyeBallX',
    eyebally: 'eyeBallY', eye_ball_y: 'eyeBallY', gazey: 'eyeBallY',
    mouthopeny: 'mouthOpenY', mouth_open_y: 'mouthOpenY', mouthopen: 'mouthOpenY',
    mouthform: 'mouthForm', mouth_form: 'mouthForm',
  };

  /**
   * 分层参数混合器：`set()` 写入一层（带权重与 TTL），`sample()` 按当前时间算出
   * "参数 → {值, 权重}" 覆盖表；权重小于 2% 视为失效并自动清理。
   */
  class ParamMixer {
    private layers = new Map<string, MixerLayer>();

    set(id: string, params: Record<string, number>, weight: number, ttlMs: number): void {
      const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 1));
      if (w <= 0) {
        this.layers.delete(id);
        return;
      }
      this.layers.set(id, {
        params: { ...params },
        weight: w,
        ttlMs: Math.max(1, ttlMs),
        expiresAt: performance.now() + Math.max(1, ttlMs),
      });
    }

    clear(id?: string): void {
      if (id) this.layers.delete(id);
      else this.layers.clear();
    }

    /** 当前活跃层 id（调试/状态展示用） */
    activeIds(nowMs = performance.now()): string[] {
      return [...this.layers.entries()].filter(([, l]) => nowMs < l.expiresAt).map(([id]) => id);
    }

    /**
     * 采样：返回值是"该参数应当采用的值"以及"这一层在该参数上的权重"。
     * 多层命中同一参数时按权重加权平均（越专门设的层 TTL 越短，自然让位给基座）。
     */
    sample(nowMs = performance.now()): Map<string, { value: number; weight: number }> {
      const acc = new Map<string, { weighted: number; weight: number }>();
      for (const [id, layer] of [...this.layers.entries()]) {
        if (nowMs >= layer.expiresAt) {
          this.layers.delete(id); // 过期即清：调用方不需要显式 stop
          continue;
        }
        // 最后 40% TTL 内线性衰减，避免"啪"地弹回去
        const left = (layer.expiresAt - nowMs) / layer.ttlMs;
        const w = layer.weight * Math.min(1, left / 0.4);
        if (w < 0.02) continue;
        for (const [param, value] of Object.entries(layer.params)) {
          if (!Number.isFinite(value)) continue;
          const cur = acc.get(param) ?? { weighted: 0, weight: 0 };
          cur.weighted += value * w;
          cur.weight += w;
          acc.set(param, cur);
        }
      }
      const out = new Map<string, { value: number; weight: number }>();
      for (const [param, { weighted, weight }] of acc.entries()) {
        if (weight <= 0) continue;
        out.set(param, { value: weighted / weight, weight: Math.min(1, weight) });
      }
      return out;
    }
  }

  const w = window as {
    PIXI?: Any;
    Live2DCubismCore?: Any;
    PetLive2d?: Any;
  };

  function log(...args: Any[]): void {
    console.log('[live2d]', ...args);
  }

  /** PIXI + Cubism Core + pixi-live2d 三者是否齐全（moc3 渲染能力探测） */
  function isLive2DAvailable(): boolean {
    const P = w.PIXI;
    return Boolean(
      P && typeof P.Application === 'function' &&
      P.live2d && typeof P.live2d.Live2DModel === 'function' &&
      w.Live2DCubismCore,
    );
  }

  /**
   * 把主进程给的各种 url 形态归一为 pixi-live2d 需要的 model3.json 地址。
   * 契约约定 url 指向主进程本地 HTTP 服务的模型文件；此处只做兜底归一：
   *  - *.model3.json       → 原样（标准形态）
   *  - *.moc3              → 推断同目录 *.model3.json（个别主进程给 moc3 文件时用）
   *  - 其余（目录/json 未知名）→ 原样尝试并打日志
   */
  function toModelSettingsUrl(raw: string): string {
    if (/\.model3\.json($|\?)/i.test(raw)) return raw;
    // 第 2 组捕获**整段**查询串（不是单个 '?'），否则 model.moc3?token=1 会被截成 model.model3.json?
    const m = raw.match(/^(.+?\.)moc3(\?.*)?$/i);
    if (m) return m[1] + 'model3.json' + (m[2] ?? '');
    if (!/\.json($|\?)/i.test(raw)) {
      log('warn: url 不是 *.model3.json 形态，将原样交给 Live2D 尝试:', raw);
    }
    return raw;
  }

  /**
   * 读 model3.json 并归一化后再交给运行库（**不是**改写用户模型文件，只是喂给库的这份内存对象）。
   * 只在 Pixi 8 那套新引擎下用（Pixi 6 + cubism4 0.4.0 不需要，传对象反而可能不兼容）。
   *
   * 为什么必须做：新引擎内部是 `Object.assign(this, new CubismModelSettingJson(buffer))`，
   * 把「框架设置类的 JSON 键名字符串」整片拷进设置对象（`hitAreas = "HitAreas"`…），
   * 再用 `if (json.HitAreas) this.hitAreas = json.HitAreas` 覆盖 —— 模型没写 HitAreas 时
   * `this.hitAreas` 会是字符串，随后 `.map()` 直接抛 `TypeError: _a.map is not a function`。
   * 实测：VTS 导出的模型普遍没有 HitAreas。
   */
  async function normalizeModelSettings(url: string): Promise<Any | null> {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Any;
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('顶层不是对象');
      json.url = url; // 运行库要求：设置对象必须带 url，用来解析贴图/动作的相对路径
      if (!Array.isArray(json.HitAreas)) json.HitAreas = [];
      if (json.Groups !== undefined && !Array.isArray(json.Groups)) json.Groups = [];
      const refs = json.FileReferences;
      if (refs && typeof refs === 'object') {
        if (refs.Textures !== undefined && !Array.isArray(refs.Textures)) refs.Textures = [];
        if (refs.Expressions !== undefined && !Array.isArray(refs.Expressions)) refs.Expressions = [];
        if (refs.Motions !== undefined && (typeof refs.Motions !== 'object' || Array.isArray(refs.Motions))) refs.Motions = {};
      }
      return json;
    } catch (err) {
      console.warn('[live2d] 设置文件归一化失败，改为直接交给运行库:', err);
      return null;
    }
  }

  /* ============================================================
     moc3：PIXI + pixi-live2d 渲染
     ============================================================ */

  /**
   * 贴图降采样的边长上限。
   *
   * 为什么必须做：桌宠窗口里模型只占屏约 200×470 逻辑像素（DPR 1.5 时约 300×700 设备像素），
   * 而大模型贴图是 4096²/8192² —— 相当于把 8192² 的图压到几百像素里采样，压缩比十几比一；
   * 又因为引擎那条 LOD 分支实测不生效（见 `lod` 处的注释），没有 mipmap 兜底，
   * 表现就是发丝闪烁、轮廓毛糙。
   *
   * 2048 的依据：即使按 DPR=2 且半身放大 2.5 倍，角色在屏上也不到 1200 设备像素，
   * 2048² 余量充足；而 8192²→2048² 把显存降到 1/16（640MB → 约 40MB）。
   */
  const TEXTURE_MAX_EDGE = 2048;

  /**
   * 把模型贴图降采样到 TEXTURE_MAX_EDGE 以内（原地替换纹理的像素源）。
   *
   * 时机：必须在**第一次上传显存之前**调用，否则改了也没用（GPU 里已经是原图）。
   * 做法：原图 drawImage 到缩小后的 canvas，再把 Pixi TextureSource 的 resource 换成它，
   * 并 update()/resize() 让它按新尺寸重新上传。
   *
   * 任何一步不对就保持原图 —— 宁可费显存，也不能弄坏画面。
   */
  function downscaleModelTextures(model: Any): void {
    const texes: Any[] = model && Array.isArray(model.textures) ? model.textures : [];
    if (!texes.length) {
      console.warn('[live2d] 模型没有 textures，跳过滤采样');
      return;
    }
    for (let i = 0; i < texes.length; i++) {
      try {
        const tex = texes[i];
        const src = tex && tex.source;
        if (!src) continue;
        const res = src.resource;
        if (!res) continue;
        // 用 pixelWidth/Height（原始资源尺寸）；width/height 可能已被引擎改写
        const sw = Number(src.pixelWidth || src.width || 0);
        const sh = Number(src.pixelHeight || src.height || 0);
        const maxEdge = Math.max(sw, sh);
        if (!sw || !sh || maxEdge <= TEXTURE_MAX_EDGE) continue;
        const k = TEXTURE_MAX_EDGE / maxEdge;
        const dw = Math.max(1, Math.round(sw * k));
        const dh = Math.max(1, Math.round(sh * k));
        const cv = document.createElement('canvas');
        cv.width = dw;
        cv.height = dh;
        const ctx = cv.getContext('2d');
        if (!ctx) continue;
        ctx.drawImage(res as CanvasImageSource, 0, 0, dw, dh);
        src.resource = cv;
        if (typeof src.update === 'function') src.update();
        if (typeof src.resize === 'function') src.resize(dw, dh, 1);
        console.log(`[live2d] 贴图 #${i} 降采样 ${sw}x${sh} → ${dw}x${dh}`);
      } catch (err) {
        console.warn(`[live2d] 贴图 #${i} 降采样异常（保持原图）`, err);
      }
    }
  }

  async function mountLive2D(input: { container: HTMLElement; url: string }): Promise<RenderHandle | null> {
    if (!isLive2DAvailable()) {
      console.warn('[live2d] PIXI / Cubism Core / pixi-live2d 运行时缺失，moc3 不可用');
      return null;
    }
    const PIXI = w.PIXI as Any;
    const modelUrl = toModelSettingsUrl(input.url);
    // 运行库是 Pixi 6（老栈）还是 Pixi 8（新栈）：两条路都要能跑，换库时不用改代码。
    const pixiMajor = (() => {
      try {
        const v = PIXI.VERSION || (PIXI.utils && PIXI.utils.VERSION) || '0';
        return Number(String(v).split('.')[0]) || 0;
      } catch {
        return 0;
      }
    })();
    const isModern = pixiMajor >= 8;
    // 新引擎（Pixi8）不会自己拿到 Pixi 的共享 Ticker：不注册的话动作/物理/顶点更新不会被驱动。
    if (isModern) {
      try {
        const LM = PIXI.live2d && PIXI.live2d.Live2DModel;
        if (LM && typeof LM.registerTicker === 'function' && PIXI.Ticker) LM.registerTicker(PIXI.Ticker);
      } catch (err) {
        console.warn('[live2d] registerTicker 失败', err);
      }
    }

    // Pixi 8：先 new、再 await init；Pixi 6：直接构造（autoStart:false —— 渲染交给本层 RAF）
    let app: Any;
    if (isModern) {
      app = new PIXI.Application();
      try {
        await app.init({
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: dpr(),
          autoStart: false,
          powerPreference: 'high-performance',
          // 透明窗口下的边缘合成：预乘 alpha 会让抗锯齿的半透明边缘与桌面底色混合出
          // 一圈发白的描边（俗称白边/毛边）。关掉后画布输出非预乘 RGBA，由合成器负责混合。
          premultipliedAlpha: false,
          width: window.innerWidth || 1,
          height: window.innerHeight || 1,
        });
      } catch (err) {
        console.warn('[live2d] Pixi 初始化失败（无 WebGL/WebGPU？）', err);
        try { app.destroy(true); } catch { /* ignore */ }
        return null;
      }
    } else {
      app = new PIXI.Application({
        backgroundAlpha: 0,           // 透明背景，配合无边框透明窗口
        antialias: true,
        autoDensity: true,
        resolution: dpr(),
        autoStart: false,
        powerPreference: 'high-performance',
        premultipliedAlpha: false,    // 同上：避免透明窗口下的边缘白边
      });
    }

    // Pixi 6 用 app.view；Pixi 8 改名成 app.canvas（两个都认）
    const view = (app.canvas ?? app.view) as HTMLCanvasElement | undefined;
    if (!view) {
      try { app.destroy(true); } catch { /* ignore */ }
      return Promise.resolve(null);
    }
    view.classList.add('pet-canvas');
    input.container.appendChild(view);

    let model: Any = null;
    let destroyed = false;
    let natW = 0;   // scale=1 时的模型宽(逻辑px)，refit 时记录
    let natH = 0;
    let lastW = 0;
    let lastH = 0;
    let lastDpr = 0; // 上次生效的设备像素比（跨屏拖动/改系统缩放的检测基准）
    /**
     * 命中遮罩（点击穿透用）：把画布**降采样**成一张小位图缓存起来，
     * 用它回答"这个点是角色还是透明背景"。
     *
     * 为什么用画布降采样而不是读贴图像素：贴图上某个像素"可见"还取决于网格顶点、
     * 变形器、遮罩与混合；只有最终合成到画布的结果才等于用户看到/点到的东西。
     * 降采样到固定小尺寸后每次只读一次 getImageData（~256KB），按需刷新，开销可控。
     */
    const MASK_W = 128;
    const MASK_H = 128;
    let maskData: Uint8ClampedArray | null = null;
    let maskAt = 0;
    /**
     * 是否需要在本帧绘制结束后立刻取样。
     *
     * 为什么必须"同一帧内"取样：上下文是 `preserveDrawingBuffer: false`（GPU 审计确认），
     * 浏览器在合成后可以随时清空绘制缓冲 —— 在帧外调 drawImage 读画布会拿到**全透明**，
     * 于是每次都判定"不在角色身上"，穿透就表现为"完全没生效"。
     * 渲染刚结束时缓冲还有效，这是唯一可靠的读取时机。
     */
    let maskRefreshQueued = false;
    /** 最近一帧是否真的画过内容（没画过就别取样，避免把空帧写成遮罩） */
    let renderedThisFrame = false;

    /** 在帧外主动请求一次取样；实际取样发生在下一次绘制之后 */
    function refreshHitMask(): boolean {
      if (!view) return false;
      maskRefreshQueued = true;
      // 本次调用不保证立刻拿到新数据：有旧数据就算成功（宁可用旧值也不要整窗失去交互）
      return maskData !== null;
    }

    /** 帧内取样（只应由渲染循环调用）：把刚画完的画布降采样成小位图缓存 */
    function captureHitMaskNow(): void {
      maskRefreshQueued = false;
      try {
        const cv = view as HTMLCanvasElement | undefined;
        if (!cv || !cv.width || !cv.height) return;
        const m = document.createElement('canvas');
        m.width = MASK_W;
        m.height = MASK_H;
        const ctx = m.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(cv, 0, 0, MASK_W, MASK_H);
        const px = ctx.getImageData(0, 0, MASK_W, MASK_H).data;
        // 全透明的遮罩视为"取样失败"，不采用。
        // 否则一旦在缓冲被清空后取到空帧，就会得出"到处都不在角色身上"，
        // 于是整窗穿透 —— 用户会连右键和设置都点不动（这是修复前踩过的坑）。
        let opaque = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 24) { opaque++; if (opaque > 4) break; }
        if (opaque <= 4) return;
        maskData = px;
        maskAt = performance.now();
      } catch (err) {
        console.warn('[live2d] 命中遮罩取样失败', err);
      }
    }
    /** 客户端坐标是否落在角色身上（alpha 阈值以上即命中）。数据缺失时返回 false（=不拦截，保住可交互） */
    function hitTest(clientX: number, clientY: number): boolean {
      if (!maskData) return false;
      const cv = view as HTMLCanvasElement | undefined;
      if (!cv) return false;
      const r = cv.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const nx = (clientX - r.left) / r.width;
      const ny = (clientY - r.top) / r.height;
      if (nx < 0 || nx >= 1 || ny < 0 || ny >= 1) return false;
      const mx = Math.min(MASK_W - 1, Math.max(0, Math.floor(nx * MASK_W)));
      const my = Math.min(MASK_H - 1, Math.max(0, Math.floor(ny * MASK_H)));
      return maskData[(my * MASK_W + mx) * 4 + 3] > 24;
    }
    const phase = Math.random() * Math.PI * 2;
    const FIT_MARGIN = 0.89; // 给摆动部件预留边距

    function refit(): void {
      if (destroyed || !model) return;
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      // 设备像素比会变：窗口从高 DPI 屏拖到普通屏、或用户改系统缩放时，DPR 会变而
      // innerWidth/Height 可能不变。只比宽高的话画布缓冲会停在旧倍率上（表现为模型被
      // 放大采样→发虚/毛边，或反之白耗显存），所以这里一并检测并重设。
      const ratio = dpr();
      if (ratio !== lastDpr) {
        lastDpr = ratio;
        if (app.renderer && 'resolution' in app.renderer) app.renderer.resolution = ratio;
        lastW = 0; // 强制走一次 resize，让画布缓冲按新倍率重建
        lastH = 0;
      }
      if (vw !== lastW || vh !== lastH) {
        app.renderer.resize(vw, vh);
        lastW = vw;
        lastH = vh;
      }
      try {
        // 先归一 scale=1 读基准尺寸（pixi-live2d 的 width/height 随 scale 变化）
        model.scale.set(1);
        natW = model.width || 0;
        natH = model.height || 0;
        if (!natW || !natH) return;
        const s = Math.min((vw * FIT_MARGIN) / natW, (vh * FIT_MARGIN) / natH) * framingZoom();
        model.scale.set(s);
        const wPx = natW * s;
        const hPx = natH * s;
        model.position.set((vw - wPx) / 2, (vh - hPx) / 2 + framingShiftPx(hPx));
      } catch (err) {
        console.warn('[live2d] moc3 refit 失败', err);
      }
    }

    // Pixi 8 那套新引擎：喂归一化后的设置对象（补 HitAreas 等）；Pixi 6 老栈直接给 URL
    const settings = isModern ? await normalizeModelSettings(modelUrl) : null;
    /**
     * 贴图 LOD —— ⚠️ 实测结论：**在当前这套运行库 + 本工程的加载路径下，这个开关对画面没有
     * 可测量的影响，请勿再把它当成"毛边已解决"的依据。**
     *
     * 引擎 `lod` 名义上只有三种取值（见 lib 里的 ge() 归一化）：false / 'single-auto' / 'full'，
     * 后两者分别对应"自动换低分辨率副本"与"生成完整 mipmap 链"。但实测（同一模型、同一取景、
     * 只改这一个值）：
     *   - GPU 审计里每张贴图的 source 与 effective 始终相同（8192² 还是 8192²）；
     *   - 像素指标 A/B：aliasEnergy 31.09 → 30.70、hardEdgeRate 4.06% → 3.89%，
     *     差异在噪声量级，等于没有效果。
     * 也就是说纹理没有走引擎那条 LOD 分支（否则 effective 会明显小于 source）。
     *
     * 保留 'single-auto' 只是取一个"不改动现状"的保守值；真正要消毛边 + 降显存，需要
     * **在贴图进 GPU 之前就降采样**（桌宠窗口模型只占屏约 200×470 逻辑像素、DPR 1.5，
     * 8192² 用不到），而不是依赖这个开关。
     */
    const modelOptions = isModern ? ({ textureOptions: { lod: 'single-auto' } } as Any) : undefined;
    return PIXI.live2d.Live2DModel
      .from(settings ?? modelUrl, modelOptions) // 默认 autoInteract=true：SDK 内部交互链路接管指针→视线(focus)
      .then((m: Any) => {
        if (destroyed) {
          // 本次挂载已被弃用（期间用户切了模型）。必须**连 app 一起销毁**：
          // 每个 app 就是一个 WebGL 上下文，只销毁 model 会把上下文留在那里，
          // 反复切模型会累积（浏览器上限约 16 个），最终表现为模型加载不了/渲染进程失稳。
          try { m.destroy({ texture: true }); } catch { /* ignore */ }
          try { app.destroy(true, { children: true, texture: true }); } catch { /* ignore */ }
          return null;
        }
        model = m;
        model.autoUpdate = false; // 由本层 update 手动驱动（与统一 RAF 同步）
        // 交互：Pixi 8 用 eventMode（旧的 interactive 已移除）；两者都设，兼容新旧运行库。
        model.eventMode = 'static';
        model.interactive = true;
        if (isModern) {
          // 新引擎的绘制回调需要 renderer（否则**静默不画**）；同时给全局 app 兜底。
          try { model.renderer = app.renderer; } catch { /* ignore */ }
          try { (w as Any).app = app; } catch { /* ignore */ }
          // 贴图降采样必须在**第一次上传显存之前**做完（见函数注释）。
          try {
            downscaleModelTextures(model);
          } catch (err) {
            console.warn('[live2d] 贴图降采样失败（继续用原图）', err);
          }
          // Pixi 8.13+ 的 TextureSource 没有 `_gpuData` 字段，而新引擎拿它判断"显存纹理是否就绪"：
          // 读到 undefined[uid] 会抛 "Failed to upload Live2D texture."。补一个空对象即可（只用于布尔判断）。
          try {
            const texes: Any[] = Array.isArray(model.textures) ? model.textures : [];
            for (const tex of texes) {
              const src = tex && tex.source;
              if (src && !src._gpuData) src._gpuData = Object.create(null);
              if (tex && tex.source) app.renderer.texture.bind(tex, 0);
            }
          } catch (err) {
            console.warn('[live2d] 贴图兼容处理失败', err);
          }
          // 高精度遮罩在新引擎里默认开启，实测在 Pixi8 上会走进崩溃分支；关掉它先保证能画。
          try {
            const r = model.internalModel && model.internalModel.renderer;
            if (r && typeof r.useHighPrecisionMask === 'function') {
              r.useHighPrecisionMask(false);
              console.log('[live2d] 已关闭高精度遮罩（Pixi8 引擎兼容处理）');
            }
          } catch (err) {
            console.warn('[live2d] 关闭高精度遮罩失败', err);
          }
        }
        app.stage.addChild(model);
        refit();
        // 纹理和布局稳定后再次校正尺寸
        const t1 = window.setTimeout(refit, 250);
        const t2 = window.setTimeout(refit, 900);

        // —— 视线跟踪 / 动作 / 表情能力（对 pixi-live2d 运行时全防御式访问）——
        // 参数容器在**两代运行库**上形状不同，两种都认：
        //   老栈（pixi-live2d-display 0.4.0）：coreModel._model.parameters{count,minimumValues,maximumValues}
        //   新栈（untitled-engine 1.4.0 / Cubism 5 框架）：coreModel._parameterValues / _parameterMinimumValues / _parameterMaximumValues
        function paramStore(): Any {
          try {
            const core = model.internalModel && model.internalModel.coreModel;
            if (!core) return null;
            const legacy = core._model && core._model.parameters;
            if (legacy && typeof legacy.count === 'number') {
              return { count: legacy.count, min: legacy.minimumValues, max: legacy.maximumValues };
            }
            const values = core._parameterValues;
            if (values && typeof values.length === 'number') {
              return { count: values.length, min: core._parameterMinimumValues, max: core._parameterMaximumValues };
            }
            return null;
          } catch {
            return null;
          }
        }
        function realParamCount(): number {
          const store = paramStore();
          return store && typeof store.count === 'number' ? store.count : -1;
        }
        /**
         * 参数名 → 索引。两代框架的差异都在这：
         *  - `getParameterIndex(字符串)` 在新框架里对**没找到**的 id 会返回 count（越界哨兵），不能直接采信；
         *  - `_parameterIds` 里是 CubismId 对象，`getString()` 返回的是 csmString（拿名字要再取 `.s`）。
         * 所以：先按名字扫表（权威），扫不到再用 getParameterIndex 且必须落在 [0,count) 内。
         */
        function paramIndex(core: Any, id: string): number {
          const count = realParamCount();
          const nameOf = (it: Any): string => {
            if (it === null || it === undefined) return '';
            if (typeof it === 'string') return it;
            let raw: Any = it;
            try {
              if (typeof it.getString === 'function') raw = it.getString();
            } catch {
              raw = it;
            }
            if (typeof raw === 'string') return raw;
            if (raw && typeof raw.s === 'string') return raw.s;
            if (typeof it.s === 'string') return it.s;
            if (typeof it._id?.s === 'string') return it._id.s;
            return '';
          };
          try {
            const ids = core._parameterIds;
            const size = Array.isArray(ids)
              ? ids.length
              : ids && typeof ids.getSize === 'function'
                ? ids.getSize()
                : 0;
            const at = (i: number): Any => (Array.isArray(ids) ? ids[i] : ids.at(i));
            for (let i = 0; i < size; i += 1) {
              if (nameOf(at(i)) === id) return i;
            }
          } catch {
            /* 落到 getParameterIndex 兜底 */
          }
          try {
            if (typeof core.getParameterIndex === 'function') {
              const idx = core.getParameterIndex(id);
              if (typeof idx === 'number' && idx >= 0 && (count < 0 || idx < count)) return idx;
            }
          } catch {
            /* ignore */
          }
          return -1;
        }
        function paramLimit(id: string): number {
          try {
            const core = model.internalModel && model.internalModel.coreModel;
            const store = paramStore();
            if (!core || !store) return 0;
            const count = realParamCount();
            const idx = paramIndex(core, id);
            if (count < 0 || idx < 0 || idx >= count) return 0;
            const min = store.min ? store.min[idx] : undefined;
            const max = store.max ? store.max[idx] : undefined;
            const limit = Math.max(Math.abs(Number(min)), Math.abs(Number(max)));
            return Number.isFinite(limit) && limit > 0 ? limit : 0;
          } catch {
            return 0;
          }
        }
        function setParam(id: string, value: number): void {
          try {
            const core = model.internalModel && model.internalModel.coreModel;
            // setParameterValueById 内部会按模型参数的 min/max 自动钳制
            if (core && typeof core.setParameterValueById === 'function') core.setParameterValueById(id, value);
          } catch (err) {
            console.warn('[live2d] 设置参数失败', id, err);
          }
        }
        function hasMotionGroup(group: string): boolean {
          try {
            const mm = model.internalModel && model.internalModel.motionManager;
            const d = mm && mm.definitions;
            return Boolean(d && Array.isArray(d[group]) && d[group].length > 0);
          } catch {
            return false;
          }
        }
        function startMocMotion(group: string, index: number): void {
          try {
            const r = typeof model.motion === 'function' ? model.motion(group, index) : null;
            if (r && typeof r.catch === 'function') r.catch(() => { /* 加载/播放失败静默 */ });
          } catch (err) {
            console.warn('[live2d] 播放动作失败', group, err);
          }
        }
        function expressionManager(): Any {
          try {
            const mm = model.internalModel && model.internalModel.motionManager;
            return mm && mm.expressionManager;
          } catch {
            return null;
          }
        }

        // 只使用头部参数跟随鼠标，避免眼球参数在不同模型上的表现不一致。
        // 调整这三个上限即可改变跟踪幅度，最终还会受模型自身参数范围限制。
        const HEAD_TRACK_MAX_X = 12;
        const HEAD_TRACK_MAX_Y = 8;
        const HEAD_TRACK_MAX_Z = 2.5;
        /**
         * 逻辑参数 → 模型实际参数 ID。
         * 默认就是 Cubism 标准名；命名不标准的模型可以在它的 pet-model.json 里写 parameterMap，
         * 挂载后由 renderer 调 setParameterMap() 换掉（换完重新探测存在性，缺哪个跳哪个）。
         */
        const paramIds: Record<ParamKey, string> = {
          angleX: 'ParamAngleX',
          angleY: 'ParamAngleY',
          angleZ: 'ParamAngleZ',
          eyeLOpen: 'ParamEyeLOpen',
          eyeROpen: 'ParamEyeROpen',
          eyeBallX: 'ParamEyeBallX',
          eyeBallY: 'ParamEyeBallY',
          mouthOpenY: 'ParamMouthOpenY',
          mouthForm: 'ParamMouthForm',
        };
        let headTrackX = 0;
        let headTrackY = 0;
        let headTrackZ = 0;
        const idleMotionAvailable = hasMotionGroup('Idle');
        let headTrackOK = false;
        // 追踪层要用到的参数是否存在（缺哪个就只驱动存在的那些，不报错）
        let eyeLOK = false;
        let eyeROK = false;
        let eyeBallXOK = false;
        let eyeBallYOK = false;
        let mouthOpenOK = false;
        let mouthFormOK = false;
        /** 重新探测参数存在性并刷新跟踪幅度（默认名与自定义映射共用同一条路径） */
        const resolveParams = (): void => {
          headTrackX = Math.min(paramLimit(paramIds.angleX), HEAD_TRACK_MAX_X);
          headTrackY = Math.min(paramLimit(paramIds.angleY), HEAD_TRACK_MAX_Y);
          headTrackZ = Math.min(paramLimit(paramIds.angleZ), HEAD_TRACK_MAX_Z);
          headTrackOK = headTrackX > 0 || headTrackY > 0;
          eyeLOK = paramLimit(paramIds.eyeLOpen) > 0;
          eyeROK = paramLimit(paramIds.eyeROpen) > 0;
          eyeBallXOK = paramLimit(paramIds.eyeBallX) > 0;
          eyeBallYOK = paramLimit(paramIds.eyeBallY) > 0;
          mouthOpenOK = paramLimit(paramIds.mouthOpenY) > 0;
          mouthFormOK = paramLimit(paramIds.mouthForm) > 0;
        };
        resolveParams();
        // 新框架（Cubism 5 / untitled-engine）在挂载瞬间 `_parameterValues` 可能还是空的，
        // 那一刻解析会得出"全部参数都不存在"；前若干帧再解析几次补上（幂等，最多 12 次）。
        let paramAttempts = 0;
        const ensureParamsReady = (): void => {
          if (paramAttempts >= 12) return;
          const store = paramStore();
          if (!store || store.count <= 0) return;
          paramAttempts += 1;
          resolveParams();
        };
        /** 基座参数值（待机 + 鼠标视线）：追踪层要按权重在这上面混合 */
        const baseParams = new Map<string, number>();
        const setBaseParam = (id: string, value: number): void => {
          baseParams.set(id, value);
          setParam(id, value);
        };
        const mixer = new ParamMixer();
        let lastFrameSource = 'none';
        let lastFrameAt = 0;
        let gazeTX = 0;  // 视线目标（renderer.setGaze 写入，nx 向右 / ny 向上）
        let gazeTY = 0;
        let gazeCX = 0;  // 视线当前值（每帧 lerp 平滑）
        let gazeCY = 0;
        let headCX = 0;  // 头部滞后跟随状态（“眼先头后”，比眼球慢）
        let headCY = 0;
        let swayStart = 0; // “挥手”摇摆手势开始时刻(秒)，0=未激活
        const SWAY_DURATION = 1.5;
        let eBreath = 1; // 呼吸/浮动 ease 状态（指数趋近，避免生硬换向）
        let eBob = 0;
        let zoomSteps = 0; // 滚轮缩放档位：scale × 1.08^steps；0 = fit 基准

        const handle: RenderHandle = {
          kind: 'moc3',
          playMotion(group: string): void {
            const g = group || '';
            if (g === 'wave') {
              if (hasMotionGroup('wave')) {
                startMocMotion('wave', 0); // 真实 wave 组（未来模型若注入则直接播）
              } else {
                // 当前资产无 wave 组 → 退化为整体左右摇摆 2.5 个周期的挥手手势
                swayStart = performance.now() / 1000;
              }
            } else if (g === 'Idle' || g === 'idle') {
              swayStart = 0;
              if (hasMotionGroup('Idle')) startMocMotion('Idle', 0);
            } else if (g && hasMotionGroup(g)) {
              startMocMotion(g, 0);
            }
          },
          setExpression(name: string | null): void {
            try {
              const em = expressionManager();
              if (!em) return;
              if (!name) {
                if (typeof em.resetExpression === 'function') em.resetExpression();
                return;
              }
              if (typeof em.getExpressionIndex === 'function' && em.getExpressionIndex(name) < 0) return;
              const r = typeof model.expression === 'function' ? model.expression(name) : null;
              if (r && typeof r.catch === 'function') r.catch(() => { /* ignore */ });
            } catch (err) {
              console.warn('[live2d] 切换表情失败', name, err);
            }
          },
          listExpressions(): string[] {
            try {
              const em = expressionManager();
              const d = em && Array.isArray(em.definitions) ? em.definitions : [];
              return d.map((x: Any) => (x && typeof x.Name === 'string' ? x.Name : '')).filter(Boolean);
            } catch {
              return [];
            }
          },
          setGaze(nx: number, ny: number): void {
          gazeTX = (Number.isFinite(nx) ? Math.max(-1, Math.min(1, nx)) : 0) * framingGazeGain();
          gazeTY = (Number.isFinite(ny) ? Math.max(-1, Math.min(1, ny)) : 0) * framingGazeGain();
          },
          /**
           * 角色在窗口里的实际可见范围（相对窗口顶部的 px）。
           * 主进程用它把对话气泡摆在"头顶上方"而不是窗口上方——窗口顶部有一大段是透明的。
           */
          bounds(): { top: number; height: number } | null {
            const vw = window.innerWidth || 1;
            const vh = window.innerHeight || 1;
            if (!natW || !natH) return null;
            const s =
              Math.min((vw * FIT_MARGIN) / natW, (vh * FIT_MARGIN) / natH) * framingZoom() * Math.pow(1.08, zoomSteps);
            if (!Number.isFinite(s) || s <= 0) return null;
            const hPx = natH * s;
            return { top: Math.round((vh - hPx) / 2 + framingShiftPx(hPx)), height: Math.round(hPx) };
          },
          zoom(dir: number): void {
            zoomSteps = Math.max(-8, Math.min(14, zoomSteps + (dir > 0 ? 1 : -1)));
          },
          setFraming(mode: 'full' | 'half'): void {
            framingMode = mode === 'half' ? 'half' : 'full';
            refit(); // 立刻按新取景重排（下一帧 update 也会跟上）
          },
          /**
           * 推进一帧追踪数据（骨骼 / 眼 / 嘴）。
           * 层级：tracking（TTL 900ms）—— 500ms 没新帧就开始衰减，1s 内自动回到鼠标跟随。
           * 缺参数降级：模型没有 ParamEyeBallX/Y 就只驱动头部；没有眨眼参数就跳过眨眼。
           */
          applyTrackingFrame(frame: TrackingFrame): void {
            if (!frame || typeof frame !== 'object') return;
            const params: Record<string, number> = {};
            const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
            const head = frame.head ?? {};
            if (headTrackX > 0 && Number.isFinite(head.yaw)) params[paramIds.angleX] = clamp(head.yaw as number) * headTrackX;
            if (headTrackY > 0 && Number.isFinite(head.pitch)) params[paramIds.angleY] = clamp(head.pitch as number) * headTrackY;
            if (headTrackZ > 0 && Number.isFinite(head.roll)) params[paramIds.angleZ] = clamp(head.roll as number) * headTrackZ;
            const eyes = frame.eyes ?? {};
            if (eyeLOK && Number.isFinite(eyes.blinkL)) params[paramIds.eyeLOpen] = 1 - Math.max(0, Math.min(1, eyes.blinkL as number));
            if (eyeROK && Number.isFinite(eyes.blinkR)) params[paramIds.eyeROpen] = 1 - Math.max(0, Math.min(1, eyes.blinkR as number));
            if (eyeBallXOK && Number.isFinite(eyes.eyeBallX)) params[paramIds.eyeBallX] = clamp(eyes.eyeBallX as number);
            if (eyeBallYOK && Number.isFinite(eyes.eyeBallY)) params[paramIds.eyeBallY] = clamp(eyes.eyeBallY as number);
            const mouth = frame.mouth ?? {};
            if (mouthOpenOK && Number.isFinite(mouth.openY)) params[paramIds.mouthOpenY] = Math.max(0, Math.min(1, mouth.openY as number));
            if (mouthFormOK && Number.isFinite(mouth.form)) params[paramIds.mouthForm] = clamp(mouth.form as number);
            lastFrameSource = typeof frame.source === 'string' ? frame.source : 'external';
            lastFrameAt = performance.now();
            if (Object.keys(params).length) mixer.set('tracking', params, 1, 900);
          },
          /** 语音口型：直接驱动嘴部参数，TTL 由调用方按音频/文本长度给 */
          applySpeech(mouth: { openY?: number; form?: number }, ttlMs = 600): void {
            const params: Record<string, number> = {};
            if (mouthOpenOK && Number.isFinite(mouth?.openY)) params[paramIds.mouthOpenY] = Math.max(0, Math.min(1, mouth.openY as number));
            if (mouthFormOK && Number.isFinite(mouth?.form)) params[paramIds.mouthForm] = Math.max(-1, Math.min(1, mouth.form as number));
            if (Object.keys(params).length) mixer.set('speech', params, 1, Math.max(120, ttlMs));
          },
          /**
           * 情绪 → 表情。
           * @param label 情绪标签（happy/sad/…）
           * @param expressionName 模型预设里指定的表情名（pet-model.json 的 emotionMap）；给了就优先用它
           * @returns 实际应用的表情名；模型没有对应表情时返回 null（保持原样，不报错）
           */
          applyEmotionLabel(label: string, expressionName?: string): string | null {
            const emotion = (window as Any).PetEmotion as
              | { expressionFor?: (l: string, list: string[]) => string | null }
              | undefined;
            let available: string[] = [];
            try {
              available = typeof handle.listExpressions === 'function' ? handle.listExpressions() : [];
            } catch {
              available = [];
            }
            let name: string | null = null;
            if (expressionName && available.includes(expressionName)) {
              name = expressionName; // 预设点名 → 必须真实存在才用（否则退回模糊匹配）
            } else if (emotion && typeof emotion.expressionFor === 'function') {
              name = emotion.expressionFor(label, available);
            }
            if (!name) return null;
            try {
              handle.setExpression?.(name);
              return name;
            } catch {
              return null;
            }
          },
          /** 追踪层状态（调试与状态展示用） */
          trackingStatus(): { sources: string[]; lastSource: string; lastFrameAgoMs: number | null } {
            return {
              sources: mixer.activeIds(),
              lastSource: lastFrameSource,
              lastFrameAgoMs: lastFrameAt ? Math.round(performance.now() - lastFrameAt) : null,
            };
          },
          /**
           * 换一套参数映射（pet-model.json 的 parameterMap）。
           * 逻辑名支持别名（anglex / angle_x / headx …）；换完重新探测存在性，
           * 因此把参数映射写错只会"该参数不再驱动"，不会抛错或把模型弄坏。
           * @returns 生效后的 逻辑名→实际参数ID 表（便于日志与调试）
           */
          setParameterMap(map: Record<string, string> | null | undefined): Record<string, string> {
            if (map && typeof map === 'object') {
              for (const [logical, actual] of Object.entries(map)) {
                if (typeof actual !== 'string' || !actual.trim()) continue;
                const lower = String(logical).toLowerCase();
                const key = (lower in PARAM_ALIASES ? PARAM_ALIASES[lower] : (logical as ParamKey));
                if (key && Object.prototype.hasOwnProperty.call(paramIds, key)) paramIds[key] = actual.trim();
              }
            }
            resolveParams();
            log('参数映射生效:', { ...paramIds });
            return { ...paramIds };
          },
          /** 当前参数映射 + 各参数是否存在（设置页/调试展示"这个模型缺什么"） */
          parameterInfo(): { ids: Record<string, string>; present: Record<string, boolean> } {
            return {
              ids: { ...paramIds },
              present: {
                [paramIds.angleX]: headTrackX > 0,
                [paramIds.angleY]: headTrackY > 0,
                [paramIds.angleZ]: headTrackZ > 0,
                [paramIds.eyeLOpen]: eyeLOK,
                [paramIds.eyeROpen]: eyeROK,
                [paramIds.eyeBallX]: eyeBallXOK,
                [paramIds.eyeBallY]: eyeBallYOK,
                [paramIds.mouthOpenY]: mouthOpenOK,
                [paramIds.mouthForm]: mouthFormOK,
              },
            };
          },
          /** 停掉追踪/语音层，回到基座（鼠标跟随） */
          clearTrackingLayer(): void {
            mixer.clear();
            lastFrameSource = 'none';
            lastFrameAt = 0;
          },
          /** 调试：换运行库/排查"画不出来"时看这一组数字 */
          debug(): Any {
            const core = model && model.internalModel && model.internalModel.coreModel;
            const cv = view as HTMLCanvasElement | undefined;
            const sample = (): Any => {
              try {
                if (!cv || !cv.width || !cv.height) return null;
                const probe = document.createElement('canvas');
                probe.width = Math.min(120, cv.width);
                probe.height = Math.min(120, cv.height);
                const ctx = probe.getContext('2d');
                if (!ctx) return null;
                ctx.drawImage(cv, 0, 0, probe.width, probe.height);
                const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
                let nonZero = 0;
                for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonZero += 1;
                return { sampled: probe.width * probe.height, nonTransparent: nonZero };
              } catch (err) {
                return `ERR:${String((err as Error)?.message ?? err).slice(0, 60)}`;
              }
            };
            const before = sample();
            // 手动 renderer.render 一次再看像素：区分"库没画"还是"画了但没提交/被清掉"
            let manualRender: Any = null;
            try {
              if (app.renderer && app.stage) app.renderer.render(app.stage);
              manualRender = 'ok';
            } catch (err) {
              manualRender = `ERR:${String((err as Error)?.message ?? err).slice(0, 80)}|${String((err as Error)?.stack ?? '').slice(0, 240)}`;
            }
            const after = sample();
            const im = model && model.internalModel;
            let texCount: Any = null;
            try {
              const t = im && (im.textures || im._textures);
              texCount = Array.isArray(t) ? t.length : t ? 'not-array' : null;
            } catch { /* ignore */ }
            return {
              natW,
              natH,
              modelW: model ? model.width : null,
              modelH: model ? model.height : null,
              scale: model && model.scale ? model.scale.x : null,
              pos: model && model.position ? { x: model.position.x, y: model.position.y } : null,
              visible: model ? model.visible : null,
              alpha: model ? model.alpha : null,
              canvas: cv ? { cssW: cv.clientWidth, cssH: cv.clientHeight, pxW: cv.width, pxH: cv.height } : null,
              stageChildren: app.stage ? app.stage.children.length : null,
              rendererType: app.renderer ? (app.renderer.name || app.renderer.type) : null,
              hasAppRender: typeof app.render === 'function',
              coreKeys: core ? Object.keys(core).slice(0, 12) : null,
              paramStore: (() => {
                try {
                  const store = paramStore();
                  const c = core;
                  const ids = c && c._parameterIds;
                  let firstIds: Any = null;
                  try {
                    const size = Array.isArray(ids) ? ids.length : ids && typeof ids.getSize === 'function' ? ids.getSize() : 0;
                    const at = (i: number): Any => (Array.isArray(ids) ? ids[i] : ids.at(i));
                    firstIds = [];
                    for (let i = 0; i < Math.min(3, size); i += 1) {
                      const it = at(i);
                      firstIds.push(
                        typeof it === 'string'
                          ? it
                          : { keys: it ? Object.keys(it).slice(0, 4) : null, getString: typeof it?.getString === 'function' ? it.getString() : null, s: it?.s, id: it?._id ?? it?.id },
                      );
                    }
                  } catch (err) {
                    firstIds = `ERR:${String((err as Error)?.message ?? err).slice(0, 60)}`;
                  }
                  return {
                    store: store ? { count: store.count, minType: Object.prototype.toString.call(store.min).slice(0, 24) } : null,
                    idsType: Object.prototype.toString.call(ids).slice(0, 24),
                    firstIds,
                    idxAngleX: c ? paramIndex(c, 'ParamAngleX') : null,
                    getParamIndexType: typeof (c && c.getParameterIndex),
                  };
                } catch (err) {
                  return `ERR:${String((err as Error)?.message ?? err).slice(0, 80)}`;
                }
              })(),
              textures: texCount,
              modelTextures: model && model.textures ? model.textures.length : null,
              /**
               * 贴图 LOD 取证：`source` 是原始资源尺寸，`effective` 是引擎当前**实际采样**的尺寸。
               * 开了 single-auto 且模型够大时，effective 会明显小于 source（说明降采样已生效）；
               * 两者相同 = LOD 未生效（贴图没到阈值，或选项被改回 false）。
               */
              textureLod: (() => {
                try {
                  const list: Any[] = model && Array.isArray(model.textures) ? model.textures : [];
                  return list.map((t: Any) => {
                    const src = t && t.source;
                    return {
                      source: src ? `${src.pixelWidth || src.width}x${src.pixelHeight || src.height}` : null,
                      effective: src ? `${src.width}x${src.height}` : null,
                    };
                  });
                } catch {
                  return null;
                }
              })(),
              bgAlpha: app.renderer && app.renderer.background ? app.renderer.background.alpha : null,
              isWebGL2: (() => {
                try {
                  return Boolean(app.renderer && app.renderer.gl && app.renderer.gl instanceof WebGL2RenderingContext);
                } catch {
                  return null;
                }
              })(),
              modelRendererSet: Boolean(model && model.renderer),
              internalModelKeys: im ? Object.keys(im).slice(0, 30) : null,
              // 网络层证据：贴图/moc3 到底请求了哪些 URL、回了多少字节（换运行库排查最有用）
              resources: (() => {
                try {
                  return performance
                    .getEntriesByType('resource')
                    .map((e: Any) => ({
                      name: String(e.name).replace(/^https?:\/\/127\.0\.0\.1:\d+/, '').slice(-70),
                      bytes: e.transferSize || e.encodedBodySize || 0,
                      ms: Math.round(e.duration || 0),
                    }))
                    .filter((r: Any) => /texture|\.moc3|model3\.json|physics|motion|exp3/i.test(r.name))
                    .slice(-14);
                } catch {
                  return null;
                }
              })(),
              drawnPixelsBefore: before,
              manualRender,
              drawnPixelsAfter: after,
            };
          },
          update(nowSec: number, deltaSec: number): void {
            if (destroyed || !model || !natW || !natH) return;
            ensureParamsReady(); // 参数表晚就绪时补解析（见上方注释）
            const vw = window.innerWidth || 1;
            const vh = window.innerHeight || 1;
            // 也按设备像素比判断：窗口跨屏拖动 / 改系统缩放时 DPR 会变而宽高不变，
            // 只比宽高会漏掉这种"缓冲倍率已过期"的情况。
            if (vw !== lastW || vh !== lastH || dpr() !== lastDpr) refit();

            // 待机呼吸和浮动：双正弦错开并平滑趋近目标
            const breathTarget = 1 + Math.sin(nowSec * 1.22 + phase * 2.1) * 0.0095
                                    + Math.sin(nowSec * 0.62 + phase) * 0.0055;
            const bobTarget = Math.sin(nowSec * 0.85 + phase) * 3.2
                              + Math.sin(nowSec * 0.43 + phase * 1.7) * 1.8;
            const ke = Math.min(1, (deltaSec || 1 / 60) * 6);
            eBreath += (breathTarget - eBreath) * ke;
            eBob += (bobTarget - eBob) * ke;
            const breathe = eBreath;
            const bob = eBob;
            // “挥手”手势：左右摇摆 ±~5°，2.5 周期、缓入缓出
            let swayRad = 0;
            if (swayStart > 0) {
              const p = (nowSec - swayStart) / SWAY_DURATION;
              if (p >= 1) {
                swayStart = 0;
              } else {
                const env = Math.sin(Math.max(0, p) * Math.PI); // 0→1→0 包络
                swayRad = Math.sin(Math.max(0, p) * Math.PI * 5) * 0.09 * env;
              }
            }
            try {
              const sFit =
                Math.min((vw * FIT_MARGIN) / natW, (vh * FIT_MARGIN) / natH) *
                framingZoom() *
                breathe *
                Math.pow(1.08, zoomSteps);
              model.scale.set(sFit);
              const wPx = natW * sFit;
              const hPx = natH * sFit;
              model.position.set((vw - wPx) / 2, (vh - hPx) / 2 + bob + framingShiftPx(hPx));
              model.rotation = swayRad;
              if (typeof model.update === 'function') model.update(deltaSec * 1000);

              // —— 视线跟踪（moc3，明显跟随）：写在 model.update 之后（避免被 Idle 动作帧覆盖）；
              //    眼球快（k≈dt*12）、头部慢（dt*4 独立滞后）→ 眼先头后的自然延迟 ——
              const dt = Math.min(0.25, Math.max(0.001, deltaSec || 1 / 60));
              const tracking = gazeTX !== 0 || gazeTY !== 0;
              const k = tracking ? 1 - Math.exp(-dt * 12) : 1 - Math.exp(-dt * 2.2); // 注视快、归零缓
              gazeCX += (gazeTX - gazeCX) * k;
              gazeCY += (gazeTY - gazeCY) * k;
              if (gazeCX > -0.004 && gazeCX < 0.004) gazeCX = 0;
              if (gazeCY > -0.004 && gazeCY < 0.004) gazeCY = 0;
              const hk = Math.min(1, dt * 4);
              headCX += (gazeCX - headCX) * hk;
              headCY += (gazeCY - headCY) * hk;
              if (gazeCX !== 0 || gazeCY !== 0) {
                // AngleX=左右，AngleY=上下；使用较慢的 headC* 保持自然滞后。
                if (headTrackX > 0) setBaseParam(paramIds.angleX, headCX * headTrackX);
                if (headTrackY > 0) setBaseParam(paramIds.angleY, headCY * headTrackY);
                if (headTrackZ > 0) setBaseParam(paramIds.angleZ, headCX * headTrackZ);
              } else if (headTrackOK && !idleMotionAvailable) {
                // 没有原生 Idle 时才补充幅度很小的头部游移。
                if (headTrackX > 0) setBaseParam(paramIds.angleX, Math.sin(nowSec * 0.45 + phase * 0.7) * Math.min(headTrackX, 2.2));
                if (headTrackY > 0) setBaseParam(paramIds.angleY, Math.sin(nowSec * 0.33 + phase * 1.1) * Math.min(headTrackY, 2.0));
                if (headTrackZ > 0) setBaseParam(paramIds.angleZ, Math.sin(nowSec * 0.27 + phase * 0.9) * Math.min(headTrackZ, 2.4));
              }
              // 追踪 / 语音层：按权重在基座值上混合；层过期后自动衰减，回到鼠标跟随（无设备时零副作用）
              const tracked = mixer.sample();
              if (tracked.size) {
                for (const [param, { value, weight }] of tracked.entries()) {
                  const base = baseParams.get(param) ?? value;
                  setParam(param, base * (1 - weight) + value * weight);
                }
              }
              // Pixi 8：走 renderer.render(stage)（实测 app.render() 在这个组合下不出画面）
              if (app.renderer && app.stage) app.renderer.render(app.stage);
              renderedThisFrame = true;
              // 命中遮罩必须在**绘制刚结束、缓冲尚未被清空**时取样，见 captureHitMaskNow 注释
              if (!maskData || maskRefreshQueued) captureHitMaskNow();
            } catch (err) {
              console.warn('[live2d] moc3 渲染帧失败', err);
            }
          },
          /** 刷新命中遮罩（点击穿透用）；返回是否成功 */
          refreshHitMask,
          /**
           * 客户端坐标是否命中角色。ok=false 表示"暂无可靠数据"，
           * 调用方应当**不拦截**鼠标（否则整窗变成看不见的挡板）。
           */
          hitTest(clientX: number, clientY: number): { ok: boolean; hit: boolean } {
            if (!maskData) return { ok: false, hit: false };
            return { ok: true, hit: hitTest(clientX, clientY) };
          },
          /**
           * 遮罩统计：不透明像素数与包围盒（归一化）。用于客观验证"遮罩是否真的有内容"，
           * 而不是靠几个采样点猜。data 为 null 时返回 available:false。
           */
          hitMaskStats(): { available: boolean; opaque: number; bbox: [number, number, number, number] | null; ageMs: number | null } {
            const d = maskData as Uint8ClampedArray | null;
            if (!d) return { available: false, opaque: 0, bbox: null, ageMs: null };
            let opaque = 0;
            let minX = MASK_W, minY = MASK_H, maxX = -1, maxY = -1;
            for (let y = 0; y < MASK_H; y++) {
              for (let x = 0; x < MASK_W; x++) {
                if (d[(y * MASK_W + x) * 4 + 3] > 24) {
                  opaque++;
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
              }
            }
            const bbox: [number, number, number, number] | null = maxX < 0
              ? null
              : [minX / MASK_W, minY / MASK_H, (maxX + 1) / MASK_W, (maxY + 1) / MASK_H];
            return { available: true, opaque, bbox, ageMs: maskAt ? Math.round(performance.now() - maskAt) : null };
          },
          /**
           * 模型内容包围盒实测：遍历可绘制网格的顶点，算出**真实内容**的范围，
           * 再与 `model.width/height`（pixi 的包围盒）对比。
           *
           * 为什么需要：某些模型（贴图仅 2048²）报告的画布高达 3778px，
           * 与实际内容严重不符；按它适配缩放会把角色压成极窄一条。
           * 用顶点范围才反映"用户能看到的东西"。
           */
          contentBounds(): Any {
            try {
              const core = model && model.internalModel && model.internalModel.coreModel;
              if (!core) return { ok: false, why: 'no coreModel' };
              const count = typeof core.getDrawableCount === 'function' ? core.getDrawableCount() : 0;
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, used = 0;
              for (let d = 0; d < count; d++) {
                let pos: Any;
                try { pos = core.getDrawableVertexPositions(d); } catch { continue; }
                if (!pos || !pos.length) continue;
                used++;
                for (let i = 0; i + 1 < pos.length; i += 2) {
                  const x = pos[i], y = pos[i + 1];
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
              }
              const scale = model.scale ? model.scale.x : 1;
              const w = maxX - minX, h = maxY - minY;
              return {
                ok: used > 0,
                drawables: count,
                used,
                // 模型坐标系下的内容范围（Cubism 里 x 向右、y 向上）
                content: [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)],
                contentSize: [Math.round(w), Math.round(h)],
                // 换算成屏幕像素（乘当前缩放）
                pixelSize: [Math.round(w * scale), Math.round(h * scale)],
                scale,
                canvasSize: [Math.round(model.width || 0), Math.round(model.height || 0)],
                viewport: [window.innerWidth || 0, window.innerHeight || 0],
              };
            } catch (err) {
              return { ok: false, why: String((err as Error).message) };
            }
          },
          destroy(): void {
            if (destroyed) return;
            destroyed = true;
            window.clearTimeout(t1);
            window.clearTimeout(t2);
            try {
              if (model) {
                app.stage.removeChild(model);
                model.destroy({ texture: true });
              }
            } catch (err) {
              console.warn('[live2d] moc3 模型销毁失败', err);
            }
            try {
              app.destroy(true, { children: true, texture: true });
            } catch (err) {
              console.warn('[live2d] PIXI app 销毁失败', err);
            }
            model = null;
          },
        };
        // 自动进入 Idle 组（若模型有）：让 moc3 自带动画（呼吸/身体微摆）真正动起来，
        // 而不是静止贴图观感；视线参数在 update() 末尾写入，不会被动作帧覆盖。
        if (idleMotionAvailable) startMocMotion('Idle', 0);
        if (headTrackOK) log('头部跟踪参数:', { headTrackX, headTrackY, headTrackZ, ids: paramIds });
        else log('头部跟踪: 当前模型没有头部角度参数', paramIds.angleX, paramIds.angleY, paramIds.angleZ);
        log('moc3 就绪:', modelUrl);
        return handle;
      })
      .catch((err: Any) => {
        console.error('[live2d] moc3 模型加载失败:', err);
        // 换运行库时排障用：把栈也打出来（压缩过的 bundle 里至少能看到函数名/行号）
        if (err && err.stack) console.error('[live2d] 失败栈:', String(err.stack).slice(0, 900));
        try { app.destroy(true); } catch { /* ignore */ }
        return null;
      });
  }

  /* ============================================================
     portrait：<img> + CSS transform 待机动画
     ============================================================ */
  function mountPortrait(input: { container: HTMLElement; url: string }): RenderHandle | null {
    const box = document.createElement('div');
    box.className = 'pet-media';

    const img = document.createElement('img');
    img.className = 'pet-portrait';
    img.alt = 'pet portrait';
    img.draggable = false;
    img.addEventListener('load', () => img.classList.add('is-visible'));
    img.addEventListener('error', () => {
      console.warn('[live2d] portrait 图片加载失败:', input.url);
      // 立绘加载失败时给出可见提示（含地址），避免“空白但无占位说明”的观感
      const errHint = document.createElement('div');
      errHint.className = 'ph-hint';
      errHint.textContent = `立绘加载失败：${input.url}`;
      box.appendChild(errHint);
    });
    img.src = input.url; // 主进程本地 HTTP 服务或 data:/blob:，均可直接显示
    box.appendChild(img);
    input.container.appendChild(box);

    const phase = Math.random() * Math.PI * 2;

    let gazeTX = 0;  // 视线目标（向右/向上为正，renderer.setGaze 写入）
    let gazeTY = 0;
    let gazeCX = 0;  // 视线当前值（每帧 lerp）
    let gazeCY = 0;
    let waveStart = 0; // “挥手”动画开始时刻(秒)，0=未激活
    const WAVE_DURATION = 1.5;
    let zoomSteps = 0; // 滚轮缩放档位（portrait）：scale × 1.08^steps

    const handle: RenderHandle = {
      kind: 'portrait',
      playMotion(group: string): void {
        const g = group || '';
        if (g === 'wave') {
          waveStart = performance.now() / 1000;
        } else {
          waveStart = 0; // Idle / 其余：取消挥手，回到待机呼吸/浮动
        }
      },
      setGaze(nx: number, ny: number): void {
      gazeTX = (Number.isFinite(nx) ? Math.max(-1, Math.min(1, nx)) : 0) * framingGazeGain();
      gazeTY = (Number.isFinite(ny) ? Math.max(-1, Math.min(1, ny)) : 0) * framingGazeGain();
      },
      zoom(dir: number): void {
        zoomSteps = Math.max(-8, Math.min(14, zoomSteps + (dir > 0 ? 1 : -1)));
      },
      setFraming(mode: 'full' | 'half'): void {
        framingMode = mode === 'half' ? 'half' : 'full';
      },
      bounds(): { top: number; height: number } | null {
        // 立绘用 CSS 变换（呼吸/浮动/缩放）：直接量元素的实际矩形最准
        try {
          const r = img.getBoundingClientRect();
          if (!r.height) return null;
          return { top: Math.round(r.top), height: Math.round(r.height) };
        } catch {
          return null;
        }
      },
      update(nowSec: number, deltaSec: number): void {
        const t = nowSec + phase;
        const zoomK = Math.pow(1.08, zoomSteps);
        // 呼吸 scale 1±0.02（0.012+0.008），上下浮动 ±4px，轻倾斜更自然
        const breathe = 1 + Math.sin(t * 1.35) * 0.012 + Math.sin(t * 0.63 + 1.8) * 0.008;
        const lift = Math.sin(t * 0.86) * 2.6 + Math.sin(t * 0.41 + 2.6) * 1.4;
        const tilt = Math.sin(t * 0.55 + 1.2) * 0.5;

        // 视线平滑：靠近鼠标快、静止/离开后缓缓归零
        const dt = Math.min(0.25, Math.max(0.001, deltaSec || 1 / 60));
        const tracking = gazeTX !== 0 || gazeTY !== 0;
        const k = tracking ? 1 - Math.exp(-dt * 10) : 1 - Math.exp(-dt * 2.2);
        gazeCX += (gazeTX - gazeCX) * k;
        gazeCY += (gazeTY - gazeCY) * k;
        if (gazeCX > -0.0015 && gazeCX < 0.0015) gazeCX = 0;
        if (gazeCY > -0.0015 && gazeCY < 0.0015) gazeCY = 0;

        // “挥手”：整体左右摇摆 2.5 周期 + 轻微横移，缓入缓出（无 moc3 时的 CSS 级降级）
        let waveRot = 0;
        let waveX = 0;
        if (waveStart > 0) {
          const p = (nowSec - waveStart) / WAVE_DURATION;
          if (p >= 1) {
            waveStart = 0;
          } else {
            const env = Math.sin(Math.max(0, p) * Math.PI);
            waveRot = Math.sin(Math.max(0, p) * Math.PI * 5) * 9 * env;
            waveX = Math.sin(Math.max(0, p) * Math.PI * 5) * 4 * env;
          }
        }

        // 身体“随鼠标”自然晃动：横向位移 ±~8px + rotateY ±~6°；纵向视线 ±~3px；
        // 视线向上时轻微后仰（rotate 分量），伪 3D 立体感更强。
        // 取景（全身/半身）在这里表现为"放大 + 整体下移"：半身时把上半身推到画面中部。
        // 立绘的下移量比 Live2D 小得多：立绘的缩放锚点在**头顶**（见 CSS 的
        // body.framing-half .pet-portrait），放大后画面顶部就是头顶附近，再按 Live2D 的
        // 0.28 往下推会在头顶上方留出一大块空白（实测过），0.05 刚好让头顶贴住上沿。
        const boxH = box.getBoundingClientRect().height || 1;
        const frameShift = framingMode === 'half' ? boxH * HALF_SHIFT_RATIO_PORTRAIT : 0;
        const gazeX = gazeCX * 8 + waveX;
        const gazeY = gazeCY * 3;
        const rotateY = gazeCX * 6;
        const tiltGaze = -gazeCY * 2;
        img.style.transform =
          `perspective(900px) translate3d(${gazeX.toFixed(2)}px, ${(lift + gazeY + frameShift).toFixed(2)}px, 0) ` +
          `rotate(${(tilt + waveRot + tiltGaze).toFixed(2)}deg) ` +
          `rotateY(${rotateY.toFixed(2)}deg) ` +
          `scale(${(breathe * zoomK * framingZoom()).toFixed(4)})`;
      },
      destroy(): void {
        box.remove();
      },
    };
    return handle;
  }

  /* ============================================================
     placeholder：占位图形（可辨识的名字卡片 + 轻浮动）
     ============================================================ */
  function mountPlaceholder(input: {
    container: HTMLElement;
    name: string;
    hint?: string;
  }): RenderHandle | null {
    const box = document.createElement('div');
    box.className = 'pet-placeholder';

    const emoji = document.createElement('div');
    emoji.className = 'ph-emoji';
    emoji.textContent = '🐾';

    const nameEl = document.createElement('div');
    nameEl.className = 'ph-name';
    nameEl.textContent = input.name || 'Pet';

    const hintEl = document.createElement('div');
    hintEl.className = 'ph-hint';
    hintEl.textContent = input.hint || '当前环境无法渲染 Live2D(moc3)';

    box.append(emoji, nameEl, hintEl);
    input.container.appendChild(box);

    const phase = Math.random() * Math.PI * 2;

    const handle: RenderHandle = {
      kind: 'placeholder',
      update(nowSec: number): void {
        const t = nowSec + phase;
        const breathe = 1 + Math.sin(t * 1.1) * 0.01;
        const lift = Math.sin(t * 0.7) * 2.2;
        box.style.transform = `translateY(${lift.toFixed(2)}px) scale(${breathe.toFixed(4)})`;
      },
      destroy(): void {
        box.remove();
      },
    };
    return handle;
  }

  /** 对外 API（renderer.ts 通过 window.PetLive2d 调用） */
  const api = {
    isLive2DAvailable,
    mountLive2D,
    mountPortrait,
    mountPlaceholder,
    /** 参数混合器（分层权重 + TTL 衰减）：暴露出来给单元测试与调试台验证混合/过期行为 */
    __ParamMixer: ParamMixer,
  };
  w.PetLive2d = api;
})();
