const videoElement = document.getElementById("video");
const canvasElement = document.getElementById("canvas");
const ctx = canvasElement.getContext("2d");

// resize canvas properly
function resize() {
  canvasElement.width = window.innerWidth;
  canvasElement.height = window.innerHeight;
}
resize();
window.addEventListener("resize", resize);

// drawing state
let drawing = false;
let prevX = null;
let prevY = null;

// smoothing
let smoothX = 0;
let smoothY = 0;
const alpha = 0.25;

function onResults(results) {
  ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    drawing = false;
    prevX = null;
    prevY = null;
    return;
  }

  const landmarks = results.multiHandLandmarks[0];

  // FIXED MIRROR COORDINATE
  const rawX = (1 - landmarks[8].x) * canvasElement.width;
  const rawY = landmarks[8].y * canvasElement.height;

  // smoothing
  smoothX += (rawX - smoothX) * alpha;
  smoothY += (rawY - smoothY) * alpha;

  const x = smoothX;
  const y = smoothY;

  // gesture: index finger up = drawing
  const isIndexUp = landmarks[8].y < landmarks[6].y;

  if (isIndexUp) {
    drawing = true;
  } else {
    drawing = false;
    prevX = null;
    prevY = null;
  }

  // draw stroke
  if (drawing) {
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
  }

  // fingertip dot
  ctx.fillStyle = "cyan";
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
}

// MediaPipe setup
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
