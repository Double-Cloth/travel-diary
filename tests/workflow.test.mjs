import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');

test('GitHub Pages workflow runs tests before deployment', () => {
    assert.match(workflow, /on:\s*\n\s+push:/);
    assert.match(workflow, /actions\/setup-python@v[0-9]+/);
    assert.match(workflow, /pip install "fonttools\[woff\]"/);
    assert.match(workflow, /npm run fonts/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /needs: test/);
});

test('GitHub Pages workflow publishes prepared static files', () => {
    assert.match(workflow, /pages:\s+write/);
    assert.match(workflow, /id-token:\s+write/);
    assert.match(workflow, /actions\/configure-pages@v[0-9]+/);
    assert.match(workflow, /npm run fonts/);
    assert.match(workflow, /cp -R assets css data doc js _site\//);
    assert.doesNotMatch(workflow, /cp -R assets css data docs js _site\//);
    assert.match(workflow, /find _site\/assets\/fonts -name '\*\.ttf' -delete/);
    assert.match(workflow, /actions\/upload-pages-artifact@v[0-9]+/);
    assert.match(workflow, /path:\s+_site/);
    assert.match(workflow, /actions\/deploy-pages@v[0-9]+/);
});
