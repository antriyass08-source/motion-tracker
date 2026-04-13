const videoElement = document.getElementById("video");
const canvasElement = document.getElementById("canvas");
const ctx = canvasElement.getContext("2d");

function resize() {
  canvasElement.width = window.innerWidth;
  canvasElement.height = window.innerHeight;
}
resize();
window.addEventListener("resize", resize);

// STATES
let mode = "draw"; // draw | ninja
let prevX = null;
let prevY = null;

// smoothing
let smoothX = 0;
let smoothY = 0;
const alpha = 0.25;

function isFist(landmarks) {
  // simple fist detection: all fingertips below knuckles
  return (
    landmarks[8].y > landmarks[6].y &&
    landmarks[12].y > landmarks[10].y &&
    landmarks[16].y > landmarks[14].y &&
    landmarks[20].y > landmarks[18].y
  );
}

function onResults(results) {
  ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    prevX = null;
    prevY = null;
    return;
  }

  const landmarks = results.multiHandLandmarks[0];

  // coords
  const rawX = landmarks[8].x * canvasElement.width;
  const rawY = landmarks[8].y * canvasElement.height;

  smoothX += (rawX - smoothX) * alpha;
  smoothY += (rawY - smoothY) * alpha;

  const x = smoothX;
  const y = smoothY;

  // MODE TOGGLE (fist gesture)
  if (isFist(landmarks)) {
    mode = mode === "draw" ? "ninja" : "draw";
  }

  // MODE DISPLAY
  ctx.fillStyle = "white";
  ctx.font = "18px Arial";
  ctx.fillText("Mode: " + mode.toUpperCase(), 20, 30);

  // -----------------------
  // DRAW MODE
  // -----------------------
  if (mode === "draw") {
    const isIndexUp = landmarks[8].y < landmarks[6].y;

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

  // -----------------------
  // NINJA MODE (base only)
  // -----------------------
  if (mode === "ninja") {
    ctx.fillStyle = "red";
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();

    // (future: fruit collision + swipe detection here)
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

// camera
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await hands.send({ image: videoElement });
  },
  width: 1280,
  height: 720,
});

camera.start();
