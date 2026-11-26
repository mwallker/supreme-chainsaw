export const T = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, FOREST: 4, DIRT: 5, ROCKY: 6, MOUNTAIN: 7, FLOOR: 8, WALL: 9 };
export const TILES = [
  { n: 'Deep Water', c: '#1f4f7c', pass: false, water: true },
  { n: 'Shallows', c: '#3a7fae', pass: true, water: true },
  { n: 'Sand', c: '#cbb47a', pass: true },
  { n: 'Grass', c: '#4f7d3b', pass: true },
  { n: 'Forest Floor', c: '#355d2c', pass: true },
  { n: 'Dirt Road', c: '#8c6c45', pass: true },
  { n: 'Rocky Ground', c: '#7b7568', pass: true },
  { n: 'Mountain', c: '#4a4540', pass: false, sight: true },
  { n: 'Wooden Floor', c: '#7b5534', pass: true },
  { n: 'Wall', c: '#38322d', pass: false, sight: true },
];
