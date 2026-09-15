document.documentElement.classList.add('js');

const progressFill = document.getElementById('progress-fill');
const journey = document.getElementById('journey');
const scroller = document.getElementById('scroller');
const masterplanScene = document.getElementById('scene-masterplan');

// ---- one-swipe paging ----
// A short swipe immediately animates a full scene, instead of the browser's own drag-then-settle.
const SWIPE_MIN = 30;
const PAGE_DURATION = 0.7;

// Scene pairs that play a rendered camera move instead of a slide. Each clip is
// pre-sped to PAGE_DURATION; the backward clips are the same move reversed.
const TRANSITIONS = {
  'scene-facade-day>scene-facade-close': 't1-fwd',
  'scene-facade-close>scene-facade-day': 't1-rev',
  'scene-facade-close>scene-entrance': 't2-fwd',
  'scene-entrance>scene-facade-close': 't2-rev',
  'scene-entrance>scene-interior': 't3-fwd',
  'scene-interior>scene-entrance': 't3-rev',
};
// If the clip hasn't shown a frame this quickly, slide instead so the swipe never waits.
const TRANSITION_START_TIMEOUT_MS = 300;
const TRANSITION_FADE_MS = 130; // just over the 0.12s CSS dissolve on .transition-video

let paging = false;
let pageTl = null;
let activeClip = null;
// True while a sideways drag (interior pan, courtyard day/night) holds the finger,
// so the same gesture can't also change scene.
let sideDragActive = false;
let activeScene = document.getElementById('scene-logo');

// Warm each clip's decoder on the visitor's first touch or click, so its first
// frame appears instantly on swipe. iOS often skips preloading until a gesture.
let clipsWarmed = false;
function warmTransitionClips() {
  // Each listener below is `once` on its own, so guard against the other two firing later.
  if (clipsWarmed) return;
  clipsWarmed = true;
  for (const id of new Set(Object.values(TRANSITIONS))) {
    const clip = document.getElementById(id);
    if (!clip) continue;
    if (clip.readyState < 2) clip.load();
    clip.play().then(() => {
      // Leave it running only if a transition started using this exact clip meanwhile.
      if (clip !== activeClip) { clip.pause(); clip.currentTime = 0; }
    }).catch(() => {});
  }
}
['touchstart', 'pointerdown', 'keydown'].forEach(evt =>
  window.addEventListener(evt, warmTransitionClips, { once: true, passive: true })
);

// Pull-to-refresh only on the first screen: there the browser keeps its own
// downward pull; on every other scene paging owns all touch gestures.
function updateNativeGestures() {
  const onFirst = activeScene.id === 'scene-logo';
  scroller.style.touchAction = onFirst ? 'pan-y' : 'none';
  scroller.style.overscrollBehaviorY = onFirst ? 'auto' : 'none';
  // iOS Safari only offers pull-to-refresh when the page itself can bounce.
  for (const el of [document.documentElement, document.body]) {
    el.style.overscrollBehaviorY = onFirst ? 'auto' : 'none';
    el.style.overflow = onFirst ? 'visible' : '';
  }
}

// Scenes inside a hidden #journey have no layout boxes, so they drop out.
const visibleScenes = () =>
  [...scroller.querySelectorAll('.scene')].filter(s => s.getClientRects().length);

const sceneVideos = scene => [...scene.querySelectorAll('video.bg')];

function onFirstFrame(video, cb) {
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => cb());
  else {
    // No frame signal: wait until a frame is ready; stop if the video gets paused.
    const check = () => {
      if (video.paused) return;
      if (video.readyState >= 2) cb();
      else setTimeout(check, 30);
    };
    setTimeout(check, 30);
  }
}

// Only the scene on screen decodes its video, so phones never run several at once.
function pauseOtherVideos(target) {
  const keep = sceneVideos(target);
  scroller.querySelectorAll('video.bg').forEach(v => { if (!keep.includes(v)) v.pause(); });
}

