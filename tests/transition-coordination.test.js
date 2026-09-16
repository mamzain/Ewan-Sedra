const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createArrivalCoordinator,
  createWarmCoordinator,
} = require('../transition-coordination.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeClip(id, playResult = Promise.resolve()) {
  return {
    id,
    readyState: 1,
    currentTime: 4,
    loadCalls: 0,
    pauseCalls: 0,
    playCalls: 0,
    load() { this.loadCalls += 1; },
    pause() { this.pauseCalls += 1; },
    play() {
      this.playCalls += 1;
      return playResult;
    },
  };
}

function manualTimers() {
  let nextId = 1;
  const jobs = new Map();
  return {
    delay(fn) {
      const id = nextId++;
      jobs.set(id, fn);
      return id;
    },
    cancel(id) { jobs.delete(id); },
    runAll() {
      const current = [...jobs.values()];
      jobs.clear();
      current.forEach(fn => fn());
    },
    get size() { return jobs.size; },
  };
}

test('a newer warm-up request cancels the previous sequence', async () => {
  const firstPlay = deferred();
  const first = fakeClip('first', firstPlay.promise);
  const staleNext = fakeClip('stale-next');
  const current = fakeClip('current');
  const clips = new Map([[first.id, first], [staleNext.id, staleNext], [current.id, current]]);
  const timers = manualTimers();
  const warm = createWarmCoordinator({
    getClip: id => clips.get(id),
    isBusy: () => false,
    delay: timers.delay,
  });

  warm.schedule(['first', 'stale-next']);
  warm.schedule(['current']);
  firstPlay.resolve();
  await Promise.resolve();
  await Promise.resolve();
  timers.runAll();
  await Promise.resolve();

  assert.equal(staleNext.playCalls, 0);
  assert.equal(current.playCalls, 1);
  assert.equal(first.pauseCalls, 1);
  assert.equal(first.currentTime, 0);
});

test('navigation cancellation parks a clip whose play promise resolves late', async () => {
  const play = deferred();
  const clip = fakeClip('clip', play.promise);
  const warm = createWarmCoordinator({
    getClip: () => clip,
    isBusy: () => false,
    delay: () => 1,
  });

  warm.schedule(['clip']);
  warm.cancel();
  play.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(clip.pauseCalls, 1);
  assert.equal(clip.currentTime, 0);
});

test('repeated requests for the same clip share one in-flight warm-up', async () => {
  const play = deferred();
  const clip = fakeClip('clip', play.promise);
  const warm = createWarmCoordinator({
    getClip: () => clip,
    isBusy: () => false,
    delay: () => 1,
  });

  warm.schedule(['clip']);
  warm.schedule(['clip']);

  assert.equal(clip.playCalls, 1);
  play.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(clip.pauseCalls, 1);
  assert.equal(clip.currentTime, 0);
});

test('successful transition delays destination entry until the dissolve finishes', () => {
  const timers = manualTimers();
  let entries = 0;
  const arrival = createArrivalCoordinator({
    enter: () => { entries += 1; },
    delay: timers.delay,
    cancelDelay: timers.cancel,
  });

  arrival.afterTransition(210);
  assert.equal(entries, 0);
  assert.equal(timers.size, 1);

  timers.runAll();
  assert.equal(entries, 1);
  arrival.enterNow();
  assert.equal(entries, 1);
});

test('timeout fallback enters the destination immediately and cancels delayed entry', () => {
  const timers = manualTimers();
  let entries = 0;
  const arrival = createArrivalCoordinator({
    enter: () => { entries += 1; },
    delay: timers.delay,
    cancelDelay: timers.cancel,
  });

  arrival.afterTransition(210);
  arrival.enterNow();
  assert.equal(entries, 1);
  assert.equal(timers.size, 0);

  timers.runAll();
  assert.equal(entries, 1);
});
