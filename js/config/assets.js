// Recursos 3D externos (opcionales). Todos son CC0: Poly Haven (modelos) y ambientCG (materiales PBR).
// Se descargan una vez con tools/download-assets.ps1 a la carpeta assets/ (que genera assets/manifest.json).
// Si un recurso falta, el juego usa su modelo o textura procedural de siempre: nada depende de ellos.
//
// Modelos: "yaw" corrige hacia dónde mira el modelo (radianes, se aplica antes de encajarlo); el tamaño final
// lo decide quien lo coloca (se encaja en la caja del objeto del juego, ver render3d/assets3d.js).

export const MODEL_ASSETS = {
  // Mesa metálica con dos bucs de cajones (Poly Haven, CC0): sustituye a la mesa de la oficina
  officeDesk: { id: 'metal_office_desk', yaw: 0 },
  // Caja de plástico apilable (Poly Haven, CC0): mercancía sobre el palé de recepción
  crate: { id: 'plastic_crate_02', yaw: 0 },
  // Contenedor industrial azul con tapas (Poly Haven, CC0): junto a la maquinaria del segundo palé
  container: { id: 'industrial_pastic_container', yaw: 0 },
  // Armario eléctrico de calle (Poly Haven, CC0): en algunas esquinas de las aceras (con nivel de detalle)
  utilityBox: { id: 'utility_box_01', yaw: 0 },
};

// Materiales PBR de ambientCG (CC0). "maps": los mapas que se cargan (color = se pasa a gris para teñirlo con
// el color de cada pieza; normal = relieve; roughness / metalness = rugosidad y metal).
export const TEXTURE_ASSETS = {
  asphalt: { id: 'Asphalt025C', maps: ['color', 'normal'] }, // grano y relieve del asfalto y las aceras
  concrete: { id: 'Concrete034', maps: ['normal', 'roughness'] }, // solera del almacén
  roofTiles: { id: 'RoofingTiles007', maps: ['color', 'normal'] }, // tejados de teja de las casas
  corrugated: { id: 'CorrugatedSteel005', maps: ['color', 'normal', 'roughness', 'metalness'] }, // cubierta del almacén
  cardboard: { id: 'Cardboard004', maps: ['normal', 'roughness'] }, // cajas de cartón
  wood: { id: 'WoodFloor043', maps: ['normal'] }, // palés y piezas de madera
};
