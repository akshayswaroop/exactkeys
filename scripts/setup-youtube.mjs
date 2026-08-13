import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const VERSION = '2026.07.04';
const EXPECTED_SHA256 = '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b';
const DOWNLOAD_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp_macos`;
const executable = resolve(process.cwd(), 'tools/yt-dlp_macos');
const temporary = `${executable}.download`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function existingBinaryIsVerified() {
  try {
    return sha256(await readFile(executable)) === EXPECTED_SHA256;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

if (process.platform !== 'darwin') {
  throw new Error('The local YouTube resolver currently supports macOS only. MIDI features remain portable.');
}

if (await existingBinaryIsVerified()) {
  await chmod(executable, 0o755);
  console.log(`yt-dlp ${VERSION} is installed and verified.`);
  process.exit(0);
}

console.log(`Downloading verified yt-dlp ${VERSION} for macOS...`);
await mkdir(dirname(executable), { recursive: true });

try {
  const response = await fetch(DOWNLOAD_URL, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== EXPECTED_SHA256) {
    throw new Error(`Checksum mismatch: expected ${EXPECTED_SHA256}, received ${actualSha256}.`);
  }

  await writeFile(temporary, bytes, { mode: 0o755 });
  await rename(temporary, executable);
  await chmod(executable, 0o755);
  console.log(`Installed verified yt-dlp ${VERSION}.`);
} finally {
  await rm(temporary, { force: true });
}
