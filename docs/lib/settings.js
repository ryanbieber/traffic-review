function readNumber(selector, fallback) {
  const value = Number(document.querySelector(selector)?.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getSpeedLimitMph() {
  return readNumber("#speed-limit", 35);
}

export function getReportedSpeedMph() {
  return readNumber("#reported-speed", 0);
}

export function getConfidenceThreshold() {
  return readNumber("#confidence-threshold", 0.35);
}

export function getHistorySeconds() {
  return readNumber("#history-seconds", 0.75);
}
