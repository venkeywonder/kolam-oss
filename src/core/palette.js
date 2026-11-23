export const PALETTE = [
  { k: null,     name: 'Default', bg: '#ffffff', dbg: '#2a2a31', line: '#8d8d97' },
  { k: 'red',    name: 'Red',     bg: '#ffdcd6', dbg: '#5b2c2a', line: '#e5534b' },
  { k: 'orange', name: 'Orange',  bg: '#ffe6c7', dbg: '#5a3e1f', line: '#ee8a26' },
  { k: 'yellow', name: 'Yellow',  bg: '#fff3b8', dbg: '#544718', line: '#e2b000' },
  { k: 'green',  name: 'Green',   bg: '#d8f3d4', dbg: '#24452c', line: '#35a35a' },
  { k: 'teal',   name: 'Teal',    bg: '#cdf0ec', dbg: '#1c4542', line: '#1a9e93' },
  { k: 'blue',   name: 'Blue',    bg: '#d6e7ff', dbg: '#22385b', line: '#3478e5' },
  { k: 'purple', name: 'Purple',  bg: '#e7dcff', dbg: '#3a2d5d', line: '#7b55d9' },
  { k: 'pink',   name: 'Pink',    bg: '#ffdcef', dbg: '#552840', line: '#db4c9a' },
  { k: 'dark',   name: 'Charcoal',bg: '#2b2b31', dbg: '#101013', line: '#2b2b31', dark: true },
];
export const pal = k => PALETTE.find(p => p.k === k) || PALETTE[0];