// Marks the scene as current: text rises in, the progress rail shows its number
// out of 10, and scene-specific code hears 'scene:enter'.
function setActive(target) {
  scroller.querySelectorAll('.scene.is-active').forEach(s => { if (s !== target) s.classList.remove('is-active'); });
  target.classList.add('is-active');
  progressFill.style.transform = 'scaleX(' + (+target.dataset.n || 0) / 10 + ')';
  target.dispatchEvent(new CustomEvent('scene:enter'));
}

function slideTo(target) {
  sceneVideos(target).forEach(v => { if (v.paused) v.play().catch(() => {}); });

  if (typeof gsap === 'undefined') {
    scroller.scrollTop = target.offsetTop;
    pauseOtherVideos(target);
    paging = false;
    return;
  }
  const pos = { y: scroller.scrollTop };
  pageTl = gsap.timeline({
    onComplete: () => { paging = false; pageTl = null; pauseOtherVideos(target); },
  });
  pageTl.to(pos, {
    y: target.offsetTop,
    duration: PAGE_DURATION,
    ease: 'power3.inOut',
    onUpdate: () => { scroller.scrollTop = pos.y; },
  });
}

function playTransition(clip, target) {
  const arrivingVideos = sceneVideos(target);
  let started = false;
  let done = false;
  activeClip = clip;

  const finish = () => {
    if (done) return;
    done = true;
    arrivingVideos.forEach(v => v.play().catch(() => {}));
    clip.classList.remove('playing');
    // Pause only after the dissolve, so the clip holds its last frame while fading out.
    setTimeout(() => { if (activeClip !== clip) clip.pause(); }, TRANSITION_FADE_MS);
    // Safe to drop now: the bar's glide already under way keeps its original timing.
    document.body.classList.remove('in-transition');
    activeClip = null;
    paging = false;
  };

  const fallBack = () => {
    started = true;
    clearTimeout(giveUp);
    clip.pause();
    activeClip = null;
    slideTo(target);
  };

  // If the clip can't start in time (slow network, refused play), fall back to a normal slide.
  const giveUp = setTimeout(() => { if (!started) fallBack(); }, TRANSITION_START_TIMEOUT_MS);

  clip.currentTime = 0;
  clip.play()
    .then(() => onFirstFrame(clip, () => {
      if (started) return;
      started = true;
      clearTimeout(giveUp);
      clip.classList.add('playing');
      document.body.classList.add('in-transition');
      // Once the clip fully covers the screen, move the page behind it, park the
      // arriving scene's video on its first frame, and pause the scene left behind.
      setTimeout(() => {
        scroller.scrollTop = target.offsetTop;
        scroller.querySelectorAll('video.bg').forEach(v => {
          v.pause();
          if (arrivingVideos.includes(v)) v.currentTime = 0;
        });
      }, TRANSITION_FADE_MS);
      clip.addEventListener('ended', finish, { once: true });
      // Safety net in case 'ended' never arrives (e.g. the tab is backgrounded).
      setTimeout(finish, ((clip.duration || 6) + 1.5) * 1000);
    }))
    .catch(() => { if (!started) fallBack(); });
}

function goTo(index) {
  const scenes = visibleScenes();
  const target = scenes[Math.max(0, Math.min(index, scenes.length - 1))];
  const from = activeScene;
  if (paging || !target || target === from) return;
  activeScene = target;
  updateNativeGestures();
  setActive(target);
  paging = true;

  const clip = document.getElementById(TRANSITIONS[from.id + '>' + target.id] || '');
  if (clip) playTransition(clip, target);
  else slideTo(target);
}

const step = dir => goTo(visibleScenes().indexOf(activeScene) + dir);

// Touch: fire as soon as the finger has moved far enough vertically, not on release.
let touch = null;
scroller.addEventListener('touchstart', e => {
  // A second finger cancels paging for this gesture, so it can't slip past a sideways drag.
  if (e.touches.length > 1) { touch = null; return; }
  const t = e.touches[0];
  touch = { x: t.clientX, y: t.clientY, fired: false };
}, { passive: true });
scroller.addEventListener('touchmove', e => {
  if (!touch || touch.fired || sideDragActive) return;
  const t = e.touches[0];
  const dx = touch.x - t.clientX;
  const dy = touch.y - t.clientY;
  // Sideways drags belong to the interior pan and the courtyard day/night swipe.
  if (Math.abs(dy) < SWIPE_MIN || Math.abs(dy) < Math.abs(dx) * 1.2) return;
  touch.fired = true;
  step(dy > 0 ? 1 : -1);
}, { passive: true });
scroller.addEventListener('touchend', () => { touch = null; }, { passive: true });

