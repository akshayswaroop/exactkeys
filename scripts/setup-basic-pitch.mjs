import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(process.cwd(), 'node_modules/@spotify/basic-pitch');
const outputRoot = resolve(process.cwd(), 'public/basic-pitch-model');
const files = [
  ['model/model.json', 'model.json'],
  ['model/group1-shard1of1.bin', 'group1-shard1of1.bin'],
  ['LICENSE', 'LICENSE'],
];

await mkdir(outputRoot, { recursive: true });

for (const [source, destination] of files) {
  await copyFile(resolve(packageRoot, source), resolve(outputRoot, destination));
}

console.log('Installed the Basic Pitch model and Apache-2.0 license from @spotify/basic-pitch.');
