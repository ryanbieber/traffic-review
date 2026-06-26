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
};

function setStatus(text) {
  elements.statusText.textContent = text;
}

function setProgress(value) {
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, value * 100))}%`;
}

function currentConfig() {
  return {
    confidenceThreshold: Number(document.querySelector("#confidence-threshold").value),
    speedLimitMph: Number(document.querySelector("#speed-limit").value),
    historySeconds: Number(document.querySelector("#history-seconds").value),
    fps: Number(document.querySelector("#fps-override").value) || 30,
    sampleEveryFrames: Number(document.querySelector("#sample-every-frames").value),
  };
}

function drawPreview(frameSource = null, annotations = null) {
  if (!appState.sourceVideo) {
    return;
  }

  const canvas = elements.previewCanvas;
  const context = canvas.getContext("2d");
  canvas.width = appState.sourceVideo.videoWidth || 960;
  canvas.height = appState.sourceVideo.videoHeight || 540;

  if (frameSource) {
    context.drawImage(frameSource, 0, 0, canvas.width, canvas.height);
  } else {
    context.drawImage(appState.sourceVideo, 0, 0, canvas.width, canvas.height);
  }

  if (!annotations) {
    return;
  }

  context.font = "600 18px IBM Plex Mono";
  annotations.forEach((item) => {
    const { box, trackId, label, currentSpeed, speedUnit, flagged } = item;
    const color = flagged ? "#b4432f" : "#204f44";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 3;
    context.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
    const speedText = Number.isFinite(currentSpeed) ? `${currentSpeed.toFixed(1)} ${speedUnit}` : `0.0 ${speedUnit}`;
    const text = `#${trackId} ${label} ${speedText}`;
    context.fillRect(box.x1, Math.max(0, box.y1 - 28), context.measureText(text).width + 18, 24);
    context.fillStyle = "#fff";
    context.fillText(text, box.x1 + 8, Math.max(18, box.y1 - 10));
  });
}

function buildCsv(rows, headers) {
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((key) => JSON.stringify(row[key])).join(","));
  });
  return lines.join("\n");
}

function setDownload(anchor, name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  anchor.href = url;
  anchor.download = name;
  anchor.classList.remove("disabled");
}

function renderSummaryTable(rows) {
  if (!rows.length) {
    elements.summaryTableBody.innerHTML = '<tr><td colspan="8">No vehicles were tracked.</td></tr>';
    return;
  }
  elements.summaryTableBody.innerHTML = rows
    .map((row) => {
      const rowClass = row.flagged ? "flagged" : "";
      return `
        <tr class="${rowClass}">
          <td>${row.track_id}</td>
          <td>${row.label}</td>
          <td>${row.peak_speed.toFixed(1)} ${row.speed_unit}</td>
          <td>${row.avg_speed.toFixed(1)} ${row.speed_unit}</td>
          <td>${row.frames_seen}</td>
          <td>${row.first_seen_s.toFixed(2)}s</td>
          <td>${row.last_seen_s.toFixed(2)}s</td>
          <td>${row.flagged ? "Yes" : "No"}</td>
        </tr>
      `;
    })
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
          <td>${row.tracks.join(", ") || "none"}</td>
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
      reject(new Error("This browser could not decode that video. Many MP4 containers work, but some codecs do not."));
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
      reject(new Error("The browser failed while seeking through the video during analysis."));
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

function getMetersPerPixel(detection) {
  const labelWidth = ASSUMED_WIDTHS_M[detection.label] || 1.8;
  const boxWidthPx = Math.max(24, detection.box.x2 - detection.box.x1);
  return labelWidth / boxWidthPx;
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
  elements.engineText.textContent = `${detector.provider.toUpperCase()} in-browser inference`;
  return detector;
}

async function analyzeVideo() {
  if (!appState.sourceVideo) {
    throw new Error("Drop a video file first.");
  }

  const detector = await ensureDetector();
  const config = currentConfig();
  const tracker = new VehicleTracker({
    historySeconds: config.historySeconds,
    speedLimitMph: config.speedLimitMph,
    speedUnit: "mph",
  });

  const video = appState.sourceVideo;
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  const frameContext = frameCanvas.getContext("2d");

  const samplePeriodS = config.sampleEveryFrames / config.fps;
  const sampleCount = Math.max(1, Math.ceil(video.duration / samplePeriodS));
  const samples = [];
  const frameMetrics = [];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const timeS = Math.min(sampleIndex * samplePeriodS, Math.max(0, video.duration - 0.001));
    await seekVideo(video, timeS);
    frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const detections = await detector.infer(frameCanvas, config.confidenceThreshold);
    const annotated = tracker.update(detections, timeS, measureDetection);
    const speeds = annotated
      .map((item) => item.currentSpeed)
      .filter((value) => Number.isFinite(value) && value > 0);
    frameMetrics.push({
      time_s: timeS,
      vehicle_count: annotated.length,
      avg_speed: speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : 0,
      max_speed: speeds.length ? Math.max(...speeds) : 0,
      speed_unit: "mph",
      tracks: annotated.map((item) => item.trackId),
    });
    samples.push({ timeS, detections: annotated });
    drawPreview(frameCanvas, annotated);
    setStatus(`Processed ${sampleIndex + 1}/${sampleCount} sampled frames.`);
    setProgress((sampleIndex + 1) / sampleCount);
  }

  const summary = tracker.getSummaryRows();
  const avgObserved = summary.length
    ? summary.reduce((sum, row) => sum + row.avg_speed, 0) / summary.length
    : 0;
  const peakObserved = summary.length
    ? Math.max(...summary.map((row) => row.peak_speed))
    : 0;

  appState.analysis = {
    samples,
    summary,
    frameMetrics,
    fps: config.fps,
    sampleEveryFrames: config.sampleEveryFrames,
    note:
      "These are rough browser-side estimates derived from tracked screen motion and assumed vehicle widths. They are simpler than manual homography, but much less defensible as true road speed.",
  };

  elements.metricVehicles.textContent = String(summary.length);
  elements.metricPeak.textContent = `${peakObserved.toFixed(1)} mph`;
  elements.metricAvg.textContent = `${avgObserved.toFixed(1)} mph`;
  elements.calibrationText.textContent = "Automatic rough scale from detected vehicle width";
  elements.noteText.textContent = appState.analysis.note;
  renderSummaryTable(summary);
  renderFrameTable(frameMetrics);
  setDownload(
    elements.downloadCsv,
    "traffic-review-summary.csv",
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
    "traffic-review-results.json",
    JSON.stringify(appState.analysis, null, 2),
    "application/json",
  );
  elements.replayButton.classList.remove("disabled");
  elements.exportVideo.classList.remove("disabled");
  setStatus(`Analysis complete. ${summary.length} tracked vehicle(s).`);
  setProgress(1);
}

