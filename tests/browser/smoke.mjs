import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
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
const sourceImagePath = path.join(
  repoRoot,
  ".venv",
  "lib",
  "python3.13",
  "site-packages",
  "ultralytics",
  "assets",
  "bus.jpg",
);

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
    assert.match(heading, /Check a speeding clip/i);

    console.log("Generating browser-native fixture");
    const imageBase64 = await fs.readFile(sourceImagePath, "base64");
    await page.evaluate(async (base64Image) => {
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;
      const image = new Image();
      image.src = dataUrl;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });

      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(5);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.start();

      for (let index = 0; index < 8; index += 1) {
        context.drawImage(image, 0, 0);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 180));
      }

      recorder.stop();
      await stopped;
      const blob = new Blob(chunks, { type: "video/webm" });
      const file = new File([blob], "bus-loop.webm", { type: "video/webm" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const input = document.querySelector("#video-file");
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, imageBase64);

    console.log("Waiting for video metadata");
    await page.waitForFunction(() => {
      const meta = document.querySelector("#video-meta");
      return meta && !meta.textContent.includes("No clip loaded");
    });

    console.log("Configuring analysis");
    await page.$eval("#sample-every-frames", (input) => {
      input.value = "4";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.$eval("#fps-override", (input) => {
      input.value = "5";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await page.waitForFunction(() => {
      const status = document.querySelector("#status-text");
      return status && status.textContent.includes("Analysis complete");
    }, { timeout: 180000 });

    console.log("Collecting assertions");
    const rows = await page.$$eval("#results-table tbody tr", (nodes) =>
      nodes.map((node) => node.textContent.trim()),
    );
    assert.ok(rows.some((row) => row.toLowerCase().includes("bus")));
    const frameRows = await page.$$eval("#frame-results-table tbody tr", (nodes) =>
      nodes.map((node) => node.textContent.trim()),
    );
    assert.ok(frameRows.some((row) => row.includes("mph")));

    const note = await page.$eval("#note-text", (node) => node.textContent || "");
    assert.match(note, /rough browser-side estimates/i);

    const csvHref = await page.$eval("#download-csv", (node) => node.getAttribute("href"));
    assert.ok(csvHref && csvHref.startsWith("blob:"));
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
