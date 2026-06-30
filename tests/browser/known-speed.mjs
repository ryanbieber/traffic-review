import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

import { computeHomography } from "../../docs/lib/homography.js";
import { startStaticServer, stopStaticServer } from "./static-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const ROAD_WIDTH_M = 7.3152;
const ROAD_LENGTH_M = 160;
const LANE_WIDTH_M = 3.6576;
const FPS = 12;
const DURATION_S = 4;
const IMAGE_POINTS = [
  [364, 140],
  [596, 140],
  [792, 540],
  [168, 540],
];
const CASES = [
  { label: "35 mph", speedMph: 35, toleranceMph: 8 },
  { label: "68 mph", speedMph: 68, toleranceMph: 10 },
];

function invertHomography(matrix) {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i],
  ] = matrix;

  const A = (e * i) - (f * h);
  const B = -((d * i) - (f * g));
  const C = (d * h) - (e * g);
  const D = -((b * i) - (c * h));
  const E = (a * i) - (c * g);
  const F = -((a * h) - (b * g));
  const G = (b * f) - (c * e);
  const H = -((a * f) - (c * d));
  const I = (a * e) - (b * d);
  const det = (a * A) + (b * B) + (c * C);

  if (Math.abs(det) < 1e-12) {
    throw new Error("Failed to invert homography.");
  }

  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ];
}

async function loadPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on("console", (message) => {
    console.log("PAGE LOG:", message.type(), message.text());
  });
  page.on("pageerror", (error) => {
    console.log("PAGE ERROR:", error.stack || error.message);
  });
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle2" });
  await page.waitForSelector("h1");
  return page;
}

async function injectKnownDetector(page) {
  await page.evaluate(() => {
    window.__trafficReview.detector = {
      provider: "test",
      infer: async (canvas) => {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;

        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const r = data[offset];
            const g = data[offset + 1];
            const b = data[offset + 2];
            if (r > 160 && g < 100 && b < 100) {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            }
          }
        }

        if (maxX < 0 || maxY < 0) {
          return [];
        }

        return [{
          classId: 2,
          label: "car",
          score: 0.99,
          box: {
            x1: Math.max(0, minX - 2),
            y1: Math.max(0, minY - 2),
            x2: Math.min(width, maxX + 3),
            y2: Math.min(height, maxY + 3),
          },
        }];
      },
    };
  });
}

async function injectFixtureCalibration(page, { worldToImage, imageToWorld }) {
  await page.evaluate(({
    worldToImage,
    imageToWorld,
    roadWidthM,
    roadLengthM,
    laneWidthM,
  }) => {
    const projectImageToWorld = (point) => {
      const [x, y] = point;
      const w =
        imageToWorld[2][0] * x +
        imageToWorld[2][1] * y +
        imageToWorld[2][2];
      const px =
        imageToWorld[0][0] * x +
        imageToWorld[0][1] * y +
        imageToWorld[0][2];
      const py =
        imageToWorld[1][0] * x +
        imageToWorld[1][1] * y +
        imageToWorld[1][2];
      return [px / w, py / w];
    };

    const projectWorldToImage = (point) => {
      const [x, y] = point;
      const w =
        worldToImage[2][0] * x +
        worldToImage[2][1] * y +
        worldToImage[2][2];
      const px =
        worldToImage[0][0] * x +
        worldToImage[0][1] * y +
        worldToImage[0][2];
      const py =
        worldToImage[1][0] * x +
        worldToImage[1][1] * y +
        worldToImage[1][2];
      return [px / w, py / w];
    };

    const roadCenterX = laneWidthM * 1.5;
    const centerTop = projectWorldToImage([roadCenterX, 0]);
    const centerBottom = projectWorldToImage([roadCenterX, roadLengthM]);
    const roadAxis = [
      centerBottom[0] - centerTop[0],
      centerBottom[1] - centerTop[1],
    ];
    const axisLength = Math.hypot(roadAxis[0], roadAxis[1]);
    const normalizedAxis = axisLength > 1e-12
      ? [roadAxis[0] / axisLength, roadAxis[1] / axisLength]
      : [0, 1];
    const centerLineAtY = (y) => {
      const t = Math.max(0, Math.min(1, (y - centerTop[1]) / Math.max(1e-6, centerBottom[1] - centerTop[1])));
      return centerTop[0] + ((centerBottom[0] - centerTop[0]) * t);
    };
    const scaleAtY = (y) => {
      const x = centerLineAtY(y);
      const worldA = projectImageToWorld([x, y]);
      const worldB = projectImageToWorld([x + normalizedAxis[0], y + normalizedAxis[1]]);
      return Math.hypot(worldB[0] - worldA[0], worldB[1] - worldA[1]);
    };
    const referenceY = (centerTop[1] + centerBottom[1]) / 2;
    const laneLeftAtReference = projectWorldToImage([laneWidthM, (roadLengthM * 0.5)])[0];
    const laneRightAtReference = projectWorldToImage([laneWidthM * 2, (roadLengthM * 0.5)])[0];
    const laneSpacingPx = Math.abs(laneRightAtReference - laneLeftAtReference);
    const dashCycleMeters = 12.192;
    const dashStart = projectWorldToImage([roadCenterX, roadLengthM * 0.25]);
    const dashEnd = projectWorldToImage([roadCenterX, roadLengthM * 0.25 + dashCycleMeters]);
    const dashCyclePx = Math.hypot(dashEnd[0] - dashStart[0], dashEnd[1] - dashStart[1]);

    window.__trafficReview.roadCalibration = {
      method: "fixture-known",
      confidence: 1,
      analysisOverride: true,
      axis: normalizedAxis,
      angleDeg: (Math.atan2(normalizedAxis[1], normalizedAxis[0]) * 180) / Math.PI,
      vanishingPoint: { x: centerTop[0], y: centerTop[1] },
      referenceY,
      laneSpacingPx,
      referenceScaleMPerPx: scaleAtY(referenceY),
      laneWidthMeters: laneWidthM,
      dashCycleMeters,
      dashCyclePx,
      homography: imageToWorld,
      homographyPoints: [
        [364, 140],
        [596, 140],
        [792, 540],
        [168, 540],
      ],
      projectedLengthMeters: roadLengthM,
      projectPoint: projectImageToWorld,
      scaleAtY,
    };
  }, {
    worldToImage,
    imageToWorld,
    roadWidthM: ROAD_WIDTH_M,
    roadLengthM: ROAD_LENGTH_M,
    laneWidthM: LANE_WIDTH_M,
  });
}