// Mouse wheel / trackpad: one scene per gesture, ignoring the trailing inertia.
let wheelLockUntil = 0;
scroller.addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) < 10 || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
  const now = Date.now();
  if (now < wheelLockUntil) return;
  wheelLockUntil = now + 900;
  step(e.deltaY > 0 ? 1 : -1);
}, { passive: true });

window.addEventListener('keydown', e => {
  // Space on a focused tab is the tab's own "press"; everything else still pages.
  if (e.key === ' ' && e.target.closest('button')) return;
  if (['ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); step(1); }
  if (['ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); step(-1); }
});

// Rotation or a browser-bar change resizes scenes; keep the current one aligned.
window.addEventListener('resize', () => {
  if (!paging) scroller.scrollTop = activeScene.offsetTop;
});

// Shared direction lock for the sideways drags: decides once per gesture, and
// while horizontal it holds the pointer and blocks scene paging.
function sideDrag(el, { onStart, onMove, onEnd }) {
  let drag = null;
  const end = () => {
    if (drag && drag.horizontal && onEnd) onEnd();
    drag = null;
    sideDragActive = false;
  };
  el.addEventListener('dragstart', e => e.preventDefault());
  el.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, horizontal: null, id: e.pointerId };
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.horizontal === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.horizontal = Math.abs(dx) > Math.abs(dy);
      if (!drag.horizontal) { drag = null; return; }
      sideDragActive = true;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      if (onStart) onStart();
    }
    onMove(dx);
  });
  ['pointerup', 'pointercancel'].forEach(t => el.addEventListener(t, end));
  // Only the element's own capture ending counts. A child (e.g. the courtyard video) losing
  // its automatic touch capture when we take it over is not the end of the drag.
  el.addEventListener('lostpointercapture', e => { if (e.target === el) end(); });
}

// ---- scene 2: masterplan type select, gates the rest of the scroll ----
// Tapping a type with content unlocks the scenes below and moves to the first
// one. A type with no content keeps #journey hidden, so there is nowhere to go.
const typeNote = document.getElementById('type-note');
const baseA = document.getElementById('masterplan-base-a');
const tabs = document.querySelectorAll('.type-tab');
const TYPE_NOTES = {
  a: 'Type A · 154 residences',
  b: 'Type B · 122 residences · Unveiling soon',
  c: 'Type C · Only three residences · Unveiling soon',
};

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const type = tab.dataset.type;
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    typeNote.textContent = TYPE_NOTES[type];

    if (type === 'a') {
      baseA.classList.add('visible');
      journey.hidden = false;
      goTo(visibleScenes().indexOf(document.getElementById('scene-facade-day')));
    } else {
      baseA.classList.remove('visible');
      // Re-lock: switching back to a type with no content must remove the
      // scenes Type A opened up, not just stop offering new ones.
      journey.hidden = true;
      scroller.querySelectorAll('#journey video.bg').forEach(v => v.pause());
      // If a slide into the journey was still running, stop it and settle on the masterplan.
      if (!activeScene.getClientRects().length) {
        if (pageTl) pageTl.kill();
        pageTl = null;
        paging = false;
        activeScene = masterplanScene;
        updateNativeGestures();
        setActive(masterplanScene);
        scroller.scrollTop = masterplanScene.offsetTop;
      }
    }
  });
});

