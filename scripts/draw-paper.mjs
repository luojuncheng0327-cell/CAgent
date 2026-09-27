// Our own repeatable stipple and short-fiber pattern. No input images or network access.
import fs from 'node:fs';

let state = 67219;
function sample() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
}
const marks = [];
for (let n = 0; n < 680; n++) {
  const x = (sample() * 192).toFixed(2);
  const y = (sample() * 192).toFixed(2);
  const radius = (0.12 + sample() * 0.42).toFixed(2);
  marks.push(`<circle cx="${x}" cy="${y}" r="${radius}"/>`);
}
for (let n = 0; n < 42; n++) {
  const x = (sample() * 192).toFixed(2);
  const y = (sample() * 192).toFixed(2);
  const dx = (sample() * 2 + 0.6).toFixed(2);
  const dy = (sample() * 1.2 - 0.6).toFixed(2);
  marks.push(`<path d="M${x} ${y}l${dx} ${dy}" fill="none" stroke="#76614b" stroke-width=".3"/>`);
}
fs.mkdirSync('src/ui/assets', { recursive: true });
fs.writeFileSync(
  'src/ui/assets/paper-fibers.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><g fill="#76614b" opacity=".16">${marks.join('')}</g></svg>\n`,
);
console.log('Wrote our procedural paper texture: 680 dots, 42 fibers.');
