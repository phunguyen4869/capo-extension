// Tạo AudioWorkletNode tách lớp (lõi Rust/WASM).

const WASM_URL = new URL('../wasm/capo_dsp.wasm', import.meta.url).href;
const WORKLET_URL = new URL('../worklets/separator-processor.js', import.meta.url).href;

let modulePromise = null;
const workletLoaded = new WeakMap(); // BaseAudioContext -> Promise

function compileModule() {
  modulePromise ??= fetch(WASM_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${WASM_URL}: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((err) => {
      modulePromise = null;
      throw err;
    });
  return modulePromise;
}

function loadWorklet(ctx) {
  if (!workletLoaded.has(ctx)) workletLoaded.set(ctx, ctx.audioWorklet.addModule(WORKLET_URL));
  return workletLoaded.get(ctx);
}

/**
 * @param {BaseAudioContext} ctx
 * @param {{fftSize:number, hop:number, timeHalf:number, freqHalf:number, margin:number, sharpness:number}} preset
 * @param {{centerWidth?:number, bassCutoffHz?:number, vocalHighHz?:number, centerSmoothingMs?:number, karaoke?:boolean}} [params]
 *   mỗi lần đặt là đặt lại TẤT CẢ: tham số bị bỏ trống quay về mặc định
 * @returns {Promise<AudioWorkletNode & {latencySamples:number, stats:{centerRatio:number}, setParams(p:object):void}>}
 *   output 0 trống · 1 bass · 2 giọng hát · 3 nhạc cụ khác
 */
export async function createSeparatorNode(ctx, preset, params = {}) {
  const [module] = await Promise.all([compileModule(), loadWorklet(ctx)]);
  const node = new AudioWorkletNode(ctx, 'capo-separator', {
    numberOfInputs: 1,
    numberOfOutputs: 4,
    outputChannelCount: [2, 2, 2, 2],
    channelCount: 2,
    channelCountMode: 'explicit', // mono được upmix lên stereo
    channelInterpretation: 'speakers',
    processorOptions: { module, preset, params },
  });
  node.stats = { centerRatio: null };
  node.latencySamples = await new Promise((resolve, reject) => {
    node.port.onmessage = (e) => {
      if (e.data?.type === 'ready') resolve(e.data.latency);
      else if (e.data?.type === 'error') reject(new Error(e.data.message));
    };
  });
  node.port.onmessage = (e) => {
    if (e.data?.type === 'stats') node.stats = { centerRatio: e.data.centerRatio };
  };
  node.setParams = (p) => node.port.postMessage({ type: 'params', ...p });
  return node;
}
