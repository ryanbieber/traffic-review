import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

import { startStaticServer, stopStaticServer } from "./static-server.mjs";

process.on("exit", (code) => {
  console.log("PROCESS EXIT", code);
});
process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED REJECTION", error);
  process.exitCode = 1;
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const clipPath = path.join(repoRoot, "tests/fixtures/vs13/CitroenC4Picasso_80.mp4");

async function prepareSmokeClip(page, sourcePath) {
  await page.evaluate(() => {
    if (document.querySelector("#smoke-source")) {
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.id = "smoke-source";
    input.style.display = "none";
    document.body.appendChild(input);
  });

  const sourceInput = await page.$("#smoke-source");
  await sourceInput.uploadFile(sourcePath);

  await page.evaluate(async () => {
    const sourceInput = document.querySelector("#smoke-source");
    const appInput = document.querySelector("#video-file");
    if (!sourceInput?.files?.[0] || !appInput) {
      throw new Error("Smoke clip preparation failed.");
    }

    const sourceFile = sourceInput.files[0];
    const sourceUrl = URL.createObjectURL(sourceFile);
    const video = document.createElement("video");
    video.src = sourceUrl;
    video.muted = true;
    video.playsInline = true;

    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not decode the smoke fixture."));
      };
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
      };
      video.addEventListener("loadedmetadata", onLoaded, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.load();
    });

    const width = video.videoWidth || 960;
    const height = video.videoHeight || 540;
    const duration = Math.min(2.5, Math.max(1.2, video.duration || 2.5));
    const fps = 15;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
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

    const frames = Math.max(12, Math.ceil(duration * fps));
    for (let index = 0; index < frames; index += 1) {
      const timeS = Math.min(duration - 0.01, (duration * index) / Math.max(1, frames - 1));
      await new Promise((resolve, reject) => {
        const onSeeked = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("Could not seek the smoke fixture."));
        };
        const cleanup = () => {
          video.removeEventListener("seeked", onSeeked);
          video.removeEventListener("error", onError);
        };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.currentTime = timeS;
      });

      context.drawImage(video, 0, 0, width, height);
      // Give MediaRecorder time to capture the updated frame.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1000 / fps));
    }

    recorder.stop();
    await stopped;
    URL.revokeObjectURL(sourceUrl);

    const blob = new Blob(chunks, { type: "video/webm" });
    const file = new File([blob], "smoke.webm", { type: "video/webm" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    appInput.files = transfer.files;
    appInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
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
    assert.match(heading, /Drop a clip/i);

    console.log("Uploading clip");
    await prepareSmokeClip(page, clipPath);

    await page.waitForFunction(() => {
      const button = document.querySelector("#analyze-button");
      const decode = document.querySelector("#decode-text");
      return button && !button.disabled && decode && /Ready to analyze/i.test(decode.textContent || "");
    }, { timeout: 30000 });

    await page.click("#analyze-button");

    await page.waitForFunction(() => {
      const status = document.querySelector("#track-status-text");
      return status && /scanning|analyzing|processed/i.test(status.textContent || "");
    }, { timeout: 30000 });

    await page.waitForFunction(() => {
      const status = document.querySelector("#results-status-text");
      return status && /analysis complete/i.test(status.textContent);
    }, { timeout: 180000 });

    await page.waitForFunction(() => {
      const stage = document.querySelector("#stage-results");
      const video = document.querySelector("#annotated-video");
      const button = document.querySelector("#build-video-button");
      return stage?.classList.contains("active") && video && !video.hidden && video.src && video.src.length > 0 && button && !button.disabled;
    }, { timeout: 180000 });

    const analysis = await page.evaluate(() => ({
      summaryLength: window.__trafficReview.analysis?.summary?.length || 0,
      note: window.__trafficReview.analysis?.note || "",
    }));
    assert.ok(analysis.summaryLength > 0);
    assert.match(analysis.note, /Every visible vehicle/i);
    const decodeText = await page.$eval("#decode-text", (node) => node.textContent || "");
    assert.match(decodeText, /Ready to analyze/i);
    const rectifiedText = await page.$eval("#rectified-text", (node) => node.textContent || "");
    assert.match(rectifiedText, /(road plane|lane patch)/i);
    assert.doesNotMatch(rectifiedText, /unavailable/i);
    const progressWidth = await page.$eval("#progress-bar", (node) => node.style.width || "");
    assert.equal(progressWidth, "100%");
    console.log("Smoke assertions passed");
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
