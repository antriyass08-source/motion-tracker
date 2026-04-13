/**
 * BLUE MOTION NINJA STUDIO — AR OVERLAY ENGINE v2.1
 * Fixes: draw stroke continuity, fist-toggle reliability
 */

'use strict';

// ─────────────────────────────── CONFIG ───────────────────────────────
const CFG = {
  TRAIL_MAX:          60,
  TRAIL_LIFE:         40,
  PARTICLE_MAX:       320,
  FRUIT_COUNT_MAX:    7,
  FRUIT_SPAWN_RATE:   110,    // frames
  SLICE_VEL_THRESH:   14,
  FIST_CONFIRM_FRAMES: 4,    // must hold fist for N consecutive frames
  FIST_COOLDOWN_MS:   900,   // ms cooldown between mode toggles
  DRAW_FADE_DELAY:    200,   // frames until stroke starts fading
  DEPTH_FACTOR:       0.55,
  WOBBLE_AMP:         1.8,
  DPR:                Math.min(window.devicePixelRatio || 1, 2),
};

// ─────────────────────────────── STATE ────────────────────────────────
const STATE = {
  mode:           'draw',
  score:          0,
  fistFrames:     0,      // consecutive fist frames
  lastToggleTime: 0,      // timestamp of last mode toggle
  frameCount:     0,
  fps:            60,
  fpsTime:        performance.now(),
  fpsFrames:      0,
  handVel:        { x: 0, y: 0 },
  lastTip:        null,
  isFist:         false,
};

// ─────────────────────────────── COLLECTIONS ──────────────────────────
const trail      = [];     // TrailPoint[]
const particles  = [];     // Particle[]
const drawStrokes = [];    // { points[], alpha, fading }
const fruits     = [];     // Fruit[]

let activeStroke  = null;  // the stroke being drawn RIGHT NOW
let fruitSpawnTimer = 0;

// ─────────────────────────────── DOM ──────────────────────────────────
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

// ─────────────────────────────── CANVAS RESIZE ────────────────────────
function resizeCanvas() {
  canvas.width        = window.innerWidth  * CFG.DPR;
  canvas.height       = window.innerHeight * CFG.DPR;
  canvas.style.width  = window.innerWidth  + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.scale(CFG.DPR, CFG.DPR);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const W = () => window.innerWidth;
const H = () => window.innerHeight;

// ─────────────────────────────── UTILS ────────────────────────────────
const lerp       = (a, b, t) => a + (b - a) * t;
const clamp      = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand       = (a, b) => a + Math.random() * (b - a);
const dist2      = (a, b) => { const dx = a.x-b.x, dy = a.y-b.y; return Math.sqrt(dx*dx+dy*dy); };
const depthScale = (y) => lerp(0.55, 1.3, clamp(y / H(), 0, 1));

let _toastTimer = null;
function showToast(msg, dur = 1600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
}

function updateScore(delta) {
  STATE.score += delta;
  scoreEl.textContent = STATE.score;
}

// ─────────────────────────────── CAMERA ───────────────────────────────
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
    showToast('⚠ Camera denied — check browser permissions', 3000);
    loadStatEl.textContent = 'CAMERA ERROR — ALLOW CAMERA ACCESS';
    console.error('Camera error:', e);
  }
}

// ─────────────────────────────── MEDIAPIPE ────────────────────────────
let handResults = null;

/** Normalized landmark → mirrored canvas pixel coord */
function lm(landmarks, idx) {
  const l = landmarks[idx];
  return { x: (1 - l.x) * W(), y: l.y * H() };
}

/**
 * Fist = all 4 finger MCP-to-tip distances are short.
 * We compare each fingertip to its corresponding base joint.
 */
function detectFist(landmarks) {
  // tip ids:  4(thumb), 8(index), 12(middle), 16(ring), 20(pinky)
  // base ids: 2(thumb), 5(index),  9(middle), 13(ring), 17(pinky)
  const pairs = [[8,6],[12,10],[16,14],[20,18]];
  let fistCount = 0;
  for (const [tip, base] of pairs) {
    const t = lm(landmarks, tip);
    const b = lm(landmarks, base);
    // tip is above (lower y) the base → finger is curled
    if (t.y > b.y) fistCount++;
  }
  return fistCount >= 3; // at least 3 of 4 fingers curled
}

