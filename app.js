/**
 * BLUE MOTION NINJA STUDIO v3.1
 * Fix: single camera path (MediaPipe Camera only, no manual getUserMedia)
 * Fix: no fist gesture — mode buttons control mode switching
 * Fix: tracking status indicator
 * Fix: mobile device detection for perf tuning
 */
'use strict';

const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// ─────────────────────────── CONFIG ───────────────────────────────────
const CFG = {
  TRAIL_LIFE:        45,
  TRAIL_MAX:         60,
  PARTICLE_MAX:      200,    // reduced for perf
  FRUIT_MAX:         12,     // sweet spot
  FRUIT_SPAWN_RATE:  22,     // fast but not overwhelming
  FRUIT_BURST:       2,
  SLICE_VEL:         6,
  DRAW_FADE_DELAY:   180,
  WOBBLE_AMP:        1.6,
  DPR:               Math.min(window.devicePixelRatio || 1, 2),
  SMOOTH:            0.55,
};

// ─────────────────────────── STATE ────────────────────────────────────
const STATE = {
  mode:        'draw',
  score:       0,
  frameCount:  0,
  fps:         0,
  fpsTime:     performance.now(),
  fpsFrames:   0,
  tracking:    false,       // true when MediaPipe sees a hand
  handVel:     { x: 0, y: 0 },
  lastTip:     null,
};

// ─────────────────────────── COLLECTIONS ──────────────────────────────
const trail       = [];
const particles   = [];
const drawStrokes = [];
const fruits      = [];
let   smoothTip   = null;   // EMA-smoothed index fingertip
let   activeStroke   = null;
let   fruitTimer     = 0;

// ─────────────────────────── DOM ──────────────────────────────────────
const video       = document.getElementById('webcam');
const canvas      = document.getElementById('ar-canvas');
const ctx         = canvas.getContext('2d');
const scoreEl     = document.getElementById('score-val');
const fpsEl       = document.getElementById('fps-counter');
const toastEl     = document.getElementById('toast');
const loadingEl   = document.getElementById('loading-screen');
const loadStatEl  = document.getElementById('load-status');
const rippleEl    = document.getElementById('ripple-overlay');
const trackStatEl = document.getElementById('track-status');

