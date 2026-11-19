/* A lightweight, procedural print sculpture. The CSS composition is always the fallback. */
(() => {
  'use strict';
  const container = document.getElementById('scene-wrap');
  const controls = document.querySelector('.scene-controls');
  const pauseButton = document.getElementById('motion-toggle');
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let renderer;
  let cleanup = () => {};

  async function init() {
    // Probe before loading the library; unsupported devices keep the finished CSS artwork.
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' });
    if (!gl) return;
    const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js');
    await Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise(resolve => setTimeout(resolve, 1500))]);

    renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    renderer.setClearColor(0x000000, 0);
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, .1, 100);
    camera.position.set(0, 0, 15);
    const root = new THREE.Group();
    root.position.set(.1, .05, 0);
    scene.add(root);

    scene.add(new THREE.AmbientLight(0xffffff, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 4.5);
    key.position.set(-4, 7, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xc8dbff, 2.0);
    fill.position.set(5, 0, 3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffd7a2, 2.8);
    rim.position.set(1, 4, -4);
    scene.add(rim);

    const materials = {
      navy: new THREE.MeshStandardMaterial({ color: 0x080f45, roughness: .28, metalness: .22 }),
      orange: new THREE.MeshStandardMaterial({ color: 0xff6500, roughness: .25, metalness: .1 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xffc400, roughness: .22, metalness: .3 }),
      white: new THREE.MeshStandardMaterial({ color: 0xfafaff, roughness: .46, metalness: .05 }),
      acrylic: new THREE.MeshPhysicalMaterial({ color: 0xd3dff5, transparent: true, opacity: .32, roughness: .12, metalness: .05, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false })
    };

    function roundedPanel(width, height, depth, radius, material) {
      const shape = new THREE.Shape();
      const x = -width / 2, y = -height / 2;
      shape.moveTo(x + radius, y);
      shape.lineTo(x + width - radius, y);
      shape.quadraticCurveTo(x + width, y, x + width, y + radius);
      shape.lineTo(x + width, y + height - radius);
      shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      shape.lineTo(x + radius, y + height);
      shape.quadraticCurveTo(x, y + height, x, y + height - radius);
      shape.lineTo(x, y + radius);
      shape.quadraticCurveTo(x, y, x + radius, y);
      const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: .025, bevelThickness: .025, bevelSegments: 2, steps: 1, curveSegments: 6 });
      geometry.translate(0, 0, -depth / 2);
      return new THREE.Mesh(geometry, material);
    }

    const stack = new THREE.Group();
    stack.rotation.set(-.08, -.32, -.19);
    stack.position.set(-.1, .08, .2);
    root.add(stack);
    const layers = [
      { material: materials.acrylic, x: .86, y: .38, z: -1.04 },
      { material: materials.navy, x: .58, y: .26, z: -.69 },
      { material: materials.orange, x: .29, y: .13, z: -.32 },
      { material: materials.white, x: 0, y: 0, z: .14 }
    ];
    layers.forEach(({ material, x, y, z }) => {
      const panel = roundedPanel(2.8, 3.65, .13, .095, material);
      panel.position.set(x, y, z);
      stack.add(panel);
    });

    // High-resolution canvas type stays sharp without loading a font mesh or extra textures.
    const artwork = document.createElement('canvas');
    artwork.width = 896;
    artwork.height = 1168;
    const ctx = artwork.getContext('2d');
    ctx.fillStyle = '#fcfcff';
    ctx.fillRect(0, 0, artwork.width, artwork.height);
    ctx.fillStyle = '#0a1142';
    ctx.font = '800 116px Manrope, Arial, sans-serif';
    ctx.fillText('n', 82, 173);
    ctx.fillStyle = '#ff6600';
    ctx.fillText('a', 154, 173);
    ctx.fillStyle = '#0a1142';
    ctx.font = '750 103px Manrope, Arial, sans-serif';
    ['Sua marca.', 'Em outra', 'dimensão.'].forEach((line, index) => ctx.fillText(line, 75, 440 + index * 122));
    ctx.strokeStyle = '#ff6600';
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.moveTo(77, 721); ctx.quadraticCurveTo(340, 694, 708, 711); ctx.stroke();
    ctx.fillStyle = '#6b7187';
    ctx.font = '400 25px "DM Sans", Arial, sans-serif';
    ctx.fillText('Ideias que se tornam presença.', 82, 935);
    ['#0a1142', '#ff6600', '#ffcf00', '#d5dbe8'].forEach((color, i) => { ctx.fillStyle = color; ctx.fillRect(82 + i * 70, 1020, 58, 14); });
    ctx.strokeStyle = '#b3b7c6'; ctx.lineWidth = 2;
    [[40, 40], [856, 40], [40, 1128], [856, 1128]].forEach(([x, y]) => {
      ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
    });
    const texture = new THREE.CanvasTexture(artwork);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
    const printedFace = new THREE.Mesh(new THREE.PlaneGeometry(2.76, 3.61), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    printedFace.position.set(0, 0, .234);
    stack.add(printedFace);

    const orbit = new THREE.Mesh(new THREE.TorusGeometry(2.26, .175, 14, 100), materials.orange);
    orbit.rotation.set(.94, -.42, -.5);
    orbit.position.set(.1, -.03, -.1);
    orbit.scale.set(1.05, 1.12, 1);
    root.add(orbit);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(.23, 24, 16), materials.gold);
    sphere.position.set(-2.12, 1.78, .4);
    root.add(sphere);
    const cube = roundedPanel(.46, .46, .46, .07, materials.navy);
    cube.position.set(1.83, -1.95, .15);
    cube.rotation.set(.4, .5, .3);
    root.add(cube);

    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 128;
    const shadowCtx = shadowCanvas.getContext('2d');
    const gradient = shadowCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(10,17,66,0.21)');
    gradient.addColorStop(1, 'rgba(10,17,66,0)');
    shadowCtx.fillStyle = gradient;
    shadowCtx.fillRect(0, 0, 128, 128);
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 1.1), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }));
    shadow.position.set(.28, -2.36, -2);
    scene.add(shadow);

    let pointer = { x: 0, y: 0 };
    let paused = preference.matches;
    let visible = true;
    let frame = 0;
    let elapsed = 0;
    let previous = 0;
    let stopped = false;
    function render() { renderer.render(scene, camera); }
    function resize() {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = width / height;
      const viewHeight = Math.max(5.65, 5.5 / ratio);
      camera.left = -viewHeight * ratio / 2;
      camera.right = viewHeight * ratio / 2;
      camera.top = viewHeight / 2;
      camera.bottom = -viewHeight / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      render();
    }
    function tick(time) {
      frame = 0;
      if (stopped || paused || !visible || document.hidden) { previous = 0; return; }
      const delta = previous ? Math.min((time - previous) / 1000, .05) : 0;
      previous = time;
      elapsed += delta;
      const follow = 1 - Math.exp(-4 * delta);
      root.rotation.y += (pointer.x * .14 - root.rotation.y) * follow;
      root.rotation.x += (-pointer.y * .08 - root.rotation.x) * follow;
      root.position.y = .05 + Math.sin(elapsed * .65) * .07;
      sphere.position.y = 1.78 + Math.sin(elapsed * .9 + 1) * .09;
      cube.rotation.z = .3 + Math.sin(elapsed * .55) * .08;
      render();
      frame = requestAnimationFrame(tick);
    }
    function sync() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
      if (!stopped && !paused && visible && !document.hidden) frame = requestAnimationFrame(tick);
    }
    function onPointer(event) {
      if (paused || event.pointerType === 'touch') return;
      const rect = container.getBoundingClientRect();
      pointer = { x: (event.clientX - rect.left) / rect.width * 2 - 1, y: (event.clientY - rect.top) / rect.height * 2 - 1 };
    }
    function resetPointer() { pointer = { x: 0, y: 0 }; }
    function updatePause() {
      pauseButton.setAttribute('aria-pressed', String(paused));
      pauseButton.setAttribute('aria-label', paused ? 'Retomar animação 3D' : 'Pausar animação 3D');
      pauseButton.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
      sync();
    }
    function togglePause() { paused = !paused; updatePause(); }
    function preferenceChanged() {
      paused = preference.matches;
      pointer = { x: 0, y: 0 };
      root.rotation.set(0, 0, 0);
      root.position.y = .05;
      render();
      updatePause();
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); }, { threshold: .01 });
    intersectionObserver.observe(container);
    container.addEventListener('pointermove', onPointer, { passive: true });
    container.addEventListener('pointerleave', resetPointer, { passive: true });
    document.addEventListener('visibilitychange', sync);
    preference.addEventListener('change', preferenceChanged);
    pauseButton.addEventListener('click', togglePause);
    function contextLost(event) {
      event.preventDefault();
      cleanup();
      container.classList.remove('is-loaded');
      controls.hidden = true;
    }
    canvas.addEventListener('webglcontextlost', contextLost, false);
    cleanup = () => {
      if (stopped) return;
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener('visibilitychange', sync);
      preference.removeEventListener('change', preferenceChanged);
      container.removeEventListener('pointermove', onPointer);
      container.removeEventListener('pointerleave', resetPointer);
      pauseButton.removeEventListener('click', togglePause);
      canvas.removeEventListener('webglcontextlost', contextLost);
      const geometries = new Set(), usedMaterials = new Set();
      scene.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) usedMaterials.add(object.material);
      });
      geometries.forEach(geometry => geometry.dispose());
      usedMaterials.forEach(material => material.dispose());
      texture.dispose();
      shadowTexture.dispose();
      renderer.dispose();
    };
    resize();
    container.classList.add('is-loaded');
    controls.hidden = false;
    updatePause();
    window.addEventListener('pagehide', event => { if (!event.persisted) cleanup(); });
  }

  init().catch(() => {
    cleanup();
    renderer?.dispose();
    container.classList.remove('is-loaded');
    controls.hidden = true;
    // Network/GPU failures intentionally leave the readable CSS sculpture in place.
  });
})();
