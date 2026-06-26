import { computeHomography, projectPoint } from "./lib/homography.js";
import { VehicleTracker } from "./lib/tracker.js";
import { createYoloDetector } from "./lib/yolo.js";

const elements = {
  form: document.querySelector("#analysis-form"),
  fileInput: document.querySelector("#video-file"),
  previewCanvas: document.querySelector("#preview-canvas"),
  pointButtons: [...document.querySelectorAll("[data-point-target]")],
  statusText: document.querySelector("#status-text"),
  engineText: document.querySelector("#engine-text"),
  calibrationText: document.querySelector("#calibration-text"),
  noteText: document.querySelector("#note-text"),
  tableBody: document.querySelector("#results-table tbody"),
  progressBar: document.querySelector("#progress-bar"),
  downloadCsv: document.querySelector("#download-csv"),
  downloadJson: document.querySelector("#download-json"),
  exportVideo: document.querySelector("#export-video"),
  replayButton: document.querySelector("#replay-button"),
  videoMeta: document.querySelector("#video-meta"),
};

const pointInputs = {
  p1: { x: document.querySelector("#p1x"), y: document.querySelector("#p1y") },
  p2: { x: document.querySelector("#p2x"), y: document.querySelector("#p2y") },
  p3: { x: document.querySelector("#p3x"), y: document.querySelector("#p3y") },
  p4: { x: document.querySelector("#p4x"), y: document.querySelector("#p4y") },
};

const appState = {
  activePoint: "p1",
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

function currentPoints() {
  return ["p1", "p2", "p3", "p4"].map((key) => [
    Number(pointInputs[key].x.value),
    Number(pointInputs[key].y.value),
  ]);
}

function currentConfig() {
  return {
    confidenceThreshold: Number(document.querySelector("#confidence-threshold").value),
    speedLimitMph: Number(document.querySelector("#speed-limit").value),
    historySeconds: Number(document.querySelector("#history-seconds").value),
    fps: Number(document.querySelector("#fps-override").value) || 30,
    sampleEveryFrames: Number(document.querySelector("#sample-every-frames").value),
    perspectiveWidthM: Number(document.querySelector("#patch-width").value),
    perspectiveLengthM: Number(document.querySelector("#patch-length").value),
    perspectivePoints: currentPoints(),
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

  const points = currentPoints();
  context.strokeStyle = "rgba(32, 79, 68, 0.95)";
  context.fillStyle = "rgba(32, 79, 68, 0.95)";
  context.lineWidth = 2;
  context.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.closePath();
  context.stroke();

  points.forEach(([x, y], index) => {
    context.beginPath();
    context.arc(x, y, 8, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#fff";
    context.font = "600 14px Space Grotesk";
    context.fillText(`P${index + 1}`, x + 12, y - 10);
    context.fillStyle = "rgba(32, 79, 68, 0.95)";
  });

  if (!annotations) {
    return;
  }

  context.font = "600 18px IBM Plex Mono";
  annotations.forEach((item) => {
    const { box, trackId, label, currentSpeedMph, flagged } = item;
    const color = flagged ? "#b4432f" : "#204f44";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 3;
    context.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
    const text = `#${trackId} ${label} ${currentSpeedMph ? currentSpeedMph.toFixed(1) : "0.0"} mph`;
    context.fillRect(box.x1, Math.max(0, box.y1 - 28), context.measureText(text).width + 18, 24);
    context.fillStyle = "#fff";
    context.fillText(text, box.x1 + 8, Math.max(18, box.y1 - 10));
  });
}

function buildCsv(rows) {
  const header = [
    "track_id",
    "label",
    "peak_speed_mph",
    "avg_speed_mph",
    "frames_seen",
    "first_seen_s",
    "last_seen_s",
    "flagged",
  ];
  const lines = [header.join(",")];
  rows.forEach((row) => {
    lines.push(header.map((key) => JSON.stringify(row[key])).join(","));
  });
  return lines.join("\n");
}

function setDownload(anchor, name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  anchor.href = url;
  anchor.download = name;
  anchor.classList.remove("disabled");
}

function renderTable(rows) {
  if (!rows.length) {
    elements.tableBody.innerHTML = '<tr><td colspan="8">No vehicles were tracked.</td></tr>';
    return;
  }
  elements.tableBody.innerHTML = rows
    .map((row) => {
      const rowClass = row.flagged ? "flagged" : "";
      return `
        <tr class="${rowClass}">
          <td>${row.track_id}</td>
          <td>${row.label}</td>
          <td>${row.peak_speed_mph.toFixed(1)}</td>
          <td>${row.avg_speed_mph.toFixed(1)}</td>
          <td>${row.frames_seen}</td>
          <td>${row.first_seen_s.toFixed(2)}s</td>
          <td>${row.last_seen_s.toFixed(2)}s</td>
          <td>${row.flagged ? "Yes" : "No"}</td>
        </tr>
      `;
    })
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
      reject(new Error("Video could not be decoded by this browser."));
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
      reject(new Error("Browser failed to seek the video."));
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

async function ensureDetector() {
  if (appState.detector) {
    return appState.detector;
  }
  setStatus("Loading browser YOLO runtime.");
  console.info("Loading YOLO detector");
  const detector = await createYoloDetector({
    modelPath: "./assets/models/yolov8n.onnx",
    preferredExecutionProviders: ["webgpu", "wasm"],
  });
  appState.detector = detector;
  console.info(`YOLO detector ready via ${detector.provider}`);
  elements.engineText.textContent = `${detector.provider.toUpperCase()} in-browser inference`;
  return detector;
}

async function analyzeVideo() {
  if (!appState.sourceVideo) {
    throw new Error("Choose a video file first.");
  }

  const detector = await ensureDetector();
  const config = currentConfig();
  console.info("Starting analysis", config);
  const homography = computeHomography(
    config.perspectivePoints,
    config.perspectiveWidthM,
    config.perspectiveLengthM,
  );
  const tracker = new VehicleTracker({
    historySeconds: config.historySeconds,
    speedLimitMph: config.speedLimitMph,
  });

  const video = appState.sourceVideo;
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  const frameContext = frameCanvas.getContext("2d");

  const samplePeriodS = config.sampleEveryFrames / config.fps;
  const sampleCount = Math.max(1, Math.ceil(video.duration / samplePeriodS));
  const samples = [];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const timeS = Math.min(sampleIndex * samplePeriodS, Math.max(0, video.duration - 0.001));
    await seekVideo(video, timeS);
    frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const detections = await detector.infer(frameCanvas, config.confidenceThreshold);
    console.info("Sample processed", sampleIndex + 1, "of", sampleCount, "detections", detections.length);
    const annotated = tracker.update(
      detections,
      timeS,
      (point) => projectPoint(homography, point),
    );
    samples.push({ timeS, detections: annotated });
    drawPreview(frameCanvas, annotated);
    setStatus(`Processed ${sampleIndex + 1}/${sampleCount} sampled frames.`);
    setProgress((sampleIndex + 1) / sampleCount);
  }

  const summary = tracker.getSummaryRows();
  const note =
    "This run happened fully in your browser with YOLO ONNX inference, browser video decoding, and homography-based speed estimation. Treat it as review evidence, not certified enforcement measurement.";
  appState.analysis = {
    samples,
    summary,
    homography,
    note,
    calibration: `Perspective plane ${config.perspectiveWidthM.toFixed(2)}m x ${config.perspectiveLengthM.toFixed(2)}m`,
    fps: config.fps,
    sampleEveryFrames: config.sampleEveryFrames,
  };

  renderTable(summary);
  elements.calibrationText.textContent = appState.analysis.calibration;
  elements.noteText.textContent = note;
  setDownload(elements.downloadCsv, "traffic-review-summary.csv", buildCsv(summary), "text/csv");
  setDownload(
    elements.downloadJson,
    "traffic-review-results.json",
    JSON.stringify(appState.analysis, null, 2),
    "application/json",
  );
  console.info("Analysis summary", summary);
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
    setStatus(`Exporting frame at ${sample.timeS.toFixed(2)}s`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, frameDelay));
  }
  recorder.stop();
  await stopped;
  setDownload(elements.exportVideo, "traffic-review-annotated.webm", chunks, "video/webm");
  setStatus("Annotated WebM export ready.");
}

function activatePoint(pointKey) {
  appState.activePoint = pointKey;
  elements.pointButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.pointTarget === pointKey);
  });
}