// ─────────────────────────── CANVAS RESIZE ────────────────────────────
function resizeCanvas() {
  canvas.width        = window.innerWidth  * CFG.DPR;
  canvas.height       = window.innerHeight * CFG.DPR;
  canvas.style.width  = window.innerWidth  + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(1, 0, 0, 1, 0, 0);   // reset before scaling
  ctx.scale(CFG.DPR, CFG.DPR);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const W = () => window.innerWidth;
const H = () => window.innerHeight;

// ─────────────────────────── UTILS ────────────────────────────────────
const lerp    = (a, b, t) => a + (b - a) * t;
const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand    = (a, b) => a + Math.random() * (b - a);
const dist2   = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

/** Objects near the top of screen appear "farther" (smaller scale) */
const depthScale = y => lerp(0.5, 1.35, clamp(y / H(), 0, 1));

/**
 * Convert a normalised MediaPipe landmark to mirrored canvas pixel coords.
 * Accounts for object-fit:cover crop so tracking is perfectly aligned
 * with what you see on screen regardless of aspect ratio.
 */
function lm(landmarks, i) {
  const vw = video.videoWidth  || 640;
  const vh = video.videoHeight || 480;
  const sw = W(), sh = H();
  const scale = Math.max(sw / vw, sh / vh);
  const rw    = vw * scale;
  const rh    = vh * scale;
  const offX  = (sw - rw) / 2;
  const offY  = (sh - rh) / 2;
  const x = (1 - landmarks[i].x) * rw + offX;
  const y = landmarks[i].y        * rh + offY;
  return { x, y };
}

/**
 * True when index finger is extended and at least 2 of the other
 * fingers (middle/ring/pinky) are curled — the classic "point" pose.
 * This prevents accidental drawing when the full hand is open.
 */
function isPointing(landmarks) {
  const indexTip = lm(landmarks, 8);
  const indexPip = lm(landmarks, 6);
  // index is extended when tip is ABOVE (lower y) the PIP joint
  if (indexTip.y >= indexPip.y) return false;

  // check middle / ring / pinky curled
  const pairs   = [[12, 10], [16, 14], [20, 18]];  // [tip, pip]
  let curled = 0;
  for (const [tip, pip] of pairs) {
    if (lm(landmarks, tip).y > lm(landmarks, pip).y) curled++;
  }
  return curled >= 2;   // at least 2 other fingers curled
}

// ─────────────────────────── TOAST ────────────────────────────────────
let _toastTimer = null;
function showToast(msg, dur = 1600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
}

// ─────────────────────────── MODE (button-driven) ─────────────────────
window.setMode = function(m) {        // called from onclick in HTML
  if (STATE.mode === m) return;
  STATE.mode = m;

  document.getElementById('btn-draw').classList.toggle('active',  m === 'draw');
  document.getElementById('btn-ninja').classList.toggle('active', m === 'ninja');

  // close any open stroke when switching away from draw
  finishStroke();

  const isNinja = m === 'ninja';
  showToast(isNinja ? '⚔  NINJA MODE' : '✦  DRAW MODE', 1800);
  triggerRipple(isNinja ? 'rgba(255,64,96,0.22)' : 'rgba(0,245,255,0.18)');
  spawnBurst(W() / 2, H() / 2, 80, isNinja ? '#ff4060' : '#00f5ff');
};

function triggerRipple(color) {
  rippleEl.style.background = `radial-gradient(circle at 50% 50%, ${color} 0%, transparent 72%)`;
  rippleEl.style.opacity = '1';
  setTimeout(() => (rippleEl.style.opacity = '0'), 400);
}

// ─────────────────────────── MEDIAPIPE SETUP ──────────────────────────
function initMediaPipe() {
  const hands = new Hands({
    locateFile: file =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
  });

  hands.setOptions({
    maxNumHands:            1,
    modelComplexity:        0,   // lite model — fast on both desktop & mobile
    minDetectionConfidence: 0.65,
    minTrackingConfidence:  0.60,
  });

  hands.onResults(onHandResults);

  /**
   * KEY FIX: MediaPipe Camera utility is the ONLY thing that touches the
   * video element.  We do NOT call getUserMedia manually.
   * Camera handles stream acquisition + feeds frames into hands.send().
   */
  const camWidth  = IS_MOBILE ? 640  : 1280;
  const camHeight = IS_MOBILE ? 480  : 720;

  const cam = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width:  camWidth,
    height: camHeight,
  });

  cam.start()
    .then(() => console.log('[MP] Camera started — mobile:', IS_MOBILE))
    .catch(err => {
      console.error('[MP] Camera start error:', err);
      loadStatEl.textContent = 'CAMERA ERROR — ALLOW CAMERA ACCESS';
    });
}

// ─────────────────────────── HAND RESULTS ─────────────────────────────
function onHandResults(results) {
  const detected = !!(
    results.multiHandLandmarks &&
    results.multiHandLandmarks.length > 0
  );

  // Update tracking status badge
  STATE.tracking = detected;
  if (trackStatEl) {
    trackStatEl.textContent = detected ? '● HAND DETECTED' : '● WAITING FOR HAND...';
    trackStatEl.style.color = detected ? '#00f5ff' : 'rgba(0,245,255,0.4)';
  }

  if (!detected) {
    finishStroke();
    STATE.lastTip = null;
    STATE.handVel = { x: 0, y: 0 };
    return;
  }

  const landmarks = results.multiHandLandmarks[0];
  const rawTip = lm(landmarks, 8); // index fingertip (raw)

  // ── EMA smoothing — removes jitter while keeping responsiveness ──
  if (!smoothTip) {
    smoothTip = { x: rawTip.x, y: rawTip.y };
  } else {
    const s = CFG.SMOOTH;
    smoothTip.x = smoothTip.x * s + rawTip.x * (1 - s);
    smoothTip.y = smoothTip.y * s + rawTip.y * (1 - s);
  }
  const tip = smoothTip;

  // velocity (from smoothed position)
  if (STATE.lastTip) {
    STATE.handVel.x = tip.x - STATE.lastTip.x;
    STATE.handVel.y = tip.y - STATE.lastTip.y;
  } else {
    STATE.handVel = { x: 0, y: 0 };
  }
  STATE.lastTip = { x: tip.x, y: tip.y };

  // ── DRAW MODE: only draw when index finger is pointing (others curled) ──
  if (STATE.mode === 'draw') {
    const pointing = isPointing(landmarks);
    if (pointing) {
      if (!activeStroke) {
        activeStroke = { points: [], alpha: 1, createdAt: STATE.frameCount };
        drawStrokes.push(activeStroke);
      }
      const last = activeStroke.points[activeStroke.points.length - 1];
      if (!last || dist2(tip, last) > 1.5) {
        activeStroke.points.push({ x: tip.x, y: tip.y });
      }
    } else {
      // open hand or other pose — lift pen
      finishStroke();
    }
  }

  // ── NINJA MODE: velocity-based slice ──
  if (STATE.mode === 'ninja') {
    const speed = Math.hypot(STATE.handVel.x, STATE.handVel.y);
    if (speed > CFG.SLICE_VEL) checkSlice(tip);
  }

  // store landmarks for render phase
  onHandResults._landmarks = landmarks;
}
onHandResults._landmarks = null;

