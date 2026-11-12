// Cargador glTF 2.0 propio (el Three.js incluido en js/vendor no trae el GLTFLoader de los "addons").
// Admite .gltf (con .bin y texturas externas o embebidas en data:) y .glb. Soporta lo que usan los modelos
// estáticos de Poly Haven / Kenney / Sketchfab: jerarquía de nodos, mallas de triángulos indexadas o no,
// normales, UV, color por vértice y materiales PBR metal/rugosidad (color, normal, ARM, emisivo,
// alpha MASK/BLEND, doble cara). No soporta animaciones, esqueletos ni compresión Draco/meshopt: si un
// modelo los usa se avisa por consola y se carga lo que se pueda (o se rechaza si está comprimido).

import * as THREE from '../vendor/three.module.js';

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const ITEM_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
// Las tangentes del archivo se ignoran: Three.js las calcula en el shader a partir de las derivadas (por eso
// se invierte normalScale.y en los materiales, como hace el GLTFLoader oficial cuando no hay tangentes).
const ATTRIBUTES = { POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', TEXCOORD_1: 'uv1', COLOR_0: 'color' };
const WRAP = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };
const MAG = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter };
const MIN = {
  9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter,
  9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter,
};
const UNSUPPORTED = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];

/** Lee la cabecera y los bloques de un .glb. */
function parseGlb(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('No es un archivo GLB');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
    else if (type === 0x004e4942) bin = buffer.slice(start, start + length);
    offset = start + length;
  }
  if (!json) throw new Error('GLB sin bloque JSON');
  return { json, bin };
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} al cargar ${url}`);
  return response.arrayBuffer();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`No se pudo cargar la imagen ${src.slice(0, 80)}`));
    image.src = src;
  });
}

/**
 * Carga un glTF y devuelve { scene, json, dispose }. "scene" es un THREE.Group con la jerarquía original;
 * las geometrías, materiales y texturas creados aquí se liberan con dispose().
 */
export async function loadGltf(url, { anisotropy = 4 } = {}) {
  const absolute = new URL(url, document.baseURI).href;
  const resolve = (uri) => new URL(uri, absolute).href;
  let json;
  let glbBin = null;
  if (/\.glb(\?|$)/i.test(absolute)) {
    ({ json, bin: glbBin } = parseGlb(await fetchBuffer(absolute)));
  } else {
    const response = await fetch(absolute);
    if (!response.ok) throw new Error(`${response.status} al cargar ${url}`);
    json = await response.json();
  }
  const required = (json.extensionsRequired ?? []).filter((name) => UNSUPPORTED.includes(name));
  if (required.length) throw new Error(`${url} usa ${required.join(', ')} (no soportado: expórtalo sin compresión)`);
  if (json.animations?.length || json.skins?.length) console.info(`[gltf] ${url}: se ignoran animaciones y esqueletos`);

  const buffers = await Promise.all((json.buffers ?? []).map((b) => (b.uri === undefined ? glbBin : fetchBuffer(resolve(b.uri)))));
  const owned = { geometries: [], materials: [], textures: [], urls: [] };

  // --- Accesores (con byteStride se copian a un array compacto)
  const accessorCache = new Map();
  const accessor = (index) => {
    if (accessorCache.has(index)) return accessorCache.get(index);
    const def = json.accessors[index];
    const Type = COMPONENT[def.componentType];
    const size = ITEM_SIZE[def.type];
    const count = def.count * size;
    let array;
    if (def.bufferView === undefined) {
      array = new Type(count);
    } else {
      const view = json.bufferViews[def.bufferView];
      const buffer = buffers[view.buffer];
      const elementBytes = Type.BYTES_PER_ELEMENT * size;
      const start = (view.byteOffset ?? 0) + (def.byteOffset ?? 0);
      const stride = view.byteStride ?? 0;
      if (stride && stride !== elementBytes) {
        array = new Type(count);
        const source = new DataView(buffer);
        const getter = {
          5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32',
        }[def.componentType];
        for (let i = 0; i < def.count; i++) {
          for (let k = 0; k < size; k++) array[i * size + k] = source[getter](start + i * stride + k * Type.BYTES_PER_ELEMENT, true);
        }
      } else if (start % Type.BYTES_PER_ELEMENT === 0) {
        array = new Type(buffer, start, count);
      } else {
        array = new Type(buffer.slice(start, start + count * Type.BYTES_PER_ELEMENT));
      }
    }
    if (def.sparse) console.warn(`[gltf] ${url}: accesor disperso ${index} no soportado (se usan los valores base)`);
    const result = { array, size, normalized: Boolean(def.normalized) };
    accessorCache.set(index, result);
    return result;
  };

  // --- Texturas (las imágenes se comparten entre texturas)
  const imageCache = new Map();
  const image = async (index) => {
    if (imageCache.has(index)) return imageCache.get(index);
    const def = json.images[index];
    let promise;
    if (def.bufferView !== undefined) {
      const view = json.bufferViews[def.bufferView];
      const bytes = new Uint8Array(buffers[view.buffer], view.byteOffset ?? 0, view.byteLength);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: def.mimeType ?? 'image/png' }));
      owned.urls.push(blobUrl);
      promise = loadImage(blobUrl);
    } else if (def.uri) {
      promise = loadImage(def.uri.startsWith('data:') ? def.uri : resolve(def.uri));
    } else {
      promise = Promise.reject(new Error(`imagen ${index} sin origen`));
    }
    imageCache.set(index, promise);
    return promise;
  };
  const textureCache = new Map();
  const texture = async (info, srgb) => {
    if (!info) return null;
    const key = `${info.index}|${srgb}`;
    if (textureCache.has(key)) return textureCache.get(key);
    const promise = (async () => {
      const def = json.textures[info.index];
      if (def.source === undefined) return null;
      const t = new THREE.Texture(await image(def.source));
      t.flipY = false; // convención de glTF
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      const sampler = json.samplers?.[def.sampler] ?? {};
      t.wrapS = WRAP[sampler.wrapS] ?? THREE.RepeatWrapping;
      t.wrapT = WRAP[sampler.wrapT] ?? THREE.RepeatWrapping;
      t.magFilter = MAG[sampler.magFilter] ?? THREE.LinearFilter;
      t.minFilter = MIN[sampler.minFilter] ?? THREE.LinearMipmapLinearFilter;
      t.anisotropy = anisotropy;
      t.needsUpdate = true;
      owned.textures.push(t);
      return t;
    })().catch((error) => {
      // Una textura que falta no tira el modelo entero: se queda sin ese mapa
      console.warn(`[gltf] ${url}:`, error.message);
      return null;
    });
    textureCache.set(key, promise);
    return promise;
  };

  // --- Materiales PBR
  const materialCache = new Map();
  const material = async (index, vertexColors) => {
    const key = `${index}|${vertexColors}`;
    if (materialCache.has(key)) return materialCache.get(key);
    const promise = (async () => {
      const def = index === undefined ? {} : json.materials[index];
      const pbr = def.pbrMetallicRoughness ?? {};
      const m = new THREE.MeshStandardMaterial({
        roughness: pbr.roughnessFactor ?? 1,
        metalness: pbr.metallicFactor ?? 1,
        vertexColors,
        side: def.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      });
      m.name = def.name ?? '';
      const [r, g, b, a] = pbr.baseColorFactor ?? [1, 1, 1, 1];
      m.color.setRGB(r, g, b); // los factores de glTF son lineales
      m.opacity = a;
      const [map, arm, normal, occlusion, emissive] = await Promise.all([
        texture(pbr.baseColorTexture, true),
        texture(pbr.metallicRoughnessTexture, false),
        texture(def.normalTexture, false),
        texture(def.occlusionTexture, false),
        texture(def.emissiveTexture, true),
      ]);
      m.map = map;
      if (arm) { m.roughnessMap = arm; m.metalnessMap = arm; } // rugosidad en G, metal en B
      if (normal) {
        m.normalMap = normal;
        // Sin tangentes guardadas (las calcula el shader) y con flipY = false hay que invertir la y del mapa
        // normal, igual que hace el GLTFLoader oficial en ese caso
        const s = def.normalTexture.scale ?? 1;
        m.normalScale.set(s, -s);
      }
      if (occlusion) {
        m.aoMap = occlusion; // canal R (en Poly Haven es la misma textura ARM)
        m.aoMapIntensity = def.occlusionTexture.strength ?? 1;
      }
      if (def.emissiveFactor) m.emissive.setRGB(...def.emissiveFactor);
      if (emissive) m.emissiveMap = emissive;
      if (def.alphaMode === 'BLEND') {
        m.transparent = true;
        m.depthWrite = false;
      } else if (def.alphaMode === 'MASK') {
        m.alphaTest = def.alphaCutoff ?? 0.5;
      }
      owned.materials.push(m);
      return m;
    })();
    materialCache.set(key, promise);
    return promise;
  };

  // --- Mallas: un grupo con una malla por primitiva
  const meshCache = new Map();
  const meshParts = (index) => {
    if (meshCache.has(index)) return meshCache.get(index);
    const promise = Promise.all(json.meshes[index].primitives.map(async (primitive) => {
      if ((primitive.mode ?? 4) !== 4) return null; // solo triángulos
      const geometry = new THREE.BufferGeometry();
      for (const [name, accessorIndex] of Object.entries(primitive.attributes)) {
        const target = ATTRIBUTES[name];
        if (!target) continue;
        const { array, size, normalized } = accessor(accessorIndex);
        geometry.setAttribute(target, new THREE.BufferAttribute(array, size, normalized));
      }
      if (!geometry.attributes.position) return null;
      if (primitive.indices !== undefined) {
        const { array } = accessor(primitive.indices);
        geometry.setIndex(new THREE.BufferAttribute(array instanceof Uint8Array ? new Uint16Array(array) : array, 1));
      }
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      owned.geometries.push(geometry);
      const m = await material(primitive.material, Boolean(geometry.attributes.color));
      return { geometry, material: m };
    }));
    meshCache.set(index, promise);
    return promise;
  };

  // --- Nodos y escena
  const buildNode = async (index) => {
    const def = json.nodes[index];
    const node = new THREE.Group();
    node.name = def.name ?? '';
    if (def.matrix) {
      node.matrix.fromArray(def.matrix);
      node.matrix.decompose(node.position, node.quaternion, node.scale);
    } else {
      if (def.translation) node.position.fromArray(def.translation);
      if (def.rotation) node.quaternion.fromArray(def.rotation);
      if (def.scale) node.scale.fromArray(def.scale);
    }
    if (def.mesh !== undefined) {
      for (const part of await meshParts(def.mesh)) {
        if (!part) continue;
        const mesh = new THREE.Mesh(part.geometry, part.material);
        mesh.name = node.name;
        node.add(mesh);
      }
    }
    for (const child of await Promise.all((def.children ?? []).map(buildNode))) node.add(child);
    return node;
  };
  // Sin escenas: solo los nodos raíz (los que no son hijos de otro), para no duplicar subárboles
  const childNodes = new Set((json.nodes ?? []).flatMap((n) => n.children ?? []));
  const sceneDef = json.scenes?.[json.scene ?? 0]
    ?? { nodes: (json.nodes ?? []).map((_, i) => i).filter((i) => !childNodes.has(i)) };
  const scene = new THREE.Group();
  for (const node of await Promise.all(sceneDef.nodes.map(buildNode))) scene.add(node);
  scene.updateMatrixWorld(true);

  return {
    scene,
    json,
    dispose() {
      for (const g of owned.geometries) g.dispose();
      for (const m of owned.materials) m.dispose();
      for (const t of owned.textures) t.dispose();
      for (const u of owned.urls) URL.revokeObjectURL(u);
    },
  };
}
