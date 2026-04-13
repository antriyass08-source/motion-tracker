const videoElement = document.getElementById("video");
const canvasElement = document.getElementById("canvas");
const ctx = canvasElement.getContext("2d");

// IMPORTANT: match actual display size
function resizeCanvas() {
  canvasElement.width = window.innerWidth;
  canvasElement.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// smoothing variables
let smoothX = 0;
let smoothY = 0;
const alpha = 0.25;

function onResults(results) {
  ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const landmarks = results.multiHandLandmarks[0];

    // raw normalized coordinates
    const rawX = (1 - landmarks[8].x) * canvasElement.width;
    const rawY = landmarks[8].y * canvasElement.height;

    // smoothing (fix jitter + misalignment feel)
    smoothX += (rawX - smoothX) * alpha;
    smoothY += (rawY - smoothY) * alpha;

    ctx.fillStyle = "cyan";
    ctx.beginPath();
    ctx.arc(smoothX, smoothY, 10, 0, Math.PI * 2);
    ctx.fill();
  }
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

// Camera setup (correct binding)
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await hands.send({ image: videoElement });
  },
  width: 1280,
  height: 720,
});

camera.start();
