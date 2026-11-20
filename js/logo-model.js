/* Procedural reconstruction of img/logo.png. Geometry is independent of image loading. */
(() => {
  'use strict';

  // Reference-space curves preserve the actual mark, rather than substituting a font glyph.
  // 416px = 4.16 world units; front is +Z and up is +Y.
  const MONOGRAM = [
    ['M',120,108], ['L',120,115], ['C',149,110,153,120,145,148],
    ['C',134,188,119,227,108,256], ['L',152,246], ['C',160,216,188,161,222,133],
    ['C',237,120,248,126,242,139], ['L',223,188], ['C',199,196,174,214,163,226],
    ['C',181,218,197,213,214,211], ['L',195,270], ['C',186,301,204,309,223,301],
    ['C',242,295,257,281,269,268], ['L',263,262], ['C',245,280,230,281,239,256],
    ['L',254,211], ['C',269,212,284,215,298,217], ['L',308,186],
    ['C',294,183,279,184,265,184], ['L',283,135], ['C',299,85,248,91,207,134],
    ['C',196,145,185,159,177,172], ['L',173,171], ['L',197,101], ['L',191,97],
    ['L',173,104], ['C',153,103,138,104,120,108]
  ];

  const LAYERS = [
    { id: 'outer-ring', color: 0x08005e, radius: 2.06, inner: 1.90, depth: .27, z: -.20, offset: [-.22,.10,-1.05], tilt: [-.035,-.04,-.025] },
    { id: 'amber-ring', color: 0xff8900, radius: 1.88, inner: 1.77, holeY: .055, depth: .24, z: -.10, offset: [-.08,.03,-.35], tilt: [.02,.025,.018] },
    { id: 'gold-core', color: 0xffcf00, radius: 1.75, inner: 0, y: .055, depth: .18, z: 0, offset: [.10,-.03,.45], tilt: [-.015,-.025,-.01] },
    { id: 'monogram', color: 0x08005e, depth: .15, z: .20, offset: [.23,-.10,1.30], tilt: [.025,.04,.035] }
  ];

  function createShape(THREE, layer) {
    const shape = new THREE.Shape();
    // Unique contour vertices avoid a duplicate endpoint pinching the circular bevel.
    function circle(path, radius, centerY = 0, clockwise = false) {
      for (let i = 0; i < 128; i++) {
        const angle = (clockwise ? -1 : 1) * i / 128 * Math.PI * 2;
        const x = Math.cos(angle) * radius, y = centerY + Math.sin(angle) * radius;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
    }
    if (layer.radius) {
      circle(shape, layer.radius);
      if (layer.inner) {
        const hole = new THREE.Path();
        circle(hole, layer.inner, layer.holeY || 0, true);
        shape.holes.push(hole);
      }
    } else {
      MONOGRAM.forEach(([command, ...points]) => {
        const values = points.map((value, i) => i % 2 ? (208 - value) / 100 : (value - 208) / 100);
        if (command === 'M') shape.moveTo(...values);
        else if (command === 'L') shape.lineTo(...values);
        else shape.bezierCurveTo(...values);
      });
      shape.closePath();
    }
    return shape;
  }

  function createGoldTexture(THREE) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const gradient = ctx.createLinearGradient(90, 0, 380, 512);
    gradient.addColorStop(0, '#fff000');
    gradient.addColorStop(.48, '#ffb600');
    gradient.addColorStop(1, '#ffe600');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);
    // The source's broad curved upper sheen is a color feature, not a fake depth map.
    ctx.save();
    ctx.scale(512 / 350, 512 / 350);
    ctx.translate(-33, -27.5);
    const sheen = ctx.createLinearGradient(0, 28, 0, 215);
    sheen.addColorStop(0, 'rgba(255,255,30,.65)');
    sheen.addColorStop(1, 'rgba(255,222,8,.30)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.moveTo(48, 156);
    ctx.bezierCurveTo(70, 75, 120, 28, 208, 28);
    ctx.bezierCurveTo(296, 28, 357, 88, 371, 156);
    ctx.bezierCurveTo(392, 235, 350, 207, 292, 195);
    ctx.bezierCurveTo(224, 177, 176, 179, 122, 193);
    ctx.bezierCurveTo(60, 211, 40, 203, 48, 156);
    ctx.fill();
    ctx.restore();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function createNossaArteLogo(THREE) {
    const root = new THREE.Group();
    root.name = 'nossa-arte-logo';
    const goldTexture = createGoldTexture(THREE);
    const materials = {
      navy: new THREE.MeshPhysicalMaterial({ color: 0x08005e, roughness: .32, metalness: .05, clearcoat: .4, clearcoatRoughness: .24 }),
      amber: new THREE.MeshPhysicalMaterial({ color: 0xff8900, roughness: .30, metalness: .08, clearcoat: .5, clearcoatRoughness: .24 }),
      gold: new THREE.MeshPhysicalMaterial({ color: goldTexture ? 0xffffff : 0xffcf00, map: goldTexture, roughness: .27, metalness: .16, clearcoat: .65, clearcoatRoughness: .24 })
    };
    const nodes = new Map();
    const sockets = new Map();
    const parts = LAYERS.map(layer => {
      const pivot = new THREE.Group();
      pivot.name = layer.id;
      pivot.position.z = layer.z;
      pivot.position.y = layer.y || 0;
      pivot.userData = {
        restPosition: pivot.position.clone(),
        explodeOffset: new THREE.Vector3(...layer.offset),
        explodeTilt: new THREE.Vector3(...layer.tilt),
        collider: { type: 'box', depth: layer.depth },
        fractureGroup: layer.id
      };
      const geometry = new THREE.ExtrudeGeometry(createShape(THREE, layer), {
        // The narrow concave joins of the mark need sharp edges to avoid bevel overlap.
        depth: layer.depth, bevelEnabled: layer.id !== 'monogram', steps: 1,
        bevelSize: layer.id === 'monogram' ? .012 : .022,
        bevelThickness: layer.id === 'monogram' ? .012 : .022,
        bevelSegments: 3, curveSegments: layer.radius ? 48 : 12
      });
      if (layer.id === 'gold-core') {
        const positions = geometry.attributes.position, uv = geometry.attributes.uv;
        for (let i = 0; i < positions.count; i++) {
          uv.setXY(i, (positions.getX(i) / (layer.radius * 2)) + .5, (positions.getY(i) / (layer.radius * 2)) + .5);
        }
      }
      const material = layer.id === 'gold-core' ? materials.gold : layer.id === 'amber-ring' ? materials.amber : materials.navy;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `${layer.id}-surface`;
      mesh.userData.partId = layer.id;
      mesh.userData.explodeWithParent = true;
      pivot.add(mesh);
      const socket = new THREE.Object3D();
      socket.name = `${layer.id}-center`;
      pivot.add(socket);
      root.add(pivot);
      nodes.set(layer.id, pivot);
      sockets.set(socket.name, socket);
      return pivot;
    });
    root.userData.sculptRuntime = { nodes, sockets, parts };
    // Always evaluate from rest transforms: rapid enter/leave never accumulates drift.
    // Accept either a shared amount or per-layer states for the GSAP stagger.
    function setExplode(amount, pointerX = 0, pointerY = 0) {
      parts.forEach((part, index) => {
        const progress = typeof amount === 'number' ? amount : amount[index].amount;
        const { restPosition, explodeOffset, explodeTilt } = part.userData;
        part.position.copy(restPosition).addScaledVector(explodeOffset, progress);
        part.position.x += pointerX * progress * index * .022;
        part.position.y += pointerY * progress * index * .018;
        part.rotation.set(explodeTilt.x * progress, explodeTilt.y * progress, explodeTilt.z * progress);
      });
    }
    function dispose() {
      parts.forEach(part => part.children.forEach(child => child.geometry?.dispose()));
      Object.values(materials).forEach(material => material.dispose());
      goldTexture?.dispose();
    }
    return { root, parts, setExplode, dispose };
  }

  function createStudioLighting(THREE, scene) {
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xfff8ec, 2.6);
    key.position.set(-3, 5, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -3.5, right: 3.5, top: 3.5, bottom: -3.5, near: 1, far: 20 });
    key.shadow.normalBias = .018;
    key.shadow.bias = -.00015;
    key.shadow.radius = 3;
    key.shadow.intensity = .38;
    const fill = new THREE.DirectionalLight(0xd9e6ff, .9);
    fill.position.set(4, -1, 4);
    const rim = new THREE.DirectionalLight(0xffdc9b, 1.6);
    rim.position.set(-2, 1, -4);
    scene.add(key, fill, rim);
    return { key, fill, rim };
  }

  window.NossaArteLogo = Object.freeze({ create: createNossaArteLogo, light: createStudioLighting });
})();
