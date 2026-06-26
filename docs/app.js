import { VehicleTracker } from "./lib/tracker.js";
import { createYoloDetector } from "./lib/yolo.js";

const ASSUMED_WIDTHS_M = {
  car: 1.8,
  motorcycle: 0.8,
  bus: 2.6,
  truck: 2.5,
};

const elements = {
  fileInput: document.querySelector("#video-file"),
  dropZone: document.querySelector("#drop-zone"),
  previewCanvas: document.querySelector("#preview-canvas"),
  statusText: document.querySelector("#status-text"),
  engineText: document.querySelector("#engine-text"),
  noteText: document.querySelector("#note-text"),
  calibrationText: document.querySelector("#calibration-text"),
  summaryTableBody: document.querySelector("#results-table tbody"),
  frameTableBody: document.querySelector("#frame-results-table tbody"),
  progressBar: document.querySelector("#progress-bar"),
  downloadCsv: document.querySelector("#download-csv"),
  downloadJson: document.querySelector("#download-json"),
  exportVideo: document.querySelector("#export-video"),
  replayButton: document.querySelector("#replay-button"),
  videoMeta: document.querySelector("#video-meta"),
  metricVehicles: document.querySelector("#metric-vehicles"),
  metricPeak: document.querySelector("#metric-peak"),
  metricAvg: document.querySelector("#metric-avg"),
};

const appState = {
  detector: null,
  objectUrl: null,
  sourceVideo: null,
  analysis: null,
  replaying: false,
  estimatedFps: 30,
  sampleEveryFrames: 3,
  selectionFrame: null,
  selectedTarget: null,
  mode: "idle",
};

window.__trafficReview = appState;

function setStatus(text) {
  elements.statusText.textContent = text;
}

function setProgress(value) {
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, value * 100))}%`;
}

function clearDownloads() {
  elements.downloadCsv.classList.add("disabled");
  elements.downloadJson.classList.add("disabled");
  elements.exportVideo.classList.add("disabled");
  elements.replayButton.classList.add("disabled");
}

function resetMetrics() {
  elements.metricVehicles.textContent = "0";
  elements.metricPeak.textContent = "0.0 mph";
  elements.metricAvg.textContent = "0.0 mph";
  elements.summaryTableBody.innerHTML = '<tr><td colspan="8">No results yet.</td></tr>';
  elements.frameTableBody.innerHTML = '<tr><td colspan="5">No frame metrics yet.</td></tr>';
  elements.noteText.textContent = "Not available yet.";
  elements.calibrationText.textContent = "Not available yet.";
}

function drawPreview(frameSource = null, annotations = null, selectedTrackId = null) {
  const canvas = elements.previewCanvas;
  const context = canvas.getContext("2d");

  if (!appState.sourceVideo && !frameSource) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const width = frameSource?.width || appState.sourceVideo.videoWidth || 960;
  const height = frameSource?.height || appState.sourceVideo.videoHeight || 540;
  canvas.width = width;
  canvas.height = height;

  if (frameSource) {
    context.drawImage(frameSource, 0, 0, width, height);
  } else {
    context.drawImage(appState.sourceVideo, 0, 0, width, height);
  }

  if (!annotations?.length) {
    return;
  }

  context.font = "600 18px IBM Plex Mono";
  annotations.forEach((item) => {
    const isSelected = selectedTrackId !== null && item.trackId === selectedTrackId;
    const color = isSelected ? "#b4432f" : "#204f44";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = isSelected ? 4 : 3;
    context.strokeRect(item.box.x1, item.box.y1, item.box.x2 - item.box.x1, item.box.y2 - item.box.y1);
    const text = isSelected
      ? `TARGET ${item.label}`
      : item.trackId
        ? `#${item.trackId} ${item.label}`
        : item.label;
    context.fillRect(item.box.x1, Math.max(0, item.box.y1 - 28), context.measureText(text).width + 18, 24);
    context.fillStyle = "#fff";
    context.fillText(text, item.box.x1 + 8, Math.max(18, item.box.y1 - 10));
  });
}