function initHands() {
  const hands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
  });
  hands.setOptions({
    maxNumHands:            1,
    modelComplexity:        1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence:  0.6,
  });
  hands.onResults(onHandResults);

  const cam = new Camera(video, {
    onFrame: async () => { await hands.send({ image: video }); },
    width:  640,
    height: 480,
  });
  cam.start();
}

// ─────────────────────────────── HAND RESULTS ─────────────────────────
function onHandResults(results) {
  handResults = results;

  const detected = !!(results.multiHandLandmarks && results.multiHandLandmarks[0]);

  if (!detected) {
    // hand left frame — close active stroke
    if (activeStroke) { finaliseStroke(); }
    STATE.lastTip  = null;
    STATE.handVel  = { x: 0, y: 0 };
    STATE.isFist   = false;
    STATE.fistFrames = 0;
    return;
  }

  const landmarks  = results.multiHandLandmarks[0];
  const tip        = lm(landmarks, 8);  // index fingertip

  // ── velocity ──
  if (STATE.lastTip) {
    STATE.handVel.x = tip.x - STATE.lastTip.x;
    STATE.handVel.y = tip.y - STATE.lastTip.y;
  }
  STATE.lastTip = tip;

  // ── fist detection with N-frame confirmation ──
  const fistNow = detectFist(landmarks);
  if (fistNow) {
    STATE.fistFrames++;
  } else {
    STATE.fistFrames = 0;
  }

  const wasFist = STATE.isFist;
  STATE.isFist  = fistNow;

  // Toggle on leading edge of confirmed fist (first time fistFrames hits threshold)
  const now = performance.now();
  if (STATE.fistFrames === CFG.FIST_CONFIRM_FRAMES &&
      (now - STATE.lastToggleTime) > CFG.FIST_COOLDOWN_MS) {
    toggleMode();
    STATE.lastToggleTime = now;
  }

  // If hand is open (not fist), do finger actions
  if (!STATE.isFist) {
    // ── trail ──
    const speed = Math.hypot(STATE.handVel.x, STATE.handVel.y);
    trail.push({ x: tip.x, y: tip.y, life: CFG.TRAIL_LIFE, speed });

    // ── DRAW MODE: accumulate stroke ──
    if (STATE.mode === 'draw') {
      if (!activeStroke) {
        // start a new stroke
        activeStroke = { points: [], alpha: 1, fading: false };
        drawStrokes.push(activeStroke);
      }
      activeStroke.points.push({ x: tip.x, y: tip.y });
    }

    // ── NINJA MODE: slice check ──
    if (STATE.mode === 'ninja') {
      const speed2 = Math.hypot(STATE.handVel.x, STATE.handVel.y);
      if (speed2 > CFG.SLICE_VEL_THRESH) {
        checkSlice(tip);
      }
    }
  } else {
    // fist held — end current draw stroke
    if (activeStroke) { finaliseStroke(); }
  }
}

function finaliseStroke() {
  // mark it as complete so it starts fading
  if (activeStroke) {
    activeStroke.fading = false; // will begin fading via updateDrawStrokes timer
    activeStroke.createdAt = STATE.frameCount;
    activeStroke = null;
  }
}

// ─────────────────────────────── MODE TOGGLE ──────────────────────────
function toggleMode() {
  // close open draw stroke
  if (activeStroke) { finaliseStroke(); }

  STATE.mode = STATE.mode === 'draw' ? 'ninja' : 'draw';

  modeTagEl.className = 'mode-tag ' + STATE.mode;
  modeTagEl.textContent = STATE.mode === 'draw' ? 'DRAW MODE' : 'NINJA MODE';

  const isNinja = STATE.mode === 'ninja';
  showToast(isNinja ? '⚔  NINJA MODE' : '✦  DRAW MODE', 1800);
  triggerRipple(isNinja ? 'rgba(255,64,96,0.22)' : 'rgba(0,245,255,0.18)');
  spawnBurst(W() / 2, H() / 2, 80, isNinja ? '#ff4060' : '#00f5ff');
}

