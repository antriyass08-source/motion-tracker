/**
 * BLUE MOTION NINJA STUDIO — AR OVERLAY ENGINE
 * MediaPipe Hands + Canvas AR Simulation
 * GitHub Pages deployable, pure browser
 */

'use strict';

// ───────────────────────────── CONFIG ─────────────────────────────
const CFG = {
  TRAIL_MAX:         64,
  TRAIL_LIFE:        42,  // frames trail point lives
  PARTICLE_MAX:      320,
  FRUIT_COUNT_MAX:   7,
  FRUIT_SPAWN_RATE:  100, // frames between spawns
  SLICE_VEL_THRESH:  18,  // px/frame to trigger slice
  FIST_COOLDOWN:     38,  // frames cooldown for mode toggle
  DRAW_FADE_DELAY:   260, // frames before draw stroke fades
  DEPTH_FACTOR:      0.55,// how much y-pos affects scale
  WOBBLE_AMP:        1.8, // px wobble amplitude on fruits
  CANVAS_DPR:        Math.min(window.devicePixelRatio || 1, 2),
};

// ───────────────────────────── STATE ──────────────────────────────
const STATE = {
  mode:       'draw',     // 'draw' | 'ninja'
  score:      0,
  paused:     false,
  gestCooldown: 0,
  frameCount: 0,
  fps:        60,
  fpsTime:    performance.now(),
  fpsFrames:  0,
  handVel:    { x: 0, y: 0 },
  lastTip:    null,       // last index fingertip pos
  isFist:     false,
  prevFist:   false,
};

// ───────────────────────────── COLLECTIONS ────────────────────────
/** @type {TrailPoint[]} */
const trail = [];
/** @type {Particle[]} */
const particles = [];
/** @type {DrawStroke[]} */
const drawStrokes = [];
/** @type {Fruit[]} */
const fruits = [];

// ───────────────────────────── DOM ────────────────────────────────
const video      = document.getElementById('webcam');
const canvas     = document.getElementById('ar-canvas');
const ctx        = canvas.getContext('2d');
const scoreEl    = document.getElementById('score-val');
const modeTagEl  = document.getElementById('mode-tag');
const fpsEl      = document.getElementById('fps-counter');
const toastEl    = document.getElementById('toast');
const loadingEl  = document.getElementById('loading-screen');
const loadStatEl = document.getElementById('load-status');
const rippleEl   = document.getElementById('ripple-overlay');

// ───────────────────────────── RESIZE ─────────────────────────────
function resizeCanvas() {
  const dpr = CFG.CANVAS_DPR;
  canvas.width  = window.innerWidth  * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width  = window.innerWidth  + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.scale(dpr, dpr);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const W = () => window.innerWidth;
const H = () => window.innerHeight;

// ───────────────────────────── UTILS ──────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function randBetween(a, b) { return a + Math.random() * (b - a); }
function dist(a, b) { const dx = a.x-b.x, dy = a.y-b.y; return Math.sqrt(dx*dx+dy*dy); }

/** Depth scale 0-1 float based on y position (top=far, bottom=near) */
function depthScale(y) {
  const t = clamp(y / H(), 0, 1);
  return lerp(0.55, 1.28, t);
}

function showToast(msg, dur = 1600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), dur);
}

function updateScore(delta) {
  STATE.score += delta;
  scoreEl.textContent = STATE.score;
}

// ───────────────────────────── CAMERA ─────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = r; });
    await video.play();
  } catch (e) {
    showToast('Camera denied ✕');
    console.error('Camera error', e);
  }
}

// ───────────────────────────── MEDIAPIPE HANDS ────────────────────
let hands = null;
let handResults = null;

function initHands() {
  hands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.72,
    minTrackingConfidence: 0.65,
  });
  hands.onResults(onHandResults);

  const camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width: 640,
    height: 480,
  });
  camera.start();
}

/** Convert normalized (0-1) landmark to canvas coords (mirrored) */
function lmToCanvas(lm) {
  // video is CSS mirrored (scaleX(-1))
  return { x: (1 - lm.x) * W(), y: lm.y * H() };
}

/**
 * Detect if hand is a fist.  Sum of distances of finger tips to palm.
 */
