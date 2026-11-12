// Recursos 3D externos: precarga, modelos encajados en el tamaño de los objetos del juego, instancias con
// nivel de detalle y texturas PBR. Todo es opcional: sin assets/manifest.json (o si falta un archivo) cada
// función devuelve null y quien la llama usa su versión procedural. Se precarga antes de crear el mundo 3D,
// así que los constructores de escena pueden preguntar de forma síncrona.

import * as THREE from '../vendor/three.module.js';
import { MODEL_ASSETS, TEXTURE_ASSETS } from '../config/assets.js';
import { loadGltf } from './gltf3d.js';

const ROOT = new URL('../../assets/', import.meta.url);
const MAPS = ['color', 'normal', 'roughness', 'ao', 'metalness'];

const models = new Map(); // id → { id, parts, box, triangles, materials }
const textureSets = new Map(); // id → { images: {map: HTMLImageElement}, base: Map(map → Texture), grays: Map(brillo → Texture) }
let preloadPromise = null;
let anisotropy = 4;

// ------------------------------------------------------------ Precarga ----

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`No se pudo cargar ${url}`));
    image.src = url;
  });
}

/**
 * Carga los recursos listados en assets/manifest.json que use el juego (config/assets.js). Nunca falla:
 * lo que no esté o no cargue se ignora. Devuelve un resumen { models, textures }.
 */
export function preloadAssets({ timeout = 20000, maxAnisotropy = 8 } = {}) {
  if (preloadPromise) return preloadPromise;
  anisotropy = maxAnisotropy;
  preloadPromise = (async () => {
    let manifest = null;
    try {
      const response = await fetch(new URL('manifest.json', ROOT), { cache: 'no-cache' });
      if (response.ok) manifest = await response.json();
    } catch {
      manifest = null;
    }
    if (!manifest || typeof manifest !== 'object') {
      console.info('[assets] Sin assets/manifest.json: se usan los modelos procedurales (ver tools/download-assets.ps1)');
      return assetSummary();
    }
    // Lo que llegue después del tiempo límite se descarta: la escena ya se ha construido sin ello
    let closed = false;
    const jobs = [];
    try {
      for (const slot of Object.values(MODEL_ASSETS)) {
        const path = manifest.models?.[slot.id];
        if (typeof path !== 'string') continue;
        jobs.push(loadGltf(new URL(path, ROOT).href, { anisotropy })
          .then((gltf) => {
            if (closed) { gltf.dispose(); return; }
            try {
              models.set(slot.id, prepareModel(slot.id, gltf));
            } catch (error) {
              gltf.dispose();
              throw error;
            }
          })
          .catch((error) => console.warn(`[assets] ${slot.id}:`, error.message)));
      }
      for (const { id, maps: used } of Object.values(TEXTURE_ASSETS)) {
        const present = manifest.textures?.[id];
        if (!Array.isArray(present)) continue;
        const maps = used.filter((m) => MAPS.includes(m) && present.includes(m));
        if (!maps.length) continue;
        const set = { images: {}, base: new Map(), grays: new Map() };
        jobs.push(Promise.all(maps.map((map) => loadImage(new URL(`textures/${id}/${map}.jpg`, ROOT).href)
          .then((image) => { set.images[map] = image; })
          .catch((error) => console.warn(`[assets] ${id}/${map}:`, error.message))))
          .then(() => { if (!closed && Object.keys(set.images).length) textureSets.set(id, set); }));
      }
    } catch (error) {
      console.warn('[assets] manifest.json no válido:', error.message);
    }
    let timer = null;
    await Promise.race([
      Promise.allSettled(jobs),
      new Promise((resolve) => { timer = setTimeout(resolve, timeout); }),
    ]);
    clearTimeout(timer);
    closed = true;
    const summary = assetSummary();
    console.info(`[assets] Modelos: ${summary.models.join(', ') || 'ninguno'} · Texturas: ${summary.textures.join(', ') || 'ninguna'}`);
    return summary;
  })().catch((error) => {
    console.warn('[assets] No se pudieron precargar los recursos:', error);
    return assetSummary();
  });
  return preloadPromise;
}

/** Qué se ha cargado (para depurar desde la consola con Renderer3D.stats()). */
export function assetSummary() {
  return {
    models: [...models.values()].map((m) => `${m.id} (${m.triangles} tri)`),
    textures: [...textureSets.keys()],
  };
}