async function uploadKnownSpeedClip(page, worldToImage, speedMph) {
  await page.evaluate(async ({
    worldToImage,
    speedMph,
    roadWidthM,
    roadLengthM,
    laneWidthM,
    durationS,
    fps,
  }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(fps);
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

    const project = (x, y) => {
      const w =
        worldToImage[2][0] * x +
        worldToImage[2][1] * y +
        worldToImage[2][2];
      const px =
        worldToImage[0][0] * x +
        worldToImage[0][1] * y +
        worldToImage[0][2];
      const py =
        worldToImage[1][0] * x +
        worldToImage[1][1] * y +
        worldToImage[1][2];
      return [px / w, py / w];
    };

    const drawPolyline = (points, { strokeStyle, lineWidth, dash = [] }) => {
      context.save();
      context.strokeStyle = strokeStyle;
      context.lineWidth = lineWidth;
      context.setLineDash(dash);
      context.beginPath();
      points.forEach(([x, y], index) => {
        const [px, py] = project(x, y);
        if (index === 0) {
          context.moveTo(px, py);
        } else {
          context.lineTo(px, py);
        }
      });
      context.stroke();
      context.restore();
    };

    const drawRoad = () => {
      const sky = context.createLinearGradient(0, 0, 0, 200);
      sky.addColorStop(0, "#b7d8ff");
      sky.addColorStop(1, "#dce9f7");
      context.fillStyle = sky;
      context.fillRect(0, 0, canvas.width, canvas.height);

      const roadCorners = [
        project(0, 0),
        project(roadWidthM, 0),
        project(roadWidthM, roadLengthM),
        project(0, roadLengthM),
      ];

      context.fillStyle = "#6f6a60";
      context.beginPath();
      roadCorners.forEach(([x, y], index) => {
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.closePath();
      context.fill();

      drawPolyline(
        [
          [0, 0],
          [0, roadLengthM],
        ],
        { strokeStyle: "#f6f1da", lineWidth: 4 },
      );
      drawPolyline(
        [
          [roadWidthM, 0],
          [roadWidthM, roadLengthM],
        ],
        { strokeStyle: "#f6f1da", lineWidth: 4 },
      );

      const dashLengthM = 3.048;
      const gapLengthM = 9.144;
      for (let startY = 0; startY < roadLengthM; startY += dashLengthM + gapLengthM) {
        drawPolyline(
          [
            [laneWidthM, startY],
            [laneWidthM, Math.min(roadLengthM, startY + dashLengthM)],
          ],
          { strokeStyle: "#f6f1da", lineWidth: 4 },
        );
      }

      context.fillStyle = "rgba(0, 0, 0, 0.08)";
      context.fillRect(0, 0, canvas.width, canvas.height);
    };

    const drawCar = (centerY) => {
      const carWidth = 1.8;
      const carLength = 4.4;
      const laneCenterX = laneWidthM + (laneWidthM / 2);
      const x1 = laneCenterX - (carWidth / 2);
      const x2 = laneCenterX + (carWidth / 2);
      const y1 = centerY - (carLength / 2);
      const y2 = centerY + (carLength / 2);
      const corners = [
        project(x1, y1),
        project(x2, y1),
        project(x2, y2),
        project(x1, y2),
      ];
      context.fillStyle = "#c63b2d";
      context.beginPath();
      corners.forEach(([x, y], index) => {
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.closePath();
      context.fill();

      context.fillStyle = "rgba(255, 255, 255, 0.32)";
      context.beginPath();
      const windshield = corners.slice(0, 2).map(([x, y]) => [x, y]);
      context.moveTo(windshield[0][0], windshield[0][1]);
      context.lineTo(windshield[1][0], windshield[1][1]);
      context.lineTo(corners[2][0], corners[2][1]);
      context.lineTo(corners[3][0], corners[3][1]);
      context.closePath();
      context.fill();
    };

    recorder.start();

    const speedMps = speedMph * 0.44704;
    const totalFrames = Math.max(1, Math.ceil(durationS * fps));
    const startCenterY = roadLengthM - 18;

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      const timeS = frameIndex / fps;
      const centerY = startCenterY - (speedMps * timeS);
      drawRoad();
      drawCar(centerY);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1000 / fps));
    }

    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: "video/webm" });
    const file = new File([blob], `known-${speedMph}.webm`, { type: "video/webm" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector("#video-file");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, {
    worldToImage,
    speedMph,
    roadWidthM: ROAD_WIDTH_M,
    roadLengthM: ROAD_LENGTH_M,
    laneWidthM: LANE_WIDTH_M,
    durationS: DURATION_S,
    fps: FPS,
  });
}

async function runCase(page, speedMph, toleranceMph) {
  await page.reload({ waitUntil: "networkidle2" });
  await injectKnownDetector(page);
  const exactImageToWorld = computeHomography(IMAGE_POINTS, ROAD_WIDTH_M, ROAD_LENGTH_M);
  const worldToImage = invertHomography(exactImageToWorld);

  await injectFixtureCalibration(page, {
    worldToImage,
    imageToWorld: exactImageToWorld,
  });

  await uploadKnownSpeedClip(page, worldToImage, speedMph);

  await page.waitForFunction(() => {
    const button = document.querySelector("#analyze-button");
    const decode = document.querySelector("#decode-text");
    return button && !button.disabled && decode && /Ready to analyze/i.test(decode.textContent || "");
  }, { timeout: 30000 });

  await page.click("#analyze-button");

  await page.waitForFunction(() => {
    const status = document.querySelector("#track-status-text");
    return status && /scanning|calibration ready|analyzing|processed/i.test(status.textContent || "");
  }, { timeout: 180000 });

  await page.waitForFunction(() => {
    const status = document.querySelector("#results-status-text");
    return status && /analysis complete/i.test(status.textContent);
  }, { timeout: 180000 });

  const actual = await page.evaluate(() => {
    const summary = window.__trafficReview.analysis?.summary || [];
    const calibration = window.__trafficReview.analysis?.calibrationDiagnostics || null;
    const analysis = window.__trafficReview.analysis || null;
    const note = document.querySelector("#results-note-text")?.textContent || "";
    return {
      summaryCount: summary.length,
      avgSpeed: summary[0]?.avg_speed ?? null,
      peakSpeed: summary[0]?.peak_speed ?? null,
      framesSeen: summary[0]?.frames_seen ?? null,
      trackWindow: analysis?.trackWindow ?? null,
      calibration,
      note,
    };
  });

  assert.ok(actual.summaryCount >= 1, `No tracks were produced for ${speedMph} mph case.`);
  assert.ok(Number.isFinite(actual.avgSpeed), `Missing average speed for ${speedMph} mph case.`);
  assert.ok(Number.isFinite(actual.peakSpeed), `Missing peak speed for ${speedMph} mph case.`);
  assert.ok(
    Math.abs(actual.avgSpeed - speedMph) <= toleranceMph,
    `${speedMph} mph case averaged ${actual.avgSpeed.toFixed(2)} mph, outside tolerance ±${toleranceMph} mph.`,
  );
  assert.match(actual.note, /Every visible vehicle/i);
  const progressWidth = await page.$eval("#progress-bar", (node) => node.style.width || "");
  assert.equal(progressWidth, "100%");
}

async function main() {
  const server = await startStaticServer(path.join(repoRoot, "docs"), 4173);
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await loadPage(browser);
    await injectKnownDetector(page);

    for (const testCase of CASES) {
      console.log(`Running known-speed case: ${testCase.label}`);
      // eslint-disable-next-line no-await-in-loop
      await runCase(page, testCase.speedMph, testCase.toleranceMph);
    }

    console.log("Known-speed assertions passed");
  } finally {
    if (browser) {
      await browser.close();
    }
    await stopStaticServer(server);
  }
}

const keepAlive = setInterval(() => {}, 1000);
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(keepAlive);
  });
