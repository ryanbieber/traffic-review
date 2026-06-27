import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

process.on("exit", (code) => {
  console.log("PROCESS EXIT", code);
});
process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED REJECTION", error);
  process.exitCode = 1;
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
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
    page.setDefaultTimeout(180000);
    page.on("console", (message) => {
      console.log("PAGE LOG:", message.type(), message.text());
    });
    page.on("pageerror", (error) => {
      console.log("PAGE ERROR:", error.stack || error.message);
    });
    console.log("Opening page");
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle2" });

    console.log("Waiting for heading");
    await page.waitForSelector("h1");
    const heading = await page.$eval("h1", (node) => node.textContent || "");
    assert.match(heading, /See the vehicle/i);

    console.log("Loading demo clip");
    await page.click("#demo-button");

    console.log("Waiting for target-pick prompt");
    await page.waitForFunction(() => {
      const status = document.querySelector("#status-text");
      return status && /click the vehicle/i.test(status.textContent);
    }, { timeout: 180000 });

    const sampleCount = await page.$$eval("#sample-gallery [data-sample-index]", (nodes) => nodes.length);
    assert.ok(sampleCount > 0);

    console.log("Clicking detected target");
    const targetBox = await page.evaluate(() => {
      const detections = window.__trafficReview.selectionFrame?.detections || [];
      const detection = detections[1] || detections[0];
      const canvas = document.querySelector("#preview-canvas");
      return detection
        ? { box: detection.box, width: canvas.width, height: canvas.height }
        : null;
    });
    assert.ok(targetBox);
    await page.$eval("#preview-canvas", (canvas, box) => {
      canvas.scrollIntoView({ block: "center" });
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
    }, targetBox.box);

    await page.waitForFunction(() => {
      const status = document.querySelector("#status-text");
      return status && /processed|analysis complete/i.test(status.textContent);
    }, { timeout: 180000 });

    const selectedTarget = await page.evaluate(() => window.__trafficReview.selectedTarget);
    assert.ok(selectedTarget);
    console.log("Smoke assertions passed");
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
