import { COCO_NAMES, VEHICLE_CLASS_IDS } from "./coco.js";

const MODEL_SIZE = 640;

function iou(boxA, boxB) {
  const left = Math.max(boxA.x1, boxB.x1);
  const top = Math.max(boxA.y1, boxB.y1);
  const right = Math.min(boxA.x2, boxB.x2);
  const bottom = Math.min(boxA.y2, boxB.y2);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (overlap <= 0) {
    return 0;
  }
  const areaA = (boxA.x2 - boxA.x1) * (boxA.y2 - boxA.y1);
  const areaB = (boxB.x2 - boxB.x1) * (boxB.y2 - boxB.y1);
  return overlap / (areaA + areaB - overlap);
}

function nonMaximumSuppression(detections, threshold) {
  const ordered = detections.slice().sort((left, right) => right.score - left.score);
  const kept = [];
  while (ordered.length) {
    const candidate = ordered.shift();
    kept.push(candidate);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      if (ordered[index].classId !== candidate.classId) {
        continue;
      }
      if (iou(candidate.box, ordered[index].box) > threshold) {
        ordered.splice(index, 1);
      }
    }
  }
  return kept;
}

function letterboxFrame(sourceCanvas, scratchCanvas) {
  scratchCanvas.width = MODEL_SIZE;
  scratchCanvas.height = MODEL_SIZE;
  const context = scratchCanvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#727272";
  context.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);

  const scale = Math.min(MODEL_SIZE / sourceCanvas.width, MODEL_SIZE / sourceCanvas.height);
  const width = Math.round(sourceCanvas.width * scale);
  const height = Math.round(sourceCanvas.height * scale);
  const padX = (MODEL_SIZE - width) / 2;
  const padY = (MODEL_SIZE - height) / 2;

  context.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, padX, padY, width, height);
  const imageData = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const tensorData = new Float32Array(1 * 3 * MODEL_SIZE * MODEL_SIZE);
  for (let index = 0; index < MODEL_SIZE * MODEL_SIZE; index += 1) {
    const pixelOffset = index * 4;
    tensorData[index] = imageData[pixelOffset] / 255;
    tensorData[MODEL_SIZE * MODEL_SIZE + index] = imageData[pixelOffset + 1] / 255;
    tensorData[2 * MODEL_SIZE * MODEL_SIZE + index] = imageData[pixelOffset + 2] / 255;
  }

  return {
    input: tensorData,
    scale,
    padX,
    padY,
  };
}

export async function createYoloDetector({ modelPath, preferredExecutionProviders }) {
  const ort = window.ort;
  if (!ort) {
    throw new Error("ONNX Runtime Web failed to load.");
  }

  ort.env.wasm.simd = true;
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";

  let session;
  const errors = [];
  for (const provider of preferredExecutionProviders) {
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
      });
      return {
        provider,
        infer: (sourceCanvas, threshold = 0.35, nmsThreshold = 0.45) =>
          runInference(session, sourceCanvas, threshold, nmsThreshold),
      };
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
    }
  }

  throw new Error(`Unable to initialize YOLO model. ${errors.join(" | ")}`);
}

async function runInference(session, sourceCanvas, threshold, nmsThreshold) {
  const scratchCanvas = document.createElement("canvas");
  const { input, scale, padX, padY } = letterboxFrame(sourceCanvas, scratchCanvas);
  const feeds = {
    [session.inputNames[0]]: new window.ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  };
  const outputs = await session.run(feeds);
  const output = outputs[session.outputNames[0]];
  const data = output.data;
  const stride = output.dims[2];
  const detections = [];

  for (let index = 0; index < stride; index += 1) {
    let bestClassId = -1;
    let bestScore = 0;
    for (const classId of VEHICLE_CLASS_IDS) {
      const score = data[(4 + classId) * stride + index];
      if (score > bestScore) {
        bestScore = score;
        bestClassId = classId;
      }
    }

    if (bestScore < threshold || bestClassId < 0) {
      continue;
    }

    const cx = data[index];
    const cy = data[stride + index];
    const width = data[2 * stride + index];
    const height = data[3 * stride + index];

    const x1 = Math.max(0, (cx - width / 2 - padX) / scale);
    const y1 = Math.max(0, (cy - height / 2 - padY) / scale);
    const x2 = Math.min(sourceCanvas.width, (cx + width / 2 - padX) / scale);
    const y2 = Math.min(sourceCanvas.height, (cy + height / 2 - padY) / scale);

    detections.push({
      classId: bestClassId,
      label: COCO_NAMES[bestClassId],
      score: bestScore,
      box: { x1, y1, x2, y2 },
    });
  }

  return nonMaximumSuppression(detections, nmsThreshold);
}