elements.pointButtons.forEach((button) => {
  button.addEventListener("click", () => activatePoint(button.dataset.pointTarget));
});

elements.previewCanvas.addEventListener("click", (event) => {
  if (!appState.sourceVideo) {
    return;
  }
  const rect = elements.previewCanvas.getBoundingClientRect();
  const scaleX = elements.previewCanvas.width / rect.width;
  const scaleY = elements.previewCanvas.height / rect.height;
  const x = Math.round((event.clientX - rect.left) * scaleX);
  const y = Math.round((event.clientY - rect.top) * scaleY);
  pointInputs[appState.activePoint].x.value = String(x);
  pointInputs[appState.activePoint].y.value = String(y);
  drawPreview();
});

elements.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
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
  elements.videoMeta.textContent = `${video.videoWidth}x${video.videoHeight} • ${video.duration.toFixed(2)}s`;
  await seekVideo(video, 0);
  drawPreview();
  setStatus("First frame loaded. Click the point buttons and mark the road patch on the canvas.");
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  console.info("Submit handler invoked");
  elements.downloadCsv.classList.add("disabled");
  elements.downloadJson.classList.add("disabled");
  elements.exportVideo.classList.add("disabled");
  elements.replayButton.classList.add("disabled");
  elements.tableBody.innerHTML = '<tr><td colspan="8">Running analysis...</td></tr>';
  elements.calibrationText.textContent = "Running...";
  elements.noteText.textContent = "Running...";
  try {
    await analyzeVideo();
  } catch (error) {
    console.error("Analysis failed", error);
    setStatus(error.message);
    elements.noteText.textContent = "The browser-only analysis failed before completion.";
    setProgress(0);
  }
});

elements.replayButton.addEventListener("click", async () => {
  await replayAnnotated();
});

elements.exportVideo.addEventListener("click", async () => {
  await exportAnnotatedVideo();
});

activatePoint("p1");
setStatus("Choose a short traffic-camera clip to start.");
