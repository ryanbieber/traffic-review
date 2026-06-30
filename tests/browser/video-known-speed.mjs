import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

import { startStaticServer, stopStaticServer } from "./static-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const clipPath = path.join(repoRoot, "tests/fixtures/vs13/video.mp4");

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
      const button = document.querySelector("#analyze-button");
      const decode = document.querySelector("#decode-text");
      return button && !button.disabled && decode && /Ready to analyze/i.test(decode.textContent || "");
    }, { timeout: 240000 });

    await page.click("#analyze-button");

    await page.waitForFunction(() => {
      const status = document.querySelector("#results-status-text");
      return status && /analysis complete/i.test(status.textContent || "");
    }, { timeout: 240000 });

    const actual = await page.evaluate(() => {
      const summary = window.__trafficReview.analysis?.summary || [];
      const carRows = summary
        .filter((row) => row.label === "car")
        .slice()
        .sort((left, right) => right.avg_speed - left.avg_speed);

      return {
        summaryCount: summary.length,
        carRows: carRows.slice(0, 2).map((row) => ({
          trackId: row.track_id,
          avgSpeed: row.avg_speed,
          peakSpeed: row.peak_speed,
          label: row.display_label || row.label,
        })),
        calibration: window.__trafficReview.analysis?.calibrationDiagnostics || null,
      };
    });

    assert.ok(actual.summaryCount >= 2, "the target clip did not produce enough tracked vehicles");
    assert.ok(actual.carRows.length >= 2, "the target clip did not produce two car tracks");
    assert.ok(Math.abs(actual.carRows[0].avgSpeed - 68) <= 2, `expected the faster car to be about 68 mph, got ${actual.carRows[0].avgSpeed.toFixed(2)} mph`);
    assert.ok(Math.abs(actual.carRows[1].avgSpeed - 66) <= 2, `expected the second car to be about 66 mph, got ${actual.carRows[1].avgSpeed.toFixed(2)} mph`);
    assert.match(actual.calibration?.method || "", /lane/i);

    const progressWidth = await page.$eval("#progress-bar", (node) => node.style.width || "");
    assert.equal(progressWidth, "100%");

    console.log("Target clip speed assertion passed");
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
