import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const clipPath = path.join(repoRoot, "tests/fixtures/vs13/CitroenC4Picasso_80.mp4");
const expectedSpeedMph = 80 * 0.621371;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer() {
  const server = spawn("python3", ["-m", "http.server", "4173", "--directory", path.join(repoRoot, "docs")], {
    stdio: "ignore",
  });
  await delay(1000);
  return server;
}

async function main() {
  const server = await startServer();
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(240000);
    page.on("console", (message) => {
      console.log("PAGE LOG:", message.type(), message.text());
    });
    page.on("pageerror", (error) => {
      console.log("PAGE ERROR:", error.stack || error.message);
    });

    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle2" });
    await (await page.$("#video-file")).uploadFile(clipPath);

    await page.waitForFunction(() => {
      const status = document.querySelector("#track-status-text");
      return status && /click the vehicle/i.test(status.textContent || "");
    }, { timeout: 240000 });

    const targetBox = await page.evaluate(() => {
      const detections = window.__trafficReview.selectionFrame?.detections || [];
      const detection = detections[0];
      return detection ? detection.box : null;
    });
    assert.ok(targetBox, "expected at least one detection in the sample clip");

    await page.$eval("#preview-canvas", (canvas, box) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / canvas.width;
      const scaleY = rect.height / canvas.height;
      const clientX = rect.left + ((box.x1 + box.x2) / 2) * scaleX;
      const clientY = rect.top + ((box.y1 + box.y2) / 2) * scaleY;
      canvas.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX,
        clientY,
      }));
    }, targetBox);

    await page.waitForFunction(() => {
      const button = document.querySelector("#analyze-button");
      return button && !button.classList.contains("disabled");
    }, { timeout: 240000 });

    await page.evaluate((reportedSpeed) => {
      const input = document.querySelector("#reported-speed");
      if (input) {
        input.value = String(reportedSpeed);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, expectedSpeedMph);

    await page.click("#analyze-button");

    await page.waitForFunction(() => {
      const status = document.querySelector("#results-status-text");
      return status && /analysis complete/i.test(status.textContent || "");
    }, { timeout: 240000 });

    const actual = await page.evaluate(() => {
      const summary = window.__trafficReview.analysis?.summary?.[0] || null;
      const calibration = window.__trafficReview.analysis?.calibrationDiagnostics || null;
      return {
        avgSpeed: summary?.avg_speed ?? null,
        peakSpeed: summary?.peak_speed ?? null,
        framesSeen: summary?.frames_seen ?? null,
        calibration,
      };
    });

    assert.ok(Number.isFinite(actual.avgSpeed), "missing average speed for the real clip");
    assert.ok(Number.isFinite(actual.peakSpeed), "missing peak speed for the real clip");
    assert.ok(actual.framesSeen > 0, "the real clip was not tracked");
    assert.ok(Math.abs(actual.avgSpeed - expectedSpeedMph) <= 6, `expected about ${expectedSpeedMph.toFixed(2)} mph, got ${actual.avgSpeed.toFixed(2)} mph`);
    assert.match(actual.calibration?.method || "", /lane/i);

    console.log("Real known-speed assertion passed");
  } finally {
    if (browser) {
      await browser.close();
    }
    server.kill("SIGTERM");
    await once(server, "exit");
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
