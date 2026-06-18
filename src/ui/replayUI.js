// Replay scrubber bar (V5 E2b) — bottom-center panel with a range slider over
// the recorded sim-time window, a ● REC indicator (red while live recording),
// and ▶ / ⏸ / EN VIVO controls (Spanish UI). Dragging the slider enters replay
// mode (main.js HARD-pauses the sim + recording and renders vehicles from the
// ring at the scrubbed sim time); «EN VIVO» exits replay and resumes the live
// simulation.
//
// The slider position maps linearly to the ring's live time window
// [minTime, maxTime]; the absolute scrub sim-time is handed to main.js via
// hooks.setReplayScrub(tSeconds). The panel reads the live recorder through
// app.world.sim.replay each tick (survives world swaps; resets on swap).
//
// hooks = { setReplayMode(bool), setReplayScrub(simSeconds), isReplayMode() }

const SLIDER_STEPS = 1000; // integer slider resolution (mapped to the time window)

export function createReplayUI(app, hooks) {
  // ---- DOM ----
  const panel = document.createElement('div');
  panel.id = 'replay';
  panel.className = 'panel';

  const row = document.createElement('div');
  row.id = 'replay-row';

  const rec = document.createElement('span');
  rec.id = 'replay-rec';
  rec.title = 'Grabando';
  rec.innerHTML = '<span id="replay-rec-dot">●</span> REC';

  const slider = document.createElement('input');
  slider.id = 'replay-slider';
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(SLIDER_STEPS);
  slider.step = '1';
  slider.value = String(SLIDER_STEPS); // far right = newest = "live edge"

  const timeLabel = document.createElement('span');
  timeLabel.id = 'replay-time';
  timeLabel.textContent = '–';

  const btnPlay = document.createElement('button');
  btnPlay.id = 'replay-play';
  btnPlay.type = 'button';
  btnPlay.textContent = '▶';
  btnPlay.title = 'Reproducir desde la posición';

  const btnPause = document.createElement('button');
  btnPause.id = 'replay-pause';
  btnPause.type = 'button';
  btnPause.className = 'secondary';
  btnPause.textContent = '⏸';
  btnPause.title = 'Pausar la repetición';

  const btnLive = document.createElement('button');
  btnLive.id = 'replay-live';
  btnLive.type = 'button';
  btnLive.textContent = 'EN VIVO';
  btnLive.title = 'Volver a la simulación en vivo';

  row.appendChild(rec);
  row.appendChild(slider);
  row.appendChild(timeLabel);
  row.appendChild(btnPlay);
  row.appendChild(btnPause);
  row.appendChild(btnLive);
  panel.appendChild(row);
  document.body.appendChild(panel);

  // ---- State ----
  let scrubT = 0; // absolute sim-time the slider currently points at
  let playing = false; // local replay playback (auto-advances scrubT)
  let lastSim = null; // detect world swap

  /** Live ring time bounds; [-1,-1] when the ring is empty. */
  function bounds() {
    const r = app.world?.sim?.replay;
    if (!r) return { lo: -1, hi: -1 };
    return { lo: r.minTime(), hi: r.maxTime() };
  }

  function fmt(t) {
    if (t < 0 || !isFinite(t)) return '–';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /** Map a slider integer [0,STEPS] to an absolute sim time in [lo,hi]. */
  function sliderToTime(v, lo, hi) {
    if (hi <= lo) return hi;
    return lo + (hi - lo) * (v / SLIDER_STEPS);
  }
  /** Map an absolute sim time to a slider integer [0,STEPS]. */
  function timeToSlider(t, lo, hi) {
    if (hi <= lo) return SLIDER_STEPS;
    return Math.round(((t - lo) / (hi - lo)) * SLIDER_STEPS);
  }

  function enterReplayAt(t) {
    scrubT = t;
    hooks.setReplayMode(true); // hard-pause sim + recording, render from ring
    hooks.setReplayScrub(scrubT);
    panel.classList.add('scrubbing');
  }

  function goLive() {
    playing = false;
    hooks.setReplayMode(false); // exit replay: resume sim + recording
    panel.classList.remove('scrubbing');
  }

  // Drag the slider -> enter replay + scrub to that sim-time.
  slider.addEventListener('input', () => {
    const { lo, hi } = bounds();
    if (lo < 0) return; // nothing recorded yet
    const t = sliderToTime(Number(slider.value), lo, hi);
    enterReplayAt(t);
  });

  btnPlay.addEventListener('click', () => {
    const { lo, hi } = bounds();
    if (lo < 0) return;
    // Start playback from the current scrub position (or the window start if
    // we're sitting at the live edge).
    if (!hooks.isReplayMode() || scrubT >= hi) scrubT = lo;
    playing = true;
    enterReplayAt(scrubT);
  });

  btnPause.addEventListener('click', () => {
    playing = false;
    // Stay in replay mode, just stop auto-advancing.
    if (hooks.isReplayMode()) hooks.setReplayScrub(scrubT);
  });

  btnLive.addEventListener('click', goLive);

  return {
    /**
     * Per-frame tick (called from the RAF loop). Refreshes the REC indicator,
     * advances playback in replay mode, and tracks the live edge otherwise.
     * `wallDt` advances replay playback in real seconds (sim-time speed-agnostic).
     */
    update(wallDt = 0) {
      const sim = app.world?.sim ?? null;
      if (sim !== lastSim) {
        // World swap: drop back to the live edge.
        lastSim = sim;
        goLive();
        slider.value = String(SLIDER_STEPS);
        timeLabel.textContent = '–';
      }
      const r = sim?.replay ?? null;
      const recording = !!r?.recording;
      rec.classList.toggle('on', recording && !hooks.isReplayMode());
      const { lo, hi } = bounds();
      if (hooks.isReplayMode()) {
        if (playing && lo >= 0) {
          scrubT += wallDt; // play forward at 1× sim-second per wall-second
          if (scrubT >= hi) {
            scrubT = hi;
            playing = false; // reached the live edge — stop (stay paused at end)
          }
          hooks.setReplayScrub(scrubT);
        }
        if (lo >= 0) slider.value = String(timeToSlider(scrubT, lo, hi));
        timeLabel.textContent = fmt(scrubT);
      } else {
        // Live: keep the handle pinned to the right (newest) edge.
        if (lo >= 0) {
          slider.value = String(SLIDER_STEPS);
          timeLabel.textContent = fmt(hi);
        }
      }
    },
    /** Force the bar back to EN VIVO (world swap hook from main.js). */
    reset() {
      goLive();
      slider.value = String(SLIDER_STEPS);
      timeLabel.textContent = '–';
    },
    get scrubT() {
      return scrubT;
    },
    dispose() {
      panel.remove();
    },
  };
}
