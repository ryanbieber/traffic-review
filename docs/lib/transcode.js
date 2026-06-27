import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { fetchFile, toBlobURL } from "../vendor/ffmpeg-util/index.js";

const CORE_BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";

let ffmpegPromise = null;

async function createFfmpeg(onLog) {
  const ffmpeg = new FFmpeg();
  if (onLog) {
    ffmpeg.on("log", ({ message }) => onLog(message));
  }
  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
    workerURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.worker.js`, "text/javascript"),
  });
  return ffmpeg;
}

async function getFfmpeg(onLog) {
  if (!ffmpegPromise) {
    ffmpegPromise = createFfmpeg(onLog);
  }
  return ffmpegPromise;
}

function replaceExtension(filename, nextExtension) {
  const stem = filename.replace(/\.[^.]+$/, "") || "upload";
  return `${stem}.${nextExtension}`;
}

export async function transcodeToBrowserVideo(file, { onStatus } = {}) {
  const ffmpeg = await getFfmpeg((message) => {
    if (message && onStatus) {
      onStatus(message);
    }
  });

  const inputName = `input-${Date.now()}`;
  const outputName = replaceExtension(file.name, "webm");

  await ffmpeg.writeFile(inputName, await fetchFile(file));
  await ffmpeg.exec([
    "-i",
    inputName,
    "-vf",
    "fps=15,scale='min(1280,iw)':-2",
    "-an",
    "-c:v",
    "libvpx",
    "-crf",
    "18",
    "-b:v",
    "0",
    outputName,
  ]);

  const outputData = await ffmpeg.readFile(outputName);
  if (typeof ffmpeg.deleteFile === "function") {
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }

  return new File([outputData.buffer], outputName, {
    type: "video/webm",
    lastModified: Date.now(),
  });
}
