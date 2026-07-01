import { VehicleTracker } from "./lib/tracker.js";
import { estimateRoadCalibration } from "./lib/perspective.js";
import { transcodeToBrowserVideo } from "./lib/transcode.js";
import { createYoloDetector } from "./lib/yolo.js";

const ANALYSIS_DEFAULTS = {
  confidenceThreshold: 0.35,
  historySeconds: 2,
  speedLimitMph: 35,
};

const TRACK_COLORS = [
  "#1f6f5b",
  "#3563e9",
  "#d97706",
  "#7c3aed",
  "#b91c1c",
  "#0f766e",
  "#8b5cf6",
  "#0b5c8a",
];

const RECTIFIED_PIXELS_PER_METER = 64;
const RECTIFIED_MAX_WIDTH = 420;
const RECTIFIED_MAX_HEIGHT = 780;

const elements = {
  loadStage: document.querySelector("#stage-load"),
  trackStage: document.querySelector("#stage-track"),
  resultsStage: document.querySelector("#stage-results"),
  trackTitle: document.querySelector("#track-title"),
  trackSubtitle: document.querySelector("#track-subtitle"),
  trackBackButton: document.querySelector("#track-back-button"),
  analyzeButton: document.querySelector("#analyze-button"),
  resultsBackButton: document.querySelector("#results-back-button"),
  buildVideoButton: document.querySelector("#build-video-button"),
  sourceVideo: document.querySelector("#source-video"),
  annotatedVideo: document.querySelector("#annotated-video"),
  annotatedVideoText: document.querySelector("#annotated-video-text"),
  fileInput: document.querySelector("#video-file"),
  dropZone: document.querySelector("#drop-zone"),
  previewCanvas: document.querySelector("#preview-canvas"),
  rectifiedCanvas: document.querySelector("#rectified-canvas"),
  trackStatusText: document.querySelector("#track-status-text"),
  resultsStatusText: document.querySelector("#results-status-text"),
  resultsNoteText: document.querySelector("#results-note-text"),
  trackCalibrationText: document.querySelector("#track-calibration-text"),
  resultsCalibrationText: document.querySelector("#results-calibration-text"),
  summaryTableBody: document.querySelector("#results-table tbody"),
  frameTableBody: document.querySelector("#frame-results-table tbody"),
  progressBar: document.querySelector("#progress-bar"),
  downloadCsv: document.querySelector("#download-csv"),
  downloadJson: document.querySelector("#download-json"),
  exportVideo: document.querySelector("#export-video"),
  replayButton: document.querySelector("#replay-button"),
  videoMeta: document.querySelector("#video-meta"),
  decodeText: document.querySelector("#decode-text"),
  rectifiedText: document.querySelector("#rectified-text"),
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
  calibrationFrame: null,
  calibrationSamples: [],
  roadCalibration: null,
  annotatedVideoUrl: null,
  decodeMode: "idle",
  stage: "load",
  cancelAnalysis: false,
  analysisInProgress: false,
};

window.__trafficReview = appState;

function setStatus(text) {
  elements.trackStatusText.textContent = text;
}

