import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

import { startStaticServer, stopStaticServer } from "./static-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const clipPath = path.join(repoRoot, "tests/fixtures/vs13/CitroenC4Picasso_80.mp4");
const expectedSpeedMph = 80 * 0.621371;

async function main() {
  const server = await startStaticServer(path.join(repoRoot, "docs"), 4173);
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
      return status && /scanning|calibration ready|analyzing|processed/i.test(status.textContent || "");
    }, { timeout: 240000 });

    await page.waitForFunction(() => {
      const status = document.querySelector("#results-status-text");
      return status && /analysis complete/i.test(status.textContent || "");
    }, { timeout: 240000 });

    const actual = await page.evaluate((expectedSpeedMph) => {
      const summary = window.__trafficReview.analysis?.summary || [];
      const primaryTrack = summary
        .slice()
        .sort((left, right) => {
          const leftDelta = Math.abs(left.avg_speed - expectedSpeedMph);
          const rightDelta = Math.abs(right.avg_speed - expectedSpeedMph);
          return (leftDelta - rightDelta) || (right.frames_seen - left.frames_seen);
        })[0] || null;
      const calibration = window.__trafficReview.analysis?.calibrationDiagnostics || null;
      return {
        summaryCount: summary.length,
        avgSpeed: primaryTrack?.avg_speed ?? null,
        peakSpeed: primaryTrack?.peak_speed ?? null,
        framesSeen: primaryTrack?.frames_seen ?? null,
        calibration,
      };
    }, expectedSpeedMph);

    assert.ok(actual.summaryCount >= 1, "the real clip was not tracked");
    assert.ok(Number.isFinite(actual.avgSpeed), "missing average speed for the real clip");
    assert.ok(Number.isFinite(actual.peakSpeed), "missing peak speed for the real clip");
    assert.ok(actual.framesSeen > 0, "the real clip was not tracked");
    assert.ok(Math.abs(actual.avgSpeed - expectedSpeedMph) <= 6, `expected about ${expectedSpeedMph.toFixed(2)} mph, got ${actual.avgSpeed.toFixed(2)} mph`);
    assert.match(actual.calibration?.method || "", /lane/i);
    const progressWidth = await page.$eval("#progress-bar", (node) => node.style.width || "");
    assert.equal(progressWidth, "100%");

    console.log("Real known-speed assertion passed");
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
