(function exposeTransitionCoordination(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TransitionCoordination = api;
})(typeof window !== 'undefined' ? window : globalThis, function buildTransitionCoordination() {
  function createWarmCoordinator({
    getClip,
    isBusy,
    shouldPark = () => true,
    delay = setTimeout,
  }) {
    let generation = 0;
    const inFlight = new WeakMap();
    const owners = new WeakMap();

    const park = clip => {
      if (!shouldPark(clip)) return;
      clip.pause();
      try { clip.currentTime = 0; } catch (_) {}
    };

    const cancel = () => { generation += 1; };

    const schedule = ids => {
      const run = ++generation;

      const warmNext = index => {
        if (run !== generation || index >= ids.length) return;
        const clip = getClip(ids[index]);
        if (!clip) return warmNext(index + 1);

        if (isBusy()) {
          delay(() => warmNext(index), 400);
          return;
        }

        owners.set(clip, run);
        let playback = inFlight.get(clip);
        if (!playback) {
          if (clip.readyState < 2) clip.load();
          try {
            playback = Promise.resolve(clip.play());
          } catch (error) {
            playback = Promise.reject(error);
          }
          inFlight.set(clip, playback);
        }

        playback.then(() => {
          if (inFlight.get(clip) === playback) inFlight.delete(clip);
          if (owners.get(clip) !== run) return;
          owners.delete(clip);
          if (run !== generation) {
            park(clip);
            return;
          }
          park(clip);
          if (index + 1 < ids.length) delay(() => warmNext(index + 1), 120);
        }).catch(() => {
          if (inFlight.get(clip) === playback) inFlight.delete(clip);
          if (owners.get(clip) !== run) return;
          owners.delete(clip);
          if (run === generation && index + 1 < ids.length) {
            delay(() => warmNext(index + 1), 120);
          }
        });
      };

      warmNext(0);
    };

    return { cancel, schedule };
  }

  function createArrivalCoordinator({
    enter,
    delay = setTimeout,
    cancelDelay = clearTimeout,
  }) {
    let entered = false;
    let pending = 0;

    const enterOnce = () => {
      if (entered) return;
      entered = true;
      pending = 0;
      enter();
    };

    const afterTransition = waitMs => {
      if (entered || pending) return;
      pending = delay(enterOnce, waitMs);
    };

    const enterNow = () => {
      if (pending) {
        cancelDelay(pending);
        pending = 0;
      }
      enterOnce();
    };

    return { afterTransition, enterNow };
  }

  return { createArrivalCoordinator, createWarmCoordinator };
});
