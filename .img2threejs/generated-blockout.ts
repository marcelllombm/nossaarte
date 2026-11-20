import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Nossa Arte Logo
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createNossaArteLogoModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Nossa Arte Logo";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": true, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0, 0, 12], "note": "Front orthographic matches graphic with 4.2-unit review viewport.", "projection": "orthographic", "orthoHeight": 4.2}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["navy"] = createSculptMaterial(
    "navy",
    {"id": "navy", "name": "navy", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#08005e", "color": "#08005e", "albedo": {"dominant": "#08005e", "secondary": ["#08005e"], "samplingNotes": "Visible flat graphic regions; gold procedural gradient."}, "colorVariation": {"palette": ["#08005e"], "pattern": "solid", "amplitude": 0}, "roughness": {"base": 0.32, "localResponse": "clean satin enamel"}, "metalness": {"base": 0.05, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "navy-bevel-response", "region": "chamfer", "roughness": 0.32, "evidenceRefs": ["full-object"]}], "shaderNotes": ["No noise or photographic PBR maps: reference is flat vector-style art. Physical response is inferred from requested gloss."], "notes": "Clean illustrated enamel, no photographic surface noise.", "clearcoat": 0.65, "clearcoatRoughness": 0.24, "textureless": {"declared": true, "evidence": ["img/logo.png: flat vector-style color and smooth gradient, no grain, pores, scratches or photographic surface detail."]}},
    options
  );
  materialMap["amber"] = createSculptMaterial(
    "amber",
    {"id": "amber", "name": "amber", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ff8900", "color": "#ff8900", "albedo": {"dominant": "#ff8900", "secondary": ["#ff8900"], "samplingNotes": "Visible flat graphic regions; gold procedural gradient."}, "colorVariation": {"palette": ["#ff8900"], "pattern": "solid", "amplitude": 0}, "roughness": {"base": 0.3, "localResponse": "clean satin enamel"}, "metalness": {"base": 0.08, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "amber-bevel-response", "region": "chamfer", "roughness": 0.3, "evidenceRefs": ["full-object"]}], "shaderNotes": ["No noise or photographic PBR maps: reference is flat vector-style art. Physical response is inferred from requested gloss."], "notes": "Clean illustrated enamel, no photographic surface noise.", "clearcoat": 0.65, "clearcoatRoughness": 0.24, "textureless": {"declared": true, "evidence": ["img/logo.png: flat vector-style color and smooth gradient, no grain, pores, scratches or photographic surface detail."]}},
    options
  );
  materialMap["gold"] = createSculptMaterial(
    "gold",
    {"id": "gold", "name": "gold", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ffcf00", "color": "#ffcf00", "albedo": {"dominant": "#ffcf00", "secondary": ["#ffcf00"], "samplingNotes": "Visible flat graphic regions; gold procedural gradient."}, "colorVariation": {"palette": ["#ffcf00"], "pattern": "gold-gradient", "amplitude": 0.2}, "roughness": {"base": 0.27, "localResponse": "clean satin enamel"}, "metalness": {"base": 0.16, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "gold-bevel-response", "region": "chamfer", "roughness": 0.27, "evidenceRefs": ["full-object"]}], "shaderNotes": ["No noise or photographic PBR maps: reference is flat vector-style art. Physical response is inferred from requested gloss."], "notes": "Clean illustrated enamel, no photographic surface noise.", "clearcoat": 0.65, "clearcoatRoughness": 0.24, "textureless": {"declared": true, "evidence": ["img/logo.png: flat vector-style color and smooth gradient, no grain, pores, scratches or photographic surface detail."]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "root", "level": "macro", "role": "container", "importance": 1.0, "confidence": 0.5, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Invisible unit-scale transform container; the four children own all visible solids.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "navy", "materialLayers": ["navy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(8, 0, 94, 1)", "secondaryAlbedo": "rgba(8, 0, 94, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "root", "level": "macro", "role": "container", "importance": 1.0, "confidence": 0.5, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Invisible unit-scale transform container; the four children own all visible solids.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "navy", "materialLayers": ["navy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(8, 0, 94, 1)", "secondaryAlbedo": "rgba(8, 0, 94, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_outer_ring_1 = makeAttachmentEndpoint(null);
  const node_outer_ring_1 = new THREE.Group();
  node_outer_ring_1.name = "outer-ring__pivot";
  node_outer_ring_1.scale.set(1, 1, 1);
  if (endpoint_outer_ring_1) {
    node_outer_ring_1.position.copy(endpoint_outer_ring_1.start);
    node_outer_ring_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_outer_ring_1.position.set(0.0, 0.0, -0.2);
    node_outer_ring_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_outer_ring_1.userData.sculptComponent = {"id": "outer-ring", "name": "outer-ring", "level": "macro", "role": "layer", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.", "geometryDescriptor": {"topologyIntent": "Closed extruded annulus", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.022, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[2.06, 0.0], [2.055589381871523, 0.13473044621409472], [2.0423764144300494, 0.2688839559733062], [2.020417677630655, 0.4018860633532242], [1.9898072021554807, 0.5331672329111927], [1.9506760667599177, 0.6621652985245129], [1.9031918369732508, 0.788327870672085], [1.847557847557338, 0.9111147018511426], [1.7840123317959438, 1.0299999999999998], [1.7128274013432432, 1.1444746800203804], [1.6343078809999445, 1.2540485437579645], [1.5487900034066937, 1.3582523791061418], [1.456639969244288, 1.4566399692442877], [1.3582523791061418, 1.5487900034066935], [1.2540485437579645, 1.6343078809999445], [1.1444746800203809, 1.712827401343243], [1.0300000000000002, 1.7840123317959435], [0.9111147018511426, 1.847557847557338], [0.7883278706720851, 1.9031918369732508], [0.6621652985245131, 1.9506760667599174], [0.5331672329111927, 1.9898072021554807], [0.40188606335322435, 2.020417677630655], [0.26888395597330655, 2.0423764144300494], [0.13473044621409513, 2.055589381871523], [1.2613862031217737e-16, 2.06], [-0.13473044621409488, 2.055589381871523], [-0.26888395597330633, 2.0423764144300494], [-0.4018860633532241, 2.020417677630655], [-0.5331672329111925, 1.9898072021554807], [-0.6621652985245129, 1.9506760667599177], [-0.7883278706720844, 1.903191836973251], [-0.9111147018511424, 1.847557847557338], [-1.0299999999999996, 1.7840123317959438], [-1.1444746800203809, 1.712827401343243], [-1.2540485437579645, 1.6343078809999445], [-1.3582523791061418, 1.5487900034066935], [-1.4566399692442877, 1.456639969244288], [-1.5487900034066933, 1.358252379106142], [-1.6343078809999443, 1.2540485437579652], [-1.7128274013432427, 1.144474680020381], [-1.7840123317959438, 1.0299999999999998], [-1.8475578475573375, 0.9111147018511435], [-1.9031918369732508, 0.7883278706720852], [-1.9506760667599174, 0.6621652985245132], [-1.9898072021554805, 0.5331672329111933], [-2.020417677630655, 0.401886063353224], [-2.0423764144300494, 0.2688839559733071], [-2.055589381871523, 0.13473044621409483], [-2.06, 2.5227724062435474e-16], [-2.055589381871523, -0.1347304462140943], [-2.0423764144300494, -0.26888395597330667], [-2.020417677630655, -0.4018860633532235], [-1.9898072021554807, -0.5331672329111928], [-1.9506760667599177, -0.6621652985245128], [-1.903191836973251, -0.7883278706720848], [-1.8475578475573375, -0.9111147018511431], [-1.784012331795944, -1.0299999999999996], [-1.7128274013432436, -1.14447468002038], [-1.6343078809999445, -1.2540485437579645], [-1.5487900034066937, -1.3582523791061418], [-1.4566399692442886, -1.456639969244287], [-1.3582523791061423, -1.5487900034066933], [-1.2540485437579652, -1.634307880999944], [-1.1444746800203804, -1.7128274013432432], [-1.030000000000001, -1.784012331795943], [-0.9111147018511428, -1.8475578475573378], [-0.7883278706720844, -1.903191836973251], [-0.6621652985245133, -1.9506760667599174], [-0.5331672329111925, -1.9898072021554807], [-0.4018860633532251, -2.0204176776306544], [-0.2688839559733064, -2.0423764144300494], [-0.13473044621409402, -2.055589381871523], [-3.784158609365321e-16, -2.06], [0.13473044621409327, -2.0555893818715236], [0.2688839559733056, -2.04237641443005], [0.4018860633532243, -2.020417677630655], [0.5331672329111918, -1.989807202155481], [0.6621652985245127, -1.9506760667599177], [0.7883278706720838, -1.9031918369732512], [0.9111147018511422, -1.8475578475573382], [1.0300000000000002, -1.7840123317959435], [1.1444746800203798, -1.7128274013432436], [1.254048543757963, -1.6343078809999456], [1.3582523791061423, -1.548790003406693], [1.4566399692442875, -1.4566399692442882], [1.5487900034066937, -1.3582523791061416], [1.634307880999944, -1.2540485437579652], [1.7128274013432423, -1.1444746800203822], [1.784012331795943, -1.030000000000001], [1.8475578475573378, -0.911114701851143], [1.903191836973251, -0.7883278706720845], [1.9506760667599174, -0.6621652985245134], [1.9898072021554802, -0.5331672329111945], [2.0204176776306544, -0.4018860633532252], [2.0423764144300494, -0.2688839559733065], [2.055589381871523, -0.13473044621409416]], "holes": [[[1.9, 0.0], [1.8959319541533466, 0.12426594553727181], [1.8837452366102396, 0.24799976521809797], [1.8634920327661377, 0.3706716118306437], [1.8352590699492297, 0.4917561856947894], [1.7991672460407007, 0.610734984076007], [1.7553711117714448, 0.7270985214936706], [1.704058208912108, 0.8403485114161023], [1.6454482671904336, 0.9499999999999998], [1.5797922633748358, 1.0555834427372441], [1.5073713465533467, 1.1566467151165691], [1.4284956342100572, 1.2527570486901307], [1.3435028842544403, 1.34350288425444], [1.2527570486901307, 1.428495634210057], [1.1566467151165691, 1.5073713465533467], [1.0555834427372446, 1.5797922633748356], [0.9500000000000002, 1.6454482671904334], [0.8403485114161023, 1.704058208912108], [0.7270985214936706, 1.7553711117714448], [0.6107349840760072, 1.7991672460407004], [0.4917561856947894, 1.8352590699492297], [0.3706716118306438, 1.8634920327661377], [0.24799976521809824, 1.8837452366102396], [0.1242659455372722, 1.8959319541533466], [1.1634144591899854e-16, 1.9], [-0.12426594553727197, 1.8959319541533466], [-0.24799976521809802, 1.8837452366102396], [-0.37067161183064357, 1.8634920327661377], [-0.4917561856947892, 1.8352590699492297], [-0.610734984076007, 1.7991672460407007], [-0.72709852149367, 1.755371111771445], [-0.8403485114161021, 1.704058208912108], [-0.9499999999999996, 1.6454482671904336], [-1.0555834427372446, 1.5797922633748356], [-1.1566467151165691, 1.5073713465533467], [-1.2527570486901307, 1.428495634210057], [-1.34350288425444, 1.3435028842544403], [-1.4284956342100568, 1.252757048690131], [-1.5073713465533465, 1.1566467151165696], [-1.5797922633748354, 1.0555834427372448], [-1.6454482671904336, 0.9499999999999998], [-1.7040582089121075, 0.8403485114161031], [-1.7553711117714448, 0.7270985214936707], [-1.7991672460407004, 0.6107349840760073], [-1.8352590699492295, 0.4917561856947899], [-1.8634920327661377, 0.3706716118306435], [-1.8837452366102396, 0.24799976521809877], [-1.8959319541533466, 0.12426594553727191], [-1.9, 2.326828918379971e-16], [-1.8959319541533466, -0.12426594553727144], [-1.8837452366102396, -0.24799976521809836], [-1.863492032766138, -0.370671611830643], [-1.8352590699492297, -0.49175618569478946], [-1.7991672460407007, -0.6107349840760069], [-1.755371111771445, -0.7270985214936704], [-1.7040582089121075, -0.8403485114161028], [-1.6454482671904336, -0.9499999999999995], [-1.5797922633748362, -1.0555834427372437], [-1.5073713465533467, -1.1566467151165691], [-1.4284956342100572, -1.2527570486901307], [-1.343502884254441, -1.3435028842544394], [-1.2527570486901312, -1.4284956342100568], [-1.1566467151165696, -1.5073713465533463], [-1.0555834427372441, -1.5797922633748358], [-0.9500000000000008, -1.645448267190433], [-0.8403485114161026, -1.7040582089121077], [-0.72709852149367, -1.755371111771445], [-0.6107349840760075, -1.7991672460407004], [-0.4917561856947892, -1.8352590699492297], [-0.37067161183064445, -1.8634920327661375], [-0.24799976521809808, -1.8837452366102396], [-0.12426594553727117, -1.8959319541533466], [-3.490243377569956e-16, -1.9], [0.1242659455372705, -1.8959319541533468], [0.24799976521809738, -1.8837452366102398], [0.37067161183064373, -1.8634920327661377], [0.4917561856947885, -1.83525906994923], [0.6107349840760068, -1.7991672460407007], [0.7270985214936694, -1.7553711117714452], [0.8403485114161019, -1.7040582089121081], [0.9500000000000002, -1.6454482671904334], [1.0555834427372435, -1.5797922633748362], [1.1566467151165678, -1.5073713465533478], [1.2527570486901312, -1.4284956342100565], [1.3435028842544399, -1.3435028842544405], [1.4284956342100572, -1.2527570486901305], [1.5073713465533463, -1.1566467151165696], [1.5797922633748351, -1.0555834427372455], [1.645448267190433, -0.9500000000000008], [1.7040582089121077, -0.8403485114161027], [1.755371111771445, -0.7270985214936702], [1.7991672460407004, -0.6107349840760075], [1.8352590699492293, -0.49175618569479096], [1.8634920327661375, -0.37067161183064457], [1.8837452366102396, -0.2479997652180982], [1.8959319541533466, -0.12426594553727131]]], "depth": 0.27}}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, -0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "outer-ring-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "outer-ring", "seamRefs": [], "detachableFragments": ["outer-ring"], "breakImpulse": 0.0, "debrisMaterial": "navy"}}, "material": "navy", "materialLayers": ["navy"], "deformations": [], "joints": [], "seams": ["nested radial contact; gold front meets monogram back"], "localFeatures": [{"id": "rim-profile", "type": "bevel", "description": "19px navy band and small inferred chamfer", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(8, 0, 94, 1)", "secondaryAlbedo": "rgba(8, 0, 94, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_outer_ring_1.userData.actionProfile = {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "outer-ring-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "outer-ring", "seamRefs": [], "detachableFragments": ["outer-ring"], "breakImpulse": 0.0, "debrisMaterial": "navy"}};
  (nodes["root"] ?? root).add(node_outer_ring_1);
  nodes["outer-ring"] = node_outer_ring_1;
  const mesh_outer_ring_1Geometry = endpoint_outer_ring_1
    ? new THREE.CylinderGeometry(endpoint_outer_ring_1.endRadius, endpoint_outer_ring_1.baseRadius, endpoint_outer_ring_1.length, 16, 6)
    : buildExtrudeGeometry({"points": [[2.06, 0.0], [2.055589381871523, 0.13473044621409472], [2.0423764144300494, 0.2688839559733062], [2.020417677630655, 0.4018860633532242], [1.9898072021554807, 0.5331672329111927], [1.9506760667599177, 0.6621652985245129], [1.9031918369732508, 0.788327870672085], [1.847557847557338, 0.9111147018511426], [1.7840123317959438, 1.0299999999999998], [1.7128274013432432, 1.1444746800203804], [1.6343078809999445, 1.2540485437579645], [1.5487900034066937, 1.3582523791061418], [1.456639969244288, 1.4566399692442877], [1.3582523791061418, 1.5487900034066935], [1.2540485437579645, 1.6343078809999445], [1.1444746800203809, 1.712827401343243], [1.0300000000000002, 1.7840123317959435], [0.9111147018511426, 1.847557847557338], [0.7883278706720851, 1.9031918369732508], [0.6621652985245131, 1.9506760667599174], [0.5331672329111927, 1.9898072021554807], [0.40188606335322435, 2.020417677630655], [0.26888395597330655, 2.0423764144300494], [0.13473044621409513, 2.055589381871523], [1.2613862031217737e-16, 2.06], [-0.13473044621409488, 2.055589381871523], [-0.26888395597330633, 2.0423764144300494], [-0.4018860633532241, 2.020417677630655], [-0.5331672329111925, 1.9898072021554807], [-0.6621652985245129, 1.9506760667599177], [-0.7883278706720844, 1.903191836973251], [-0.9111147018511424, 1.847557847557338], [-1.0299999999999996, 1.7840123317959438], [-1.1444746800203809, 1.712827401343243], [-1.2540485437579645, 1.6343078809999445], [-1.3582523791061418, 1.5487900034066935], [-1.4566399692442877, 1.456639969244288], [-1.5487900034066933, 1.358252379106142], [-1.6343078809999443, 1.2540485437579652], [-1.7128274013432427, 1.144474680020381], [-1.7840123317959438, 1.0299999999999998], [-1.8475578475573375, 0.9111147018511435], [-1.9031918369732508, 0.7883278706720852], [-1.9506760667599174, 0.6621652985245132], [-1.9898072021554805, 0.5331672329111933], [-2.020417677630655, 0.401886063353224], [-2.0423764144300494, 0.2688839559733071], [-2.055589381871523, 0.13473044621409483], [-2.06, 2.5227724062435474e-16], [-2.055589381871523, -0.1347304462140943], [-2.0423764144300494, -0.26888395597330667], [-2.020417677630655, -0.4018860633532235], [-1.9898072021554807, -0.5331672329111928], [-1.9506760667599177, -0.6621652985245128], [-1.903191836973251, -0.7883278706720848], [-1.8475578475573375, -0.9111147018511431], [-1.784012331795944, -1.0299999999999996], [-1.7128274013432436, -1.14447468002038], [-1.6343078809999445, -1.2540485437579645], [-1.5487900034066937, -1.3582523791061418], [-1.4566399692442886, -1.456639969244287], [-1.3582523791061423, -1.5487900034066933], [-1.2540485437579652, -1.634307880999944], [-1.1444746800203804, -1.7128274013432432], [-1.030000000000001, -1.784012331795943], [-0.9111147018511428, -1.8475578475573378], [-0.7883278706720844, -1.903191836973251], [-0.6621652985245133, -1.9506760667599174], [-0.5331672329111925, -1.9898072021554807], [-0.4018860633532251, -2.0204176776306544], [-0.2688839559733064, -2.0423764144300494], [-0.13473044621409402, -2.055589381871523], [-3.784158609365321e-16, -2.06], [0.13473044621409327, -2.0555893818715236], [0.2688839559733056, -2.04237641443005], [0.4018860633532243, -2.020417677630655], [0.5331672329111918, -1.989807202155481], [0.6621652985245127, -1.9506760667599177], [0.7883278706720838, -1.9031918369732512], [0.9111147018511422, -1.8475578475573382], [1.0300000000000002, -1.7840123317959435], [1.1444746800203798, -1.7128274013432436], [1.254048543757963, -1.6343078809999456], [1.3582523791061423, -1.548790003406693], [1.4566399692442875, -1.4566399692442882], [1.5487900034066937, -1.3582523791061416], [1.634307880999944, -1.2540485437579652], [1.7128274013432423, -1.1444746800203822], [1.784012331795943, -1.030000000000001], [1.8475578475573378, -0.911114701851143], [1.903191836973251, -0.7883278706720845], [1.9506760667599174, -0.6621652985245134], [1.9898072021554802, -0.5331672329111945], [2.0204176776306544, -0.4018860633532252], [2.0423764144300494, -0.2688839559733065], [2.055589381871523, -0.13473044621409416]], "holes": [[[1.9, 0.0], [1.8959319541533466, 0.12426594553727181], [1.8837452366102396, 0.24799976521809797], [1.8634920327661377, 0.3706716118306437], [1.8352590699492297, 0.4917561856947894], [1.7991672460407007, 0.610734984076007], [1.7553711117714448, 0.7270985214936706], [1.704058208912108, 0.8403485114161023], [1.6454482671904336, 0.9499999999999998], [1.5797922633748358, 1.0555834427372441], [1.5073713465533467, 1.1566467151165691], [1.4284956342100572, 1.2527570486901307], [1.3435028842544403, 1.34350288425444], [1.2527570486901307, 1.428495634210057], [1.1566467151165691, 1.5073713465533467], [1.0555834427372446, 1.5797922633748356], [0.9500000000000002, 1.6454482671904334], [0.8403485114161023, 1.704058208912108], [0.7270985214936706, 1.7553711117714448], [0.6107349840760072, 1.7991672460407004], [0.4917561856947894, 1.8352590699492297], [0.3706716118306438, 1.8634920327661377], [0.24799976521809824, 1.8837452366102396], [0.1242659455372722, 1.8959319541533466], [1.1634144591899854e-16, 1.9], [-0.12426594553727197, 1.8959319541533466], [-0.24799976521809802, 1.8837452366102396], [-0.37067161183064357, 1.8634920327661377], [-0.4917561856947892, 1.8352590699492297], [-0.610734984076007, 1.7991672460407007], [-0.72709852149367, 1.755371111771445], [-0.8403485114161021, 1.704058208912108], [-0.9499999999999996, 1.6454482671904336], [-1.0555834427372446, 1.5797922633748356], [-1.1566467151165691, 1.5073713465533467], [-1.2527570486901307, 1.428495634210057], [-1.34350288425444, 1.3435028842544403], [-1.4284956342100568, 1.252757048690131], [-1.5073713465533465, 1.1566467151165696], [-1.5797922633748354, 1.0555834427372448], [-1.6454482671904336, 0.9499999999999998], [-1.7040582089121075, 0.8403485114161031], [-1.7553711117714448, 0.7270985214936707], [-1.7991672460407004, 0.6107349840760073], [-1.8352590699492295, 0.4917561856947899], [-1.8634920327661377, 0.3706716118306435], [-1.8837452366102396, 0.24799976521809877], [-1.8959319541533466, 0.12426594553727191], [-1.9, 2.326828918379971e-16], [-1.8959319541533466, -0.12426594553727144], [-1.8837452366102396, -0.24799976521809836], [-1.863492032766138, -0.370671611830643], [-1.8352590699492297, -0.49175618569478946], [-1.7991672460407007, -0.6107349840760069], [-1.755371111771445, -0.7270985214936704], [-1.7040582089121075, -0.8403485114161028], [-1.6454482671904336, -0.9499999999999995], [-1.5797922633748362, -1.0555834427372437], [-1.5073713465533467, -1.1566467151165691], [-1.4284956342100572, -1.2527570486901307], [-1.343502884254441, -1.3435028842544394], [-1.2527570486901312, -1.4284956342100568], [-1.1566467151165696, -1.5073713465533463], [-1.0555834427372441, -1.5797922633748358], [-0.9500000000000008, -1.645448267190433], [-0.8403485114161026, -1.7040582089121077], [-0.72709852149367, -1.755371111771445], [-0.6107349840760075, -1.7991672460407004], [-0.4917561856947892, -1.8352590699492297], [-0.37067161183064445, -1.8634920327661375], [-0.24799976521809808, -1.8837452366102396], [-0.12426594553727117, -1.8959319541533466], [-3.490243377569956e-16, -1.9], [0.1242659455372705, -1.8959319541533468], [0.24799976521809738, -1.8837452366102398], [0.37067161183064373, -1.8634920327661377], [0.4917561856947885, -1.83525906994923], [0.6107349840760068, -1.7991672460407007], [0.7270985214936694, -1.7553711117714452], [0.8403485114161019, -1.7040582089121081], [0.9500000000000002, -1.6454482671904334], [1.0555834427372435, -1.5797922633748362], [1.1566467151165678, -1.5073713465533478], [1.2527570486901312, -1.4284956342100565], [1.3435028842544399, -1.3435028842544405], [1.4284956342100572, -1.2527570486901305], [1.5073713465533463, -1.1566467151165696], [1.5797922633748351, -1.0555834427372455], [1.645448267190433, -0.9500000000000008], [1.7040582089121077, -0.8403485114161027], [1.755371111771445, -0.7270985214936702], [1.7991672460407004, -0.6107349840760075], [1.8352590699492293, -0.49175618569479096], [1.8634920327661375, -0.37067161183064457], [1.8837452366102396, -0.2479997652180982], [1.8959319541533466, -0.12426594553727131]]], "depth": 0.27});
  if (!endpoint_outer_ring_1) {
    mesh_outer_ring_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_outer_ring_1 = new THREE.Mesh(
    mesh_outer_ring_1Geometry,
    materialMap["navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_outer_ring_1.name = "outer-ring";
  if (endpoint_outer_ring_1) {
    mesh_outer_ring_1.position.copy(endpoint_outer_ring_1.midpoint);
    mesh_outer_ring_1.quaternion.copy(endpoint_outer_ring_1.quaternion);
  }
  mesh_outer_ring_1.castShadow = options.castShadow ?? true;
  mesh_outer_ring_1.receiveShadow = options.receiveShadow ?? true;
  mesh_outer_ring_1.userData.sculptComponent = {"id": "outer-ring", "name": "outer-ring", "level": "macro", "role": "layer", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.", "geometryDescriptor": {"topologyIntent": "Closed extruded annulus", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.022, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[2.06, 0.0], [2.055589381871523, 0.13473044621409472], [2.0423764144300494, 0.2688839559733062], [2.020417677630655, 0.4018860633532242], [1.9898072021554807, 0.5331672329111927], [1.9506760667599177, 0.6621652985245129], [1.9031918369732508, 0.788327870672085], [1.847557847557338, 0.9111147018511426], [1.7840123317959438, 1.0299999999999998], [1.7128274013432432, 1.1444746800203804], [1.6343078809999445, 1.2540485437579645], [1.5487900034066937, 1.3582523791061418], [1.456639969244288, 1.4566399692442877], [1.3582523791061418, 1.5487900034066935], [1.2540485437579645, 1.6343078809999445], [1.1444746800203809, 1.712827401343243], [1.0300000000000002, 1.7840123317959435], [0.9111147018511426, 1.847557847557338], [0.7883278706720851, 1.9031918369732508], [0.6621652985245131, 1.9506760667599174], [0.5331672329111927, 1.9898072021554807], [0.40188606335322435, 2.020417677630655], [0.26888395597330655, 2.0423764144300494], [0.13473044621409513, 2.055589381871523], [1.2613862031217737e-16, 2.06], [-0.13473044621409488, 2.055589381871523], [-0.26888395597330633, 2.0423764144300494], [-0.4018860633532241, 2.020417677630655], [-0.5331672329111925, 1.9898072021554807], [-0.6621652985245129, 1.9506760667599177], [-0.7883278706720844, 1.903191836973251], [-0.9111147018511424, 1.847557847557338], [-1.0299999999999996, 1.7840123317959438], [-1.1444746800203809, 1.712827401343243], [-1.2540485437579645, 1.6343078809999445], [-1.3582523791061418, 1.5487900034066935], [-1.4566399692442877, 1.456639969244288], [-1.5487900034066933, 1.358252379106142], [-1.6343078809999443, 1.2540485437579652], [-1.7128274013432427, 1.144474680020381], [-1.7840123317959438, 1.0299999999999998], [-1.8475578475573375, 0.9111147018511435], [-1.9031918369732508, 0.7883278706720852], [-1.9506760667599174, 0.6621652985245132], [-1.9898072021554805, 0.5331672329111933], [-2.020417677630655, 0.401886063353224], [-2.0423764144300494, 0.2688839559733071], [-2.055589381871523, 0.13473044621409483], [-2.06, 2.5227724062435474e-16], [-2.055589381871523, -0.1347304462140943], [-2.0423764144300494, -0.26888395597330667], [-2.020417677630655, -0.4018860633532235], [-1.9898072021554807, -0.5331672329111928], [-1.9506760667599177, -0.6621652985245128], [-1.903191836973251, -0.7883278706720848], [-1.8475578475573375, -0.9111147018511431], [-1.784012331795944, -1.0299999999999996], [-1.7128274013432436, -1.14447468002038], [-1.6343078809999445, -1.2540485437579645], [-1.5487900034066937, -1.3582523791061418], [-1.4566399692442886, -1.456639969244287], [-1.3582523791061423, -1.5487900034066933], [-1.2540485437579652, -1.634307880999944], [-1.1444746800203804, -1.7128274013432432], [-1.030000000000001, -1.784012331795943], [-0.9111147018511428, -1.8475578475573378], [-0.7883278706720844, -1.903191836973251], [-0.6621652985245133, -1.9506760667599174], [-0.5331672329111925, -1.9898072021554807], [-0.4018860633532251, -2.0204176776306544], [-0.2688839559733064, -2.0423764144300494], [-0.13473044621409402, -2.055589381871523], [-3.784158609365321e-16, -2.06], [0.13473044621409327, -2.0555893818715236], [0.2688839559733056, -2.04237641443005], [0.4018860633532243, -2.020417677630655], [0.5331672329111918, -1.989807202155481], [0.6621652985245127, -1.9506760667599177], [0.7883278706720838, -1.9031918369732512], [0.9111147018511422, -1.8475578475573382], [1.0300000000000002, -1.7840123317959435], [1.1444746800203798, -1.7128274013432436], [1.254048543757963, -1.6343078809999456], [1.3582523791061423, -1.548790003406693], [1.4566399692442875, -1.4566399692442882], [1.5487900034066937, -1.3582523791061416], [1.634307880999944, -1.2540485437579652], [1.7128274013432423, -1.1444746800203822], [1.784012331795943, -1.030000000000001], [1.8475578475573378, -0.911114701851143], [1.903191836973251, -0.7883278706720845], [1.9506760667599174, -0.6621652985245134], [1.9898072021554802, -0.5331672329111945], [2.0204176776306544, -0.4018860633532252], [2.0423764144300494, -0.2688839559733065], [2.055589381871523, -0.13473044621409416]], "holes": [[[1.9, 0.0], [1.8959319541533466, 0.12426594553727181], [1.8837452366102396, 0.24799976521809797], [1.8634920327661377, 0.3706716118306437], [1.8352590699492297, 0.4917561856947894], [1.7991672460407007, 0.610734984076007], [1.7553711117714448, 0.7270985214936706], [1.704058208912108, 0.8403485114161023], [1.6454482671904336, 0.9499999999999998], [1.5797922633748358, 1.0555834427372441], [1.5073713465533467, 1.1566467151165691], [1.4284956342100572, 1.2527570486901307], [1.3435028842544403, 1.34350288425444], [1.2527570486901307, 1.428495634210057], [1.1566467151165691, 1.5073713465533467], [1.0555834427372446, 1.5797922633748356], [0.9500000000000002, 1.6454482671904334], [0.8403485114161023, 1.704058208912108], [0.7270985214936706, 1.7553711117714448], [0.6107349840760072, 1.7991672460407004], [0.4917561856947894, 1.8352590699492297], [0.3706716118306438, 1.8634920327661377], [0.24799976521809824, 1.8837452366102396], [0.1242659455372722, 1.8959319541533466], [1.1634144591899854e-16, 1.9], [-0.12426594553727197, 1.8959319541533466], [-0.24799976521809802, 1.8837452366102396], [-0.37067161183064357, 1.8634920327661377], [-0.4917561856947892, 1.8352590699492297], [-0.610734984076007, 1.7991672460407007], [-0.72709852149367, 1.755371111771445], [-0.8403485114161021, 1.704058208912108], [-0.9499999999999996, 1.6454482671904336], [-1.0555834427372446, 1.5797922633748356], [-1.1566467151165691, 1.5073713465533467], [-1.2527570486901307, 1.428495634210057], [-1.34350288425444, 1.3435028842544403], [-1.4284956342100568, 1.252757048690131], [-1.5073713465533465, 1.1566467151165696], [-1.5797922633748354, 1.0555834427372448], [-1.6454482671904336, 0.9499999999999998], [-1.7040582089121075, 0.8403485114161031], [-1.7553711117714448, 0.7270985214936707], [-1.7991672460407004, 0.6107349840760073], [-1.8352590699492295, 0.4917561856947899], [-1.8634920327661377, 0.3706716118306435], [-1.8837452366102396, 0.24799976521809877], [-1.8959319541533466, 0.12426594553727191], [-1.9, 2.326828918379971e-16], [-1.8959319541533466, -0.12426594553727144], [-1.8837452366102396, -0.24799976521809836], [-1.863492032766138, -0.370671611830643], [-1.8352590699492297, -0.49175618569478946], [-1.7991672460407007, -0.6107349840760069], [-1.755371111771445, -0.7270985214936704], [-1.7040582089121075, -0.8403485114161028], [-1.6454482671904336, -0.9499999999999995], [-1.5797922633748362, -1.0555834427372437], [-1.5073713465533467, -1.1566467151165691], [-1.4284956342100572, -1.2527570486901307], [-1.343502884254441, -1.3435028842544394], [-1.2527570486901312, -1.4284956342100568], [-1.1566467151165696, -1.5073713465533463], [-1.0555834427372441, -1.5797922633748358], [-0.9500000000000008, -1.645448267190433], [-0.8403485114161026, -1.7040582089121077], [-0.72709852149367, -1.755371111771445], [-0.6107349840760075, -1.7991672460407004], [-0.4917561856947892, -1.8352590699492297], [-0.37067161183064445, -1.8634920327661375], [-0.24799976521809808, -1.8837452366102396], [-0.12426594553727117, -1.8959319541533466], [-3.490243377569956e-16, -1.9], [0.1242659455372705, -1.8959319541533468], [0.24799976521809738, -1.8837452366102398], [0.37067161183064373, -1.8634920327661377], [0.4917561856947885, -1.83525906994923], [0.6107349840760068, -1.7991672460407007], [0.7270985214936694, -1.7553711117714452], [0.8403485114161019, -1.7040582089121081], [0.9500000000000002, -1.6454482671904334], [1.0555834427372435, -1.5797922633748362], [1.1566467151165678, -1.5073713465533478], [1.2527570486901312, -1.4284956342100565], [1.3435028842544399, -1.3435028842544405], [1.4284956342100572, -1.2527570486901305], [1.5073713465533463, -1.1566467151165696], [1.5797922633748351, -1.0555834427372455], [1.645448267190433, -0.9500000000000008], [1.7040582089121077, -0.8403485114161027], [1.755371111771445, -0.7270985214936702], [1.7991672460407004, -0.6107349840760075], [1.8352590699492293, -0.49175618569479096], [1.8634920327661375, -0.37067161183064457], [1.8837452366102396, -0.2479997652180982], [1.8959319541533466, -0.12426594553727131]]], "depth": 0.27}}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, -0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "outer-ring-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "outer-ring", "seamRefs": [], "detachableFragments": ["outer-ring"], "breakImpulse": 0.0, "debrisMaterial": "navy"}}, "material": "navy", "materialLayers": ["navy"], "deformations": [], "joints": [], "seams": ["nested radial contact; gold front meets monogram back"], "localFeatures": [{"id": "rim-profile", "type": "bevel", "description": "19px navy band and small inferred chamfer", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(8, 0, 94, 1)", "secondaryAlbedo": "rgba(8, 0, 94, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_outer_ring_1.add(mesh_outer_ring_1);
  meshes["outer-ring"] = mesh_outer_ring_1;
  colliders["outer-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["outer-ring"] ??= [];
  destructionGroups["outer-ring"].push(node_outer_ring_1);
  const socket_outer_ring_outer_ring_center_0 = new THREE.Object3D();
  socket_outer_ring_outer_ring_center_0.name = "outer-ring-center";
  socket_outer_ring_outer_ring_center_0.position.set(0.0, 0.0, 0.0);
  socket_outer_ring_outer_ring_center_0.rotation.set(0, 0, 0);
  socket_outer_ring_outer_ring_center_0.userData.socket = {"id": "outer-ring-center", "position": [0, 0, 0]};
  node_outer_ring_1.add(socket_outer_ring_outer_ring_center_0);
  sockets["outer-ring:outer-ring-center"] = socket_outer_ring_outer_ring_center_0;

  const endpoint_amber_ring_2 = makeAttachmentEndpoint(null);
  const node_amber_ring_2 = new THREE.Group();
  node_amber_ring_2.name = "amber-ring__pivot";
  node_amber_ring_2.scale.set(1, 1, 1);
  if (endpoint_amber_ring_2) {
    node_amber_ring_2.position.copy(endpoint_amber_ring_2.start);
    node_amber_ring_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_amber_ring_2.position.set(0.0, 0.0, -0.1);
    node_amber_ring_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_amber_ring_2.userData.sculptComponent = {"id": "amber-ring", "name": "amber-ring", "level": "macro", "role": "layer", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.", "geometryDescriptor": {"topologyIntent": "Closed extruded annulus", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.022, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[1.91, 0.0], [1.9059105433857326, 0.12491997682957325], [1.8936596852239778, 0.2493050271402985], [1.8732998855701701, 0.37262251505080496], [1.8449183282121204, 0.4943443761458146], [1.8086365473356518, 0.6139493787290387], [1.7646099070965575, 0.7309253558173214], [1.7130269363274346, 0.8447713983182924], [1.6541085212282778, 0.9549999999999998], [1.5881069594978614, 1.0611391450674401], [1.5153048799562592, 1.1627343294066563], [1.436014032284847, 1.2593505068411315], [1.3505739520663058, 1.3505739520663056], [1.2593505068411315, 1.4360140322848467], [1.1627343294066563, 1.5153048799562592], [1.0611391450674406, 1.5881069594978612], [0.9550000000000002, 1.6541085212282776], [0.8447713983182924, 1.7130269363274346], [0.7309253558173215, 1.7646099070965575], [0.6139493787290388, 1.8086365473356516], [0.4943443761458146, 1.8449183282121204], [0.37262251505080507, 1.8732998855701701], [0.24930502714029876, 1.8936596852239778], [0.12491997682957363, 1.9059105433857326], [1.1695376931857223e-16, 1.91], [-0.1249199768295734, 1.9059105433857326], [-0.24930502714029854, 1.8936596852239778], [-0.37262251505080485, 1.8732998855701701], [-0.4943443761458144, 1.8449183282121204], [-0.6139493787290387, 1.8086365473356518], [-0.7309253558173209, 1.7646099070965577], [-0.8447713983182922, 1.7130269363274346], [-0.9549999999999996, 1.6541085212282778], [-1.0611391450674406, 1.5881069594978612], [-1.1627343294066563, 1.5153048799562592], [-1.2593505068411315, 1.4360140322848467], [-1.3505739520663056, 1.3505739520663058], [-1.4360140322848465, 1.2593505068411317], [-1.515304879956259, 1.1627343294066568], [-1.588106959497861, 1.0611391450674408], [-1.6541085212282778, 0.9549999999999998], [-1.7130269363274342, 0.8447713983182932], [-1.7646099070965575, 0.7309253558173217], [-1.8086365473356516, 0.6139493787290389], [-1.8449183282121202, 0.4943443761458151], [-1.8732998855701701, 0.3726225150508048], [-1.8936596852239778, 0.24930502714029928], [-1.9059105433857326, 0.12491997682957334], [-1.91, 2.3390753863714446e-16], [-1.9059105433857326, -0.12491997682957287], [-1.8936596852239778, -0.24930502714029887], [-1.8732998855701704, -0.3726225150508043], [-1.8449183282121204, -0.4943443761458147], [-1.8086365473356518, -0.6139493787290385], [-1.7646099070965577, -0.7309253558173212], [-1.7130269363274342, -0.8447713983182927], [-1.654108521228278, -0.9549999999999995], [-1.5881069594978618, -1.0611391450674397], [-1.5153048799562592, -1.1627343294066563], [-1.436014032284847, -1.2593505068411315], [-1.3505739520663065, -1.350573952066305], [-1.259350506841132, -1.4360140322848465], [-1.1627343294066568, -1.5153048799562587], [-1.0611391450674401, -1.5881069594978614], [-0.9550000000000008, -1.6541085212282771], [-0.8447713983182925, -1.7130269363274344], [-0.7309253558173209, -1.7646099070965577], [-0.613949378729039, -1.8086365473356516], [-0.4943443761458144, -1.8449183282121204], [-0.37262251505080574, -1.87329988557017], [-0.2493050271402986, -1.8936596852239778], [-0.12491997682957261, -1.9059105433857326], [-3.5086130795571667e-16, -1.91], [0.12491997682957191, -1.9059105433857328], [0.24930502714029792, -1.893659685223978], [0.37262251505080507, -1.8732998855701701], [0.4943443761458137, -1.8449183282121207], [0.6139493787290384, -1.8086365473356518], [0.7309253558173203, -1.764609907096558], [0.844771398318292, -1.7130269363274349], [0.9550000000000002, -1.6541085212282776], [1.0611391450674394, -1.5881069594978618], [1.162734329406655, -1.51530487995626], [1.259350506841132, -1.4360140322848463], [1.3505739520663054, -1.350573952066306], [1.436014032284847, -1.2593505068411313], [1.5153048799562587, -1.1627343294066568], [1.5881069594978605, -1.0611391450674417], [1.6541085212282771, -0.9550000000000008], [1.7130269363274344, -0.8447713983182926], [1.7646099070965577, -0.730925355817321], [1.8086365473356516, -0.6139493787290391], [1.84491832821212, -0.49434437614581617], [1.87329988557017, -0.37262251505080585], [1.8936596852239778, -0.2493050271402987], [1.9059105433857326, -0.12491997682957275]], "holes": [[[1.76, 0.0], [1.756231704899942, 0.11510950744505179], [1.7449429560179064, 0.22972609830729077], [1.7261820935096857, 0.34335896674838573], [1.7000294542687602, 0.4555215193804365], [1.666597027911386, 0.5657334589335644], [1.6260279772198647, 0.673522840962558], [1.5784960250975315, 0.7784280947854422], [1.524204710660612, 0.8799999999999999], [1.4633865176524796, 0.9778036101144998], [1.3963018789125738, 1.0714201150553484], [1.3232380611630004, 1.1604486345761211], [1.2445079348883237, 1.2445079348883235], [1.1604486345761211, 1.3232380611630001], [1.0714201150553484, 1.3963018789125738], [0.9778036101145002, 1.4633865176524794], [0.8800000000000002, 1.524204710660612], [0.7784280947854422, 1.5784960250975315], [0.6735228409625581, 1.6260279772198647], [0.5657334589335646, 1.6665970279113858], [0.4555215193804365, 1.7000294542687602], [0.34335896674838584, 1.7261820935096857], [0.22972609830729102, 1.7449429560179064], [0.11510950744505216, 1.756231704899942], [1.0776891832496708e-16, 1.76], [-0.11510950744505194, 1.756231704899942], [-0.22972609830729082, 1.7449429560179064], [-0.3433589667483856, 1.7261820935096857], [-0.45552151938043633, 1.7000294542687602], [-0.5657334589335644, 1.666597027911386], [-0.6735228409625575, 1.626027977219865], [-0.778428094785442, 1.5784960250975315], [-0.8799999999999997, 1.524204710660612], [-0.9778036101145002, 1.4633865176524794], [-1.0714201150553484, 1.3963018789125738], [-1.1604486345761211, 1.3232380611630001], [-1.2445079348883235, 1.2445079348883237], [-1.323238061163, 1.1604486345761214], [-1.3963018789125736, 1.0714201150553488], [-1.4633865176524792, 0.9778036101145005], [-1.524204710660612, 0.8799999999999999], [-1.578496025097531, 0.778428094785443], [-1.6260279772198647, 0.6735228409625582], [-1.6665970279113858, 0.5657334589335646], [-1.70002945426876, 0.455521519380437], [-1.7261820935096857, 0.34335896674838556], [-1.7449429560179064, 0.22972609830729152], [-1.756231704899942, 0.11510950744505188], [-1.76, 2.1553783664993416e-16], [-1.756231704899942, -0.11510950744505145], [-1.7449429560179064, -0.2297260983072911], [-1.7261820935096857, -0.3433589667483851], [-1.7000294542687602, -0.4555215193804366], [-1.666597027911386, -0.5657334589335643], [-1.626027977219865, -0.6735228409625579], [-1.578496025097531, -0.7784280947854426], [-1.5242047106606122, -0.8799999999999996], [-1.46338651765248, -0.9778036101144995], [-1.3963018789125738, -1.0714201150553484], [-1.3232380611630004, -1.1604486345761211], [-1.2445079348883243, -1.244507934888323], [-1.1604486345761216, -1.323238061163], [-1.0714201150553488, -1.3963018789125734], [-0.9778036101144998, -1.4633865176524796], [-0.8800000000000008, -1.5242047106606116], [-0.7784280947854424, -1.5784960250975313], [-0.6735228409625575, -1.626027977219865], [-0.5657334589335647, -1.6665970279113858], [-0.45552151938043633, -1.7000294542687602], [-0.34335896674838645, -1.7261820935096854], [-0.22972609830729088, -1.7449429560179064], [-0.1151095074450512, -1.756231704899942], [-3.233067549749012e-16, -1.76], [0.11510950744505057, -1.7562317048999423], [0.22972609830729024, -1.7449429560179064], [0.34335896674838584, -1.7261820935096857], [0.4555215193804357, -1.7000294542687604], [0.5657334589335642, -1.666597027911386], [0.673522840962557, -1.6260279772198651], [0.7784280947854418, -1.5784960250975317], [0.8800000000000002, -1.524204710660612], [0.9778036101144992, -1.46338651765248], [1.071420115055347, -1.396301878912575], [1.1604486345761216, -1.323238061163], [1.2445079348883235, -1.244507934888324], [1.3232380611630004, -1.160448634576121], [1.3963018789125734, -1.0714201150553488], [1.4633865176524787, -0.9778036101145012], [1.5242047106606116, -0.8800000000000008], [1.5784960250975313, -0.7784280947854425], [1.626027977219865, -0.6735228409625577], [1.6665970279113858, -0.5657334589335649], [1.70002945426876, -0.45552151938043794], [1.7261820935096854, -0.34335896674838656], [1.7449429560179064, -0.22972609830729096], [1.756231704899942, -0.11510950744505133]]], "depth": 0.24}}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, -0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "amber-ring-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "amber-ring", "seamRefs": [], "detachableFragments": ["amber-ring"], "breakImpulse": 0.0, "debrisMaterial": "amber"}}, "material": "amber", "materialLayers": ["amber"], "deformations": [], "joints": [], "seams": ["nested radial contact; gold front meets monogram back"], "localFeatures": [{"id": "amber-profile", "type": "bevel", "description": "amber inset annulus", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 137, 0, 1)", "secondaryAlbedo": "rgba(255, 137, 0, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_amber_ring_2.userData.actionProfile = {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "amber-ring-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "amber-ring", "seamRefs": [], "detachableFragments": ["amber-ring"], "breakImpulse": 0.0, "debrisMaterial": "amber"}};
  (nodes["root"] ?? root).add(node_amber_ring_2);
  nodes["amber-ring"] = node_amber_ring_2;
  const mesh_amber_ring_2Geometry = endpoint_amber_ring_2
    ? new THREE.CylinderGeometry(endpoint_amber_ring_2.endRadius, endpoint_amber_ring_2.baseRadius, endpoint_amber_ring_2.length, 16, 6)
    : buildExtrudeGeometry({"points": [[1.91, 0.0], [1.9059105433857326, 0.12491997682957325], [1.8936596852239778, 0.2493050271402985], [1.8732998855701701, 0.37262251505080496], [1.8449183282121204, 0.4943443761458146], [1.8086365473356518, 0.6139493787290387], [1.7646099070965575, 0.7309253558173214], [1.7130269363274346, 0.8447713983182924], [1.6541085212282778, 0.9549999999999998], [1.5881069594978614, 1.0611391450674401], [1.5153048799562592, 1.1627343294066563], [1.436014032284847, 1.2593505068411315], [1.3505739520663058, 1.3505739520663056], [1.2593505068411315, 1.4360140322848467], [1.1627343294066563, 1.5153048799562592], [1.0611391450674406, 1.5881069594978612], [0.9550000000000002, 1.6541085212282776], [0.8447713983182924, 1.7130269363274346], [0.7309253558173215, 1.7646099070965575], [0.6139493787290388, 1.8086365473356516], [0.4943443761458146, 1.8449183282121204], [0.37262251505080507, 1.8732998855701701], [0.24930502714029876, 1.8936596852239778], [0.12491997682957363, 1.9059105433857326], [1.1695376931857223e-16, 1.91], [-0.1249199768295734, 1.9059105433857326], [-0.24930502714029854, 1.8936596852239778], [-0.37262251505080485, 1.8732998855701701], [-0.4943443761458144, 1.8449183282121204], [-0.6139493787290387, 1.8086365473356518], [-0.7309253558173209, 1.7646099070965577], [-0.8447713983182922, 1.7130269363274346], [-0.9549999999999996, 1.6541085212282778], [-1.0611391450674406, 1.5881069594978612], [-1.1627343294066563, 1.5153048799562592], [-1.2593505068411315, 1.4360140322848467], [-1.3505739520663056, 1.3505739520663058], [-1.4360140322848465, 1.2593505068411317], [-1.515304879956259, 1.1627343294066568], [-1.588106959497861, 1.0611391450674408], [-1.6541085212282778, 0.9549999999999998], [-1.7130269363274342, 0.8447713983182932], [-1.7646099070965575, 0.7309253558173217], [-1.8086365473356516, 0.6139493787290389], [-1.8449183282121202, 0.4943443761458151], [-1.8732998855701701, 0.3726225150508048], [-1.8936596852239778, 0.24930502714029928], [-1.9059105433857326, 0.12491997682957334], [-1.91, 2.3390753863714446e-16], [-1.9059105433857326, -0.12491997682957287], [-1.8936596852239778, -0.24930502714029887], [-1.8732998855701704, -0.3726225150508043], [-1.8449183282121204, -0.4943443761458147], [-1.8086365473356518, -0.6139493787290385], [-1.7646099070965577, -0.7309253558173212], [-1.7130269363274342, -0.8447713983182927], [-1.654108521228278, -0.9549999999999995], [-1.5881069594978618, -1.0611391450674397], [-1.5153048799562592, -1.1627343294066563], [-1.436014032284847, -1.2593505068411315], [-1.3505739520663065, -1.350573952066305], [-1.259350506841132, -1.4360140322848465], [-1.1627343294066568, -1.5153048799562587], [-1.0611391450674401, -1.5881069594978614], [-0.9550000000000008, -1.6541085212282771], [-0.8447713983182925, -1.7130269363274344], [-0.7309253558173209, -1.7646099070965577], [-0.613949378729039, -1.8086365473356516], [-0.4943443761458144, -1.8449183282121204], [-0.37262251505080574, -1.87329988557017], [-0.2493050271402986, -1.8936596852239778], [-0.12491997682957261, -1.9059105433857326], [-3.5086130795571667e-16, -1.91], [0.12491997682957191, -1.9059105433857328], [0.24930502714029792, -1.893659685223978], [0.37262251505080507, -1.8732998855701701], [0.4943443761458137, -1.8449183282121207], [0.6139493787290384, -1.8086365473356518], [0.7309253558173203, -1.764609907096558], [0.844771398318292, -1.7130269363274349], [0.9550000000000002, -1.6541085212282776], [1.0611391450674394, -1.5881069594978618], [1.162734329406655, -1.51530487995626], [1.259350506841132, -1.4360140322848463], [1.3505739520663054, -1.350573952066306], [1.436014032284847, -1.2593505068411313], [1.5153048799562587, -1.1627343294066568], [1.5881069594978605, -1.0611391450674417], [1.6541085212282771, -0.9550000000000008], [1.7130269363274344, -0.8447713983182926], [1.7646099070965577, -0.730925355817321], [1.8086365473356516, -0.6139493787290391], [1.84491832821212, -0.49434437614581617], [1.87329988557017, -0.37262251505080585], [1.8936596852239778, -0.2493050271402987], [1.9059105433857326, -0.12491997682957275]], "holes": [[[1.76, 0.0], [1.756231704899942, 0.11510950744505179], [1.7449429560179064, 0.22972609830729077], [1.7261820935096857, 0.34335896674838573], [1.7000294542687602, 0.4555215193804365], [1.666597027911386, 0.5657334589335644], [1.6260279772198647, 0.673522840962558], [1.5784960250975315, 0.7784280947854422], [1.524204710660612, 0.8799999999999999], [1.4633865176524796, 0.9778036101144998], [1.3963018789125738, 1.0714201150553484], [1.3232380611630004, 1.1604486345761211], [1.2445079348883237, 1.2445079348883235], [1.1604486345761211, 1.3232380611630001], [1.0714201150553484, 1.3963018789125738], [0.9778036101145002, 1.4633865176524794], [0.8800000000000002, 1.524204710660612], [0.7784280947854422, 1.5784960250975315], [0.6735228409625581, 1.6260279772198647], [0.5657334589335646, 1.6665970279113858], [0.4555215193804365, 1.7000294542687602], [0.34335896674838584, 1.7261820935096857], [0.22972609830729102, 1.7449429560179064], [0.11510950744505216, 1.756231704899942], [1.0776891832496708e-16, 1.76], [-0.11510950744505194, 1.756231704899942], [-0.22972609830729082, 1.7449429560179064], [-0.3433589667483856, 1.7261820935096857], [-0.45552151938043633, 1.7000294542687602], [-0.5657334589335644, 1.666597027911386], [-0.6735228409625575, 1.626027977219865], [-0.778428094785442, 1.5784960250975315], [-0.8799999999999997, 1.524204710660612], [-0.9778036101145002, 1.4633865176524794], [-1.0714201150553484, 1.3963018789125738], [-1.1604486345761211, 1.3232380611630001], [-1.2445079348883235, 1.2445079348883237], [-1.323238061163, 1.1604486345761214], [-1.3963018789125736, 1.0714201150553488], [-1.4633865176524792, 0.9778036101145005], [-1.524204710660612, 0.8799999999999999], [-1.578496025097531, 0.778428094785443], [-1.6260279772198647, 0.6735228409625582], [-1.6665970279113858, 0.5657334589335646], [-1.70002945426876, 0.455521519380437], [-1.7261820935096857, 0.34335896674838556], [-1.7449429560179064, 0.22972609830729152], [-1.756231704899942, 0.11510950744505188], [-1.76, 2.1553783664993416e-16], [-1.756231704899942, -0.11510950744505145], [-1.7449429560179064, -0.2297260983072911], [-1.7261820935096857, -0.3433589667483851], [-1.7000294542687602, -0.4555215193804366], [-1.666597027911386, -0.5657334589335643], [-1.626027977219865, -0.6735228409625579], [-1.578496025097531, -0.7784280947854426], [-1.5242047106606122, -0.8799999999999996], [-1.46338651765248, -0.9778036101144995], [-1.3963018789125738, -1.0714201150553484], [-1.3232380611630004, -1.1604486345761211], [-1.2445079348883243, -1.244507934888323], [-1.1604486345761216, -1.323238061163], [-1.0714201150553488, -1.3963018789125734], [-0.9778036101144998, -1.4633865176524796], [-0.8800000000000008, -1.5242047106606116], [-0.7784280947854424, -1.5784960250975313], [-0.6735228409625575, -1.626027977219865], [-0.5657334589335647, -1.6665970279113858], [-0.45552151938043633, -1.7000294542687602], [-0.34335896674838645, -1.7261820935096854], [-0.22972609830729088, -1.7449429560179064], [-0.1151095074450512, -1.756231704899942], [-3.233067549749012e-16, -1.76], [0.11510950744505057, -1.7562317048999423], [0.22972609830729024, -1.7449429560179064], [0.34335896674838584, -1.7261820935096857], [0.4555215193804357, -1.7000294542687604], [0.5657334589335642, -1.666597027911386], [0.673522840962557, -1.6260279772198651], [0.7784280947854418, -1.5784960250975317], [0.8800000000000002, -1.524204710660612], [0.9778036101144992, -1.46338651765248], [1.071420115055347, -1.396301878912575], [1.1604486345761216, -1.323238061163], [1.2445079348883235, -1.244507934888324], [1.3232380611630004, -1.160448634576121], [1.3963018789125734, -1.0714201150553488], [1.4633865176524787, -0.9778036101145012], [1.5242047106606116, -0.8800000000000008], [1.5784960250975313, -0.7784280947854425], [1.626027977219865, -0.6735228409625577], [1.6665970279113858, -0.5657334589335649], [1.70002945426876, -0.45552151938043794], [1.7261820935096854, -0.34335896674838656], [1.7449429560179064, -0.22972609830729096], [1.756231704899942, -0.11510950744505133]]], "depth": 0.24});
  if (!endpoint_amber_ring_2) {
    mesh_amber_ring_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_amber_ring_2 = new THREE.Mesh(
    mesh_amber_ring_2Geometry,
    materialMap["amber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_amber_ring_2.name = "amber-ring";
  if (endpoint_amber_ring_2) {
    mesh_amber_ring_2.position.copy(endpoint_amber_ring_2.midpoint);
    mesh_amber_ring_2.quaternion.copy(endpoint_amber_ring_2.quaternion);
  }
  mesh_amber_ring_2.castShadow = options.castShadow ?? true;
  mesh_amber_ring_2.receiveShadow = options.receiveShadow ?? true;
  mesh_amber_ring_2.userData.sculptComponent = {"id": "amber-ring", "name": "amber-ring", "level": "macro", "role": "layer", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.", "geometryDescriptor": {"topologyIntent": "Closed extruded annulus", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.022, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[1.91, 0.0], [1.9059105433857326, 0.12491997682957325], [1.8936596852239778, 0.2493050271402985], [1.8732998855701701, 0.37262251505080496], [1.8449183282121204, 0.4943443761458146], [1.8086365473356518, 0.6139493787290387], [1.7646099070965575, 0.7309253558173214], [1.7130269363274346, 0.8447713983182924], [1.6541085212282778, 0.9549999999999998], [1.5881069594978614, 1.0611391450674401], [1.5153048799562592, 1.1627343294066563], [1.436014032284847, 1.2593505068411315], [1.3505739520663058, 1.3505739520663056], [1.2593505068411315, 1.4360140322848467], [1.1627343294066563, 1.5153048799562592], [1.0611391450674406, 1.5881069594978612], [0.9550000000000002, 1.6541085212282776], [0.8447713983182924, 1.7130269363274346], [0.7309253558173215, 1.7646099070965575], [0.6139493787290388, 1.8086365473356516], [0.4943443761458146, 1.8449183282121204], [0.37262251505080507, 1.8732998855701701], [0.24930502714029876, 1.8936596852239778], [0.12491997682957363, 1.9059105433857326], [1.1695376931857223e-16, 1.91], [-0.1249199768295734, 1.9059105433857326], [-0.24930502714029854, 1.8936596852239778], [-0.37262251505080485, 1.8732998855701701], [-0.4943443761458144, 1.8449183282121204], [-0.6139493787290387, 1.8086365473356518], [-0.7309253558173209, 1.7646099070965577], [-0.8447713983182922, 1.7130269363274346], [-0.9549999999999996, 1.6541085212282778], [-1.0611391450674406, 1.5881069594978612], [-1.1627343294066563, 1.5153048799562592], [-1.2593505068411315, 1.4360140322848467], [-1.3505739520663056, 1.3505739520663058], [-1.4360140322848465, 1.2593505068411317], [-1.515304879956259, 1.1627343294066568], [-1.588106959497861, 1.0611391450674408], [-1.6541085212282778, 0.9549999999999998], [-1.7130269363274342, 0.8447713983182932], [-1.7646099070965575, 0.7309253558173217], [-1.8086365473356516, 0.6139493787290389], [-1.8449183282121202, 0.4943443761458151], [-1.8732998855701701, 0.3726225150508048], [-1.8936596852239778, 0.24930502714029928], [-1.9059105433857326, 0.12491997682957334], [-1.91, 2.3390753863714446e-16], [-1.9059105433857326, -0.12491997682957287], [-1.8936596852239778, -0.24930502714029887], [-1.8732998855701704, -0.3726225150508043], [-1.8449183282121204, -0.4943443761458147], [-1.8086365473356518, -0.6139493787290385], [-1.7646099070965577, -0.7309253558173212], [-1.7130269363274342, -0.8447713983182927], [-1.654108521228278, -0.9549999999999995], [-1.5881069594978618, -1.0611391450674397], [-1.5153048799562592, -1.1627343294066563], [-1.436014032284847, -1.2593505068411315], [-1.3505739520663065, -1.350573952066305], [-1.259350506841132, -1.4360140322848465], [-1.1627343294066568, -1.5153048799562587], [-1.0611391450674401, -1.5881069594978614], [-0.9550000000000008, -1.6541085212282771], [-0.8447713983182925, -1.7130269363274344], [-0.7309253558173209, -1.7646099070965577], [-0.613949378729039, -1.8086365473356516], [-0.4943443761458144, -1.8449183282121204], [-0.37262251505080574, -1.87329988557017], [-0.2493050271402986, -1.8936596852239778], [-0.12491997682957261, -1.9059105433857326], [-3.5086130795571667e-16, -1.91], [0.12491997682957191, -1.9059105433857328], [0.24930502714029792, -1.893659685223978], [0.37262251505080507, -1.8732998855701701], [0.4943443761458137, -1.8449183282121207], [0.6139493787290384, -1.8086365473356518], [0.7309253558173203, -1.764609907096558], [0.844771398318292, -1.7130269363274349], [0.9550000000000002, -1.6541085212282776], [1.0611391450674394, -1.5881069594978618], [1.162734329406655, -1.51530487995626], [1.259350506841132, -1.4360140322848463], [1.3505739520663054, -1.350573952066306], [1.436014032284847, -1.2593505068411313], [1.5153048799562587, -1.1627343294066568], [1.5881069594978605, -1.0611391450674417], [1.6541085212282771, -0.9550000000000008], [1.7130269363274344, -0.8447713983182926], [1.7646099070965577, -0.730925355817321], [1.8086365473356516, -0.6139493787290391], [1.84491832821212, -0.49434437614581617], [1.87329988557017, -0.37262251505080585], [1.8936596852239778, -0.2493050271402987], [1.9059105433857326, -0.12491997682957275]], "holes": [[[1.76, 0.0], [1.756231704899942, 0.11510950744505179], [1.7449429560179064, 0.22972609830729077], [1.7261820935096857, 0.34335896674838573], [1.7000294542687602, 0.4555215193804365], [1.666597027911386, 0.5657334589335644], [1.6260279772198647, 0.673522840962558], [1.5784960250975315, 0.7784280947854422], [1.524204710660612, 0.8799999999999999], [1.4633865176524796, 0.9778036101144998], [1.3963018789125738, 1.0714201150553484], [1.3232380611630004, 1.1604486345761211], [1.2445079348883237, 1.2445079348883235], [1.1604486345761211, 1.3232380611630001], [1.0714201150553484, 1.3963018789125738], [0.9778036101145002, 1.4633865176524794], [0.8800000000000002, 1.524204710660612], [0.7784280947854422, 1.5784960250975315], [0.6735228409625581, 1.6260279772198647], [0.5657334589335646, 1.6665970279113858], [0.4555215193804365, 1.7000294542687602], [0.34335896674838584, 1.7261820935096857], [0.22972609830729102, 1.7449429560179064], [0.11510950744505216, 1.756231704899942], [1.0776891832496708e-16, 1.76], [-0.11510950744505194, 1.756231704899942], [-0.22972609830729082, 1.7449429560179064], [-0.3433589667483856, 1.7261820935096857], [-0.45552151938043633, 1.7000294542687602], [-0.5657334589335644, 1.666597027911386], [-0.6735228409625575, 1.626027977219865], [-0.778428094785442, 1.5784960250975315], [-0.8799999999999997, 1.524204710660612], [-0.9778036101145002, 1.4633865176524794], [-1.0714201150553484, 1.3963018789125738], [-1.1604486345761211, 1.3232380611630001], [-1.2445079348883235, 1.2445079348883237], [-1.323238061163, 1.1604486345761214], [-1.3963018789125736, 1.0714201150553488], [-1.4633865176524792, 0.9778036101145005], [-1.524204710660612, 0.8799999999999999], [-1.578496025097531, 0.778428094785443], [-1.6260279772198647, 0.6735228409625582], [-1.6665970279113858, 0.5657334589335646], [-1.70002945426876, 0.455521519380437], [-1.7261820935096857, 0.34335896674838556], [-1.7449429560179064, 0.22972609830729152], [-1.756231704899942, 0.11510950744505188], [-1.76, 2.1553783664993416e-16], [-1.756231704899942, -0.11510950744505145], [-1.7449429560179064, -0.2297260983072911], [-1.7261820935096857, -0.3433589667483851], [-1.7000294542687602, -0.4555215193804366], [-1.666597027911386, -0.5657334589335643], [-1.626027977219865, -0.6735228409625579], [-1.578496025097531, -0.7784280947854426], [-1.5242047106606122, -0.8799999999999996], [-1.46338651765248, -0.9778036101144995], [-1.3963018789125738, -1.0714201150553484], [-1.3232380611630004, -1.1604486345761211], [-1.2445079348883243, -1.244507934888323], [-1.1604486345761216, -1.323238061163], [-1.0714201150553488, -1.3963018789125734], [-0.9778036101144998, -1.4633865176524796], [-0.8800000000000008, -1.5242047106606116], [-0.7784280947854424, -1.5784960250975313], [-0.6735228409625575, -1.626027977219865], [-0.5657334589335647, -1.6665970279113858], [-0.45552151938043633, -1.7000294542687602], [-0.34335896674838645, -1.7261820935096854], [-0.22972609830729088, -1.7449429560179064], [-0.1151095074450512, -1.756231704899942], [-3.233067549749012e-16, -1.76], [0.11510950744505057, -1.7562317048999423], [0.22972609830729024, -1.7449429560179064], [0.34335896674838584, -1.7261820935096857], [0.4555215193804357, -1.7000294542687604], [0.5657334589335642, -1.666597027911386], [0.673522840962557, -1.6260279772198651], [0.7784280947854418, -1.5784960250975317], [0.8800000000000002, -1.524204710660612], [0.9778036101144992, -1.46338651765248], [1.071420115055347, -1.396301878912575], [1.1604486345761216, -1.323238061163], [1.2445079348883235, -1.244507934888324], [1.3232380611630004, -1.160448634576121], [1.3963018789125734, -1.0714201150553488], [1.4633865176524787, -0.9778036101145012], [1.5242047106606116, -0.8800000000000008], [1.5784960250975313, -0.7784280947854425], [1.626027977219865, -0.6735228409625577], [1.6665970279113858, -0.5657334589335649], [1.70002945426876, -0.45552151938043794], [1.7261820935096854, -0.34335896674838656], [1.7449429560179064, -0.22972609830729096], [1.756231704899942, -0.11510950744505133]]], "depth": 0.24}}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, -0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "amber-ring-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "amber-ring", "seamRefs": [], "detachableFragments": ["amber-ring"], "breakImpulse": 0.0, "debrisMaterial": "amber"}}, "material": "amber", "materialLayers": ["amber"], "deformations": [], "joints": [], "seams": ["nested radial contact; gold front meets monogram back"], "localFeatures": [{"id": "amber-profile", "type": "bevel", "description": "amber inset annulus", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 137, 0, 1)", "secondaryAlbedo": "rgba(255, 137, 0, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_amber_ring_2.add(mesh_amber_ring_2);
  meshes["amber-ring"] = mesh_amber_ring_2;
  colliders["amber-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["amber-ring"] ??= [];
  destructionGroups["amber-ring"].push(node_amber_ring_2);
  const socket_amber_ring_amber_ring_center_0 = new THREE.Object3D();
  socket_amber_ring_amber_ring_center_0.name = "amber-ring-center";
  socket_amber_ring_amber_ring_center_0.position.set(0.0, 0.0, 0.0);
  socket_amber_ring_amber_ring_center_0.rotation.set(0, 0, 0);
  socket_amber_ring_amber_ring_center_0.userData.socket = {"id": "amber-ring-center", "position": [0, 0, 0]};
  node_amber_ring_2.add(socket_amber_ring_amber_ring_center_0);
  sockets["amber-ring:amber-ring-center"] = socket_amber_ring_amber_ring_center_0;

  const endpoint_gold_core_3 = makeAttachmentEndpoint(null);
  const node_gold_core_3 = new THREE.Group();
  node_gold_core_3.name = "gold-core__pivot";
  node_gold_core_3.scale.set(1, 1, 1);
  if (endpoint_gold_core_3) {
    node_gold_core_3.position.copy(endpoint_gold_core_3.start);
    node_gold_core_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_gold_core_3.position.set(0.0, 0.0, 0.0);
    node_gold_core_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_gold_core_3.userData.sculptComponent = {"id": "gold-core", "name": "gold-core", "level": "macro", "role": "layer", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.", "geometryDescriptor": {"topologyIntent": "Closed extruded profile", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.022, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[1.77, 0.0], [1.766210294132328, 0.11576353873735322], [1.7548574046316443, 0.23103136022949128], [1.7359899463137178, 0.345309869968547], [1.709688712531651, 0.4581097098314617], [1.6760663292063371, 0.568947853586596], [1.6352667725449777, 0.6773496752862089], [1.5874647525128585, 0.7828509816876322], [1.5328649646984565, 0.8849999999999999], [1.471701213775505, 0.9833593124446959], [1.4042354123154863, 1.0775077293454356], [1.3307564592377903, 1.167042092727122], [1.2515790027001892, 1.251579002700189], [1.167042092727122, 1.33075645923779], [1.0775077293454356, 1.4042354123154863], [0.9833593124446962, 1.4717012137755048], [0.8850000000000002, 1.5328649646984562], [0.7828509816876322, 1.5874647525128585], [0.677349675286209, 1.6352667725449777], [0.5689478535865962, 1.676066329206337], [0.4581097098314617, 1.709688712531651], [0.3453098699685471, 1.7359899463137178], [0.23103136022949153, 1.7548574046316443], [0.1157635387373536, 1.766210294132328], [1.0838124172454077e-16, 1.77], [-0.11576353873735337, 1.766210294132328], [-0.23103136022949133, 1.7548574046316443], [-0.3453098699685469, 1.7359899463137178], [-0.45810970983146154, 1.709688712531651], [-0.568947853586596, 1.6760663292063371], [-0.6773496752862084, 1.6352667725449777], [-0.782850981687632, 1.5874647525128585], [-0.8849999999999997, 1.5328649646984565], [-0.9833593124446962, 1.4717012137755048], [-1.0775077293454356, 1.4042354123154863], [-1.167042092727122, 1.33075645923779], [-1.251579002700189, 1.2515790027001892], [-1.3307564592377898, 1.1670420927271221], [-1.404235412315486, 1.077507729345436], [-1.4717012137755048, 0.9833593124446964], [-1.5328649646984565, 0.8849999999999999], [-1.587464752512858, 0.782850981687633], [-1.6352667725449777, 0.6773496752862092], [-1.676066329206337, 0.5689478535865963], [-1.7096887125316507, 0.4581097098314622], [-1.7359899463137178, 0.34530986996854685], [-1.7548574046316443, 0.23103136022949203], [-1.766210294132328, 0.11576353873735332], [-1.77, 2.1676248344908153e-16], [-1.766210294132328, -0.11576353873735287], [-1.7548574046316443, -0.23103136022949164], [-1.735989946313718, -0.3453098699685464], [-1.709688712531651, -0.4581097098314618], [-1.6760663292063371, -0.5689478535865959], [-1.6352667725449777, -0.6773496752862087], [-1.587464752512858, -0.7828509816876326], [-1.5328649646984567, -0.8849999999999996], [-1.4717012137755054, -0.9833593124446954], [-1.4042354123154863, -1.0775077293454356], [-1.3307564592377903, -1.167042092727122], [-1.2515790027001898, -1.2515790027001885], [-1.1670420927271223, -1.3307564592377898], [-1.077507729345436, -1.4042354123154859], [-0.9833593124446959, -1.471701213775505], [-0.8850000000000008, -1.532864964698456], [-0.7828509816876325, -1.5874647525128582], [-0.6773496752862084, -1.6352667725449777], [-0.5689478535865964, -1.676066329206337], [-0.45810970983146154, -1.709688712531651], [-0.34530986996854773, -1.7359899463137176], [-0.2310313602294914, -1.7548574046316443], [-0.11576353873735264, -1.766210294132328], [-3.2514372517362223e-16, -1.77], [0.115763538737352, -1.7662102941323283], [0.23103136022949075, -1.7548574046316445], [0.3453098699685471, -1.7359899463137178], [0.45810970983146093, -1.7096887125316511], [0.5689478535865958, -1.6760663292063371], [0.6773496752862078, -1.6352667725449779], [0.7828509816876318, -1.5874647525128587], [0.8850000000000002, -1.5328649646984562], [0.9833593124446953, -1.4717012137755054], [1.0775077293454343, -1.4042354123154872], [1.1670420927271223, -1.3307564592377896], [1.2515790027001887, -1.2515790027001894], [1.3307564592377903, -1.1670420927271217], [1.4042354123154859, -1.077507729345436], [1.4717012137755043, -0.9833593124446972], [1.532864964698456, -0.8850000000000008], [1.5874647525128582, -0.7828509816876326], [1.6352667725449777, -0.6773496752862085], [1.676066329206337, -0.5689478535865965], [1.7096887125316504, -0.4581097098314632], [1.7359899463137176, -0.34530986996854784], [1.7548574046316443, -0.23103136022949147], [1.766210294132328, -0.11576353873735275]], "holes": [], "depth": 0.18}}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0.0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "gold-core-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "gold-core", "seamRefs": [], "detachableFragments": ["gold-core"], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": ["nested radial contact; gold front meets monogram back"], "localFeatures": [{"id": "gold-profile", "type": "bevel", "description": "circular gold disk seated inside amber", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "gold-gradient", "type": "decal", "description": "warm gold gradient", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "gold-gloss", "type": "gloss", "description": "broad upper curved satin highlight", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 207, 0, 1)", "secondaryAlbedo": "rgba(255, 207, 0, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_gold_core_3.userData.actionProfile = {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "gold-core-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "gold-core", "seamRefs": [], "detachableFragments": ["gold-core"], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_gold_core_3);
  nodes["gold-core"] = node_gold_core_3;
  const mesh_gold_core_3Geometry = endpoint_gold_core_3
    ? new THREE.CylinderGeometry(endpoint_gold_core_3.endRadius, endpoint_gold_core_3.baseRadius, endpoint_gold_core_3.length, 16, 6)
    : buildExtrudeGeometry({"points": [[1.77, 0.0], [1.766210294132328, 0.11576353873735322], [1.7548574046316443, 0.23103136022949128], [1.7359899463137178, 0.345309869968547], [1.709688712531651, 0.4581097098314617], [1.6760663292063371, 0.568947853586596], [1.6352667725449777, 0.6773496752862089], [1.5874647525128585, 0.7828509816876322], [1.5328649646984565, 0.8849999999999999], [1.471701213775505, 0.9833593124446959], [1.4042354123154863, 1.0775077293454356], [1.3307564592377903, 1.167042092727122], [1.2515790027001892, 1.251579002700189], [1.167042092727122, 1.33075645923779], [1.0775077293454356, 1.4042354123154863], [0.9833593124446962, 1.4717012137755048], [0.8850000000000002, 1.5328649646984562], [0.7828509816876322, 1.5874647525128585], [0.677349675286209, 1.6352667725449777], [0.5689478535865962, 1.676066329206337], [0.4581097098314617, 1.709688712531651], [0.3453098699685471, 1.7359899463137178], [0.23103136022949153, 1.7548574046316443], [0.1157635387373536, 1.766210294132328], [1.0838124172454077e-16, 1.77], [-0.11576353873735337, 1.766210294132328], [-0.23103136022949133, 1.7548574046316443], [-0.3453098699685469, 1.7359899463137178], [-0.45810970983146154, 1.709688712531651], [-0.568947853586596, 1.6760663292063371], [-0.6773496752862084, 1.6352667725449777], [-0.782850981687632, 1.5874647525128585], [-0.8849999999999997, 1.5328649646984565], [-0.9833593124446962, 1.4717012137755048], [-1.0775077293454356, 1.4042354123154863], [-1.167042092727122, 1.33075645923779], [-1.251579002700189, 1.2515790027001892], [-1.3307564592377898, 1.1670420927271221], [-1.404235412315486, 1.077507729345436], [-1.4717012137755048, 0.9833593124446964], [-1.5328649646984565, 0.8849999999999999], [-1.587464752512858, 0.782850981687633], [-1.6352667725449777, 0.6773496752862092], [-1.676066329206337, 0.5689478535865963], [-1.7096887125316507, 0.4581097098314622], [-1.7359899463137178, 0.34530986996854685], [-1.7548574046316443, 0.23103136022949203], [-1.766210294132328, 0.11576353873735332], [-1.77, 2.1676248344908153e-16], [-1.766210294132328, -0.11576353873735287], [-1.7548574046316443, -0.23103136022949164], [-1.735989946313718, -0.3453098699685464], [-1.709688712531651, -0.4581097098314618], [-1.6760663292063371, -0.5689478535865959], [-1.6352667725449777, -0.6773496752862087], [-1.587464752512858, -0.7828509816876326], [-1.5328649646984567, -0.8849999999999996], [-1.4717012137755054, -0.9833593124446954], [-1.4042354123154863, -1.0775077293454356], [-1.3307564592377903, -1.167042092727122], [-1.2515790027001898, -1.2515790027001885], [-1.1670420927271223, -1.3307564592377898], [-1.077507729345436, -1.4042354123154859], [-0.9833593124446959, -1.471701213775505], [-0.8850000000000008, -1.532864964698456], [-0.7828509816876325, -1.5874647525128582], [-0.6773496752862084, -1.6352667725449777], [-0.5689478535865964, -1.676066329206337], [-0.45810970983146154, -1.709688712531651], [-0.34530986996854773, -1.7359899463137176], [-0.2310313602294914, -1.7548574046316443], [-0.11576353873735264, -1.766210294132328], [-3.2514372517362223e-16, -1.77], [0.115763538737352, -1.7662102941323283], [0.23103136022949075, -1.7548574046316445], [0.3453098699685471, -1.7359899463137178], [0.45810970983146093, -1.7096887125316511], [0.5689478535865958, -1.6760663292063371], [0.6773496752862078, -1.6352667725449779], [0.7828509816876318, -1.5874647525128587], [0.8850000000000002, -1.5328649646984562], [0.9833593124446953, -1.4717012137755054], [1.0775077293454343, -1.4042354123154872], [1.1670420927271223, -1.3307564592377896], [1.2515790027001887, -1.2515790027001894], [1.3307564592377903, -1.1670420927271217], [1.4042354123154859, -1.077507729345436], [1.4717012137755043, -0.9833593124446972], [1.532864964698456, -0.8850000000000008], [1.5874647525128582, -0.7828509816876326], [1.6352667725449777, -0.6773496752862085], [1.676066329206337, -0.5689478535865965], [1.7096887125316504, -0.4581097098314632], [1.7359899463137176, -0.34530986996854784], [1.7548574046316443, -0.23103136022949147], [1.766210294132328, -0.11576353873735275]], "holes": [], "depth": 0.18});
  if (!endpoint_gold_core_3) {
    mesh_gold_core_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_gold_core_3 = new THREE.Mesh(
    mesh_gold_core_3Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_gold_core_3.name = "gold-core";
  if (endpoint_gold_core_3) {
    mesh_gold_core_3.position.copy(endpoint_gold_core_3.midpoint);
    mesh_gold_core_3.quaternion.copy(endpoint_gold_core_3.quaternion);
  }
  mesh_gold_core_3.castShadow = options.castShadow ?? true;
  mesh_gold_core_3.receiveShadow = options.receiveShadow ?? true;
  mesh_gold_core_3.userData.sculptComponent = {"id": "gold-core", "name": "gold-core", "level": "macro", "role": "layer", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.", "geometryDescriptor": {"topologyIntent": "Closed extruded profile", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.022, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[1.77, 0.0], [1.766210294132328, 0.11576353873735322], [1.7548574046316443, 0.23103136022949128], [1.7359899463137178, 0.345309869968547], [1.709688712531651, 0.4581097098314617], [1.6760663292063371, 0.568947853586596], [1.6352667725449777, 0.6773496752862089], [1.5874647525128585, 0.7828509816876322], [1.5328649646984565, 0.8849999999999999], [1.471701213775505, 0.9833593124446959], [1.4042354123154863, 1.0775077293454356], [1.3307564592377903, 1.167042092727122], [1.2515790027001892, 1.251579002700189], [1.167042092727122, 1.33075645923779], [1.0775077293454356, 1.4042354123154863], [0.9833593124446962, 1.4717012137755048], [0.8850000000000002, 1.5328649646984562], [0.7828509816876322, 1.5874647525128585], [0.677349675286209, 1.6352667725449777], [0.5689478535865962, 1.676066329206337], [0.4581097098314617, 1.709688712531651], [0.3453098699685471, 1.7359899463137178], [0.23103136022949153, 1.7548574046316443], [0.1157635387373536, 1.766210294132328], [1.0838124172454077e-16, 1.77], [-0.11576353873735337, 1.766210294132328], [-0.23103136022949133, 1.7548574046316443], [-0.3453098699685469, 1.7359899463137178], [-0.45810970983146154, 1.709688712531651], [-0.568947853586596, 1.6760663292063371], [-0.6773496752862084, 1.6352667725449777], [-0.782850981687632, 1.5874647525128585], [-0.8849999999999997, 1.5328649646984565], [-0.9833593124446962, 1.4717012137755048], [-1.0775077293454356, 1.4042354123154863], [-1.167042092727122, 1.33075645923779], [-1.251579002700189, 1.2515790027001892], [-1.3307564592377898, 1.1670420927271221], [-1.404235412315486, 1.077507729345436], [-1.4717012137755048, 0.9833593124446964], [-1.5328649646984565, 0.8849999999999999], [-1.587464752512858, 0.782850981687633], [-1.6352667725449777, 0.6773496752862092], [-1.676066329206337, 0.5689478535865963], [-1.7096887125316507, 0.4581097098314622], [-1.7359899463137178, 0.34530986996854685], [-1.7548574046316443, 0.23103136022949203], [-1.766210294132328, 0.11576353873735332], [-1.77, 2.1676248344908153e-16], [-1.766210294132328, -0.11576353873735287], [-1.7548574046316443, -0.23103136022949164], [-1.735989946313718, -0.3453098699685464], [-1.709688712531651, -0.4581097098314618], [-1.6760663292063371, -0.5689478535865959], [-1.6352667725449777, -0.6773496752862087], [-1.587464752512858, -0.7828509816876326], [-1.5328649646984567, -0.8849999999999996], [-1.4717012137755054, -0.9833593124446954], [-1.4042354123154863, -1.0775077293454356], [-1.3307564592377903, -1.167042092727122], [-1.2515790027001898, -1.2515790027001885], [-1.1670420927271223, -1.3307564592377898], [-1.077507729345436, -1.4042354123154859], [-0.9833593124446959, -1.471701213775505], [-0.8850000000000008, -1.532864964698456], [-0.7828509816876325, -1.5874647525128582], [-0.6773496752862084, -1.6352667725449777], [-0.5689478535865964, -1.676066329206337], [-0.45810970983146154, -1.709688712531651], [-0.34530986996854773, -1.7359899463137176], [-0.2310313602294914, -1.7548574046316443], [-0.11576353873735264, -1.766210294132328], [-3.2514372517362223e-16, -1.77], [0.115763538737352, -1.7662102941323283], [0.23103136022949075, -1.7548574046316445], [0.3453098699685471, -1.7359899463137178], [0.45810970983146093, -1.7096887125316511], [0.5689478535865958, -1.6760663292063371], [0.6773496752862078, -1.6352667725449779], [0.7828509816876318, -1.5874647525128587], [0.8850000000000002, -1.5328649646984562], [0.9833593124446953, -1.4717012137755054], [1.0775077293454343, -1.4042354123154872], [1.1670420927271223, -1.3307564592377896], [1.2515790027001887, -1.2515790027001894], [1.3307564592377903, -1.1670420927271217], [1.4042354123154859, -1.077507729345436], [1.4717012137755043, -0.9833593124446972], [1.532864964698456, -0.8850000000000008], [1.5874647525128582, -0.7828509816876326], [1.6352667725449777, -0.6773496752862085], [1.676066329206337, -0.5689478535865965], [1.7096887125316504, -0.4581097098314632], [1.7359899463137176, -0.34530986996854784], [1.7548574046316443, -0.23103136022949147], [1.766210294132328, -0.11576353873735275]], "holes": [], "depth": 0.18}}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0.0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "gold-core-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "gold-core", "seamRefs": [], "detachableFragments": ["gold-core"], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": ["nested radial contact; gold front meets monogram back"], "localFeatures": [{"id": "gold-profile", "type": "bevel", "description": "circular gold disk seated inside amber", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "gold-gradient", "type": "decal", "description": "warm gold gradient", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "gold-gloss", "type": "gloss", "description": "broad upper curved satin highlight", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 207, 0, 1)", "secondaryAlbedo": "rgba(255, 207, 0, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_gold_core_3.add(mesh_gold_core_3);
  meshes["gold-core"] = mesh_gold_core_3;
  colliders["gold-core"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["gold-core"] ??= [];
  destructionGroups["gold-core"].push(node_gold_core_3);
  const socket_gold_core_gold_core_center_0 = new THREE.Object3D();
  socket_gold_core_gold_core_center_0.name = "gold-core-center";
  socket_gold_core_gold_core_center_0.position.set(0.0, 0.0, 0.0);
  socket_gold_core_gold_core_center_0.rotation.set(0, 0, 0);
  socket_gold_core_gold_core_center_0.userData.socket = {"id": "gold-core-center", "position": [0, 0, 0]};
  node_gold_core_3.add(socket_gold_core_gold_core_center_0);
  sockets["gold-core:gold-core-center"] = socket_gold_core_gold_core_center_0;

  const endpoint_monogram_4 = makeAttachmentEndpoint(null);
  const node_monogram_4 = new THREE.Group();
  node_monogram_4.name = "monogram__pivot";
  node_monogram_4.scale.set(1, 1, 1);
  if (endpoint_monogram_4) {
    node_monogram_4.position.copy(endpoint_monogram_4.start);
    node_monogram_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_monogram_4.position.set(0.0, 0.0, 0.245);
    node_monogram_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_monogram_4.userData.sculptComponent = {"id": "monogram", "name": "monogram", "level": "macro", "role": "layer", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.", "geometryDescriptor": {"topologyIntent": "Closed extruded profile", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.88, 1.0], [-0.88, 0.93], [-0.812633101851852, 0.939357638888889], [-0.7552314814814812, 0.942361111111111], [-0.70734375, 0.93890625], [-0.6685185185185182, 0.9288888888888888], [-0.6383043981481487, 0.9122048611111114], [-0.61625, 0.88875], [-0.6019039351851854, 0.8584201388888889], [-0.5948148148148149, 0.8211111111111111], [-0.59453125, 0.77671875], [-0.6006018518518517, 0.7251388888888889], [-0.6125752314814815, 0.6662673611111112], [-0.63, 0.6], [-0.6582870370370373, 0.5002604166666665], [-0.6879629629629628, 0.40125], [-0.71875, 0.30328125], [-0.7503703703703701, 0.20666666666666686], [-0.7825462962962965, 0.11171875000000028], [-0.815, 0.01875], [-0.8474537037037038, -0.07192708333333371], [-0.8796296296296297, -0.16], [-0.91125, -0.24515625], [-0.942037037037037, -0.32708333333333345], [-0.9717129629629631, -0.40546875], [-1.0, -0.48], [-0.56, -0.38], [-0.5359143518518519, -0.3000925925925921], [-0.5039814814814815, -0.2115740740740742], [-0.4646875, -0.11625], [-0.4185185185185182, -0.015925925925926093], [-0.36596064814814866, 0.08759259259259324], [-0.3075, 0.1925], [-0.24362268518518504, 0.2969907407407405], [-0.17481481481481495, 0.39925925925925926], [-0.1015625, 0.4975], [-0.02435185185185162, 0.5899074074074077], [0.056331018518518475, 0.6746759259259258], [0.14, 0.75], [0.17659143518518505, 0.7786111111111115], [0.21106481481481523, 0.7997222222222223], [0.24296875, 0.81375], [0.2718518518518522, 0.8211111111111109], [0.29726273148148125, 0.8222222222222225], [0.31875, 0.8175], [0.33586226851851875, 0.8073611111111112], [0.3481481481481478, 0.7922222222222223], [0.35515625, 0.7725], [0.35643518518518535, 0.7486111111111109], [0.35153356481481496, 0.7209722222222222], [0.34, 0.69], [0.15, 0.2], [0.089878472222222, 0.17800925925925953], [0.029861111111111144, 0.15240740740740705], [-0.02953125, 0.12375], [-0.08777777777777772, 0.09259259259259238], [-0.14435763888888942, 0.05949074074074133], [-0.19875, 0.025], [-0.25043402777777773, -0.010324074074073906], [-0.29888888888888915, -0.04592592592592552], [-0.34359375, -0.08125], [-0.3840277777777777, -0.11574074074074076], [-0.4196701388888889, -0.14884259259259267], [-0.45, -0.18], [-0.4053993055555557, -0.160625], [-0.3615277777777777, -0.1425000000000003], [-0.31828125, -0.125625], [-0.27555555555555544, -0.11000000000000028], [-0.2332465277777783, -0.09562499999999943], [-0.19125, -0.0825], [-0.14946180555555544, -0.070625], [-0.10777777777777771, -0.05999999999999971], [-0.06609375, -0.050625], [-0.024305555555555428, -0.0425], [0.017690972222222285, -0.035625], [0.06, -0.03], [-0.13, -0.62], [-0.14702546296296304, -0.6927488425925924], [-0.15370370370370354, -0.7561574074074077], [-0.1509375, -0.81046875], [-0.13962962962962963, -0.8559259259259261], [-0.12068287037037095, -0.8927719907407402], [-0.095, -0.92125], [-0.06348379629629619, -0.9416030092592598], [-0.027037037037036953, -0.9540740740740739], [0.0134375, -0.95890625], [0.057037037037036956, -0.9563425925925924], [0.10285879629629618, -0.9466261574074076], [0.15, -0.93], [0.19667245370370354, -0.9133854166666668], [0.24171296296296332, -0.8937500000000012], [0.28515625, -0.87140625], [0.32703703703703724, -0.8466666666666669], [0.3673900462962959, -0.8198437499999994], [0.40625, -0.79125], [0.44365162037037037, -0.7611979166666663], [0.47962962962962935, -0.73], [0.51421875, -0.69796875], [0.5474537037037038, -0.6654166666666669], [0.5793692129629631, -0.63265625], [0.61, -0.6], [0.55, -0.54], [0.5057465277777772, -0.58140625], [0.46347222222222256, -0.6154166666666668], [0.42390625, -0.64171875], [0.387777777777778, -0.66], [0.3558159722222217, -0.6699479166666663], [0.32875, -0.67125], [0.3073090277777777, -0.66359375], [0.2922222222222217, -0.6466666666666668], [0.28421875, -0.62015625], [0.284027777777778, -0.58375], [0.2923784722222223, -0.5371354166666669], [0.31, -0.48], [0.46, -0.03], [0.4974942129629625, -0.03289930555555486], [0.5349537037037038, -0.036527777777777715], [0.57234375, -0.04078125], [0.6096296296296293, -0.04555555555555571], [0.6467766203703701, -0.05074652777777743], [0.68375, -0.05625], [0.7205150462962961, -0.06196180555555543], [0.757037037037037, -0.06777777777777771], [0.79328125, -0.07359375], [0.8292129629629631, -0.07930555555555543], [0.8647974537037038, -0.08480902777777771], [0.9, -0.09], [1.0, 0.22], [0.9648032407407402, 0.2266956018518522], [0.9292592592592598, 0.2318981481481481], [0.8934375, 0.23578125], [0.8574074074074082, 0.23851851851851846], [0.821238425925925, 0.24028356481481525], [0.785, 0.24125], [0.748761574074074, 0.24159143518518533], [0.7125925925925923, 0.24148148148148152], [0.6765625, 0.24109375], [0.6407407407407407, 0.24060185185185162], [0.6051967592592592, 0.2401793981481481], [0.57, 0.24], [0.75, 0.73], [0.7764872685185179, 0.8434432870370372], [0.7777314814814815, 0.9342129629629629], [0.75640625, 1.00296875], [0.7151851851851854, 1.0503703703703702], [0.6567418981481472, 1.0770775462962965], [0.58375, 1.08375], [0.4988831018518522, 1.0710474537037036], [0.4048148148148147, 1.0396296296296297], [0.30421875, 0.99015625], [0.19976851851851848, 0.923287037037037], [0.09413773148148152, 0.839681712962963], [-0.01, 0.74], [-0.03748263888888914, 0.7118981481481483], [-0.06486111111111058, 0.6826851851851851], [-0.09203125, 0.6525], [-0.11888888888888886, 0.6214814814814815], [-0.14532986111111143, 0.5897685185185191], [-0.17125, 0.5575], [-0.19654513888888886, 0.5248148148148146], [-0.22111111111111115, 0.4918518518518522], [-0.24484375, 0.45875], [-0.26763888888888887, 0.4256481481481481], [-0.28939236111111116, 0.39268518518518536], [-0.31, 0.36], [-0.35, 0.37], [-0.11, 1.07], [-0.17, 1.11], [-0.35, 1.04], [-0.3990046296296296, 1.0420775462962966], [-0.44620370370370355, 1.0432870370370368], [-0.491875, 1.04359375], [-0.5362962962962962, 1.0429629629629629], [-0.5797453703703707, 1.0413599537037037], [-0.6225, 1.03875], [-0.664837962962963, 1.0350983796296296], [-0.7070370370370372, 1.0303703703703704], [-0.749375, 1.02453125], [-0.7921296296296296, 1.0175462962962962], [-0.8355787037037037, 1.009380787037037], [-0.88, 1.0]], "holes": [], "depth": 0.15}}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0.245], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "monogram-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "monogram", "seamRefs": [], "detachableFragments": ["monogram"], "breakImpulse": 0.0, "debrisMaterial": "navy"}}, "material": "navy", "materialLayers": ["navy"], "deformations": [], "joints": [], "seams": ["nested radial contact; gold front meets monogram back"], "localFeatures": [{"id": "left-serif", "type": "linework", "description": "short upper left serif (120,108)", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "italic-stem", "type": "linework", "description": "inclined stem descending to (108,256)", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "inner-arch", "type": "linework", "description": "open curved negative space at (222,133)", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "crossbar", "type": "linework", "description": "right crossbar ending at (308,186)", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "lower-hook", "type": "linework", "description": "lower terminal curves back to (269,268)", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(8, 0, 94, 1)", "secondaryAlbedo": "rgba(8, 0, 94, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_monogram_4.userData.actionProfile = {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "monogram-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "monogram", "seamRefs": [], "detachableFragments": ["monogram"], "breakImpulse": 0.0, "debrisMaterial": "navy"}};
  (nodes["root"] ?? root).add(node_monogram_4);
  nodes["monogram"] = node_monogram_4;
  const mesh_monogram_4Geometry = endpoint_monogram_4
    ? new THREE.CylinderGeometry(endpoint_monogram_4.endRadius, endpoint_monogram_4.baseRadius, endpoint_monogram_4.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.88, 1.0], [-0.88, 0.93], [-0.812633101851852, 0.939357638888889], [-0.7552314814814812, 0.942361111111111], [-0.70734375, 0.93890625], [-0.6685185185185182, 0.9288888888888888], [-0.6383043981481487, 0.9122048611111114], [-0.61625, 0.88875], [-0.6019039351851854, 0.8584201388888889], [-0.5948148148148149, 0.8211111111111111], [-0.59453125, 0.77671875], [-0.6006018518518517, 0.7251388888888889], [-0.6125752314814815, 0.6662673611111112], [-0.63, 0.6], [-0.6582870370370373, 0.5002604166666665], [-0.6879629629629628, 0.40125], [-0.71875, 0.30328125], [-0.7503703703703701, 0.20666666666666686], [-0.7825462962962965, 0.11171875000000028], [-0.815, 0.01875], [-0.8474537037037038, -0.07192708333333371], [-0.8796296296296297, -0.16], [-0.91125, -0.24515625], [-0.942037037037037, -0.32708333333333345], [-0.9717129629629631, -0.40546875], [-1.0, -0.48], [-0.56, -0.38], [-0.5359143518518519, -0.3000925925925921], [-0.5039814814814815, -0.2115740740740742], [-0.4646875, -0.11625], [-0.4185185185185182, -0.015925925925926093], [-0.36596064814814866, 0.08759259259259324], [-0.3075, 0.1925], [-0.24362268518518504, 0.2969907407407405], [-0.17481481481481495, 0.39925925925925926], [-0.1015625, 0.4975], [-0.02435185185185162, 0.5899074074074077], [0.056331018518518475, 0.6746759259259258], [0.14, 0.75], [0.17659143518518505, 0.7786111111111115], [0.21106481481481523, 0.7997222222222223], [0.24296875, 0.81375], [0.2718518518518522, 0.8211111111111109], [0.29726273148148125, 0.8222222222222225], [0.31875, 0.8175], [0.33586226851851875, 0.8073611111111112], [0.3481481481481478, 0.7922222222222223], [0.35515625, 0.7725], [0.35643518518518535, 0.7486111111111109], [0.35153356481481496, 0.7209722222222222], [0.34, 0.69], [0.15, 0.2], [0.089878472222222, 0.17800925925925953], [0.029861111111111144, 0.15240740740740705], [-0.02953125, 0.12375], [-0.08777777777777772, 0.09259259259259238], [-0.14435763888888942, 0.05949074074074133], [-0.19875, 0.025], [-0.25043402777777773, -0.010324074074073906], [-0.29888888888888915, -0.04592592592592552], [-0.34359375, -0.08125], [-0.3840277777777777, -0.11574074074074076], [-0.4196701388888889, -0.14884259259259267], [-0.45, -0.18], [-0.4053993055555557, -0.160625], [-0.3615277777777777, -0.1425000000000003], [-0.31828125, -0.125625], [-0.27555555555555544, -0.11000000000000028], [-0.2332465277777783, -0.09562499999999943], [-0.19125, -0.0825], [-0.14946180555555544, -0.070625], [-0.10777777777777771, -0.05999999999999971], [-0.06609375, -0.050625], [-0.024305555555555428, -0.0425], [0.017690972222222285, -0.035625], [0.06, -0.03], [-0.13, -0.62], [-0.14702546296296304, -0.6927488425925924], [-0.15370370370370354, -0.7561574074074077], [-0.1509375, -0.81046875], [-0.13962962962962963, -0.8559259259259261], [-0.12068287037037095, -0.8927719907407402], [-0.095, -0.92125], [-0.06348379629629619, -0.9416030092592598], [-0.027037037037036953, -0.9540740740740739], [0.0134375, -0.95890625], [0.057037037037036956, -0.9563425925925924], [0.10285879629629618, -0.9466261574074076], [0.15, -0.93], [0.19667245370370354, -0.9133854166666668], [0.24171296296296332, -0.8937500000000012], [0.28515625, -0.87140625], [0.32703703703703724, -0.8466666666666669], [0.3673900462962959, -0.8198437499999994], [0.40625, -0.79125], [0.44365162037037037, -0.7611979166666663], [0.47962962962962935, -0.73], [0.51421875, -0.69796875], [0.5474537037037038, -0.6654166666666669], [0.5793692129629631, -0.63265625], [0.61, -0.6], [0.55, -0.54], [0.5057465277777772, -0.58140625], [0.46347222222222256, -0.6154166666666668], [0.42390625, -0.64171875], [0.387777777777778, -0.66], [0.3558159722222217, -0.6699479166666663], [0.32875, -0.67125], [0.3073090277777777, -0.66359375], [0.2922222222222217, -0.6466666666666668], [0.28421875, -0.62015625], [0.284027777777778, -0.58375], [0.2923784722222223, -0.5371354166666669], [0.31, -0.48], [0.46, -0.03], [0.4974942129629625, -0.03289930555555486], [0.5349537037037038, -0.036527777777777715], [0.57234375, -0.04078125], [0.6096296296296293, -0.04555555555555571], [0.6467766203703701, -0.05074652777777743], [0.68375, -0.05625], [0.7205150462962961, -0.06196180555555543], [0.757037037037037, -0.06777777777777771], [0.79328125, -0.07359375], [0.8292129629629631, -0.07930555555555543], [0.8647974537037038, -0.08480902777777771], [0.9, -0.09], [1.0, 0.22], [0.9648032407407402, 0.2266956018518522], [0.9292592592592598, 0.2318981481481481], [0.8934375, 0.23578125], [0.8574074074074082, 0.23851851851851846], [0.821238425925925, 0.24028356481481525], [0.785, 0.24125], [0.748761574074074, 0.24159143518518533], [0.7125925925925923, 0.24148148148148152], [0.6765625, 0.24109375], [0.6407407407407407, 0.24060185185185162], [0.6051967592592592, 0.2401793981481481], [0.57, 0.24], [0.75, 0.73], [0.7764872685185179, 0.8434432870370372], [0.7777314814814815, 0.9342129629629629], [0.75640625, 1.00296875], [0.7151851851851854, 1.0503703703703702], [0.6567418981481472, 1.0770775462962965], [0.58375, 1.08375], [0.4988831018518522, 1.0710474537037036], [0.4048148148148147, 1.0396296296296297], [0.30421875, 0.99015625], [0.19976851851851848, 0.923287037037037], [0.09413773148148152, 0.839681712962963], [-0.01, 0.74], [-0.03748263888888914, 0.7118981481481483], [-0.06486111111111058, 0.6826851851851851], [-0.09203125, 0.6525], [-0.11888888888888886, 0.6214814814814815], [-0.14532986111111143, 0.5897685185185191], [-0.17125, 0.5575], [-0.19654513888888886, 0.5248148148148146], [-0.22111111111111115, 0.4918518518518522], [-0.24484375, 0.45875], [-0.26763888888888887, 0.4256481481481481], [-0.28939236111111116, 0.39268518518518536], [-0.31, 0.36], [-0.35, 0.37], [-0.11, 1.07], [-0.17, 1.11], [-0.35, 1.04], [-0.3990046296296296, 1.0420775462962966], [-0.44620370370370355, 1.0432870370370368], [-0.491875, 1.04359375], [-0.5362962962962962, 1.0429629629629629], [-0.5797453703703707, 1.0413599537037037], [-0.6225, 1.03875], [-0.664837962962963, 1.0350983796296296], [-0.7070370370370372, 1.0303703703703704], [-0.749375, 1.02453125], [-0.7921296296296296, 1.0175462962962962], [-0.8355787037037037, 1.009380787037037], [-0.88, 1.0]], "holes": [], "depth": 0.15});
  if (!endpoint_monogram_4) {
    mesh_monogram_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_monogram_4 = new THREE.Mesh(
    mesh_monogram_4Geometry,
    materialMap["navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_monogram_4.name = "monogram";
  if (endpoint_monogram_4) {
    mesh_monogram_4.position.copy(endpoint_monogram_4.midpoint);
    mesh_monogram_4.quaternion.copy(endpoint_monogram_4.quaternion);
  }
  mesh_monogram_4.castShadow = options.castShadow ?? true;
  mesh_monogram_4.receiveShadow = options.receiveShadow ?? true;
  mesh_monogram_4.userData.sculptComponent = {"id": "monogram", "name": "monogram", "level": "macro", "role": "layer", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed planar profile with inferred extrusion and edge bevel, matching requested logo relief.", "geometryDescriptor": {"topologyIntent": "Closed extruded profile", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.88, 1.0], [-0.88, 0.93], [-0.812633101851852, 0.939357638888889], [-0.7552314814814812, 0.942361111111111], [-0.70734375, 0.93890625], [-0.6685185185185182, 0.9288888888888888], [-0.6383043981481487, 0.9122048611111114], [-0.61625, 0.88875], [-0.6019039351851854, 0.8584201388888889], [-0.5948148148148149, 0.8211111111111111], [-0.59453125, 0.77671875], [-0.6006018518518517, 0.7251388888888889], [-0.6125752314814815, 0.6662673611111112], [-0.63, 0.6], [-0.6582870370370373, 0.5002604166666665], [-0.6879629629629628, 0.40125], [-0.71875, 0.30328125], [-0.7503703703703701, 0.20666666666666686], [-0.7825462962962965, 0.11171875000000028], [-0.815, 0.01875], [-0.8474537037037038, -0.07192708333333371], [-0.8796296296296297, -0.16], [-0.91125, -0.24515625], [-0.942037037037037, -0.32708333333333345], [-0.9717129629629631, -0.40546875], [-1.0, -0.48], [-0.56, -0.38], [-0.5359143518518519, -0.3000925925925921], [-0.5039814814814815, -0.2115740740740742], [-0.4646875, -0.11625], [-0.4185185185185182, -0.015925925925926093], [-0.36596064814814866, 0.08759259259259324], [-0.3075, 0.1925], [-0.24362268518518504, 0.2969907407407405], [-0.17481481481481495, 0.39925925925925926], [-0.1015625, 0.4975], [-0.02435185185185162, 0.5899074074074077], [0.056331018518518475, 0.6746759259259258], [0.14, 0.75], [0.17659143518518505, 0.7786111111111115], [0.21106481481481523, 0.7997222222222223], [0.24296875, 0.81375], [0.2718518518518522, 0.8211111111111109], [0.29726273148148125, 0.8222222222222225], [0.31875, 0.8175], [0.33586226851851875, 0.8073611111111112], [0.3481481481481478, 0.7922222222222223], [0.35515625, 0.7725], [0.35643518518518535, 0.7486111111111109], [0.35153356481481496, 0.7209722222222222], [0.34, 0.69], [0.15, 0.2], [0.089878472222222, 0.17800925925925953], [0.029861111111111144, 0.15240740740740705], [-0.02953125, 0.12375], [-0.08777777777777772, 0.09259259259259238], [-0.14435763888888942, 0.05949074074074133], [-0.19875, 0.025], [-0.25043402777777773, -0.010324074074073906], [-0.29888888888888915, -0.04592592592592552], [-0.34359375, -0.08125], [-0.3840277777777777, -0.11574074074074076], [-0.4196701388888889, -0.14884259259259267], [-0.45, -0.18], [-0.4053993055555557, -0.160625], [-0.3615277777777777, -0.1425000000000003], [-0.31828125, -0.125625], [-0.27555555555555544, -0.11000000000000028], [-0.2332465277777783, -0.09562499999999943], [-0.19125, -0.0825], [-0.14946180555555544, -0.070625], [-0.10777777777777771, -0.05999999999999971], [-0.06609375, -0.050625], [-0.024305555555555428, -0.0425], [0.017690972222222285, -0.035625], [0.06, -0.03], [-0.13, -0.62], [-0.14702546296296304, -0.6927488425925924], [-0.15370370370370354, -0.7561574074074077], [-0.1509375, -0.81046875], [-0.13962962962962963, -0.8559259259259261], [-0.12068287037037095, -0.8927719907407402], [-0.095, -0.92125], [-0.06348379629629619, -0.9416030092592598], [-0.027037037037036953, -0.9540740740740739], [0.0134375, -0.95890625], [0.057037037037036956, -0.9563425925925924], [0.10285879629629618, -0.9466261574074076], [0.15, -0.93], [0.19667245370370354, -0.9133854166666668], [0.24171296296296332, -0.8937500000000012], [0.28515625, -0.87140625], [0.32703703703703724, -0.8466666666666669], [0.3673900462962959, -0.8198437499999994], [0.40625, -0.79125], [0.44365162037037037, -0.7611979166666663], [0.47962962962962935, -0.73], [0.51421875, -0.69796875], [0.5474537037037038, -0.6654166666666669], [0.5793692129629631, -0.63265625], [0.61, -0.6], [0.55, -0.54], [0.5057465277777772, -0.58140625], [0.46347222222222256, -0.6154166666666668], [0.42390625, -0.64171875], [0.387777777777778, -0.66], [0.3558159722222217, -0.6699479166666663], [0.32875, -0.67125], [0.3073090277777777, -0.66359375], [0.2922222222222217, -0.6466666666666668], [0.28421875, -0.62015625], [0.284027777777778, -0.58375], [0.2923784722222223, -0.5371354166666669], [0.31, -0.48], [0.46, -0.03], [0.4974942129629625, -0.03289930555555486], [0.5349537037037038, -0.036527777777777715], [0.57234375, -0.04078125], [0.6096296296296293, -0.04555555555555571], [0.6467766203703701, -0.05074652777777743], [0.68375, -0.05625], [0.7205150462962961, -0.06196180555555543], [0.757037037037037, -0.06777777777777771], [0.79328125, -0.07359375], [0.8292129629629631, -0.07930555555555543], [0.8647974537037038, -0.08480902777777771], [0.9, -0.09], [1.0, 0.22], [0.9648032407407402, 0.2266956018518522], [0.9292592592592598, 0.2318981481481481], [0.8934375, 0.23578125], [0.8574074074074082, 0.23851851851851846], [0.821238425925925, 0.24028356481481525], [0.785, 0.24125], [0.748761574074074, 0.24159143518518533], [0.7125925925925923, 0.24148148148148152], [0.6765625, 0.24109375], [0.6407407407407407, 0.24060185185185162], [0.6051967592592592, 0.2401793981481481], [0.57, 0.24], [0.75, 0.73], [0.7764872685185179, 0.8434432870370372], [0.7777314814814815, 0.9342129629629629], [0.75640625, 1.00296875], [0.7151851851851854, 1.0503703703703702], [0.6567418981481472, 1.0770775462962965], [0.58375, 1.08375], [0.4988831018518522, 1.0710474537037036], [0.4048148148148147, 1.0396296296296297], [0.30421875, 0.99015625], [0.19976851851851848, 0.923287037037037], [0.09413773148148152, 0.839681712962963], [-0.01, 0.74], [-0.03748263888888914, 0.7118981481481483], [-0.06486111111111058, 0.6826851851851851], [-0.09203125, 0.6525], [-0.11888888888888886, 0.6214814814814815], [-0.14532986111111143, 0.5897685185185191], [-0.17125, 0.5575], [-0.19654513888888886, 0.5248148148148146], [-0.22111111111111115, 0.4918518518518522], [-0.24484375, 0.45875], [-0.26763888888888887, 0.4256481481481481], [-0.28939236111111116, 0.39268518518518536], [-0.31, 0.36], [-0.35, 0.37], [-0.11, 1.07], [-0.17, 1.11], [-0.35, 1.04], [-0.3990046296296296, 1.0420775462962966], [-0.44620370370370355, 1.0432870370370368], [-0.491875, 1.04359375], [-0.5362962962962962, 1.0429629629629629], [-0.5797453703703707, 1.0413599537037037], [-0.6225, 1.03875], [-0.664837962962963, 1.0350983796296296], [-0.7070370370370372, 1.0303703703703704], [-0.749375, 1.02453125], [-0.7921296296296296, 1.0175462962962962], [-0.8355787037037037, 1.009380787037037], [-0.88, 1.0]], "holes": [], "depth": 0.15}}, "parent": "root", "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0, 0.245], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "monogram-center", "position": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "monogram", "seamRefs": [], "detachableFragments": ["monogram"], "breakImpulse": 0.0, "debrisMaterial": "navy"}}, "material": "navy", "materialLayers": ["navy"], "deformations": [], "joints": [], "seams": ["nested radial contact; gold front meets monogram back"], "localFeatures": [{"id": "left-serif", "type": "linework", "description": "short upper left serif (120,108)", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "italic-stem", "type": "linework", "description": "inclined stem descending to (108,256)", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "inner-arch", "type": "linework", "description": "open curved negative space at (222,133)", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "crossbar", "type": "linework", "description": "right crossbar ending at (308,186)", "evidenceRefs": ["full-object"], "confidence": 0.95}, {"id": "lower-hook", "type": "linework", "description": "lower terminal curves back to (269,268)", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "invisibleRoot": true, "colorMaterialRecipe": {"dominantAlbedo": "rgba(8, 0, 94, 1)", "secondaryAlbedo": "rgba(8, 0, 94, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidenceRefs": ["full-object"]}};
  node_monogram_4.add(mesh_monogram_4);
  meshes["monogram"] = mesh_monogram_4;
  colliders["monogram"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["monogram"] ??= [];
  destructionGroups["monogram"].push(node_monogram_4);
  const socket_monogram_monogram_center_0 = new THREE.Object3D();
  socket_monogram_monogram_center_0.name = "monogram-center";
  socket_monogram_monogram_center_0.position.set(0.0, 0.0, 0.0);
  socket_monogram_monogram_center_0.rotation.set(0, 0, 0);
  socket_monogram_monogram_center_0.userData.socket = {"id": "monogram-center", "position": [0, 0, 0]};
  node_monogram_4.add(socket_monogram_monogram_center_0);
  sockets["monogram:monogram-center"] = socket_monogram_monogram_center_0;

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": false, "normalOrBumpRequired": false, "localOverridesRequired": true, "minimumTextureResolution": 512, "preferredTextureResolution": 512, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "Source is a flat logo illustration, no physical PBR information. User requests an inferred satin/gloss material."}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createNossaArteLogoLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Nossa Arte Logo look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["Inferred studio key (-3,5,7), ambient white, cool fill (4,-1,4), rim (-2,1,-4).", "Transparent background, neutral tone mapping exposure 1; soft contact shadow from monogram on core.", "Soft key reflection on chamfers; modest clearcoat keeps dark navy readable."];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": false, "normalOrBumpRequired": false, "localOverridesRequired": true, "minimumTextureResolution": 512, "preferredTextureResolution": 512, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "Source is a flat logo illustration, no physical PBR information. User requests an inferred satin/gloss material."}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createNossaArteLogoEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameNossaArteLogoCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createNossaArteLogoPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureNossaArteLogoRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createNossaArteLogoInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