// ---- scene 6: interior, curved drag-to-look ----
// The flat render is redrawn in thin vertical strips with a cylinder-style
// warp, so the room bends slightly at the edges as you look around instead of
// sliding like a flat picture. It opens centred.
(function interiorPan() {
  const scene = document.getElementById('scene-interior');
  const canvas = document.getElementById('pan-canvas');
  if (!scene || !canvas) return;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.src = 'CAM07-INTERIOR%20RECEPTION%202%20(00180).jpg';

  const HALF = 0.5; // half the horizontal field of view, in radians
  const TAN_HALF = Math.tan(HALF);

  let W = 0, H = 0, dpr = 1;
  let center = null, target = null, raf = 0;

  // Width of the image, in image pixels, that spans the screen at a height-fit scale.
  const viewWidth = () => W * img.naturalHeight / H;
  const clamp = c => {
    const half = viewWidth() / 2;
    return Math.max(half, Math.min(img.naturalWidth - half, c));
  };

  function draw() {
    if (!img.naturalWidth || !W || !H) return;
    const vw = viewWidth();
    const ih = img.naturalHeight;
    const strip = Math.max(2, Math.round(3 * dpr));
    ctx.clearRect(0, 0, W, H);
    for (let x = 0; x < W; x += strip) {
      const x2 = Math.min(W, x + strip);
      const u1 = (x / W) * 2 - 1;
      const u2 = (x2 / W) * 2 - 1;
      // Inward curve: the edges are pulled in and grow taller, the centre stays screen height.
      const s1 = center + (Math.atan(u1 * TAN_HALF) / HALF) * (vw / 2);
      const s2 = center + (Math.atan(u2 * TAN_HALF) / HALF) * (vw / 2);
      const um = (u1 + u2) / 2;
      const dh = H / Math.cos(Math.atan(um * TAN_HALF));
      ctx.drawImage(img, s1, 0, Math.max(0.5, s2 - s1), ih, x, (H - dh) / 2, x2 - x + 0.5, dh);
    }
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextW = Math.round(r.width * dpr);
    const nextH = Math.round(r.height * dpr);
    if (nextW !== W || nextH !== H) {
      W = nextW;
      H = nextH;
      canvas.width = W;
      canvas.height = H;
    }
    if (!img.naturalWidth) return;
    if (center === null) center = target = img.naturalWidth / 2;
    center = clamp(center);
    target = clamp(target);
    draw();
  }

  function tick() {
    raf = 0;
    const d = target - center;
    if (Math.abs(d) > 0.3) {
      center += d * 0.25;
      raf = requestAnimationFrame(tick);
    } else {
      center = target;
    }
    draw();
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  img.onload = resize;
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  // The canvas is hidden until Type A, so also size it whenever the scene is reached.
  scene.addEventListener('scene:enter', () => requestAnimationFrame(resize));
  window.addEventListener('resize', resize);

  let dragStart = 0;
  sideDrag(canvas, {
    onStart: () => { dragStart = target; },
    onMove: dx => {
      if (center === null || !H) return;
      // One screen pixel of drag moves the view by one image pixel at the base scale.
      target = clamp(dragStart - dx * img.naturalHeight / (H / dpr));
      kick();
    },
  });
})();

// ---- scene 8: courtyard, swipe sideways from day to night ----
// No slider or handle: dragging left fades night in, dragging right brings day back.
(function courtyardSwipe() {
  const section = document.getElementById('scene-courtyard');
  const night = document.getElementById('courtyard-night');
  if (!section || !night) return;
  let amount = 0;
  let startAmount = 0;

  // Arrive on day every visit.
  section.addEventListener('scene:enter', () => {
    amount = 0;
    night.style.opacity = 0;
  });

  // Day and night are two videos of the same shot: keep them on the same frame.
  const day = document.getElementById('courtyard-day');
  const resync = () => {
    // Only nudge when clearly off (and not right at the loop point), so the night picture doesn't stutter.
    if (!day || day.currentTime < 0.3 || day.currentTime > day.duration - 0.3) return;
    if (Math.abs(night.currentTime - day.currentTime) > 0.25) night.currentTime = day.currentTime;
  };
  if (day) {
    day.addEventListener('playing', resync);
    day.addEventListener('seeked', resync);
    day.addEventListener('timeupdate', resync);
    night.addEventListener('playing', resync);
  }

  sideDrag(section, {
    onStart: () => { startAmount = amount; },
    onMove: dx => {
      amount = Math.max(0, Math.min(1, startAmount - dx / (section.clientWidth * 0.6)));
      night.style.opacity = amount;
    },
  });
})();

// ---- start ----
updateNativeGestures();
setActive(activeScene);