function detectFist(landmarks) {
  if (!landmarks) return false;
  const palm    = lmToCanvas(landmarks[0]);
  const tipIds  = [8, 12, 16, 20];
  let sum = 0;
  for (const id of tipIds) {
    const t = lmToCanvas(landmarks[id]);
    sum += dist(palm, t);
  }
  const avg = sum / tipIds.length;
  return avg < H() * 0.15;
}

function onHandResults(results) {
  handResults = results;
  if (!results.multiHandLandmarks || !results.multiHandLandmarks[0]) {
    STATE.lastTip = null;
    STATE.isFist  = false;
    return;
  }

  const lms  = results.multiHandLandmarks[0];
  const tip  = lmToCanvas(lms[8]); // index fingertip
  const mTip = lmToCanvas(lms[12]);

  // Velocity
  if (STATE.lastTip) {
    STATE.handVel.x = tip.x - STATE.lastTip.x;
    STATE.handVel.y = tip.y - STATE.lastTip.y;
  } else {
    STATE.handVel = { x: 0, y: 0 };
  }

  // Fist check
  STATE.prevFist = STATE.isFist;
  STATE.isFist   = detectFist(lms);

  // Fist toggle mode
  if (STATE.isFist && !STATE.prevFist && STATE.gestCooldown === 0) {
    toggleMode();
    STATE.gestCooldown = CFG.FIST_COOLDOWN;
  }

  // Record trail if not fist
  if (!STATE.isFist) {
    trail.push({ x: tip.x, y: tip.y, life: CFG.TRAIL_LIFE, speed: Math.hypot(STATE.handVel.x, STATE.handVel.y) });
    if (trail.length > CFG.TRAIL_MAX) trail.shift();

    // Draw mode — accumulate stroke
    if (STATE.mode === 'draw') {
      const last = drawStrokes[drawStrokes.length - 1];
      if (last && last.age === 0) {
        last.points.push({ x: tip.x, y: tip.y });
      } else {
        drawStrokes.push({ points: [{ x: tip.x, y: tip.y }], age: 0, alpha: 1 });
      }
    }

    // Ninja — check slice
    if (STATE.mode === 'ninja') {
      const speed = Math.hypot(STATE.handVel.x, STATE.handVel.y);
      if (speed > CFG.SLICE_VEL_THRESH) {
        checkSlice(tip, mTip);
      }
    }
  }

  STATE.lastTip = tip;
}

// ───────────────────────────── MODE TOGGLE ────────────────────────
function toggleMode() {
  STATE.mode = STATE.mode === 'draw' ? 'ninja' : 'draw';
  modeTagEl.className = 'mode-tag ' + STATE.mode;
  modeTagEl.textContent = STATE.mode === 'draw' ? 'DRAW MODE' : 'NINJA MODE';
  showToast(STATE.mode === 'draw' ? '✦ DRAW MODE' : '⚔ NINJA MODE', 1800);
  triggerRipple();
  spawnBurst(W() / 2, H() / 2, 80, STATE.mode === 'ninja' ? '#ff4060' : '#00f5ff');
}

function triggerRipple() {
  rippleEl.style.opacity = '1';
  rippleEl.style.background = STATE.mode === 'ninja'
    ? 'radial-gradient(circle at 50% 50%, rgba(255,64,96,0.22) 0%, transparent 72%)'
    : 'radial-gradient(circle at 50% 50%, rgba(0,245,255,0.18) 0%, transparent 72%)';
  setTimeout(() => { rippleEl.style.opacity = '0'; }, 380);
}