function finishStroke() {
  if (activeStroke) {
    activeStroke.createdAt = STATE.frameCount; // stamp for fade timer
    activeStroke = null;
  }
}

// ─────────────────────────── SCORE ────────────────────────────────────
function addScore(n) {
  STATE.score += n;
  scoreEl.textContent = STATE.score;
}

// ─────────────────────────── PARTICLES ────────────────────────────────
class Particle {
  constructor(x, y, color, vx, vy, r, life) {
    Object.assign(this, { x, y, color, vx, vy, r, life, maxLife: life });
  }
  update() {
    this.x  += this.vx;
    this.y  += this.vy;
    this.vy += 0.18;
    this.vx *= 0.97;
    this.r   = Math.max(0, this.r * 0.975);
    this.life--;
  }
}

// Batch-draw all particles in one pass (reduce ctx state changes)
function drawParticles() {
  // group by approximate color to minimize state switches
  ctx.save();
  ctx.shadowBlur = 10;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.update();
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    const a = p.life / p.maxLife;
    ctx.globalAlpha = a;
    ctx.shadowColor = p.color;
    ctx.fillStyle   = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function addParticle(x, y, color, vx, vy, r, life) {
  if (particles.length < CFG.PARTICLE_MAX)
    particles.push(new Particle(x, y, color, vx, vy, r, life));
}

function spawnBurst(x, y, count, color) {
  for (let i = 0; i < count; i++) {
    const angle = rand(0, Math.PI * 2);
    const spd   = rand(2, 9);
    addParticle(
      x + rand(-10, 10), y + rand(-10, 10),
      Math.random() < 0.3 ? '#ffffff' : color,
      Math.cos(angle) * spd, Math.sin(angle) * spd,
      rand(2, 5.5), rand(25, 50)
    );
  }
}

function spawnMotionParticles(x, y, speed) {
  const n = Math.floor(speed * 0.3);
  for (let i = 0; i < n; i++) {
    addParticle(
      x + rand(-4, 4), y + rand(-4, 4),
      Math.random() < 0.5 ? '#00f5ff' : '#0080ff',
      rand(-1.5, 1.5), rand(-2, 0),
      rand(1.5, 4), rand(10, 24)
    );
  }
}

// ─────────────────────────── AMBIENT PARTICLES ────────────────────────
const ambients = Array.from({ length: 55 }, () => ({
  x:     rand(0, window.innerWidth),
  y:     rand(0, window.innerHeight),
  r:     rand(0.8, 2.4),
  spd:   rand(0.12, 0.55),
  drift: rand(-0.28, 0.28),
  alpha: rand(0.18, 0.55),
  hue:   Math.random() < 0.6 ? '#00f5ff' : '#7b2fff',
}));

function drawAmbients() {
  for (const p of ambients) {
    p.y -= p.spd;
    p.x += p.drift;
    if (p.y < -8) { p.y = H() + 8; p.x = rand(0, W()); }
    if (p.x < -8 || p.x > W() + 8) p.x = rand(0, W());
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.shadowBlur  = 8;
    ctx.shadowColor = p.hue;
    ctx.fillStyle   = p.hue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ─────────────────────────── TRAIL ────────────────────────────────────
function drawTrail() {
  // age out
  for (let i = trail.length - 1; i >= 0; i--)
    if (--trail[i].life <= 0) trail.splice(i, 1);

  if (trail.length < 2) return;

  for (let i = 1; i < trail.length; i++) {
    const p0 = trail[i - 1], p1 = trail[i];
    const t  = i / trail.length;
    const a  = (p1.life / CFG.TRAIL_LIFE) * t;
    const lw = clamp((p1.speed || 0) * 0.25 + 1.5, 1.5, 10);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#00f5ff';
    ctx.lineWidth   = lw;
    ctx.lineCap     = 'round';
    ctx.shadowBlur  = 20;
    ctx.shadowColor = '#00f5ff';
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    ctx.restore();
  }
}

// ─────────────────────────── DRAW STROKES ─────────────────────────────
function drawDrawStrokes() {
  for (let i = drawStrokes.length - 1; i >= 0; i--) {
    const s = drawStrokes[i];

    if (s !== activeStroke) {
      const age = STATE.frameCount - s.createdAt;
      if (age > CFG.DRAW_FADE_DELAY) s.alpha = Math.max(0, s.alpha - 0.016);
      if (s.alpha <= 0) { drawStrokes.splice(i, 1); continue; }
    }

    if (s.points.length < 2) continue;

    const isLive = s === activeStroke;
    ctx.save();
    ctx.globalAlpha = isLive ? 0.95 : s.alpha * 0.9;
    ctx.strokeStyle = '#00f5ff';
    ctx.lineWidth   = 3.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.shadowBlur  = 22;
    ctx.shadowColor = '#00f5ff';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let j = 1; j < s.points.length; j++) {
      const p   = s.points[j];
      const osc = !isLive ? Math.sin(STATE.frameCount * 0.04 + j * 0.3) * CFG.WOBBLE_AMP : 0;
      ctx.lineTo(p.x + osc, p.y + osc * 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }
}

// ─────────────────────────── FINGERTIP EMITTER ────────────────────────
function drawEmitter(tip) {
  const sc    = depthScale(tip.y);
  const pulse = 0.55 + 0.45 * Math.sin(STATE.frameCount * 0.18);

  // outer ring
  ctx.save();
  ctx.globalAlpha = pulse * 0.55;
  ctx.strokeStyle = '#00f5ff';
  ctx.lineWidth   = 1.5;
  ctx.shadowBlur  = 22;
  ctx.shadowColor = '#00f5ff';
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 28 * sc * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // dot
  ctx.save();
  ctx.fillStyle   = '#e0f7ff';
  ctx.shadowBlur  = 30;
  ctx.shadowColor = '#00f5ff';
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 5 * sc, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // crosshair
  const len = 14 * sc;
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = '#00f5ff';
  ctx.lineWidth   = 1;
  ctx.shadowBlur  = 8;
  ctx.shadowColor = '#00f5ff';
  ctx.beginPath();
  ctx.moveTo(tip.x - len, tip.y); ctx.lineTo(tip.x + len, tip.y);
  ctx.moveTo(tip.x, tip.y - len); ctx.lineTo(tip.x, tip.y + len);
  ctx.stroke();
  ctx.restore();
}

// ─────────────────────────── HAND SKELETON ────────────────────────────
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

function drawSkeleton(landmarks) {
  ctx.save();
  ctx.strokeStyle = 'rgba(0,128,255,0.38)';
  ctx.lineWidth   = 1.5;
  ctx.shadowBlur  = 8;
  ctx.shadowColor = '#0080ff';
  for (const [a, b] of CONNECTIONS) {
    const pa = lm(landmarks, a), pb = lm(landmarks, b);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  for (let i = 0; i < 21; i++) {
    const p  = lm(landmarks, i);
    const r  = i === 8 ? 5 : 3;
    ctx.fillStyle   = i === 8 ? '#00f5ff' : 'rgba(0,200,255,0.65)';
    ctx.shadowBlur  = i === 8 ? 24 : 7;
    ctx.shadowColor = '#00f5ff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─────────────────────────── FRUITS ───────────────────────────────────
const EMOJIS = ['🍉','🍊','🍋','🍇','🍓','🍑','🥝'];
const COLORS  = ['#ff4060','#ff8c00','#ffd700','#9b59b6','#e74c3c','#f39c12','#2ecc71'];

class Fruit {
  constructor() {
    const i   = Math.floor(Math.random() * EMOJIS.length);
    this.emoji = EMOJIS[i];
    this.color = COLORS[i];
    this.x     = rand(W() * 0.04, W() * 0.96);
    this.y     = rand(-120, -30);
    this.vx    = rand(-4.5, 4.5);
    this.vy    = rand(5.5, 9.5);           // fast fall
    this.rot   = 0;
    this.rotV  = rand(-0.08, 0.08);        // faster spin
    this.size  = rand(50, 80);
    this.wob   = Math.random() * Math.PI * 2;
    this.alive = true;
  }
  update() {
    this.vy   += 0.22;   // heavy gravity
    this.x    += this.vx;
    this.y    += this.vy;
    this.rot  += this.rotV;
    this.wob  += 0.06;
    if (this.y > H() + 130) this.alive = false;
  }
  draw() {
    const sc  = depthScale(this.y);
    const sz  = this.size * sc;
    // No save/restore + no shadowBlur per fruit = huge perf win in ninja mode
    ctx.globalAlpha    = 1;
    ctx.font           = `${sz}px serif`;
    ctx.textAlign      = 'center';
    ctx.textBaseline   = 'middle';
    ctx.fillText(this.emoji, this.x, this.y);

    // lightweight ring (no shadow)
    ctx.globalAlpha = 0.22 * sc;
    ctx.strokeStyle = this.color;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(this.x, this.y, sz * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function manageFruits() {
  if (STATE.mode === 'ninja') {
    if (++fruitTimer >= CFG.FRUIT_SPAWN_RATE && fruits.length < CFG.FRUIT_MAX) {
      // spawn a burst of N fruits at once
      const n = Math.min(CFG.FRUIT_BURST, CFG.FRUIT_MAX - fruits.length);
      for (let k = 0; k < n; k++) fruits.push(new Fruit());
      fruitTimer = 0;
    }
  } else {
    fruitTimer = 0;
  }
  for (let i = fruits.length - 1; i >= 0; i--) {
    fruits[i].update();
    if (!fruits[i].alive) { fruits.splice(i, 1); continue; }
    if (STATE.mode === 'ninja') fruits[i].draw();
  }
}

function checkSlice(tip) {
  for (let i = fruits.length - 1; i >= 0; i--) {
    const f  = fruits[i];
    const sc = depthScale(f.y);
    const r  = f.size * sc * 0.62;
    if (dist2(tip, f) < r + 32) {   // bigger hit radius
      spawnBurst(f.x, f.y, 55, f.color);
      addScore(10);
      showToast('⚔  SLICED!  +10', 900);
      fruits.splice(i, 1);
    }
  }
}

// ─────────────────────────── FPS COUNTER ──────────────────────────────
function tickFPS() {
  STATE.fpsFrames++;
  const now = performance.now();
  if (now - STATE.fpsTime >= 1000) {
    fpsEl.textContent = Math.round(STATE.fpsFrames * 1000 / (now - STATE.fpsTime)) + ' FPS';
    STATE.fpsFrames   = 0;
    STATE.fpsTime     = now;
  }
}

// ─────────────────────────── RENDER LOOP ──────────────────────────────
function render() {
  STATE.frameCount++;
  ctx.clearRect(0, 0, W() + 1, H() + 1);

  // 1. Ambient background particles
  drawAmbients();

  // 2. Draw strokes (draw mode light painting)
  if (drawStrokes.length) drawDrawStrokes();

  // 3. Fruits
  manageFruits();

  // 4. Hand overlay
  const landmarks = onHandResults._landmarks;
  if (STATE.tracking && landmarks) {
    const tip   = smoothTip || lm(landmarks, 8);
    const speed = Math.hypot(STATE.handVel.x, STATE.handVel.y);

    // Push trail point each frame
    trail.push({ x: tip.x, y: tip.y, life: CFG.TRAIL_LIFE, speed });
    if (trail.length > CFG.TRAIL_MAX) trail.shift();

    // Skeleton only in draw mode (too expensive + distracting in ninja)
    if (STATE.mode === 'draw') drawSkeleton(landmarks);

    drawTrail();
    drawEmitter(tip);

    if (speed > 6) spawnMotionParticles(tip.x, tip.y, speed);
  } else {
    drawTrail();
  }

  // 5. Particles (batched)
  drawParticles();

  tickFPS();
  requestAnimationFrame(render);
}

// ─────────────────────────── BOOT ─────────────────────────────────────
async function boot() {
  const steps = [
    'CONNECTING MEDIAPIPE...',
    'LOADING HAND MODEL...',
    'REQUESTING CAMERA ACCESS...',
    'CALIBRATING AR OVERLAY...',
    'LAUNCHING EXPERIENCE...',
  ];
  let si = 0;
  const iv = setInterval(() => {
    if (si < steps.length) loadStatEl.textContent = steps[si++];
    else clearInterval(iv);
  }, 450);

  // ★ Only init MediaPipe — no manual getUserMedia ★
  initMediaPipe();

  await new Promise(r => setTimeout(r, 2400));
  clearInterval(iv);
  loadingEl.classList.add('hidden');
  showToast('✦ POINT YOUR INDEX FINGER TO START', 3000);
  render();
}

boot();