function setDownload(anchor, name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  anchor.href = url;
  anchor.download = name;
  anchor.classList.remove("disabled");
}

function buildCsv(rows, headers) {
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((key) => JSON.stringify(row[key])).join(","));
  });
  return lines.join("\n");
}

function renderSummaryTable(rows) {
  if (!rows.length) {
    elements.summaryTableBody.innerHTML = '<tr><td colspan="8">The selected vehicle was not tracked.</td></tr>';
    return;
  }

  elements.summaryTableBody.innerHTML = rows
    .map(
      (row) => `
        <tr class="${row.flagged ? "flagged" : ""}">
          <td>${row.track_id}</td>
          <td>${row.label}</td>
          <td>${row.peak_speed.toFixed(1)} ${row.speed_unit}</td>
          <td>${row.avg_speed.toFixed(1)} ${row.speed_unit}</td>
          <td>${row.frames_seen}</td>
          <td>${row.first_seen_s.toFixed(2)}s</td>
          <td>${row.last_seen_s.toFixed(2)}s</td>
          <td>${row.flagged ? "Yes" : "No"}</td>
        </tr>
      `,
    )
    .join("");
}

function renderFrameTable(rows) {
  if (!rows.length) {
    elements.frameTableBody.innerHTML = '<tr><td colspan="5">No frame metrics yet.</td></tr>';
    return;
  }

  elements.frameTableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${row.time_s.toFixed(2)}s</td>
          <td>${row.vehicle_count}</td>
          <td>${row.avg_speed.toFixed(1)} ${row.speed_unit}</td>
          <td>${row.max_speed.toFixed(1)} ${row.speed_unit}</td>
          <td>${row.tracks.length ? row.tracks.join(", ") : "none"}</td>
        </tr>
      `,
    )
    .join("");
}

function waitForVideo(video) {
  return new Promise((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve(video);
    };
    const onError = () => {
      cleanup();
      reject(new Error("This browser could not decode that video. Some MP4 codecs still fail in-browser."));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function seekVideo(video, timeS) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The browser failed while seeking through the uploaded video."));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = Math.min(timeS, Math.max(0, video.duration - 0.001));
  });
}

async function estimateFps(video) {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    return 30;
  }

  try {
    await seekVideo(video, 0);
    video.muted = true;
    const deltas = [];
    let previousMediaTime = null;

    const sampling = new Promise((resolve, reject) => {
      let frameCount = 0;
      const finish = () => {
        video.pause();
        resolve();
      };

      const callback = (_now, metadata) => {
        if (previousMediaTime !== null) {
          const delta = metadata.mediaTime - previousMediaTime;
          if (delta > 0) {
            deltas.push(delta);
          }
        }
        previousMediaTime = metadata.mediaTime;
        frameCount += 1;
        if (frameCount >= 12 || metadata.mediaTime >= Math.min(0.75, video.duration)) {
          finish();
          return;
        }
        video.requestVideoFrameCallback(callback);
      };

      video.requestVideoFrameCallback(callback);
      video.play().catch(reject);
    });

    await sampling;
    if (!deltas.length) {
      return 30;
    }
    const averageDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const fps = Math.round(1 / averageDelta);
    return Number.isFinite(fps) && fps > 0 ? fps : 30;
  } catch {
    video.pause();
    return 30;
  }
}

function chooseSamplingStep(fps) {
  if (fps >= 50) {
    return 5;
  }
  if (fps >= 30) {
    return 3;
  }
  if (fps >= 20) {
    return 2;
  }
  return 1;
}

function getMetersPerPixel(detection) {
  const widthM = ASSUMED_WIDTHS_M[detection.label] || 1.8;
  const widthPx = Math.max(24, detection.box.x2 - detection.box.x1);
  return widthM / widthPx;
}

function measureDetection(detection) {
  return {
    anchorPoint: [
      (detection.box.x1 + detection.box.x2) / 2,
      detection.box.y2,
    ],
    metersPerPixel: getMetersPerPixel(detection),
  };
}

async function ensureDetector() {
  if (appState.detector) {
    return appState.detector;
  }
  setStatus("Loading browser YOLO runtime.");
  const detector = await createYoloDetector({
    modelPath: "./assets/models/yolov8n.onnx",
    preferredExecutionProviders: ["webgpu", "wasm"],
  });
  appState.detector = detector;
  elements.engineText.value = `${detector.provider.toUpperCase()} in-browser inference`;
  return detector;
}

async function findSelectionFrame(video, detector) {
  const candidateTimes = [
    Math.min(1, Math.max(0, video.duration * 0.2)),
    Math.min(Math.max(0, video.duration * 0.35), Math.max(0, video.duration - 0.001)),
    Math.min(Math.max(0, video.duration * 0.5), Math.max(0, video.duration - 0.001)),
    0,
  ];

  const uniqueTimes = [...new Set(candidateTimes.map((value) => Number(value.toFixed(3))))];
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  const frameContext = frameCanvas.getContext("2d");

  for (const timeS of uniqueTimes) {
    await seekVideo(video, timeS);
    frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const detections = await detector.infer(frameCanvas, 0.2);
    if (detections.length) {
      const snapshot = document.createElement("canvas");
      snapshot.width = frameCanvas.width;
      snapshot.height = frameCanvas.height;
      snapshot.getContext("2d").drawImage(frameCanvas, 0, 0);
      return { timeS, frameCanvas: snapshot, detections };
    }
  }

  throw new Error("No vehicles were detected in the sampled frames of this clip.");
}

function buildSampleTimes(duration, fps, step, selectionTimeS) {
  const times = [];
  const samplePeriodS = step / fps;
  const sampleCount = Math.max(1, Math.ceil(duration / samplePeriodS));
  for (let index = 0; index < sampleCount; index += 1) {
    times.push(Number(Math.min(index * samplePeriodS, Math.max(0, duration - 0.001)).toFixed(3)));
  }
  times.push(Number(selectionTimeS.toFixed(3)));
  return [...new Set(times)].sort((left, right) => left - right);
}

function findTargetAtPoint(detections, x, y) {
  const containing = detections.filter(
    (item) => x >= item.box.x1 && x <= item.box.x2 && y >= item.box.y1 && y <= item.box.y2,
  );
  if (!containing.length) {
    return null;
  }
  containing.sort((left, right) => right.score - left.score);
  return containing[0];
}

function boxesOverlap(boxA, boxB) {
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

async function analyzeSelectedVehicle() {
  if (!appState.sourceVideo || !appState.selectionFrame || !appState.selectedTarget) {
    throw new Error("Choose a file and click the target vehicle first.");
  }

  const detector = await ensureDetector();
  const tracker = new VehicleTracker({
    historySeconds: 0.75,
    speedLimitMph: Number(document.querySelector("#speed-limit").value),
    speedUnit: "mph",
  });

  const video = appState.sourceVideo;
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  const frameContext = frameCanvas.getContext("2d");
  const sampleTimes = buildSampleTimes(
    video.duration,
    appState.estimatedFps,
    appState.sampleEveryFrames,
    appState.selectionFrame.timeS,
  );

  let selectedTrackId = null;
  const allSamples = [];

  for (let index = 0; index < sampleTimes.length; index += 1) {
    const timeS = sampleTimes[index];
    await seekVideo(video, timeS);
    frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const detections = await detector.infer(frameCanvas, Number(document.querySelector("#confidence-threshold").value));
    const annotated = tracker.update(detections, timeS, measureDetection);

    if (selectedTrackId === null && Math.abs(timeS - appState.selectionFrame.timeS) < 0.002) {
      let bestMatch = null;
      let bestScore = 0;
      for (const item of annotated) {
        const score = boxesOverlap(item.box, appState.selectedTarget.box);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = item;
        }
      }
      if (bestMatch) {
        selectedTrackId = bestMatch.trackId;
      }
    }

    const filtered = selectedTrackId === null
      ? []
      : annotated.filter((item) => item.trackId === selectedTrackId);

    allSamples.push({
      timeS,
      detections: filtered,
    });

    drawPreview(frameCanvas, filtered, selectedTrackId);
    setStatus(`Processed ${index + 1}/${sampleTimes.length} sampled frames.`);
    setProgress((index + 1) / sampleTimes.length);
  }

  if (selectedTrackId === null) {
    throw new Error("The selected vehicle could not be linked to a stable track across the clip.");
  }

  const summary = tracker.getSummaryRows().filter((row) => row.track_id === selectedTrackId);
  const frameMetrics = allSamples.map((sample) => {
    const speeds = sample.detections
      .map((item) => item.currentSpeed)
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      time_s: sample.timeS,
      vehicle_count: sample.detections.length,
      avg_speed: speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : 0,
      max_speed: speeds.length ? Math.max(...speeds) : 0,
      speed_unit: "mph",
      tracks: sample.detections.map((item) => item.trackId),
    };
  });

  const peakObserved = summary.length ? Math.max(...summary.map((row) => row.peak_speed)) : 0;
  const avgObserved = summary.length ? summary[0].avg_speed : 0;

  appState.analysis = {
    fps: appState.estimatedFps,
    sampleEveryFrames: appState.sampleEveryFrames,
    selectedTrackId,
    targetClass: appState.selectedTarget.label,
    summary,
    frameMetrics,
    samples: allSamples,
    note:
      "This tracks only the vehicle you clicked. Speeds are rough estimates from screen motion plus assumed vehicle width, not calibrated road speed.",
  };

  elements.metricVehicles.textContent = summary.length ? "1" : "0";
  elements.metricPeak.textContent = `${peakObserved.toFixed(1)} mph`;
  elements.metricAvg.textContent = `${avgObserved.toFixed(1)} mph`;
  elements.calibrationText.textContent = "Auto rough scale from selected vehicle width";
  elements.noteText.textContent = appState.analysis.note;

  renderSummaryTable(summary);
  renderFrameTable(frameMetrics);
  setDownload(
    elements.downloadCsv,
    "traffic-review-target-summary.csv",
    buildCsv(summary, [
      "track_id",
      "label",
      "peak_speed",
      "avg_speed",
      "speed_unit",
      "frames_seen",
      "first_seen_s",
      "last_seen_s",
      "flagged",
    ]),
    "text/csv",
  );
  setDownload(
    elements.downloadJson,
    "traffic-review-target-results.json",
    JSON.stringify(appState.analysis, null, 2),
    "application/json",
  );
  elements.replayButton.classList.remove("disabled");
  elements.exportVideo.classList.remove("disabled");
  setStatus("Analysis complete for the selected vehicle.");
  setProgress(1);
}

async function replayAnnotated() {
  if (!appState.analysis || appState.replaying) {
    return;
  }
  appState.replaying = true;
  const frameDelay = (appState.sampleEveryFrames / appState.estimatedFps) * 1000;
  for (const sample of appState.analysis.samples) {
    if (!appState.replaying) {
      break;
    }
    await seekVideo(appState.sourceVideo, sample.timeS);
    drawPreview(null, sample.detections, appState.analysis.selectedTrackId);
    setStatus(`Replay ${sample.timeS.toFixed(2)}s`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, frameDelay));
  }
  appState.replaying = false;
}

async function exportAnnotatedVideo() {
  if (!appState.analysis) {
    return;
  }
  const canvas = elements.previewCanvas;
  const stream = canvas.captureStream(Math.max(1, appState.estimatedFps / appState.sampleEveryFrames));
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();

  const frameDelay = (appState.sampleEveryFrames / appState.estimatedFps) * 1000;
  for (const sample of appState.analysis.samples) {
    await seekVideo(appState.sourceVideo, sample.timeS);
    drawPreview(null, sample.detections, appState.analysis.selectedTrackId);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, frameDelay));
  }

  recorder.stop();
  await stopped;
  setDownload(elements.exportVideo, "traffic-review-target-annotated.webm", chunks, "video/webm");
  setStatus("Annotated WebM export ready.");
}

async function loadSelectedFile(file) {
  if (appState.objectUrl) {
    URL.revokeObjectURL(appState.objectUrl);
  }
  appState.objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";
  video.src = appState.objectUrl;
  await waitForVideo(video);
  appState.sourceVideo = video;
  appState.estimatedFps = await estimateFps(video);
  appState.sampleEveryFrames = chooseSamplingStep(appState.estimatedFps);
  elements.videoMeta.textContent =
    `${video.videoWidth}x${video.videoHeight} • ${video.duration.toFixed(2)}s • ~${appState.estimatedFps} fps • ${file.name}`;
}

async function prepareSelection(file) {
  clearDownloads();
  resetMetrics();
  setProgress(0);
  setStatus("Loading video.");
  await loadSelectedFile(file);
  const detector = await ensureDetector();
  setStatus("Scanning the clip for visible vehicles.");
  appState.selectionFrame = await findSelectionFrame(appState.sourceVideo, detector);
  appState.selectedTarget = null;
  appState.mode = "select-target";
  drawPreview(appState.selectionFrame.frameCanvas, appState.selectionFrame.detections, null);
  elements.noteText.textContent = "Click the vehicle you want to track. The app will then analyze only that target.";
  elements.calibrationText.textContent = "Automatic scale from vehicle width";
  setStatus("Click the vehicle you want to track.");
}

async function handleFile(file) {
  if (!file) {
    return;
  }
  try {
    await prepareSelection(file);
  } catch (error) {
    appState.mode = "idle";
    setProgress(0);
    setStatus(error.message);
    elements.noteText.textContent = "Failed while loading the clip or finding vehicles.";
  }
}

elements.previewCanvas.addEventListener("click", async (event) => {
  if (appState.mode !== "select-target" || !appState.selectionFrame) {
    return;
  }

  const rect = elements.previewCanvas.getBoundingClientRect();
  const scaleX = elements.previewCanvas.width / rect.width;
  const scaleY = elements.previewCanvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  console.info("Canvas click", { x, y, mode: appState.mode, detections: appState.selectionFrame.detections.length });
  const target = findTargetAtPoint(appState.selectionFrame.detections, x, y);
  if (!target) {
    console.info("Canvas click missed all detections");
    setStatus("Click inside one of the detected vehicle boxes.");
    return;
  }

  console.info("Selected target", target.label, target.box);
  appState.selectedTarget = target;
  appState.mode = "analyzing";
  drawPreview(appState.selectionFrame.frameCanvas, appState.selectionFrame.detections, target.trackId);
  setStatus(`Selected ${target.label}. Running full analysis.`);

  try {
    await analyzeSelectedVehicle();
  } catch (error) {
    appState.mode = "idle";
    setStatus(error.message);
    elements.noteText.textContent = "The selected vehicle could not be tracked through the clip.";
  }
});

elements.fileInput.addEventListener("change", async (event) => {
  await handleFile(event.target.files?.[0]);
});

elements.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("dragover");
});

elements.dropZone.addEventListener("dragleave", () => {
  elements.dropZone.classList.remove("dragover");
});

elements.dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragover");
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }
  const transfer = new DataTransfer();
  transfer.items.add(file);
  elements.fileInput.files = transfer.files;
  await handleFile(file);
});

elements.replayButton.addEventListener("click", async () => {
  await replayAnnotated();
});

elements.exportVideo.addEventListener("click", async () => {
  await exportAnnotatedVideo();
});

clearDownloads();
resetMetrics();
setStatus("Drag and drop a clip to start.");
