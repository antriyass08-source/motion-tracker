const videoElement = document.getElementById("video");
const canvasElement = document.getElementById("canvas");
const ctx = canvasElement.getContext("2d");
const modeUI = document.getElementById("mode");

function resize() {
  canvasElement.width = window.innerWidth;
  canvasElement.height = window.innerHeight;
}
resize();
window.addEventListener("resize", resize);

// STATE
let mode = "draw";
let prevX = null;
let prevY = null;
let lastToggle = 0;

// smoothing
let smoothX = 0;
let smoothY = 0;
const alpha = 0.25;

// swipe tracking
let prevPoints = [];

function isFist(lm) {
  return (
    lm[8].y > lm[6].y &&
    lm[12].y > lm[10].y &&
    lm[16].y > lm[14].y &&
    lm[20].y > lm[18].y
  );
}

function getSpeed() {
  if (prevPoints.length < 2) return 0;

  const a = prevPoints[0];
  const b = prevPoints[prevPoints.length - 1];

  const dx = b.x - a.x;
  const dy = b.y - a.y;

  return Math.sqrt(dx * dx + dy * dy);
}

function onResults(results) {
  ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    prevX = null;
    prevY = null;
    prevPoints = [];
    return;
  }

  const lm = results.multiHandLandmarks[0];

  // NORMAL coordinates (mirror handled only by CSS)
  const rawX = lm[8].x * canvasElement.width;
  const rawY = lm[8].y * canvasElement.height;

  // smoothing
  smoothX += (rawX - smoothX) * alpha;
  smoothY += (rawY - smoothY) * alpha;

  const x = smoothX;
  const y = smoothY;

  // toggle mode (cooldown to prevent spam)
  const now = Date.now();
  if (isFist(lm) && now - lastToggle > 1200) {
    mode = mode === "draw" ? "ninja" : "draw";
    lastToggle = now;
  }

  modeUI.innerText = "MODE: " + mode.toUpperCase();

  // track movement history (for swipe)
  prevPoints.push({ x, y });
  if (prevPoints.length > 5) prevPoints.shift();

  // ---------------- DRAW MODE ----------------
  if (mode === "draw") {
    const isIndexUp = lm[8].y < lm[6].y;

    if (isIndexUp) {
      if (prevX !== null && prevY !== null) {
        ctx.strokeStyle = "cyan";
        ctx.lineWidth = 4;
        ctx.lineCap = "round";

        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      prevX = x;
      prevY = y;
    } else {
      prevX = null;
      prevY = null;
    }

    ctx.fillStyle = "cyan";
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------------- NINJA MODE ----------------
  if (mode === "ninja") {
    const speed = getSpeed();

    ctx.fillStyle = speed > 20 ? "lime" : "red";
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
  }
}

// MediaPipe
const hands = new Hands({
  locateFile: (file) =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
});

hands.onResults(onResults);

// Camera
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await hands.send({ image: videoElement });
  },
  width: 1280,
  height: 720,
});

camera.start();