// ───────────────────────────── PARTICLES ──────────────────────────
class Particle {
  constructor(x, y, color, vx, vy, size, life) {
    this.x    = x; this.y = y;
    this.color = color;
    this.vx   = vx; this.vy = vy;
    this.size = size;
    this.life = life;
    this.maxLife = life;
    this.alpha = 1;
    this.gravity = 0.18;
  }
  update() {
    this.x  += this.vx;
    this.y  += this.vy;
    this.vy += this.gravity;
    this.vx *= 0.97;
    this.life--;
    this.alpha = Math.max(0, this.life / this.maxLife);
    this.size  = Math.max(0, this.size * 0.97);
  }
  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.shadowBlur  = 14;
    ctx.shadowColor = this.color;
    ctx.fillStyle   = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function spawnBurst(x, y, count, color) {
  for (let i = 0; i < count && particles.length < CFG.PARTICLE_MAX; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = randBetween(2, 9);
    const col = Math.random() < 0.3 ? '#ffffff' : color;
    particles.push(new Particle(
      x + randBetween(-10, 10),
      y + randBetween(-10, 10),
      col,
      Math.cos(angle) * speed,
      Math.sin(angle) * speed,
      randBetween(2, 5.5),
      randBetween(28, 52)
    ));
  }
}

function spawnMotionParticles(x, y, speed) {
  if (particles.length >= CFG.PARTICLE_MAX) return;
  const count = Math.floor(speed * 0.35);
  for (let i = 0; i < count; i++) {
    particles.push(new Particle(
      x + randBetween(-4, 4),
      y + randBetween(-4, 4),
      Math.random() < 0.5 ? '#00f5ff' : '#0080ff',
      randBetween(-1.5, 1.5),
      randBetween(-2.0, 0),
      randBetween(1.5, 4),
      randBetween(12, 26)
    ));
  }
}

// ───────────────────────────── AMBIENT PARTICLES ──────────────────
const ambients = [];
for (let i = 0; i < 55; i++) {
  ambients.push({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: randBetween(0.8, 2.4),
    spd: randBetween(0.12, 0.55),
    drift: randBetween(-0.28, 0.28),
    alpha: randBetween(0.18, 0.55),
    hue: Math.random() < 0.6 ? '#00f5ff' : '#7b2fff',
  });
}

function updateAmbients() {
  for (const p of ambients) {
    p.y -= p.spd;
    p.x += p.drift;
    if (p.y < -8) { p.y = H() + 8; p.x = Math.random() * W(); }
    if (p.x < -8 || p.x > W() + 8) { p.x = Math.random() * W(); }
  }
}

function drawAmbients() {
  for (const p of ambients) {
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.shadowBlur  = 10;
    ctx.shadowColor = p.hue;
    ctx.fillStyle   = p.hue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ───────────────────────────── TRAIL ──────────────────────────────
function updateTrail() {
  for (let i = trail.length - 1; i >= 0; i--) {
    trail[i].life--;
    if (trail[i].life <= 0) trail.splice(i, 1);
  }
}

function drawTrail() {
  if (trail.length < 2) return;
  for (let i = 1; i < trail.length; i++) {
    const p0 = trail[i - 1];
    const p1 = trail[i];
    const t  = i / trail.length;
    const speed = p1.speed || 0;
    const thickness = clamp(speed * 0.22 + 1.5, 1.5, 8);
    const alpha = (p1.life / CFG.TRAIL_LIFE) * t;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.strokeStyle = `rgba(0,245,255,${alpha.toFixed(3)})`;
    ctx.lineWidth = thickness;
    ctx.lineCap   = 'round';
    ctx.shadowBlur  = 18;
    ctx.shadowColor = '#00f5ff';
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.restore();
  }
}

// ───────────────────────────── DRAW MODE ──────────────────────────
function updateDrawStrokes() {
  for (let i = drawStrokes.length - 1; i >= 0; i--) {
    const s = drawStrokes[i];
    s.age++;
    if (s.age > CFG.DRAW_FADE_DELAY) {
      s.alpha = Math.max(0, s.alpha - 0.02);
    }
    if (s.alpha <= 0) drawStrokes.splice(i, 1);
  }
}

function drawDrawStrokes() {
  for (const stroke of drawStrokes) {
    if (stroke.points.length < 2) continue;
    ctx.save();
    ctx.globalAlpha = stroke.alpha * 0.88;
    ctx.strokeStyle = '#00f5ff';
    ctx.lineWidth   = 3.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.shadowBlur  = 22;
    ctx.shadowColor = '#00f5ff';

    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      // slight oscillation for organic AR feel
      const osc = Math.sin(STATE.frameCount * 0.04 + i * 0.3) * CFG.WOBBLE_AMP;
      ctx.lineTo(p.x + osc, p.y + osc * 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }
}

// ───────────────────────────── FINGERTIP EMITTER ──────────────────
function drawFingertipEmitter(tip) {
  if (!tip) return;
  const sc = depthScale(tip.y);

  // outer pulse ring
  ctx.save();
  const pulse = 0.55 + 0.45 * Math.sin(STATE.frameCount * 0.18);
  ctx.globalAlpha = pulse * 0.55;
  ctx.strokeStyle = '#00f5ff';
  ctx.lineWidth   = 1.5;
  ctx.shadowBlur  = 20;
  ctx.shadowColor = '#00f5ff';
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 26 * sc * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // inner dot
  ctx.save();
  ctx.fillStyle   = '#e0f7ff';
  ctx.shadowBlur  = 28;
  ctx.shadowColor = '#00f5ff';
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 5 * sc, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // cross-hair lines
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = '#00f5ff';
  ctx.lineWidth   = 1;
  ctx.shadowBlur  = 8;
  ctx.shadowColor = '#00f5ff';
  const len = 14 * sc;
  ctx.beginPath();
  ctx.moveTo(tip.x - len, tip.y); ctx.lineTo(tip.x + len, tip.y);
  ctx.moveTo(tip.x, tip.y - len); ctx.lineTo(tip.x, tip.y + len);
  ctx.stroke();
  ctx.restore();
}

// ───────────────────────────── FRUITS ─────────────────────────────
const FRUIT_EMOJIS  = ['🍉', '🍊', '🍋', '🍇', '🍓', '🍑', '🥝'];
const FRUIT_COLORS  = ['#ff406088', '#ff8c00aa', '#ffd700aa', '#9b59b6aa', '#e74c3caa', '#f39c12aa', '#2ecc71aa'];
let   fruitSpawnTimer = 0;

class Fruit {
  constructor() {
    this.eid   = FRUIT_EMOJIS[Math.floor(Math.random() * FRUIT_EMOJIS.length)];
    this.color = FRUIT_COLORS[Math.floor(Math.random() * FRUIT_COLORS.length)];
    this.x     = randBetween(W() * 0.08, W() * 0.92);
    this.y     = -80;
    this.vx    = randBetween(-1.8, 1.8);
    this.vy    = randBetween(1.4, 3.2);
    this.rot   = 0;
    this.rotV  = randBetween(-0.04, 0.04);
    this.baseSize = randBetween(46, 68);
    this.sliced= false;
    this.alive = true;
    this.wobblePhase = Math.random() * Math.PI * 2;
  }
  update() {
    this.vy  += 0.07; // gravity
    this.x   += this.vx;
    this.y   += this.vy;
    this.rot += this.rotV;
    this.wobblePhase += 0.06;
    if (this.y > H() + 120) this.alive = false;
  }
  draw(ctx) {
    const sc  = depthScale(this.y);
    const sz  = this.baseSize * sc;
    const wobX = Math.sin(this.wobblePhase) * CFG.WOBBLE_AMP;
    const wobY = Math.cos(this.wobblePhase * 0.7) * CFG.WOBBLE_AMP * 0.5;

    ctx.save();
    ctx.translate(this.x + wobX, this.y + wobY);
    ctx.rotate(this.rot);

    // depth glow halo
    ctx.shadowBlur  = 28 * sc;
    ctx.shadowColor = this.color;

    ctx.font = `${sz}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.eid, 0, 0);

    // subtle AR outline ring
    ctx.globalAlpha = 0.28 * sc;
    ctx.strokeStyle = this.color;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(0, 0, sz * 0.62, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }
}

function spawnFruit() {
  if (fruits.length < CFG.FRUIT_COUNT_MAX) fruits.push(new Fruit());
}

function updateFruits() {
  fruitSpawnTimer++;
  if (fruitSpawnTimer >= CFG.FRUIT_SPAWN_RATE && STATE.mode === 'ninja') {
    spawnFruit();
    fruitSpawnTimer = 0;
  }
  for (let i = fruits.length - 1; i >= 0; i--) {
    fruits[i].update();
    if (!fruits[i].alive) fruits.splice(i, 1);
  }
}

function drawFruits() {
  for (const f of fruits) f.draw(ctx);
}

function checkSlice(tipA, tipB) {
  for (let i = fruits.length - 1; i >= 0; i--) {
    const f   = fruits[i];
    const sc  = depthScale(f.y);
    const r   = f.baseSize * sc * 0.55;
    const d   = dist(tipA, f);
    if (d < r + 20) {
      sliceFruit(i);
    }
  }
}

function sliceFruit(idx) {
  const f = fruits[idx];
  spawnBurst(f.x, f.y, 55, f.color.substring(0, 7));
  updateScore(10);
  showToast('⚔ SLICED! +10', 900);
  fruits.splice(idx, 1);
}

// ───────────────────────────── HAND SKELETON ──────────────────────
function drawHandSkeleton(landmarks) {
  const connections = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
  ];

  ctx.save();
  ctx.strokeStyle = 'rgba(0,128,255,0.42)';
  ctx.lineWidth   = 1.5;
  ctx.shadowBlur  = 10;
  ctx.shadowColor = '#0080ff';
  for (const [a, b] of connections) {
    const pa = lmToCanvas(landmarks[a]);
    const pb = lmToCanvas(landmarks[b]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // joints
  for (let i = 0; i < 21; i++) {
    const p  = lmToCanvas(landmarks[i]);
    const sz = i === 8 ? 5 : 3;
    ctx.fillStyle   = i === 8 ? '#00f5ff' : 'rgba(0,200,255,0.65)';
    ctx.shadowBlur  = i === 8 ? 22 : 8;
    ctx.shadowColor = '#00f5ff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ───────────────────────────── FRAME LOOP ─────────────────────────
function updateFPS() {
  STATE.fpsFrames++;
  const now = performance.now();
  const dt  = now - STATE.fpsTime;
  if (dt >= 1000) {
    STATE.fps     = Math.round(STATE.fpsFrames * 1000 / dt);
    STATE.fpsFrames = 0;
    STATE.fpsTime   = now;
    fpsEl.textContent = `${STATE.fps} FPS`;
  }
}

function clearCanvas() {
  ctx.clearRect(0, 0, W() * CFG.CANVAS_DPR, H() * CFG.CANVAS_DPR);
}

function render() {
  STATE.frameCount++;

  // cooldowns
  if (STATE.gestCooldown > 0) STATE.gestCooldown--;

  clearCanvas();

  // AMBIENT
  updateAmbients();
  drawAmbients();

  // DRAW STROKES (draw mode persistent light painting)
  if (STATE.mode === 'draw') {
    updateDrawStrokes();
    drawDrawStrokes();
  }

  // FRUITS (ninja mode)
  updateFruits();
  if (STATE.mode === 'ninja') drawFruits();

  // TRAIL
  updateTrail();
  drawTrail();

  // HAND (if tracking active)
  if (handResults?.multiHandLandmarks?.[0]) {
    const lms = handResults.multiHandLandmarks[0];
    drawHandSkeleton(lms);
    const tip = lmToCanvas(lms[8]);

    // Fingertip emitter
    if (!STATE.isFist) drawFingertipEmitter(tip);

    // Motion particles from fingertip
    const spd = Math.hypot(STATE.handVel.x, STATE.handVel.y);
    if (spd > 5 && !STATE.isFist) {
      spawnMotionParticles(tip.x, tip.y, spd);
    }
  }

  // PARTICLES
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    if (particles[i].life <= 0) { particles.splice(i, 1); continue; }
    particles[i].draw(ctx);
  }

  updateFPS();
  requestAnimationFrame(render);
}

// ───────────────────────────── BOOT ───────────────────────────────
async function boot() {
  // Loading sequence
  const steps = [
    'INITIALIZING CAMERA...',
    'LOADING AR ENGINE...',
    'CONNECTING MEDIAPIPE...',
    'CALIBRATING HAND TRACKING...',
    'LAUNCHING EXPERIENCE...',
  ];
  let si = 0;
  const stepInterval = setInterval(() => {
    if (si < steps.length) { loadStatEl.textContent = steps[si++]; }
    else clearInterval(stepInterval);
  }, 440);

  await startCamera();
  await new Promise(r => setTimeout(r, 500));
  initHands();

  await new Promise(r => setTimeout(r, 2200));
  clearInterval(stepInterval);
  loadingEl.classList.add('hidden');

  showToast('✦ WELCOME — FIST TO TOGGLE MODE', 3000);

  render();
}

boot();