function setProgress(value) {
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, value * 100))}%`;
}

function setResultsStatus(text) {
  elements.resultsStatusText.textContent = text;
}

function revokeAnnotatedVideo() {
  if (appState.annotatedVideoUrl) {
    URL.revokeObjectURL(appState.annotatedVideoUrl);
    appState.annotatedVideoUrl = null;
  }
  elements.annotatedVideo.removeAttribute("src");
  elements.annotatedVideo.hidden = true;
  elements.annotatedVideo.load();
  elements.annotatedVideoText.textContent = "Final annotated WebM will appear here.";
}

function clearDownloads() {
  elements.downloadCsv.classList.add("disabled");
  elements.downloadJson.classList.add("disabled");
  elements.exportVideo.classList.add("disabled");
  elements.replayButton.classList.add("disabled");
}

function trackColor(trackId) {
  return TRACK_COLORS[Math.abs(Number(trackId) || 0) % TRACK_COLORS.length];
}

function getRectifiedViewConfig(calibration) {
  if (!calibration?.projectPoint) {
    return null;
  }
  const laneWidthMeters = Number.isFinite(calibration.laneWidthMeters) && calibration.laneWidthMeters > 0
    ? calibration.laneWidthMeters
    : 3.6576;
  const lengthMeters = Number.isFinite(calibration.projectedLengthMeters) && calibration.projectedLengthMeters > 0
    ? calibration.projectedLengthMeters
    : Math.max(24, (calibration.referenceScaleMPerPx || 0.03) * (calibration.sourceHeight || 540) * 0.8);
  const mode = calibration.homography ? "homography" : "metric";
  const displayWidthMeters = mode === "homography"
    ? laneWidthMeters
    : laneWidthMeters * 3;
  const displayHeightMeters = lengthMeters;
  const rawWidth = displayWidthMeters * RECTIFIED_PIXELS_PER_METER;
  const rawHeight = displayHeightMeters * RECTIFIED_PIXELS_PER_METER;
  const scale = Math.min(
    1,
    RECTIFIED_MAX_WIDTH / rawWidth,
    RECTIFIED_MAX_HEIGHT / rawHeight,
  );
  const width = Math.max(220, Math.round(rawWidth * scale));
  const height = Math.max(320, Math.round(rawHeight * scale));
  return {
    mode,
    width,
    height,
    laneWidthMeters,
    lengthMeters,
    displayWidthMeters,
    pixelsPerMeter: width / displayWidthMeters,
  };
}

function drawRectifiedGrid(context, config) {
  const {
    mode,
    width,
    height,
    laneWidthMeters,
    displayWidthMeters,
    lengthMeters,
    pixelsPerMeter,
  } = config;
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.fillStyle = "#13211c";
  context.fillRect(0, 0, width, height);

  context.fillStyle = "rgba(255, 255, 255, 0.05)";
  context.fillRect(0, 0, width, height);

  const roadLeftMeters = mode === "metric" ? -(laneWidthMeters * 1.5) : 0;
  const roadRightMeters = mode === "metric" ? (laneWidthMeters * 1.5) : laneWidthMeters;
  const roadLeftPx = mode === "metric"
    ? (width / 2) + (roadLeftMeters * pixelsPerMeter)
    : roadLeftMeters * pixelsPerMeter;
  const roadRightPx = mode === "metric"
    ? (width / 2) + (roadRightMeters * pixelsPerMeter)
    : roadRightMeters * pixelsPerMeter;

  context.fillStyle = "rgba(255, 255, 255, 0.04)";
  context.fillRect(Math.min(roadLeftPx, roadRightPx), 0, Math.abs(roadRightPx - roadLeftPx), height);

  context.strokeStyle = "rgba(255, 255, 255, 0.12)";
  context.lineWidth = 1;

  const xStart = mode === "metric" ? roadLeftMeters : 0;
  const xEnd = mode === "metric" ? roadRightMeters : laneWidthMeters;
  for (let meter = Math.floor(xStart); meter <= Math.ceil(xEnd); meter += 1) {
    const x = mode === "metric"
      ? (width / 2) + (meter * pixelsPerMeter)
      : Math.min(width, meter * pixelsPerMeter);
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  for (let meter = 0; meter <= Math.ceil(lengthMeters); meter += 1) {
    const y = Math.min(height, meter * pixelsPerMeter);
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  context.strokeStyle = "rgba(255, 255, 255, 0.28)";
  context.setLineDash([10, 8]);
  context.beginPath();
  context.moveTo(mode === "metric" ? width / 2 : (laneWidthMeters / 2) * pixelsPerMeter, 0);
  context.lineTo(mode === "metric" ? width / 2 : (laneWidthMeters / 2) * pixelsPerMeter, height);
  context.stroke();
  context.setLineDash([]);

  context.fillStyle = "rgba(255, 255, 255, 0.78)";
  context.font = "500 12px IBM Plex Mono";
  context.fillText(`0m`, 8, 18);
  context.fillText(`${laneWidthMeters.toFixed(1)}m`, Math.max(8, width - 72), 18);
  context.fillText(`${lengthMeters.toFixed(1)}m`, 8, Math.max(18, height - 8));
  context.restore();
}

function drawRectifiedAnnotations(context, annotations, config) {
  const calibration = appState.roadCalibration;
  if (!calibration?.projectPoint) {
    return;
  }

  context.save();
  context.beginPath();
  context.rect(0, 0, config.width, config.height);
  context.clip();
  context.font = "600 14px IBM Plex Mono";

  annotations.forEach((item) => {
    const color = trackColor(item.trackId);
    const projectedCorners = [
      [item.box.x1, item.box.y1],
      [item.box.x2, item.box.y1],
      [item.box.x2, item.box.y2],
      [item.box.x1, item.box.y2],
    ]
      .map((point) => {
        try {
          return calibration.projectPoint(point);
        } catch {
          return null;
        }
      })
      .filter((point) => Array.isArray(point) && point.every(Number.isFinite))
      .map(([x, y]) => (config.mode === "metric"
        ? [
          (config.width / 2) + (x * config.pixelsPerMeter),
          y * config.pixelsPerMeter,
        ]
        : [
          x * config.pixelsPerMeter,
          y * config.pixelsPerMeter,
        ]));

    if (projectedCorners.length === 4) {
      context.globalAlpha = item.flagged ? 1 : 0.92;
      context.strokeStyle = color;
      context.fillStyle = `${color}22`;
      context.lineWidth = item.flagged ? 4 : 2;
      context.beginPath();
      projectedCorners.forEach(([x, y], index) => {
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.closePath();
      context.fill();
      context.stroke();
    }

    const labelAnchor = (() => {
      try {
        return calibration.projectPoint([
          (item.box.x1 + item.box.x2) / 2,
          item.box.y2,
        ]);
      } catch {
        return null;
      }
    })();

    if (labelAnchor && labelAnchor.every(Number.isFinite)) {
      const [x, y] = config.mode === "metric"
        ? [
          (config.width / 2) + (labelAnchor[0] * config.pixelsPerMeter),
          labelAnchor[1] * config.pixelsPerMeter,
        ]
        : [labelAnchor[0] * config.pixelsPerMeter, labelAnchor[1] * config.pixelsPerMeter];
      const speedText = Number.isFinite(item.currentSpeed) ? ` ${item.currentSpeed.toFixed(1)} mph` : "";
      const text = `${item.displayLabel || item.label}${speedText}`;
      const textWidth = context.measureText(text).width;
      const textX = Math.max(0, Math.min(config.width - textWidth - 12, x - (textWidth / 2) - 4));
      const textY = Math.max(20, Math.min(config.height - 8, y - 10));
      context.fillStyle = color;
      context.fillRect(textX, textY - 16, textWidth + 12, 22);
      context.fillStyle = "#fff";
      context.fillText(text, textX + 6, textY);
    }
    context.globalAlpha = 1;
  });

  context.restore();
}

function drawRectifiedPreview(frameSource = null, annotations = null) {
  const canvas = elements.rectifiedCanvas;
  const context = canvas.getContext("2d");
  const calibration = appState.roadCalibration;
  const config = getRectifiedViewConfig(calibration);

  if (!config) {
    canvas.width = 320;
    canvas.height = 240;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#13211c";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(255, 255, 255, 0.82)";
    context.font = "600 16px Space Grotesk";
    context.fillText("Rectified road plane", 18, 38);
    context.font = "500 13px IBM Plex Mono";
    context.fillText(
      calibration?.homography
        ? "Waiting for a frame to project."
        : "Lane calibration unavailable yet.",
      18,
      68,
    );
    context.fillText(
      "The original camera view stays visible beside this panel.",
      18,
      92,
    );
    elements.rectifiedText.textContent = "Rectified view needs lane calibration from visible markings.";
    return;
  }

  canvas.width = config.width;
  canvas.height = config.height;

  context.clearRect(0, 0, config.width, config.height);
  drawRectifiedGrid(context, config);
  if (annotations?.length) {
    drawRectifiedAnnotations(context, annotations, config);
  }
  elements.rectifiedText.textContent = calibration?.homography
    ? `Rectified lane patch: ${config.laneWidthMeters.toFixed(1)}m wide × ${config.lengthMeters.toFixed(1)}m long`
    : `Metric road plane: shared road transform over a ${config.laneWidthMeters.toFixed(1)}m lane`;
}

function canEnterStage(stage) {
  if (stage === "load") {
    return true;
  }
  if (stage === "analyze") {
    return Boolean(appState.sourceVideo);
  }
  if (stage === "results") {
    return Boolean(appState.analysis);
  }
  return false;
}

function setStage(stage, { force = false } = {}) {
  if (!force && !canEnterStage(stage)) {
    return;
  }
  if (appState.stage === "analyze" && stage !== "analyze") {
    appState.cancelAnalysis = true;
  }
  appState.stage = stage;
  renderStage();
}

function renderStage() {
  const isAnalyze = appState.stage === "analyze";
  const isResults = appState.stage === "results";

  elements.loadStage.classList.toggle("active", appState.stage === "load");
  elements.trackStage.classList.toggle("active", isAnalyze);
  elements.resultsStage.classList.toggle("active", isResults);

  elements.trackTitle.textContent = "Analyzing video";
  elements.trackSubtitle.textContent = isAnalyze
    ? (appState.analysisInProgress
      ? "The browser is labeling every detected vehicle with its current speed estimate."
      : "The browser is finding vehicles, calibrating the road, and tracking them frame by frame."
    )
    : "The browser is finding vehicles, calibrating the road, and tracking them frame by frame.";
  elements.trackBackButton.textContent = appState.analysisInProgress ? "Cancel analysis" : "Back to upload";
  elements.resultsBackButton.textContent = "Back to upload";
  elements.resultsStage.hidden = !isResults;
  elements.loadStage.hidden = appState.stage !== "load";
  elements.trackStage.hidden = !isAnalyze;
  elements.resultsBackButton.disabled = !appState.sourceVideo;
  elements.buildVideoButton.disabled = !appState.analysis;
  elements.analyzeButton.disabled = !appState.sourceVideo || appState.analysisInProgress;
}

function resetMetrics() {
  const calibrationOverride = appState.roadCalibration?.analysisOverride ? appState.roadCalibration : null;
  elements.metricVehicles.textContent = "0";
  elements.metricPeak.textContent = "0.0 mph";
  elements.metricAvg.textContent = "0.0 mph";
  elements.videoMeta.textContent = "No clip loaded";
  elements.summaryTableBody.innerHTML = '<tr><td colspan="10">No results yet.</td></tr>';
  elements.frameTableBody.innerHTML = '<tr><td colspan="5">No frame metrics yet.</td></tr>';
  elements.resultsNoteText.textContent = "Not available yet.";
  elements.resultsCalibrationText.textContent = "Not available yet.";
  elements.trackCalibrationText.textContent = "Not available yet.";
  elements.trackStatusText.textContent = "Load a clip to start.";
  elements.resultsStatusText.textContent = "Waiting for analysis.";
  elements.rectifiedText.textContent = "Rectified view needs lane calibration from visible markings.";
  elements.decodeText.textContent = "Source: not loaded";
  elements.analyzeButton.disabled = true;
  elements.sourceVideo.hidden = true;
  elements.sourceVideo.removeAttribute("src");
  elements.sourceVideo.load();
  appState.analysis = null;
  appState.roadCalibration = null;
  appState.calibrationFrame = null;
  appState.calibrationSamples = [];
  appState.analysisInProgress = false;
  appState.sourceVideo = null;
  appState.roadCalibration = calibrationOverride;
  revokeAnnotatedVideo();
  if (elements.rectifiedCanvas) {
    const context = elements.rectifiedCanvas.getContext("2d");
    context.clearRect(0, 0, elements.rectifiedCanvas.width, elements.rectifiedCanvas.height);
  }
  if (elements.previewCanvas) {
    const context = elements.previewCanvas.getContext("2d");
    context.clearRect(0, 0, elements.previewCanvas.width, elements.previewCanvas.height);
  }
}

function drawPreview(frameSource = null, annotations = null) {
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
  const isCalibrationFrame = appState.calibrationFrame?.frameCanvas && frameSource === appState.calibrationFrame.frameCanvas;
  annotations.forEach((item) => {
    const color = trackColor(item.trackId);
    const speedText = Number.isFinite(item.currentSpeed) ? ` ${item.currentSpeed.toFixed(1)} mph` : "";
    const calibrationIndex = isCalibrationFrame && appState.calibrationFrame?.detections
      ? appState.calibrationFrame.detections.indexOf(item)
      : -1;
    const text = isCalibrationFrame
      ? `${item.label} ${calibrationIndex >= 0 ? calibrationIndex + 1 : ""}`.trim()
      : `${item.displayLabel || (item.trackId ? `#${item.trackId} ${item.label}` : item.label)}${speedText}`;
    const textWidth = context.measureText(text).width;

    context.shadowColor = "transparent";
    context.shadowBlur = 0;
    context.strokeStyle = color;
    context.globalAlpha = item.flagged ? 1 : 0.95;
    context.fillStyle = `${color}22`;
    context.lineWidth = item.flagged ? 5 : 3;
    context.strokeRect(item.box.x1, item.box.y1, item.box.x2 - item.box.x1, item.box.y2 - item.box.y1);
    context.fillStyle = color;
    context.fillRect(item.box.x1, Math.max(0, item.box.y1 - 28), textWidth + 18, 24);
    context.fillStyle = "#fff";
    context.fillText(text, item.box.x1 + 8, Math.max(18, item.box.y1 - 10));
    context.globalAlpha = 1;
  });
}

function renderReviewFrame(frameSource = null, annotations = null) {
  drawPreview(frameSource, annotations);
  drawRectifiedPreview(frameSource, annotations);
}

function setDownload(anchor, name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  anchor.href = url;
  anchor.download = name;
  anchor.classList.remove("disabled");
}

function describeCalibration(calibration) {
  if (!calibration) {
    return "No lane calibration available";
  }
  const method = calibration.homography ? "Lane homography" : "Lane fallback";
  const details = [];
  if (calibration.laneSpacingPx) {
    details.push(`lane ${calibration.laneSpacingPx.toFixed(0)}px`);
  }
  if (calibration.dashCyclePx) {
    details.push(`dash ${calibration.dashCyclePx.toFixed(0)}px`);
  }
  details.push(`${Math.round(calibration.confidence * 100)}% confidence`);
  return `${method} ${calibration.angleDeg.toFixed(0)}deg - ${details.join(" - ")}`;
}

function updateCalibrationText(calibration) {
  const text = describeCalibration(calibration);
  elements.trackCalibrationText.textContent = text;
  elements.resultsCalibrationText.textContent = text;
  return text;
}

function hasSpeedCalibration(calibration) {
  if (!calibration) {
    return false;
  }
  if (Number.isFinite(calibration.referenceScaleMPerPx) && calibration.referenceScaleMPerPx > 0) {
    return true;
  }
  return Boolean(calibration.homography);
}

function buildCsv(rows, headers) {
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((key) => JSON.stringify(row[key])).join(","));
  });
  return lines.join("\n");
}

function formatSpeed(value, unit) {
  return Number.isFinite(value) ? `${value.toFixed(1)} ${unit}` : "Not enough info";
}

function formatSpeedStatus(status) {
  return status === "estimated" ? "Estimated" : "Not enough info";
}

function renderSummaryTable(rows) {
  if (!rows.length) {
    elements.summaryTableBody.innerHTML = '<tr><td colspan="10">No vehicles were tracked.</td></tr>';
    return;
  }

  elements.summaryTableBody.innerHTML = rows
    .map(
      (row) => `
        <tr class="${row.flagged ? "flagged" : ""}">
          <td>${row.track_id}</td>
          <td>${row.display_label || row.label}</td>
          <td>${formatSpeed(row.peak_speed, row.speed_unit)}</td>
          <td>${formatSpeed(row.avg_speed, row.speed_unit)}</td>
          <td>${row.frames_seen}</td>
          <td>${row.first_seen_s.toFixed(2)}s</td>
          <td>${row.last_seen_s.toFixed(2)}s</td>
          <td>${formatSpeedStatus(row.speed_status)}</td>
          <td>${row.trust_reason || ""}</td>
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
    if (video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0) {
      resolve(video);
      return;
    }
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
    video.load();
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

