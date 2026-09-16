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
const TRANSITION_FADE_MS = 210; // just over the 0.2s CSS dissolve on .transition-video

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
  // Needs one touch first (iOS); after that every arrival warms its own clips.
  clipsWarmed = true;
  const ids = Object.entries(TRANSITIONS)
    .filter(([key]) => key.startsWith(activeScene.id + '>'))
    .map(([, id]) => id);
  if (!ids.length) return;
  (function warmNext(i) {
    const clip = document.getElementById(ids[i]);
    if (!clip) return i + 1 < ids.length && warmNext(i + 1);
    const next = () => { if (i + 1 < ids.length) warmNext(i + 1); };
    // Never nudge a clip while a transition is running: a warm-up play() landing on the
    // clip being revealed would start it moving before its first frame is on screen.
    if (activeClip || paging) return setTimeout(() => warmNext(i), 400);
    if (clip.readyState < 2) clip.load();
    // Nudge it into decoding, then park it back on frame one and warm the next.
    clip.play().then(() => {
      if (clip !== activeClip) { clip.pause(); clip.currentTime = 0; }
      setTimeout(next, 120);
    }).catch(() => setTimeout(next, 120));
  })(0);
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

// Load a video only when it's about to be needed: phones stall when asked to fetch and
// decode every video on the page at once.
function primeVideo(v) {
  if (!v || v.preload === 'auto') return;
  v.preload = 'auto';
  if (v.readyState === 0) v.load();
}
// The scene you're on, the ones either side of it, and the transition clips out of it.
function primeAround(scene) {
  const scenes = visibleScenes();
  const i = scenes.indexOf(scene);
  [scenes[i - 1], scene, scenes[i + 1]].forEach(s => { if (s) sceneVideos(s).forEach(primeVideo); });
  Object.entries(TRANSITIONS).forEach(([key, id]) => {
    if (key.startsWith(scene.id + '>')) primeVideo(document.getElementById(id));
  });
}

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
  // Load first: an arrival handler may ask a video to play, and a later load() would cancel that.
  primeAround(target);
  target.dispatchEvent(new CustomEvent('scene:enter'));
  // Once the transition or slide has really finished, decode the clips that can play next.
  const warmWhenSettled = () => {
    if (activeScene !== target || !clipsWarmed) return;
    if (paging) return setTimeout(warmWhenSettled, 250);
    warmTransitionClips();
  };
  setTimeout(warmWhenSettled, 400);
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

