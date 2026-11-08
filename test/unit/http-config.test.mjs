import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import '../helpers.mjs';
import { chooseValidation, parseAllowedHosts } from '../../dist/httpServer.js';

describe('HTTP Host/Origin validation choice', () => {
    it('parses ALLOWED_HOSTS', () => {
        assert.equal(parseAllowedHosts(undefined), undefined);
        assert.equal(parseAllowedHosts(' , '), undefined);
        assert.deepEqual(parseAllowedHosts('mcp.example.com, localhost ,127.0.0.1'), ['mcp.example.com', 'localhost', '127.0.0.1']);
    });
    it('uses the allow-list when given', () => {
        const v = chooseValidation({ host: '0.0.0.0', publicUrl: 'http://x:1', allowedHosts: ['x'] });
        assert.equal(v.mode, 'allow-list');
        assert.equal(v.validators.length, 2);
    });
    it('enforces localhost names on a localhost bind', () => {
        assert.equal(chooseValidation({ host: '127.0.0.1', publicUrl: 'http://127.0.0.1:3457' }).mode, 'localhost');
        assert.equal(chooseValidation({ host: 'localhost', publicUrl: 'http://localhost:3457' }).mode, 'localhost');
    });
    it('enforces localhost names when PUBLIC_URL is local even on 0.0.0.0 (docker -p 127.0.0.1:…)', () => {
        assert.equal(chooseValidation({ host: '0.0.0.0', publicUrl: 'http://127.0.0.1:3457' }).mode, 'localhost');
        assert.equal(chooseValidation({ host: '0.0.0.0', publicUrl: 'http://localhost:3457' }).mode, 'localhost');
    });
    it('turns validation off only for non-local bind + non-local PUBLIC_URL without allow-list', () => {
        assert.equal(chooseValidation({ host: '0.0.0.0', publicUrl: 'https://mcp.example.com' }).mode, 'none');
        assert.equal(chooseValidation({ host: '0.0.0.0', publicUrl: 'not a url' }).mode, 'none');
    });
});