/** Prepara un modelo: piezas (geometría, material y matriz respecto a la raíz), caja envolvente y sombras. */
function prepareModel(id, gltf) {
  const parts = [];
  const materials = new Set();
  let triangles = 0;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((object) => {
    if (!object.isMesh) return;
    parts.push({ geometry: object.geometry, material: object.material, matrix: object.matrixWorld.clone() });
    materials.add(object.material);
    const g = object.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  const box = new THREE.Box3();
  for (const part of parts) box.union(part.geometry.boundingBox.clone().applyMatrix4(part.matrix));
  const size = box.getSize(new THREE.Vector3());
  if (!parts.length || box.isEmpty() || !(size.x > 0 && size.y > 0 && size.z > 0)) throw new Error('el modelo no tiene mallas de triángulos');
  return { id, parts, box, triangles: Math.round(triangles), materials: [...materials] };
}

/** Todos los materiales de los modelos cargados (para que reciban los reflejos del cielo). */
export function assetMaterials() {
  return [...models.values()].flatMap((m) => m.materials);
}

// ------------------------------------------------------------ Modelos ----

/** Modelo cargado de una ranura de config/assets.js ("officeDesk", "crate"…) o null. */
export function getModel(slot) {
  const def = MODEL_ASSETS[slot];
  const model = def ? models.get(def.id) : null;
  return model ? { ...model, yaw: def.yaw ?? 0 } : null;
}

/**
 * Matriz que lleva el modelo a la caja de un objeto del juego: base en y = 0, centrado en x/z y girado "yaw".
 * size = [ancho x, alto y, fondo z] en px. mode: 'height' (la altura manda) o 'contain' (cabe entero).
 * maxStretch permite deformar un poco los lados para ocupar la huella del objeto (1 = sin deformar).
 */
export function fitMatrix(model, { size, mode = 'height', maxStretch = 1, yaw = 0 }) {
  const rotation = new THREE.Matrix4().makeRotationY((model.yaw ?? 0) + yaw);
  const box = model.box.clone().applyMatrix4(rotation);
  const dim = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const [w, h, d] = size;
  const ratios = [w / dim.x, h / dim.y, d / dim.z].filter((r) => Number.isFinite(r) && r > 0);
  const s = mode === 'contain' || !(h > 0) ? Math.min(...ratios) : h / dim.y;
  const axis = (target, raw) => {
    if (!(target > 0) || maxStretch <= 1) return s;
    return s * Math.min(maxStretch, Math.max(1 / maxStretch, target / raw / s));
  };
  const scale = new THREE.Matrix4().makeScale(axis(w, dim.x), s, axis(d, dim.z));
  const move = new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z);
  return scale.multiply(move).multiply(rotation);
}

/** Tamaño final [x, y, z] en px del modelo encajado con "fit" (para apilarlo o separarlo de otros). */
export function fittedSize(model, fit) {
  const box = model.box.clone().applyMatrix4(fitMatrix(model, fit));
  const size = box.getSize(new THREE.Vector3());
  return [size.x, size.y, size.z];
}

/** Grupo con el modelo encajado (comparte geometrías y materiales con el recurso: no hay que liberarlo). */
export function modelGroup(model, fit) {
  const group = new THREE.Group();
  const base = fitMatrix(model, fit);
  for (const part of model.parts) {
    const mesh = new THREE.Mesh(part.geometry, part.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.multiplyMatrices(base, part.matrix);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/**
 * Muchas copias del mismo modelo (una InstancedMesh por pieza). placements = [{ x, y, z, rotY, scale }].
 * setPlacements() cambia las copias visibles sin recrear nada (para el nivel de detalle).
 */
export function modelInstances(model, fit, placements, { capacity = placements.length, cast = true } = {}) {
  const group = new THREE.Group();
  const base = fitMatrix(model, fit);
  const meshes = model.parts.map((part) => {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.max(1, capacity));
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.userData.local = new THREE.Matrix4().multiplyMatrices(base, part.matrix);
    group.add(mesh);
    return mesh;
  });
  const place = new THREE.Matrix4();
  const out = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const setPlacements = (list) => {
    const count = Math.min(list.length, Math.max(1, capacity));
    for (let i = 0; i < count; i++) {
      const item = list[i];
      q.setFromAxisAngle(up, item.rotY ?? 0);
      p.set(item.x, item.y ?? 0, item.z);
      const k = item.scale ?? 1;
      sc.set(k, k, k);
      place.compose(p, q, sc);
      for (const mesh of meshes) mesh.setMatrixAt(i, out.multiplyMatrices(place, mesh.userData.local));
    }
    for (const mesh of meshes) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.visible = count > 0;
    }
  };
  setPlacements(placements);
  return {
    group,
    meshes,
    setPlacements,
    dispose() { for (const mesh of meshes) mesh.dispose(); },
  };
}

/**
 * Nivel de detalle: a menos de "near" px de la cámara se dibuja el modelo real; más lejos, una versión barata
 * (lowGeometry + lowMaterial, ya encajada: base en y = 0). update(cameraPosition) se llama cada fotograma.
 */
export function lodInstances(model, fit, placements, { near = 260, lowGeometry, lowMaterial, maxNear = 24 } = {}) {
  const group = new THREE.Group();
  const hi = modelInstances(model, fit, [], { capacity: Math.min(maxNear, placements.length) });
  const lo = new THREE.InstancedMesh(lowGeometry, lowMaterial, Math.max(1, placements.length));
  lo.castShadow = true;
  lo.receiveShadow = true;
  group.add(hi.group, lo);
  const dummy = new THREE.Object3D();
  const last = new THREE.Vector3(Infinity, 0, 0);
  const update = (camera) => {
    if (camera && last.distanceToSquared(camera) < 100) return; // solo si la cámara se ha movido 10 px
    if (camera) last.copy(camera);
    // Los "maxNear" más cercanos dentro del radio llevan el modelo real; el resto, la versión barata
    const ranked = placements
      .map((item) => ({ item, d: camera ? Math.hypot(item.x - camera.x, item.z - camera.z) : Infinity }))
      .sort((a, b) => a.d - b.d);
    const nearList = [];
    let farCount = 0;
    for (const { item, d } of ranked) {
      if (d < near && nearList.length < maxNear) {
        nearList.push(item);
        continue;
      }
      dummy.position.set(item.x, item.y ?? 0, item.z);
      dummy.rotation.set(0, item.rotY ?? 0, 0);
      dummy.scale.setScalar(item.scale ?? 1);
      dummy.updateMatrix();
      lo.setMatrixAt(farCount++, dummy.matrix);
    }
    lo.count = farCount;
    lo.instanceMatrix.needsUpdate = true;
    lo.computeBoundingSphere();
    hi.setPlacements(nearList);
  };
  update(null);
  return { group, update, dispose() { hi.dispose(); lo.dispose(); } };
}

// ------------------------------------------------------------ Texturas PBR ----

function baseTexture(set, map) {
  let texture = set.base.get(map);
  if (!texture && set.images[map]) {
    texture = new THREE.Texture(set.images[map]);
    texture.colorSpace = map === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
    set.base.set(map, texture);
  }
  return texture ?? null;
}

const setOf = (key) => textureSets.get(TEXTURE_ASSETS[key]?.id);

/** ¿Está cargado el material "key" de config/assets.js ("asphalt", "roofTiles"…)? */
export function hasTextureSet(key) {
  return Boolean(setOf(key));
}

/** Proporción ancho / alto de las imágenes del material (algunos son 2:1). */
function aspectOf(set) {
  const image = Object.values(set.images)[0];
  const w = image?.naturalWidth || image?.width || 1;
  const h = image?.naturalHeight || image?.height || 1;
  return w / h;
}

/**
 * Copia de un mapa ("color", "normal", "roughness", "ao", "metalness") de un material PBR repetida
 * repeat = [u, v] veces (si la imagen no es cuadrada se corrige la v para no deformarla). Las copias comparten
 * la imagen en la GPU. null si no está.
 */
export function pbrMap(key, map, repeat = [1, 1], rotation = 0) {
  const set = setOf(key);
  const base = set && baseTexture(set, map);
  if (!base) return null;
  const copy = base.clone();
  copy.repeat.set(repeat[0], repeat[1] * aspectOf(set));
  copy.center.set(0.5, 0.5);
  copy.rotation = rotation;
  copy.needsUpdate = true;
  return copy;
}

/**
 * Color del material pasado a gris y normalizado a un brillo medio "mean" (factor de brillo para teñirlo con
 * el color de cada pieza, como las texturas procedurales). Se calcula una vez por material y brillo.
 */
export function grayMap(key, repeat = [1, 1], mean = 0.8) {
  const set = setOf(key);
  const image = set?.images.color;
  if (!image) return null;
  set.grays ??= new Map();
  let gray = set.grays.get(mean);
  if (!gray) {
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    const k0 = Math.min(1, 1024 / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * k0));
    const h = Math.max(1, Math.round(ih * k0));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
    const average = sum / (px.length / 4) || 1;
    const k = (mean * 255) / average;
    for (let i = 0; i < px.length; i += 4) {
      const v = Math.min(255, (px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722) * k);
      px[i] = v; px[i + 1] = v; px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
    gray = new THREE.CanvasTexture(canvas);
    gray.colorSpace = THREE.NoColorSpace;
    gray.wrapS = THREE.RepeatWrapping;
    gray.wrapT = THREE.RepeatWrapping;
    gray.anisotropy = anisotropy;
    set.grays.set(mean, gray);
  }
  const copy = gray.clone();
  copy.repeat.set(repeat[0], repeat[1] * aspectOf(set));
  copy.needsUpdate = true;
  return copy;
}