function playTransition(clip, target, parked) {
  const arrivingVideos = sceneVideos(target);
  let started = false;
  let done = false;
  activeClip = clip;

  const finish = () => {
    if (done) return;
    done = true;
    clip.classList.remove('playing');
    setTimeout(() => arrivingVideos.forEach(v => v.play().catch(() => {})), TRANSITION_FADE_MS);
    // Pause only after the dissolve, so the clip holds its last frame while fading out.
    setTimeout(() => { if (activeClip !== clip) { clip.pause(); clip.currentTime = 0; } }, TRANSITION_FADE_MS);
    // Safe to drop now: the bar's glide already under way keeps its original timing.
    document.body.classList.remove('in-transition');
    activeClip = null;
    paging = false;
  };

  const fallBack = () => {
    started = true;
    clearTimeout(giveUp);
    clearTimeout(hardGiveUp);
    clip.pause();
    clip.currentTime = 0;
    activeClip = null;
    slideTo(target);
  };

  // If the clip can't start in time (slow network, refused play), fall back to a normal slide.
  // Counted from the settle, not from the swipe, so the settle never spends this budget.
  let giveUp = 0;
  const armGiveUp = () => { giveUp = setTimeout(() => { if (!started) fallBack(); }, TRANSITION_START_TIMEOUT_MS); };
  if (parked) parked.then(armGiveUp); else armGiveUp();
  // Absolute limit, in case the settle itself never reports back.
  const hardGiveUp = setTimeout(() => { if (!started) fallBack(); }, 700);

  // Show the clip only once its own first frame is on screen. Revealing it mid-motion
  // (which is what happens on a cold load, while the decoder is still catching up)
  // reads as the camera sliding at the join.
  const startFromFirstFrame = () => {
      if (started) return;
      started = true;
      clearTimeout(giveUp);
      clearTimeout(hardGiveUp);
      clip.classList.add('playing');
      document.body.classList.add('in-transition');
      // Freeze the scene being left the moment the blend starts: its own camera is
      // still travelling, and the clip always begins at that video's first frame,
      // so a moving picture underneath is what reads as a slide at the join.
      scroller.querySelectorAll('video.bg').forEach(v => { if (!arrivingVideos.includes(v)) v.pause(); });
      // If the phone refuses to start it after all, jump the page across and clear up,
      // rather than leaving a frozen frame on screen.
      clip.play().catch(() => {
        scroller.scrollTop = target.offsetTop;
        finish();
      });
      // Once the clip fully covers the screen, move the page behind it, park the
      // arriving scene's video on its first frame, and pause the scene left behind.
      setTimeout(() => {
        scroller.scrollTop = target.offsetTop;
        scroller.querySelectorAll('video.bg').forEach(v => {
          v.pause();
          if (arrivingVideos.includes(v)) v.currentTime = 0;
        });
      }, TRANSITION_FADE_MS + 60);
      clip.addEventListener('ended', finish, { once: true });
      // Safety net in case 'ended' never arrives (e.g. the tab is backgrounded).
      setTimeout(finish, ((clip.duration || 6) + 1.5) * 1000);
  };

  // Hold the clip back until the scene it is leaving has settled onto its first frame,
  // which is the frame the clip starts on. Capped, so a slow settle never stalls a swipe.
  const whenParked = cb => {
    if (!parked) return cb();
    let fired = false;
    const once = () => { if (!fired) { fired = true; cb(); } };
    parked.then(once);
    setTimeout(once, 260);
  };
  const revealWhenReady = () => whenParked(startFromFirstFrame);

  clip.pause();
  if (clip.readyState >= 2 && clip.currentTime === 0) revealWhenReady();
  else {
    clip.addEventListener('seeked', () => onFirstFrame(clip, revealWhenReady), { once: true });
    clip.currentTime = 0;
    // A clip with nothing decoded yet never fires 'seeked'; wait for data instead.
    if (clip.readyState < 2) clip.addEventListener('loadeddata', () => { clip.currentTime = 0; }, { once: true });
  }
}

function goTo(index) {
  const scenes = visibleScenes();
  const target = scenes[Math.max(0, Math.min(index, scenes.length - 1))];
  const from = activeScene;
  if (paging || !target || target === from) {
    if (from.resumeAfterPark) from.resumeAfterPark();
    return;
  }
  if (from.id === 'scene-courtyard' && target.id === 'scene-plans') {
    const night = document.getElementById('courtyard-night');
    const goal = from.dataset.goal
      || (night && parseFloat(getComputedStyle(night).opacity) > 0.5 ? 'night' : 'day');
    // Switch at once, not with the fade, so the page never slides in mid-change.
    target.classList.add('instant');
    target.dataset.time = goal;
    void target.offsetWidth;
    requestAnimationFrame(() => target.classList.remove('instant'));
  }
  activeScene = target;
  updateNativeGestures();
  setActive(target);
  paging = true;

  if (from.leaveHook) from.leaveHook();
  const parked = from.parkOnFirstFrame ? from.parkOnFirstFrame() : null;
  const clip = document.getElementById(TRANSITIONS[from.id + '>' + target.id] || '');
  if (clip) playTransition(clip, target, parked);
  else slideTo(target);
}

