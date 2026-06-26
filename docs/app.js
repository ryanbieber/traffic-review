const form = document.querySelector("#analysis-form");
const statusText = document.querySelector("#status-text");
const calibrationText = document.querySelector("#calibration-text");
const noteText = document.querySelector("#note-text");
const videoLink = document.querySelector("#video-link");
const csvLink = document.querySelector("#csv-link");
const resultsBody = document.querySelector("#results-table tbody");

function setStatus(text) {
  statusText.textContent = text;
}

function setDownloadLink(anchor, href) {
  if (!href) {
    anchor.href = "#";
    anchor.classList.add("disabled");
    return;
  }

  anchor.href = href;
  anchor.classList.remove("disabled");
}

function renderRows(rows) {
  if (!rows.length) {
    resultsBody.innerHTML = '<tr><td colspan="8">No vehicles were tracked in this run.</td></tr>';
    return;
  }

  resultsBody.innerHTML = rows
    .map((row) => {
      const rowClass = row.flagged ? "flagged" : "";
      return `
        <tr class="${rowClass}">
          <td>${row.track_id}</td>
          <td>${row.label}</td>
          <td>${Number(row.peak_speed_mph).toFixed(1)}</td>
          <td>${Number(row.avg_speed_mph).toFixed(1)}</td>
          <td>${row.frames_seen}</td>
          <td>${Number(row.first_seen_s).toFixed(2)}s</td>
          <td>${Number(row.last_seen_s).toFixed(2)}s</td>
          <td>${row.flagged ? "Yes" : "No"}</td>
        </tr>
      `;
    })
    .join("");
}

function buildConfig() {
  return {
    model_name: document.querySelector("#model-name").value,
    confidence_threshold: Number(document.querySelector("#confidence-threshold").value),
    history_seconds: Number(document.querySelector("#history-seconds").value),
    speed_limit_mph: Number(document.querySelector("#speed-limit").value),
    fps_override: Number(document.querySelector("#fps-override").value) || null,
    calibration_mode: "perspective",
    perspective_points: [
      [Number(document.querySelector("#p1x").value), Number(document.querySelector("#p1y").value)],
      [Number(document.querySelector("#p2x").value), Number(document.querySelector("#p2y").value)],
      [Number(document.querySelector("#p3x").value), Number(document.querySelector("#p3y").value)],
      [Number(document.querySelector("#p4x").value), Number(document.querySelector("#p4y").value)],
    ],
    perspective_width_m: Number(document.querySelector("#patch-width").value),
    perspective_length_m: Number(document.querySelector("#patch-length").value),
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const apiBase = document.querySelector("#api-base").value.replace(/\/$/, "");
  const videoFile = document.querySelector("#video-file").files[0];
  if (!videoFile) {
    setStatus("Choose a video file first.");
    return;
  }

  setStatus("Uploading clip and running YOLO analysis. This can take a while on larger videos.");
  calibrationText.textContent = "Running...";
  noteText.textContent = "Running...";
  setDownloadLink(videoLink, "");
  setDownloadLink(csvLink, "");
  resultsBody.innerHTML = '<tr><td colspan="8">Processing...</td></tr>';

  const payload = new FormData();
  payload.append("video", videoFile);
  payload.append("config", JSON.stringify(buildConfig()));

  try {
    const response = await fetch(`${apiBase}/api/analyze`, {
      method: "POST",
      body: payload,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Analysis failed");
    }

    setStatus(`Run ${data.run_id} complete.`);
    calibrationText.textContent = data.calibration_description;
    noteText.textContent = data.note;
    setDownloadLink(videoLink, `${apiBase}${data.downloads.video}`);
    setDownloadLink(csvLink, `${apiBase}${data.downloads.summary_csv}`);
    renderRows(data.summary || []);
  } catch (error) {
    setStatus(error.message || "Analysis failed.");
    calibrationText.textContent = "Not available.";
    noteText.textContent = "The backend returned an error.";
    resultsBody.innerHTML = `<tr><td colspan="8">${error.message || "Request failed."}</td></tr>`;
  }
});
