import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

const { generateSbom, CYCLONEDX_NPM_VERSION } = await import('./generate-sbom.js');

function fakeChildProcess(): EventEmitter {
  const emitter = new EventEmitter();
  spawnMock.mockReturnValue(emitter);
  return emitter;
}

describe('generateSbom', () => {
  afterEach(() => {
    spawnMock.mockReset();
    readFileMock.mockReset();
  });

  it('invokes npx with an exact pinned cyclonedx-npm version, never the bare/floating package name', async () => {
    const child = fakeChildProcess();
    readFileMock.mockResolvedValue(JSON.stringify({ bomFormat: 'CycloneDX', components: [] }));

    const resultPromise = generateSbom({ cwd: '/fake/pkg' });
    child.emit('exit', 0);
    await resultPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    // The pinned form, not the bare package name — a regression here would mean every generate-sbom
    // run (ours and every plugin author's) silently tracks whatever npm currently calls "latest".
    expect(args).toContain(`@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}`);
    expect(args).not.toContain('@cyclonedx/cyclonedx-npm');
  });

  it('passes --workspace/--no-include-workspace-root only when a workspace is given', async () => {
    const child = fakeChildProcess();
    readFileMock.mockResolvedValue(JSON.stringify({ bomFormat: 'CycloneDX', components: [] }));

    const resultPromise = generateSbom({ cwd: '/fake/root', workspace: 'my-plugin' });
    child.emit('exit', 0);
    await resultPromise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(expect.arrayContaining(['--workspace', 'my-plugin', '--no-include-workspace-root']));
  });

  it('rejects when cyclonedx-npm exits non-zero', async () => {
    const child = fakeChildProcess();
    const resultPromise = generateSbom({ cwd: '/fake/pkg' });
    child.emit('exit', 1);
    await expect(resultPromise).rejects.toThrow(/exited with code 1/);
  });

  it('rejects when the process itself fails to spawn', async () => {
    const child = fakeChildProcess();
    const resultPromise = generateSbom({ cwd: '/fake/pkg' });
    child.emit('error', new Error('spawn ENOENT'));
    await expect(resultPromise).rejects.toThrow('spawn ENOENT');
  });

  it('returns the parsed SBOM and its compatibility result', async () => {
    const child = fakeChildProcess();
    readFileMock.mockResolvedValue(
      JSON.stringify({
        bomFormat: 'CycloneDX',
        components: [{ name: 'lodash', version: '4.18.1', licenses: [{ license: { id: 'MIT' } }] }],
      }),
    );

    const resultPromise = generateSbom({ cwd: '/fake/pkg', outputFile: 'out.cdx.json' });
    child.emit('exit', 0);
    const result = await resultPromise;

    expect(result.outputFile).toBe('/fake/pkg/out.cdx.json');
    expect(result.compatibility).toEqual({ compatible: true, violations: [] });
  });
});
