// Syntax-checks every JavaScript file that ships with the app or the extension.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const folders = ['src', 'src/engine', 'extension', 'scripts', 'tests', 'website'];
let checked = 0;
for (const folder of folders) {
  const directory = path.join(root, folder);
  if (!fs.existsSync(directory)) continue;
  for (const file of fs.readdirSync(directory)) {
    if (!/\.(c|m)?js$/.test(file)) continue;
    execFileSync(process.execPath, ['--check', path.join(directory, file)], { stdio: 'inherit' });
    checked += 1;
  }
}
console.log(`Syntax OK (${checked} files)`);