function triggerRipple(color) {
  rippleEl.style.background = `radial-gradient(circle at 50% 50%, ${color} 0%, transparent 72%)`;
  rippleEl.style.opacity = '1';
  setTimeout(() => { rippleEl.style.opacity = '0'; }, 400);
}

// ─────────────────────────────── PARTICLES ────────────────────────────
class Particle {
  constructor(x, y, color, vx, vy, size, life) {
    this.x = x; this.y = y;
    this.color = color;
    this.vx = vx; this.vy = vy;
    this.size = size;
    this.life = this.maxLife = life;
  }
  update() {
    this.x  += this.vx;
    this.y  += this.vy;
    this.vy += 0.18;  // gravity
    this.vx *= 0.97;
    this.life--;
    this.size = Math.max(0, this.size * 0.97);
  }
  draw() {
    const a = this.life / this.maxLife;
    ctx.save();
    ctx.globalAlpha = a;
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
    const spd   = rand(2, 9);
    particles.push(new Particle(
      x + rand(-10, 10), y + rand(-10, 10),
      Math.random() < 0.3 ? '#ffffff' : color,
      Math.cos(angle) * spd, Math.sin(angle) * spd,
      rand(2, 5.5), rand(25, 50)
    ));
  }
}

function spawnMotionParticles(x, y, speed) {
  if (particles.length >= CFG.PARTICLE_MAX) return;
  const n = Math.floor(speed * 0.3);
  for (let i = 0; i < n; i++) {
    particles.push(new Particle(
      x + rand(-4, 4), y + rand(-4, 4),
      Math.random() < 0.5 ? '#00f5ff' : '#0080ff',
      rand(-1.5, 1.5), rand(-2, 0),
      rand(1.5, 4), rand(10, 24)
    ));
  }
}

// ─────────────────────────────── AMBIENT PARTICLES ────────────────────
const ambients = Array.from({ length: 55 }, () => ({
  x:     Math.random() * window.innerWidth,
  y:     Math.random() * window.innerHeight,
  r:     rand(0.8, 2.4),
  spd:   rand(0.12, 0.55),
  drift: rand(-0.28, 0.28),
  alpha: rand(0.18, 0.55),
  hue:   Math.random() < 0.6 ? '#00f5ff' : '#7b2fff',
}));