function buildFrameTimes(duration, fps) {
  const safeFps = Math.max(1, fps);
  const frameStepS = 1 / safeFps;
  const frameCount = Math.max(1, Math.ceil(duration * safeFps));
  const endTimeS = Math.max(0, duration - 0.001);
  const times = [];

  for (let index = 0; index < frameCount; index += 1) {
    times.push(Number(Math.min(index * frameStepS, endTimeS).toFixed(3)));
  }

  return [...new Set(times)].sort((left, right) => left - right);
}

function measureDetection(detection) {
  const anchorY = detection.box.y2;
  const anchorPoint = [
    (detection.box.x1 + detection.box.x2) / 2,
    anchorY,
  ];
  const worldPoint = appState.roadCalibration?.projectPoint?.(anchorPoint);
  const calibratedScale = appState.roadCalibration?.scaleAtY?.(anchorY);
  return {
    anchorPoint,
    worldPoint: worldPoint && worldPoint.every(Number.isFinite) ? worldPoint : null,
    metersPerPixel: calibratedScale && Number.isFinite(calibratedScale) ? calibratedScale : null,
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
  return detector;
}

async function findSelectionFrame(video, detector, onProgress = null) {
  const candidateTimes = [
    0,
    Math.min(1, Math.max(0, video.duration * 0.15)),
    Math.min(Math.max(0, video.duration * 0.3), Math.max(0, video.duration - 0.001)),
    Math.min(Math.max(0, video.duration * 0.45), Math.max(0, video.duration - 0.001)),
    Math.min(Math.max(0, video.duration * 0.6), Math.max(0, video.duration - 0.001)),
    Math.min(Math.max(0, video.duration * 0.8), Math.max(0, video.duration - 0.001)),
  ];

  const uniqueTimes = [...new Set(candidateTimes.map((value) => Number(value.toFixed(3))))];
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  const frameContext = frameCanvas.getContext("2d");
  const samples = [];

  for (let index = 0; index < uniqueTimes.length; index += 1) {
    if (appState.cancelAnalysis) {
      throw new Error("Analysis canceled.");
    }
    const timeS = uniqueTimes[index];
    await seekVideo(video, timeS);
    if (appState.cancelAnalysis) {
      throw new Error("Analysis canceled.");
    }
    frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const detections = await detector.infer(frameCanvas, 0.2);
    if (appState.cancelAnalysis) {
      throw new Error("Analysis canceled.");
    }
    if (detections.length) {
      const snapshot = document.createElement("canvas");
      snapshot.width = frameCanvas.width;
      snapshot.height = frameCanvas.height;
      snapshot.getContext("2d").drawImage(frameCanvas, 0, 0);
      samples.push({
        timeS,
        frameCanvas: snapshot,
        detections,
        previewUrl: snapshot.toDataURL("image/jpeg", 0.8),
      });
    }
    if (onProgress) {
      onProgress((index + 1) / uniqueTimes.length);
    }
  }

  if (!samples.length) {
    throw new Error("No vehicles were detected in the sampled frames of this clip.");
  }

  return samples;
}

function pickCalibrationTarget(detections) {
  if (!detections.length) {
    return null;
  }
  return detections
    .slice()
    .sort((left, right) => {
      const leftArea = (left.box.x2 - left.box.x1) * (left.box.y2 - left.box.y1);
      const rightArea = (right.box.x2 - right.box.x1) * (right.box.y2 - right.box.y1);
      return (right.score - left.score) || (rightArea - leftArea);
    })[0] || null;
}

function pickCalibrationFrame(samples) {
  if (!samples.length) {
    return null;
  }

  return samples
    .slice()
    .sort((left, right) => {
      const leftDetections = left.detections || [];
      const rightDetections = right.detections || [];
      const leftScore = leftDetections.reduce((sum, detection) => sum + (detection.score || 0), 0);
      const rightScore = rightDetections.reduce((sum, detection) => sum + (detection.score || 0), 0);
      return (rightDetections.length - leftDetections.length) || (rightScore - leftScore) || (left.timeS - right.timeS);
    })[0] || null;
}

async function analyzeAllVehicles({ progressOffset = 0, progressScale = 1 } = {}) {
  if (!appState.sourceVideo || !appState.calibrationFrame) {
    throw new Error("Choose a file first.");
  }

  const detector = await ensureDetector();
  const tracker = new VehicleTracker({
    historySeconds: ANALYSIS_DEFAULTS.historySeconds,
    speedLimitMph: ANALYSIS_DEFAULTS.speedLimitMph,
    speedUnit: "mph",
    roadAxis: appState.roadCalibration?.axis || null,
    preferWorldMotion: Boolean(appState.roadCalibration?.analysisOverride),
  });

  const video = appState.sourceVideo;
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  const frameContext = frameCanvas.getContext("2d");
  const frameTimes = buildFrameTimes(video.duration, appState.estimatedFps);

  const annotatedSamples = [];

  for (let index = 0; index < frameTimes.length; index += 1) {
    if (appState.cancelAnalysis) {
      throw new Error("Analysis canceled.");
    }
    const timeS = frameTimes[index];
    await seekVideo(video, timeS);
    if (appState.cancelAnalysis) {
      throw new Error("Analysis canceled.");
    }
    frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const detections = await detector.infer(frameCanvas, ANALYSIS_DEFAULTS.confidenceThreshold);
    if (appState.cancelAnalysis) {
      throw new Error("Analysis canceled.");
    }
    const annotated = tracker.update(detections, timeS, measureDetection);
    annotatedSamples.push({
      timeS,
      detections: annotated.map((item) => ({ ...item })),
    });

    renderReviewFrame(frameCanvas, annotated);
    setStatus(`Processed ${index + 1}/${frameTimes.length} frames.`);
    setProgress(progressOffset + (progressScale * ((index + 1) / frameTimes.length)));
  }

  const summaryRows = tracker.getSummaryRows();
  const displayedSummaryRows = summaryRows;
  const worldPoints = annotatedSamples
    .flatMap((sample) => sample.detections.map((item) => item.worldPoint))
    .filter((point) => Array.isArray(point) && point.every(Number.isFinite));
  const projectedDistanceM = worldPoints.length >= 2
    ? Math.abs(worldPoints[worldPoints.length - 1][1] - worldPoints[0][1])
    : null;
  const frameMetrics = annotatedSamples.map((sample) => {
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

  const reportableSummaryRows = summaryRows.filter((row) => Number.isFinite(row.avg_speed) && Number.isFinite(row.peak_speed));
  const peakObserved = reportableSummaryRows.length ? Math.max(...reportableSummaryRows.map((row) => row.peak_speed)) : null;
  appState.analysis = {
    fps: appState.estimatedFps,
    summary: displayedSummaryRows,
    frameMetrics,
    calibrationDiagnostics: appState.roadCalibration
      ? {
        method: appState.roadCalibration.method,
        confidence: appState.roadCalibration.confidence,
        laneSpacingPx: appState.roadCalibration.laneSpacingPx,
        dashCyclePx: appState.roadCalibration.dashCyclePx,
        laneWidthMeters: appState.roadCalibration.laneWidthMeters,
        dashCycleMeters: appState.roadCalibration.dashCycleMeters,
        projectedDistanceM,
        homographyPoints: appState.roadCalibration.homographyPoints,
      }
      : null,
    samples: annotatedSamples,
    fullFrameCount: frameTimes.length,
    trackedVehicleCount: displayedSummaryRows.length,
    note: "Every visible vehicle is tracked and labeled in the replay. Review the summary table before you act on any estimate.",
  };

  elements.metricVehicles.textContent = String(displayedSummaryRows.length);
  elements.metricPeak.textContent = formatSpeed(peakObserved, "mph");
  const displayedAverage = reportableSummaryRows.length
    ? reportableSummaryRows.reduce((sum, row) => sum + row.avg_speed, 0) / reportableSummaryRows.length
    : null;
  elements.metricAvg.textContent = formatSpeed(displayedAverage, "mph");
  updateCalibrationText(appState.roadCalibration);
  elements.resultsNoteText.textContent = appState.analysis.note;
  setResultsStatus("Analysis complete. Building the annotated WebM.");

  renderSummaryTable(displayedSummaryRows);
  renderFrameTable(frameMetrics);
  setDownload(
    elements.downloadCsv,
    "traffic-review-summary.csv",
    buildCsv(displayedSummaryRows, [
      "track_id",
      "label",
      "display_label",
      "peak_speed",
      "avg_speed",
      "speed_status",
      "trust_reason",
      "track_duration_s",
      "speed_sample_count",
      "rejected_speed_sample_count",
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
  setProgress(1);
}

async function replayAnnotated() {
  if (!appState.analysis || appState.replaying) {
    return;
  }
  appState.replaying = true;
  const frameDelay = (1 / Math.max(1, appState.estimatedFps)) * 1000;
  const playbackFrameCanvas = document.createElement("canvas");
  playbackFrameCanvas.width = appState.sourceVideo.videoWidth;
  playbackFrameCanvas.height = appState.sourceVideo.videoHeight;
  const playbackFrameContext = playbackFrameCanvas.getContext("2d");
  for (const sample of appState.analysis.samples) {
    if (!appState.replaying) {
      break;
    }
    await seekVideo(appState.sourceVideo, sample.timeS);
    playbackFrameContext.drawImage(appState.sourceVideo, 0, 0, playbackFrameCanvas.width, playbackFrameCanvas.height);
    renderReviewFrame(playbackFrameCanvas, sample.detections);
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
  elements.buildVideoButton.disabled = true;
  const stream = canvas.captureStream(Math.max(1, appState.estimatedFps));
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

  const frameDelay = (1 / Math.max(1, appState.estimatedFps)) * 1000;
  const playbackFrameCanvas = document.createElement("canvas");
  playbackFrameCanvas.width = appState.sourceVideo.videoWidth;
  playbackFrameCanvas.height = appState.sourceVideo.videoHeight;
  const playbackFrameContext = playbackFrameCanvas.getContext("2d");
  for (const sample of appState.analysis.samples) {
    await seekVideo(appState.sourceVideo, sample.timeS);
    playbackFrameContext.drawImage(appState.sourceVideo, 0, 0, playbackFrameCanvas.width, playbackFrameCanvas.height);
    renderReviewFrame(playbackFrameCanvas, sample.detections);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, frameDelay));
  }

  recorder.stop();
  await stopped;
  const blob = new Blob(chunks, { type: "video/webm" });
  revokeAnnotatedVideo();
  appState.annotatedVideoUrl = URL.createObjectURL(blob);
  elements.annotatedVideo.src = appState.annotatedVideoUrl;
  elements.annotatedVideo.hidden = false;
  elements.annotatedVideoText.textContent = "Final annotated WebM ready to play.";
  setDownload(elements.exportVideo, "traffic-review-annotated.webm", blob, "video/webm");
  elements.resultsStatusText.textContent = "Annotated WebM built. Play it above or download it.";
  setStatus("Annotated WebM export ready.");
  elements.buildVideoButton.disabled = false;
}

async function loadSelectedFile(file) {
  if (appState.objectUrl) {
    URL.revokeObjectURL(appState.objectUrl);
  }
  appState.decodeMode = "direct";
  let activeFile = file;
  if (!file.type.includes("webm")) {
    setStatus("Converting the clip to WebM for browser playback and analysis.");
    appState.decodeMode = "converted";
    activeFile = await transcodeToBrowserVideo(file, {
      onStatus(message) {
        if (/frame=|time=|size=|video:/i.test(message)) {
          setStatus("Converting the clip to WebM for browser playback and analysis.");
        }
      },
    });
  }

  if (appState.objectUrl) {
    URL.revokeObjectURL(appState.objectUrl);
  }
  appState.objectUrl = URL.createObjectURL(activeFile);
  elements.sourceVideo.playsInline = true;
  elements.sourceVideo.preload = "auto";
  elements.sourceVideo.muted = true;
  elements.sourceVideo.hidden = false;
  elements.sourceVideo.src = appState.objectUrl;
  await waitForVideo(elements.sourceVideo);

  appState.analysis = null;
  appState.analysisInProgress = false;
  appState.sourceVideo = elements.sourceVideo;
  appState.estimatedFps = await estimateFps(elements.sourceVideo);
  elements.videoMeta.textContent =
    `${elements.sourceVideo.videoWidth}x${elements.sourceVideo.videoHeight} • ${elements.sourceVideo.duration.toFixed(2)}s • ~${appState.estimatedFps} fps • ${activeFile.name}`;
  elements.decodeText.textContent =
    appState.decodeMode === "converted"
      ? "Source: converted to WebM for browser playback"
      : "Source: decoded directly in the browser";
}

async function handleFile(file) {
  if (!file) {
    return;
  }
  try {
    clearDownloads();
    resetMetrics();
    setProgress(0);
    setStatus("Loading video.");
    elements.analyzeButton.textContent = "Loading...";
    elements.videoMeta.textContent = file.name || "Loading clip...";
    elements.decodeText.textContent = file.type.includes("webm")
      ? "Loading video in the browser."
      : "Converting to WebM for browser playback.";
    await loadSelectedFile(file);
    setStage("load", { force: true });
    elements.analyzeButton.disabled = false;
    elements.analyzeButton.textContent = "Analyze video";
    elements.decodeText.textContent = `${elements.decodeText.textContent} • Ready to analyze`;
    setStatus("Clip loaded. Click Analyze to start.");
  } catch (error) {
    setProgress(0);
    setStatus(error.message);
    elements.resultsNoteText.textContent = "Failed while loading the clip, finding vehicles, or running analysis.";
    elements.analyzeButton.textContent = "Analyze video";
    setStage("load", { force: true });
  }
}

async function startAnalysis() {
  if (!appState.sourceVideo || appState.analysisInProgress) {
    return;
  }
  try {
    const calibrationOverride = appState.roadCalibration?.analysisOverride ? appState.roadCalibration : null;
    clearDownloads();
    appState.analysis = null;
    appState.roadCalibration = calibrationOverride;
    appState.calibrationFrame = null;
    appState.calibrationSamples = [];
    revokeAnnotatedVideo();
    elements.metricVehicles.textContent = "0";
    elements.metricPeak.textContent = "0.0 mph";
    elements.metricAvg.textContent = "0.0 mph";
    elements.summaryTableBody.innerHTML = '<tr><td colspan="10">No results yet.</td></tr>';
    elements.frameTableBody.innerHTML = '<tr><td colspan="5">No frame metrics yet.</td></tr>';
    elements.resultsNoteText.textContent = "Not available yet.";
    elements.resultsCalibrationText.textContent = "Not available yet.";
    elements.trackCalibrationText.textContent = "Not available yet.";
    elements.resultsStatusText.textContent = "Waiting for analysis.";
    elements.trackStatusText.textContent = "Scanning the clip for visible vehicles.";
    elements.rectifiedText.textContent = "Rectified view needs lane calibration from visible markings.";
    setProgress(0);
    appState.analysisInProgress = true;
    setStage("analyze", { force: true });
    setStatus("Scanning the clip for visible vehicles.");
    setResultsStatus("Waiting for analysis.");
    const detector = await ensureDetector();
    appState.cancelAnalysis = false;
    appState.calibrationSamples = await findSelectionFrame(appState.sourceVideo, detector, (fraction) => {
      setProgress(fraction * 0.2);
    });
    appState.calibrationFrame = pickCalibrationFrame(appState.calibrationSamples) || appState.calibrationSamples[0];
    appState.roadCalibration = calibrationOverride || estimateRoadCalibration(
      appState.calibrationSamples,
      pickCalibrationTarget(appState.calibrationFrame.detections)
        ? { targetBox: pickCalibrationTarget(appState.calibrationFrame.detections).box }
        : {},
    );
    if (!hasSpeedCalibration(appState.roadCalibration)) {
      throw new Error("Lane markings were not clear enough for automatic speed estimates.");
    }
    renderReviewFrame(appState.calibrationFrame.frameCanvas, appState.calibrationFrame.detections);
    updateCalibrationText(appState.roadCalibration);
    setProgress(0.2);
    setStatus("Calibration ready. Analyzing every visible vehicle.");
    setResultsStatus("Waiting for analysis.");
    await analyzeAllVehicles({ progressOffset: 0.2, progressScale: 0.8 });
    await exportAnnotatedVideo();
    setStage("results", { force: true });
  } catch (error) {
    if (error.message !== "Analysis canceled.") {
      setProgress(0.2);
      setStatus(error.message);
      elements.resultsNoteText.textContent = "Failed while loading the clip, finding vehicles, or running analysis.";
    }
    setStage("load", { force: true });
  } finally {
    appState.analysisInProgress = false;
    renderStage();
  }
}

elements.fileInput.addEventListener("change", async (event) => {
  await handleFile(event.target.files?.[0]);
});

elements.trackBackButton.addEventListener("click", () => {
  if (appState.stage === "analyze" && appState.analysisInProgress) {
    appState.cancelAnalysis = true;
    setStage("load", { force: true });
    return;
  }
  setStage("load", { force: true });
});

elements.analyzeButton.addEventListener("click", async () => {
  await startAnalysis();
});

elements.resultsBackButton.addEventListener("click", () => {
  setStage("load", { force: true });
});

elements.buildVideoButton.addEventListener("click", async () => {
  await exportAnnotatedVideo();
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
setStage("load", { force: true });
setStatus("Drop a video file or choose one to start.");
