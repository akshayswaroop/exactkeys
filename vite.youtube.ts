import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';

const MAX_BODY_BYTES = 8_192;
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;
const MAX_DURATION_SECONDS = 600;
const DOWNLOAD_TIMEOUT_MS = 180_000;

function normalizeYouTubeUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2_048) throw new Error('Enter one YouTube video URL.');
  const url = new URL(input.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) YouTube URLs are accepted.');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const youtubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
  if (!youtubeHost && host !== 'youtu.be') throw new Error('Only youtube.com and youtu.be URLs are accepted.');
  if (url.pathname === '/' || (youtubeHost && !url.searchParams.get('v') && !url.pathname.startsWith('/shorts/'))) {
    throw new Error('Use a direct YouTube video URL, not a channel or playlist.');
  }
  return url.href;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.m4a': return 'audio/mp4';
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.opus': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.webm': return 'audio/webm';
    default: return 'application/octet-stream';
  }
}

async function readJsonBody(req: Connect.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('Request is too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function downloadAudio(url: string): Promise<{ directory: string; file: string; title: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'exactkeys-youtube-'));
  const executable = resolve(process.cwd(), 'tools/yt-dlp_macos');
  await access(executable);
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--no-simulate',
    '--force-ipv4',
    '--socket-timeout', '15',
    '--impersonate', 'chrome',
    '--js-runtimes', `node:${process.execPath}`,
    '--match-filter', `duration <= ${MAX_DURATION_SECONDS}`,
    '--max-filesize', String(MAX_AUDIO_BYTES),
    '--format', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '--output', join(directory, 'audio.%(ext)s'),
    '--print', '%(title)s',
    url,
  ];
  let stdout = '';
  let stderr = '';
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        rejectPromise(new Error('YouTube audio extraction timed out after three minutes.'));
      }, DOWNLOAD_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-8_192); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_192); });
      child.once('error', rejectPromise);
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(stderr.trim() || `yt-dlp stopped with status ${code ?? 'unknown'}.`));
      });
    });
    const files = (await readdir(directory)).filter((name) => name.startsWith('audio.'));
    if (files.length !== 1) throw new Error('YouTube did not return one usable audio stream.');
    const file = join(directory, files[0]);
    const details = await stat(file);
    if (details.size <= 0 || details.size > MAX_AUDIO_BYTES) throw new Error('Downloaded audio is empty or exceeds 80 MB.');
    const title = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? 'YouTube piano';
    return { directory, file, title };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function youtubeMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (req.url !== '/api/youtube-audio') return next();
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      return res.end('POST required');
    }
    let directory: string | undefined;
    try {
      const body = await readJsonBody(req) as { url?: unknown };
      const url = normalizeYouTubeUrl(body.url);
      const downloaded = await downloadAudio(url);
      directory = downloaded.directory;
      const details = await stat(downloaded.file);
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType(downloaded.file));
      res.setHeader('Content-Length', String(details.size));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-ExactKeys-Title', encodeURIComponent(downloaded.title.slice(0, 300)));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const stream = createReadStream(downloaded.file);
      stream.on('error', (error) => res.destroy(error));
      stream.on('close', () => void rm(downloaded.directory, { recursive: true, force: true }));
      stream.pipe(res);
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'YouTube import failed.' }));
    }
  };
}

export function youtubeAudioPlugin(): Plugin {
  return {
    name: 'exactkeys-youtube-audio',
    configureServer(server) {
      server.middlewares.use(youtubeMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(youtubeMiddleware());
    },
  };
}

export const youtubeTestables = { normalizeYouTubeUrl, contentType };
