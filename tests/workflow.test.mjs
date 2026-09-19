import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
const staticCapability = JSON.parse(await readFile(new URL('../api/travel-records', import.meta.url), 'utf8'));

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
    assert.doesNotMatch(workflow, /build-data-backup|travel-diary-data\.zip/);
    assert.match(workflow, /mkdir -p _site\/data\/travel-diary _site\/data\/photos _site\/data\/videos _site\/data\/profile/);
    assert.match(workflow, /cp -R api assets css doc js _site\//);
    assert.deepEqual(staticCapability, { service: 'travel-diary-static-v1', readonly: true });
    assert.match(workflow, /if \[ -d data \]; then cp -R data\/\. _site\/data\/; fi/);
    assert.match(workflow, /if \[ ! -f _site\/data\/travel_data\.json \]; then printf '\[\]\\n'/);
    assert.match(workflow, /if \[ ! -f _site\/data\/profile\/profile-picture\.png \]; then printf 'iVBORw0KGgo/);
    assert.doesNotMatch(workflow, /cp -R[^\n]*\.secrets/);
    assert.match(workflow, /find _site\/assets\/fonts -name '\*\.ttf' -delete/);
    assert.match(workflow, /actions\/upload-pages-artifact@v[0-9]+/);
    assert.match(workflow, /path:\s+_site/);
    assert.match(workflow, /actions\/deploy-pages@v[0-9]+/);
});
