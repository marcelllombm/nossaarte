/* Hero controller: reversible GSAP choreography, loading/fallback and GPU lifecycle. */
(() => {
  'use strict';
  const container = document.querySelector('.hero-visual');
  if (!container) return;
  const canvas = container.querySelector('canvas');
  const fallback = container.querySelector('.logo-fallback');
  const controls = container.querySelector('.scene-controls');
  const layersButton = document.getElementById('layers-toggle');
  const pauseButton = document.getElementById('motion-toggle');
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const TRANSITION_MS = 550;
  let renderer, gl, model, lights, layerTimeline, motionMedia;
  let resourcesReleased = false;
  function releaseResources() {
    if (resourcesReleased) return;
    resourcesReleased = true;
    motionMedia?.revert();
    layerTimeline?.kill();
    model?.dispose();
    lights?.key.shadow.dispose();
    renderer?.dispose();
  }
  let dispose = releaseResources;
  container.dataset.logoState = 'loading';

  function showFallback() {
    container.classList.remove('is-loaded');
    container.dataset.logoState = 'fallback';
    canvas.setAttribute('aria-hidden', 'true');
    fallback.removeAttribute('aria-hidden');
    controls.hidden = true;
  }

  async function init() {
    // The logo stays visible during a slow CDN; CSS fills in if the PNG is late.
    gl = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' });
    if (!gl || !window.NossaArteLogo) { showFallback(); return; }
    let timeout;
    const THREE = await Promise.race([
      import('https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Three.js loading timed out')), 12000); })
    ]).finally(() => clearTimeout(timeout));

    renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, .1, 40);
    camera.position.set(0, 0, 12);
    model = window.NossaArteLogo.create(THREE);
    scene.add(model.root);
    lights = window.NossaArteLogo.light(THREE, scene);

    const gsap = window.gsap;
    let disposed = false, visible = true, frame = 0, previous = 0, elapsed = 0;
    let tickerAttached = false;
    let userPaused = false, hovered = false, manual = null;
    // Start with the layers already exposed, as the hero's default presentation.
    // GSAP records the assembled origin, then seeks to the exposed initial presentation.
    const motion = { amount: gsap ? 0 : 1 };
    const layerMotion = model.parts.map(() => ({ amount: gsap ? 0 : 1 }));
    let target = 1, from = 1, transitionStart = 0;
    let bounds = container.getBoundingClientRect();
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
    const removers = [];
    const paused = () => userPaused || preference.matches;
    const listen = (element, name, handler, options) => {
      element.addEventListener(name, handler, options);
      removers.push(() => element.removeEventListener(name, handler, options));
    };

    if (gsap) {
      const duration = TRANSITION_MS / 1000;
      const stagger = .03;
      // One reusable timeline reverses from its current playhead on rapid enter/leave.
      // Animate plain state objects; Three.js owns all mesh transforms and rendering.
      layerTimeline = gsap.timeline({ paused: true, defaults: { ease: 'power2.inOut' } })
        .addLabel('assembled', 0)
        .to(motion, { amount: 1, duration }, 0)
        .to(layerMotion, {
          amount: 1, duration: duration - stagger * (layerMotion.length - 1),
          stagger
        }, 0)
        .addLabel('exploded', duration)
        .progress(1).pause();
    }

    function syncTransition() {
      if (paused()) {
        layerTimeline?.pause().progress(target);
        motion.amount = target;
        layerMotion.forEach(layer => { layer.amount = target; });
      } else if (!visible || document.hidden || disposed) layerTimeline?.pause();
      else if (target) layerTimeline?.play();
      else layerTimeline?.reverse();
    }
    function gsapTick(time) { tick(time * 1000); }
    function requestFrame() {
      if (disposed || !visible || document.hidden) return;
      if (gsap) {
        // Subscribe after GSAP's update so the canvas uses this tick's interpolated values.
        if (!tickerAttached) {
          tickerAttached = true;
          gsap.ticker.add(gsapTick);
        }
      } else if (!frame) frame = requestAnimationFrame(tick);
    }
    function suspend() {
      cancelAnimationFrame(frame);
      if (tickerAttached) gsap.ticker.remove(gsapTick);
      tickerAttached = false;
      layerTimeline?.pause();
      frame = 0;
      previous = 0;
    }
    function pose(delta) {
      const still = paused();
      const amount = motion.amount;
      const follow = still ? 1 : 1 - Math.exp(-9 * delta);
      pointer.x += ((still ? 0 : pointer.targetX) - pointer.x) * follow;
      pointer.y += ((still ? 0 : pointer.targetY) - pointer.y) * follow;
      // The oblique angle reveals depth while preserving the mark's front readability.
      model.root.rotation.set(
        -.035 - amount * .12 - pointer.y * .05 + (still ? 0 : Math.sin(elapsed * .55) * .02),
        .045 + amount * .48 + pointer.x * .08 + (still ? 0 : Math.sin(elapsed * .42) * .035),
        still ? 0 : Math.sin(elapsed * .32) * .008
      );
      model.root.position.y = still ? 0 : Math.sin(elapsed * .65) * .035;
      model.setExplode(layerMotion, pointer.x, pointer.y);
    }
    function tick(time) {
      frame = 0;
      if (disposed || !visible || document.hidden) { suspend(); return; }
      const delta = previous ? Math.min((time - previous) / 1000, .05) : 1 / 60;
      previous = time;
      // Reconcile controls with the current preference even before its change event arrives.
      pauseButton.hidden = preference.matches;
      if (paused()) syncTransition();
      else {
        elapsed += delta;
        // A blocked GSAP CDN still leaves a working, reversible Three.js scene.
        if (!gsap) {
          const t = Math.min(1, Math.max(0, (time - transitionStart) / TRANSITION_MS));
          motion.amount = from + (target - from) * t * t * (3 - 2 * t);
          layerMotion.forEach(layer => { layer.amount = motion.amount; });
        }
      }
      pose(delta);
      renderer.render(scene, camera);
      if (!paused()) requestFrame();
      else suspend();
    }
    function sync() { suspend(); syncTransition(); requestFrame(); }
    function setExpanded(expanded) {
      const next = expanded ? 1 : 0;
      if (next === target) return;
      from = motion.amount;
      target = next;
      transitionStart = performance.now();
      layersButton.setAttribute('aria-pressed', String(expanded));
      layersButton.querySelector('span').textContent = expanded ? 'Remontar logo' : 'Explorar camadas';
      container.dataset.logoExpanded = String(expanded);
      syncTransition();
      requestFrame();
    }
    function updatePause() {
      pauseButton.hidden = preference.matches;
      pauseButton.setAttribute('aria-pressed', String(userPaused));
      pauseButton.setAttribute('aria-label', userPaused ? 'Retomar animação 3D' : 'Pausar animação 3D');
      pauseButton.querySelector('use').setAttribute('href', userPaused ? '#i-play' : '#i-pause');
      sync();
    }
    function reset() {
      hovered = false;
      manual = null;
      pointer.targetX = pointer.targetY = 0;
      setExpanded(false);
    }
    function enter(event) {
      if (event.pointerType === 'touch') return;
      bounds = container.getBoundingClientRect();
      hovered = true;
      if (manual === null) setExpanded(true);
    }
    function move(event) {
      if (event.pointerType === 'touch' || paused() || !bounds.width || !bounds.height) return;
      pointer.targetX = THREE.MathUtils.clamp((event.clientX - bounds.left) / bounds.width * 2 - 1, -1, 1);
      pointer.targetY = THREE.MathUtils.clamp(1 - (event.clientY - bounds.top) / bounds.height * 2, -1, 1);
      requestFrame();
    }
    function leave(event) { if (event.pointerType !== 'touch') reset(); }
    function toggleLayers() { manual = !target; setExpanded(manual); }
    function resize() {
      bounds = container.getBoundingClientRect();
      const { width, height } = bounds;
      if (!width || !height) return;
      const aspect = width / height;
      // Keep both assembled and exploded poses inside the same responsive frame.
      const viewHeight = Math.max(5.8, 5.8 / aspect);
      camera.left = -viewHeight * aspect / 2;
      camera.right = viewHeight * aspect / 2;
      camera.top = viewHeight / 2;
      camera.bottom = -viewHeight / 2;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      requestFrame();
    }

    listen(container, 'pointerenter', enter, { passive: true });
    listen(container, 'pointermove', move, { passive: true });
    listen(container, 'pointerleave', leave, { passive: true });
    listen(container, 'pointercancel', reset, { passive: true });
    listen(layersButton, 'click', toggleLayers);
    listen(pauseButton, 'click', () => { userPaused = !userPaused; updatePause(); });
    listen(container, 'keydown', event => { if (event.key === 'Escape') reset(); });
    listen(container, 'focusout', event => { if (!container.contains(event.relatedTarget) && !hovered) reset(); });
    if (!gsap) listen(preference, 'change', () => { pointer.targetX = pointer.targetY = 0; updatePause(); });
    listen(document, 'visibilitychange', sync);
    listen(window, 'resize', resize, { passive: true });
    listen(window, 'scroll', () => { bounds = container.getBoundingClientRect(); }, { passive: true });
    listen(window, 'blur', reset);

    // Picking shares the named parts used by the explosion hierarchy.
    const raycaster = new THREE.Raycaster();
    listen(canvas, 'click', event => {
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
      if (raycaster.intersectObjects(model.parts, true).length) toggleLayers();
    });
    const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(container);
    const intersectionObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      sync();
    }, { threshold: .01 }) : null;
    intersectionObserver?.observe(container);

    dispose = () => {
      if (disposed) return;
      disposed = true;
      suspend();
      removers.forEach(remove => remove());
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      releaseResources();
    };
    listen(canvas, 'webglcontextlost', event => { event.preventDefault(); dispose(); showFallback(); });
    listen(window, 'pagehide', event => {
      if (event.persisted) suspend();
      else { dispose(); renderer.forceContextLoss(); }
    });
    listen(window, 'pageshow', sync);

    if (gsap) {
      motionMedia = gsap.matchMedia();
      motionMedia.add({
        reduceMotion: '(prefers-reduced-motion: reduce)',
        allowMotion: '(prefers-reduced-motion: no-preference)'
      }, () => {
        pointer.targetX = pointer.targetY = 0;
        updatePause();
        return () => layerTimeline.pause();
      });
    }

    resize();
    pose(0);
    renderer.render(scene, camera); // Reveal only after a successful first frame, layers exposed.
    container.classList.add('is-loaded');
    container.dataset.logoState = 'ready';
    container.dataset.logoExpanded = 'true';
    canvas.removeAttribute('aria-hidden');
    fallback.setAttribute('aria-hidden', 'true');
    controls.hidden = false;
    updatePause();
    container.dispatchEvent(new CustomEvent('logo:ready', { detail: { model, renderer, scene, camera, dispose, animation: layerTimeline } }));
  }

  init().catch(error => {
    dispose();
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    showFallback();
    console.warn('Logo 3D indisponível; exibindo a versão estática.', error);
  });
})();
