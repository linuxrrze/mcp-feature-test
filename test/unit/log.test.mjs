import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import '../helpers.mjs';
import { configureLogger, errorData, isLevelEnabled, logger } from '../../dist/log.js';

describe('logger', () => {
    let restore;
    const capture = patch => {
        const lines = [];
        restore = configureLogger({ write: l => lines.push(l), ...patch });
        return lines;
    };
    afterEach(() => restore && configureLogger(restore));

    it('json format writes one parseable object per line', () => {
        const lines = capture({ format: 'json', level: 'info' });
        logger.info('test.event', 'hello', { a: 1 }, 'details are text-only');
        assert.equal(lines.length, 1);
        assert.ok(lines[0].endsWith('\n'));
        const rec = JSON.parse(lines[0]);
        assert.equal(rec.level, 'info');
        assert.equal(rec.event, 'test.event');
        assert.equal(rec.msg, 'hello');
        assert.equal(rec.a, 1);
        assert.equal(rec.details, undefined);
        assert.ok(!Number.isNaN(Date.parse(rec.time)));
    });

    it('text format includes level, event and indented details', () => {
        const lines = capture({ format: 'text', level: 'debug' });
        logger.warn('x.y', 'something', {}, 'line1\nline2');
        assert.match(lines[0], /WARN\s+\[x\.y\] something\n {4}line1\n {4}line2\n$/);
    });

    it('respects LOG_LEVEL thresholds', () => {
        const lines = capture({ format: 'json', level: 'warn' });
        logger.debug('a', 'no');
        logger.info('a', 'no');
        logger.warn('a', 'yes');
        logger.error('a', 'yes');
        assert.equal(lines.length, 2);
        assert.equal(isLevelEnabled('info'), false);
        assert.equal(isLevelEnabled('error'), true);
    });

    it('silent suppresses everything', () => {
        const lines = capture({ level: 'silent' });
        logger.error('a', 'nope');
        assert.equal(lines.length, 0);
    });

    it('errorData flattens errors', () => {
        capture({ level: 'info' });
        assert.deepEqual(errorData(new Error('boom')), { error: 'boom' });
        assert.deepEqual(errorData('plain'), { error: 'plain' });
    });
});