const step = dir => {
  // A scene can take the step itself first (the closing page fades sunset into night).
  if (!paging && activeScene.takeStep && activeScene.takeStep(dir)) return;
  goTo(visibleScenes().indexOf(activeScene) + dir);
};

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
  if (!paging && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx) && activeScene.parkOnFirstFrame) activeScene.parkOnFirstFrame();
  if (Math.abs(dy) < SWIPE_MIN || Math.abs(dy) < Math.abs(dx) * 1.2) return;
  touch.fired = true;
  step(dy > 0 ? 1 : -1);
}, { passive: true });
scroller.addEventListener('touchend', () => {
  // Finger lifted without changing scene: put the scene's move back.
  if (touch && !touch.fired && activeScene.resumeAfterPark) activeScene.resumeAfterPark();
  touch = null;
}, { passive: true });

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
function sideDrag(el, { onStart, onMove, onEnd, onPress }) {
  let drag = null;
  const end = () => {
    // Speed older than a few frames means the finger had already come to rest.
    const fresh = drag && drag.lastTime && performance.now() - drag.lastTime < 80;
    if (drag && drag.horizontal && onEnd) onEnd(fresh ? (drag.speed || 0) : 0);
    drag = null;
    sideDragActive = false;
  };
  el.addEventListener('dragstart', e => e.preventDefault());
  el.addEventListener('pointerdown', e => {
    if (onPress) onPress();
    drag = { x: e.clientX, y: e.clientY, horizontal: null, id: e.pointerId };
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    // Screen pixels per millisecond, smoothed, so a flick can carry on gliding.
    const now = performance.now();
    if (drag.lastTime) {
      const gap = now - drag.lastTime;
      if (gap > 0) {
        const latest = (e.clientX - drag.lastX) / gap;
        drag.speed = drag.speed == null ? latest : drag.speed * 0.65 + latest * 0.35;
      }
    }
    drag.lastTime = now;
    drag.lastX = e.clientX;
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
  img.src = 'Scenes/CAM07-INTERIOR%20RECEPTION%202%20(00180).jpg';

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
  // Image pixels the view moves for one screen pixel of finger travel.
  const perPixel = () => img.naturalHeight / (H / dpr);
  // Glide: the view carries on after the finger lifts and slows to a stop.
  let speed = 0, glideRaf = 0, glideTime = 0;
  const stopGlide = () => { speed = 0; if (glideRaf) cancelAnimationFrame(glideRaf); glideRaf = 0; };
  function glide(now) {
    // Leaving the scene mid-glide ends it, so it never redraws over a transition.
    if (!scene.classList.contains('is-active')) return stopGlide();
    const step = Math.min(32, now - glideTime);
    glideTime = now;
    const before = target;
    target = clamp(target + speed * step);
    // Reaching either end of the panorama stops it dead rather than bouncing.
    if (target === before) return stopGlide();
    speed *= Math.pow(0.995, step);
    kick();
    glideRaf = Math.abs(speed) > 0.02 ? requestAnimationFrame(glide) : 0;
  }
  sideDrag(canvas, {
    onPress: stopGlide,
    onStart: () => { stopGlide(); dragStart = target; },
    onMove: dx => {
      if (center === null || !H) return;
      // One screen pixel of drag moves the view by one image pixel at the base scale.
      target = clamp(dragStart - dx * perPixel());
      kick();
    },
    onEnd: fingerSpeed => {
      if (center === null || !H || !fingerSpeed) return;
      speed = -fingerSpeed * perPixel();
      if (Math.abs(speed) < 0.05) return;
      glideTime = performance.now();
      glideRaf = requestAnimationFrame(glide);
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

  // No reset on arrival: the courtyard stays on whichever day/night it was left.

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

  // After the finger lifts, ease the rest of the way rather than stopping part-faded.
  let settleRaf = 0;
  const stopSettle = () => { if (settleRaf) cancelAnimationFrame(settleRaf); settleRaf = 0; };
  function settleTo(end) {
    section.dataset.goal = end ? 'night' : 'day';
    const from = amount;
    const started = performance.now();
    const run = now => {
      const t = Math.min(1, (now - started) / 450);
      const eased = 1 - Math.pow(1 - t, 3);
      amount = from + (end - from) * eased;
      night.style.opacity = amount;
      settleRaf = t < 1 ? requestAnimationFrame(run) : 0;
    };
    stopSettle();
    settleRaf = requestAnimationFrame(run);
  }

  sideDrag(section, {
    onPress: stopSettle,
    onStart: () => { stopSettle(); startAmount = amount; },
    onMove: dx => {
      amount = Math.max(0, Math.min(1, startAmount - dx / (section.clientWidth * 0.6)));
      night.style.opacity = amount;
    },
    onEnd: fingerSpeed => {
      // A flick decides the direction; a slow drag lands on whichever is nearer.
      if (fingerSpeed < -0.25) settleTo(1);
      else if (fingerSpeed > 0.25) settleTo(0);
      else settleTo(amount > 0.5 ? 1 : 0);
    },
  });
})();

// ---- park the scenes a transition starts from on their first frame ----
// Measured with ffmpeg: each transition clip begins on its scene video's FIRST frame.
// Those videos used to loop, so by the time a swipe came the camera had travelled and
// the join showed as a slide. Now each plays its move once on arrival, then dissolves
// back to its first frame (the poster still, which matches it) and holds there.
(function parkSceneVideos() {
  ['scene-facade-day', 'scene-facade-close', 'scene-entrance'].forEach(id => {
    const scene = document.getElementById(id);
    const video = scene && scene.querySelector('video.bg');
    if (!video || !video.poster) return;
    video.loop = false;

    const still = document.createElement('img');
    still.className = 'bg bg-still';
    still.alt = '';
    still.draggable = false;
    still.src = video.poster;
    video.insertAdjacentElement('afterend', still);

    let settling = 0;
    // Cover with the still, rewind behind it, then drop the still once the rewind has
    // really landed — the picture underneath is then the same frame.
    const settle = (fadeMs, onSettled) => {
      clearTimeout(settling);
      still.style.transitionDuration = fadeMs + 'ms';
      still.style.opacity = '1';
      settling = setTimeout(() => {
        video.pause();
        // Covered now, so the transition need not wait for the rewind as well.
        if (onSettled) onSettled();
        const drop = () => { still.style.opacity = '0'; };
        if (video.currentTime === 0) drop();
        else {
          video.addEventListener('seeked', drop, { once: true });
          video.currentTime = 0;
          // If the seek never reports back, don't leave the still up for ever.
          setTimeout(drop, 600);
        }
      }, fadeMs + 40);
    };

    // Called the moment a swipe starts: the clip about to play begins on this video's
    // first frame, so the scene must be showing that frame, not wherever its camera
    // has travelled to.
    // Returns a promise that settles once the scene really is on its first frame,
    // so the transition can hold the clip back until then.
    let parking = null;
    scene.parkOnFirstFrame = () => {
      if (video.paused && video.currentTime === 0) return Promise.resolve();
      if (!parking) parking = new Promise(done => settle(90, done));
      return parking;
    };
    // A drag that doesn't change scene puts the move back.
    scene.resumeAfterPark = () => {
      parking = null;
      // Always drop a settle that has been scheduled but not run, or the video pauses
      // a moment after the finger has gone and stays parked.
      clearTimeout(settling);
      if (!scene.classList.contains('is-active')) return;
      still.style.opacity = '0';
      if (video.paused) video.play().catch(() => {});
    };

    video.addEventListener('ended', () => settle(500));

    scene.addEventListener('scene:enter', () => {
      parking = null;
      clearTimeout(settling);
      still.style.opacity = '0';
      video.currentTime = 0;
      video.play().catch(() => {});
    });
  });
})();

// ---- scene 9: floor plans, swipe sideways floor to floor ----
// Ground, First, Roof sit side by side, right to left. The page follows the finger, then
// snaps to the next floor (or back) when it lets go; swiping right moves on. The Ground/First/Roof bar can be tapped too.
(function floorPlans() {
  const scene = document.getElementById('scene-plans');
  const track = scene && scene.querySelector('.floors');
  if (!track) return;
  const count = track.children.length;
  const tabs = [...scene.querySelectorAll('.floor-tab')];
  let index = 0;
  let lastDx = 0;

  const show = i => {
    index = Math.max(0, Math.min(count - 1, i));
    track.style.transition = '';
    track.style.transform = 'translateX(' + (index * 100) + '%)';
    tabs.forEach((t, k) => {
      t.classList.toggle('on', k === index);
      t.setAttribute('aria-selected', k === index ? 'true' : 'false');
      t.tabIndex = k === index ? 0 : -1;
    });
    [...track.children].forEach((f, k) => {
      f.toggleAttribute('inert', k !== index);
      f.setAttribute('aria-hidden', k === index ? 'false' : 'true');
    });
  };

  sideDrag(scene, {
    onStart: () => { lastDx = 0; track.style.transition = 'none'; },
    onMove: dx => {
      lastDx = dx;
      // Past the first or last floor it only gives a little, so it's clear there's no more.
      const edge = (index === 0 && dx < 0) || (index === count - 1 && dx > 0);
      track.style.transform = 'translateX(calc(' + (index * 100) + '% + ' + (edge ? dx * 0.25 : dx) + 'px))';
    },
    onEnd: speed => {
      const far = Math.abs(lastDx) > scene.clientWidth * 0.18;
      const flick = Math.abs(speed) > 0.35;
      // Swiping right brings the next floor in from the left.
      if (far || flick) show(index + ((flick ? speed : lastDx) > 0 ? 1 : -1));
      else show(index);
    },
  });

  tabs.forEach((t, k) => t.addEventListener('click', () => show(k)));
  window.addEventListener('keydown', e => {
    if (activeScene !== scene) return;
    if (e.key === 'ArrowLeft') show(index + 1);
    if (e.key === 'ArrowRight') show(index - 1);
  });
})();

// ---- scene 10: closing, sunset fades into night in place ----
(function closingSunset() {
  const scene = document.getElementById('scene-closing');
  if (!scene) return;
  let lockedUntil = 0;
  const resetWhenGone = () => setTimeout(() => {
    if (activeScene === scene || scene.dataset.time === 'sunset') return;
    scene.classList.add('instant');
    scene.dataset.time = 'sunset';
    void scene.offsetWidth;
    requestAnimationFrame(() => scene.classList.remove('instant'));
  }, PAGE_DURATION * 1000 + 100);
  scene.leaveHook = resetWhenGone;
  scene.takeStep = dir => {
    // Ignore repeat steps while the fade runs, so one swipe is one change.
    if (Date.now() < lockedUntil) return true;
    if (dir > 0 && scene.dataset.time === 'sunset') { scene.dataset.time = 'night'; lockedUntil = Date.now() + 900; return true; }
    if (dir < 0 && scene.dataset.time === 'night') { scene.dataset.time = 'sunset'; lockedUntil = Date.now() + 900; return true; }
    return false;
  };

  // Back to types: fade to black, jump to the masterplan page, fade back in.
  const button = scene.querySelector('.back-to-types');
  const veil = document.getElementById('jump-veil');
  const types = document.getElementById('scene-masterplan');
  if (!button || !veil || !types) return;
  button.addEventListener('click', () => {
    if (paging) return;
    paging = true;
    veil.classList.add('on');
    setTimeout(() => {
      if (pageTl) { pageTl.kill(); pageTl = null; }
      activeScene = types;
      resetWhenGone();
      scroller.scrollTop = types.offsetTop;
      updateNativeGestures();
      setActive(types);
      pauseOtherVideos(types);
      veil.classList.remove('on');
      paging = false;
    }, 380);
  });
})();

// ---- start ----
updateNativeGestures();
setActive(activeScene);