async function replayAnnotated() {
  if (!appState.analysis || appState.replaying) {
    return;
  }
  appState.replaying = true;
  const frameDelay = (appState.analysis.sampleEveryFrames / appState.analysis.fps) * 1000;
  for (const sample of appState.analysis.samples) {
    if (!appState.replaying) {
      break;
    }
    await seekVideo(appState.sourceVideo, sample.timeS);
    drawPreview(null, sample.detections);
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
  const stream = canvas.captureStream(Math.max(1, appState.analysis.fps / appState.analysis.sampleEveryFrames));
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
  const frameDelay = (appState.analysis.sampleEveryFrames / appState.analysis.fps) * 1000;
  for (const sample of appState.analysis.samples) {
    await seekVideo(appState.sourceVideo, sample.timeS);
    drawPreview(null, sample.detections);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, frameDelay));
  }
  recorder.stop();
  await stopped;
  setDownload(elements.exportVideo, "traffic-review-annotated.webm", chunks, "video/webm");
  setStatus("Annotated WebM export ready.");
}

function clearOutputState() {
  elements.downloadCsv.classList.add("disabled");
  elements.downloadJson.classList.add("disabled");
  elements.exportVideo.classList.add("disabled");
  elements.replayButton.classList.add("disabled");
  elements.summaryTableBody.innerHTML = '<tr><td colspan="8">Running analysis...</td></tr>';
  elements.frameTableBody.innerHTML = '<tr><td colspan="5">Running analysis...</td></tr>';
  elements.metricVehicles.textContent = "0";
  elements.metricPeak.textContent = "0.0 mph";
  elements.metricAvg.textContent = "0.0 mph";
  elements.calibrationText.textContent = "Running...";
  elements.noteText.textContent = "Running...";
  setProgress(0);
}

async function loadSelectedFile(file) {
  if (!file) {
    return;
  }
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
  elements.videoMeta.textContent = `${video.videoWidth}x${video.videoHeight} • ${video.duration.toFixed(2)}s • ${file.name}`;
  await seekVideo(video, 0);
  drawPreview();
}

async function handleFile(file) {
  try {
    clearOutputState();
    setStatus("Loading video.");
    await loadSelectedFile(file);
    setStatus("Video loaded. Starting automatic analysis.");
    await analyzeVideo();
  } catch (error) {
    setStatus(error.message);
    elements.noteText.textContent = "Analysis failed before completion.";
    elements.calibrationText.textContent = "Not available";
    setProgress(0);
  }
}

elements.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await handleFile(file);
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

setStatus("Drag and drop a clip to start.");
