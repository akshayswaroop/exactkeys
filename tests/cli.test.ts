import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { frozenMidiFixture } from './helpers';

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'exactkeys-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('CLI integration', () => {
  it('writes four artifacts only for a certified input', () => {
    const directory = tempDirectory();
    const input = join(directory, 'oracle.mid');
    const output = join(directory, 'out');
    writeFileSync(input, frozenMidiFixture());
    const result = runCli([input, '--out-dir', output]);
    expect(result.status, result.stderr).toBe(0);
    for (const extension of ['normalized.mid', 'audit.json', 'musicxml', 'notes.csv']) {
      expect(existsSync(join(output, `oracle.${extension}`))).toBe(true);
    }
    const audit = JSON.parse(readFileSync(join(output, 'oracle.audit.json'), 'utf8'));
    expect(audit.outcome).toMatchObject({ status: 'certified-score', certified: true });
    expect(audit.eventVerification).toMatchObject({ verified: true, accuracy: 1 });
  });

  it('withholds score artifacts and returns one on abstention', () => {
    const directory = tempDirectory();
    const input = join(directory, 'oracle.mid');
    const output = join(directory, 'out');
    writeFileSync(input, frozenMidiFixture());
    const result = runCli([input, '--out-dir', output, '--grid', '1/8t']);
    expect(result.status, result.stderr).toBe(1);
    expect(existsSync(join(output, 'oracle.normalized.mid'))).toBe(true);
    expect(existsSync(join(output, 'oracle.audit.json'))).toBe(true);
    expect(existsSync(join(output, 'oracle.musicxml'))).toBe(false);
    expect(existsSync(join(output, 'oracle.notes.csv'))).toBe(false);
  });

  it('rejects audio and refuses a lowered threshold with distinct exit codes', () => {
    const directory = tempDirectory();
    const audio = join(directory, 'take.wav');
    writeFileSync(audio, Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]));
    expect(runCli([audio]).status).toBe(3);

    const midi = join(directory, 'oracle.mid');
    writeFileSync(midi, frozenMidiFixture());
    expect(runCli([midi, '--threshold', '0.98']).status).toBe(2);
  });
});
