import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ROOT } from '../helpers.mjs';
import { serverVersion } from '../../dist/version.js';

const SCRIPT = join(ROOT, '.github', 'scripts', 'next-version.sh');
const MAIN = 'refs/heads/main';

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A throwaway repo with package.json at `pkgVersion` and one commit. */
function repo(pkgVersion) {
    dir = mkdtempSync(join(tmpdir(), 'next-version-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    setPkg(pkgVersion);
    commit('initial');
}
function setPkg(v) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: v }));
}
function commit(msg) {
    writeFileSync(join(dir, 'f.txt'), `${Math.random()}`);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
}
function next(event = 'push', ref = MAIN) {
    const out = execFileSync('bash', [SCRIPT, event, ref], { cwd: dir }).toString();
    return Object.fromEntries(out.trim().split('\n').map(l => l.split('=')));
}

describe('next-version.sh (automatic versions for CI)', () => {
    it('first release: package.json version', () => {
        repo('1.1.0');
        assert.deepEqual(next(), { version: '1.1.0', release: 'true' });
    });

    it('patch bump after the latest tag', () => {
        repo('1.1.0');
        git('tag', 'v1.1.0');
        commit('fix something');
        assert.deepEqual(next(), { version: '1.1.1', release: 'true' });
    });

    it('uses the highest tag by version order, not by name', () => {
        repo('1.0.0');
        git('tag', 'v1.9.0');
        commit('a');
        git('tag', 'v1.10.0');
        commit('b');
        assert.equal(next().version, '1.10.1');
    });

    it('[minor] and [major] in any commit since the tag', () => {
        repo('1.1.0');
        git('tag', 'v1.1.3');
        commit('Add a tool [minor]');
        commit('docs');
        assert.equal(next().version, '1.2.0');
        commit('Breaking change [major]');
        assert.equal(next().version, '2.0.0');
    });

    it('a manual bump in package.json wins when it is higher', () => {
        repo('1.1.0');
        git('tag', 'v1.1.0');
        setPkg('3.0.0');
        commit('bump');
        assert.equal(next().version, '3.0.0');
        setPkg('1.0.5'); // lower than the computed version: ignored
        commit('oops');
        assert.equal(next().version, '1.1.1');
    });

    it('a re-run on an already tagged commit builds that version without a new release', () => {
        repo('1.1.0');
        git('tag', 'v1.1.0');
        commit('x');
        git('tag', 'v1.1.1');
        assert.deepEqual(next(), { version: '1.1.1', release: 'false' });
    });

    it('schedule re-publishes the latest release without a bump', () => {
        repo('1.1.0');
        git('tag', 'v1.1.4');
        commit('bot: base image digest');
        assert.deepEqual(next('schedule'), { version: '1.1.4', release: 'false' });
    });

    it('schedule before the first release uses package.json', () => {
        repo('1.1.0');
        assert.deepEqual(next('schedule'), { version: '1.1.0', release: 'false' });
    });

    it('releases only for push and manual runs on main', () => {
        repo('1.1.0');
        git('tag', 'v1.1.0');
        commit('x');
        assert.deepEqual(next('pull_request', 'refs/pull/7/merge'), { version: '1.1.1', release: 'false' });
        assert.deepEqual(next('push', 'refs/heads/feature'), { version: '1.1.1', release: 'false' });
        assert.deepEqual(next('workflow_dispatch'), { version: '1.1.1', release: 'true' });
    });

    it('ignores tags that are not vX.Y.Z', () => {
        repo('1.1.0');
        git('tag', 'v2.0.0-rc1');
        git('tag', 'latest');
        assert.equal(next().version, '1.1.0');
    });

    it('refuses a package.json version that is not X.Y.Z', () => {
        repo('1.1');
        assert.throws(() => execFileSync('bash', [SCRIPT, 'push', MAIN], { cwd: dir, stdio: 'pipe' }), /not X\.Y\.Z/);
    });
});

describe('server version', () => {
    it('defaults to package.json and can be set by the image build', () => {
        assert.match(serverVersion({}), /^\d+\.\d+\.\d+$/);
        assert.equal(serverVersion({ MCP_FEATURE_TEST_VERSION: '9.8.7' }), '9.8.7');
        assert.equal(serverVersion({ MCP_FEATURE_TEST_VERSION: '  ' }), serverVersion({}), 'blank falls back');
    });
});