function updateAndDrawAmbients() {
  for (const p of ambients) {
    p.y -= p.spd;
    p.x += p.drift;
    if (p.y < -8) { p.y = H() + 8; p.x = Math.random() * W(); }
    if (p.x < -8 || p.x > W() + 8) p.x = Math.random() * W();

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

// ─────────────────────────────── TRAIL ────────────────────────────────
function updateAndDrawTrail() {
  // age out
  for (let i = trail.length - 1; i >= 0; i--) {
    if (--trail[i].life <= 0) trail.splice(i, 1);
  }
  if (trail.length < 2) return;

  for (let i = 1; i < trail.length; i++) {
    const p0 = trail[i - 1], p1 = trail[i];
    const t   = i / trail.length;
    const alpha = (p1.life / CFG.TRAIL_LIFE) * t;
    const width = clamp((p1.speed || 0) * 0.22 + 1.5, 1.5, 9);

    ctx.save();
    ctx.globalAlpha  = alpha;
    ctx.strokeStyle  = '#00f5ff';
    ctx.lineWidth    = width;
    ctx.lineCap      = 'round';
    ctx.shadowBlur   = 20;
    ctx.shadowColor  = '#00f5ff';
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    ctx.restore();
  }
}

// ─────────────────────────────── DRAW STROKES ─────────────────────────
function updateAndDrawStrokes() {
  for (let i = drawStrokes.length - 1; i >= 0; i--) {
    const s = drawStrokes[i];

    // only start fading strokes that are complete (not the active one)
    if (s !== activeStroke) {
      const age = STATE.frameCount - (s.createdAt || 0);
      if (age > CFG.DRAW_FADE_DELAY) {
        s.alpha = Math.max(0, s.alpha - 0.018);
      }
      if (s.alpha <= 0) { drawStrokes.splice(i, 1); continue; }
    }

    if (s.points.length < 2) continue;

    const isLive = s === activeStroke;
    ctx.save();
    ctx.globalAlpha  = isLive ? 0.92 : s.alpha * 0.88;
    ctx.strokeStyle  = '#00f5ff';
    ctx.lineWidth    = 3.5;
    ctx.lineCap      = 'round';
    ctx.lineJoin     = 'round';
    ctx.shadowBlur   = 24;
    ctx.shadowColor  = '#00f5ff';

    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let j = 1; j < s.points.length; j++) {
      const p = s.points[j];
      // organic oscillation
      const osc = !isLive ? Math.sin(STATE.frameCount * 0.04 + j * 0.3) * CFG.WOBBLE_AMP : 0;
      ctx.lineTo(p.x + osc, p.y + osc * 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }
}

// ─────────────────────────────── FINGERTIP EMITTER ────────────────────
function drawFingertipEmitter(tip) {
  const sc    = depthScale(tip.y);
  const pulse = 0.55 + 0.45 * Math.sin(STATE.frameCount * 0.18);

  // outer pulse ring
  ctx.save();
  ctx.globalAlpha  = pulse * 0.55;
  ctx.strokeStyle  = '#00f5ff';
  ctx.lineWidth    = 1.5;
  ctx.shadowBlur   = 22;
  ctx.shadowColor  = '#00f5ff';
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

  // crosshair
  ctx.save();
  ctx.globalAlpha  = 0.4;
  ctx.strokeStyle  = '#00f5ff';
  ctx.lineWidth    = 1;
  ctx.shadowBlur   = 8;
  ctx.shadowColor  = '#00f5ff';
  const len = 14 * sc;
  ctx.beginPath();
  ctx.moveTo(tip.x - len, tip.y); ctx.lineTo(tip.x + len, tip.y);
  ctx.moveTo(tip.x, tip.y - len); ctx.lineTo(tip.x, tip.y + len);
  ctx.stroke();
  ctx.restore();
}

// ─────────────────────────────── FRUITS ───────────────────────────────
const EMOJIS = ['🍉','🍊','🍋','🍇','🍓','🍑','🥝'];
const COLORS  = ['#ff4060','#ff8c00','#ffd700','#9b59b6','#e74c3c','#f39c12','#2ecc71'];

class Fruit {
  constructor() {
    const idx      = Math.floor(Math.random() * EMOJIS.length);
    this.emoji     = EMOJIS[idx];
    this.color     = COLORS[idx];
    this.x         = rand(W() * 0.08, W() * 0.92);
    this.y         = -80;
    this.vx        = rand(-2, 2);
    this.vy        = rand(1.4, 3.2);
    this.rot       = 0;
    this.rotV      = rand(-0.05, 0.05);
    this.baseSize  = rand(48, 70);
    this.wobble    = Math.random() * Math.PI * 2;
    this.alive     = true;
  }
  update() {
    this.vy     += 0.07;
    this.x      += this.vx;
    this.y      += this.vy;
    this.rot    += this.rotV;
    this.wobble += 0.06;
    if (this.y > H() + 130) this.alive = false;
  }
  draw() {
    const sc  = depthScale(this.y);
    const sz  = this.baseSize * sc;
    const wbx = Math.sin(this.wobble) * CFG.WOBBLE_AMP;
    const wby = Math.cos(this.wobble * 0.7) * CFG.WOBBLE_AMP * 0.5;

    ctx.save();
    ctx.translate(this.x + wbx, this.y + wby);
    ctx.rotate(this.rot);
    ctx.shadowBlur  = 28 * sc;
    ctx.shadowColor = this.color + 'aa';
    ctx.font        = `${sz}px serif`;
    ctx.textAlign   = 'center';
    ctx.textBaseline= 'middle';
    ctx.fillText(this.emoji, 0, 0);

    // AR ring
    ctx.globalAlpha = 0.28 * sc;
    ctx.strokeStyle = this.color;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(0, 0, sz * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function manageFruits() {
  if (STATE.mode === 'ninja') {
    fruitSpawnTimer++;
    if (fruitSpawnTimer >= CFG.FRUIT_SPAWN_RATE && fruits.length < CFG.FRUIT_COUNT_MAX) {
      fruits.push(new Fruit());
      fruitSpawnTimer = 0;
    }
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
    const r  = f.baseSize * sc * 0.6;
    if (dist2(tip, f) < r + 18) {
      spawnBurst(f.x, f.y, 55, f.color);
      updateScore(10);
      showToast('⚔  SLICED!  +10', 900);
      fruits.splice(i, 1);
    }
  }
}

// ─────────────────────────────── HAND SKELETON ────────────────────────
function drawHandSkeleton(landmarks) {
  const CONN = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
  ];
  ctx.save();
  ctx.strokeStyle = 'rgba(0,128,255,0.38)';
  ctx.lineWidth   = 1.5;
  ctx.shadowBlur  = 8;
  ctx.shadowColor = '#0080ff';
  for (const [a, b] of CONN) {
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
    ctx.shadowBlur  = i === 8 ? 22 : 7;
    ctx.shadowColor = '#00f5ff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─────────────────────────────── FPS ──────────────────────────────────
function tickFPS() {
  STATE.fpsFrames++;
  const now = performance.now();
  if (now - STATE.fpsTime >= 1000) {
    STATE.fps       = Math.round(STATE.fpsFrames * 1000 / (now - STATE.fpsTime));
    STATE.fpsFrames = 0;
    STATE.fpsTime   = now;
    fpsEl.textContent = STATE.fps + ' FPS';
  }
}

// ─────────────────────────────── RENDER LOOP ──────────────────────────
function render() {
  STATE.frameCount++;

  ctx.clearRect(0, 0, W() * CFG.DPR, H() * CFG.DPR);

  // 1. ambient floating particles
  updateAndDrawAmbients();

  // 2. persistent draw strokes
  if (drawStrokes.length) updateAndDrawStrokes();

  // 3. fruits (ninja mode)
  manageFruits();

  // 4. motion trail
  updateAndDrawTrail();

  // 5. hand overlay
  if (handResults?.multiHandLandmarks?.[0]) {
    const landmarks = handResults.multiHandLandmarks[0];
    drawHandSkeleton(landmarks);

    if (!STATE.isFist) {
      const tip   = lm(landmarks, 8);
      const speed = Math.hypot(STATE.handVel.x, STATE.handVel.y);
      drawFingertipEmitter(tip);
      if (speed > 5) spawnMotionParticles(tip.x, tip.y, speed);
    }
  }

  // 6. particle system
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    if (particles[i].life <= 0) { particles.splice(i, 1); continue; }
    particles[i].draw();
  }

  tickFPS();
  requestAnimationFrame(render);
}

// ─────────────────────────────── BOOT ─────────────────────────────────
async function boot() {
  const steps = [
    'INITIALIZING CAMERA...',
    'LOADING AR ENGINE...',
    'CONNECTING MEDIAPIPE...',
    'CALIBRATING HAND TRACKING...',
    'LAUNCHING EXPERIENCE...',
  ];
  let si = 0;
  const iv = setInterval(() => {
    if (si < steps.length) loadStatEl.textContent = steps[si++];
    else clearInterval(iv);
  }, 420);

  await startCamera();
  await new Promise(r => setTimeout(r, 500));
  initHands();
  await new Promise(r => setTimeout(r, 2100));
  clearInterval(iv);
  loadingEl.classList.add('hidden');
  showToast('✦ OPEN PALM = DRAW  |  ✊ FIST = TOGGLE MODE', 3500);
  render();
}

boot();
