'use strict';
// The home's picture is what Run does: a job running on a paired computer, its output arriving line by line, and the
// meter (the owner, 2026-11-09: no more "generic circled" homes). It is an example and says so, and it is still under
// reduced motion.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    await check('the home draws a job on a paired computer, labelled as an example', async () => {
        const res = await fetch(`${t.base}/`);
        assert.strictEqual(res.status, 200);
        const home = await res.text();
        const scene = (home.match(/<figure class="run-scene"[\s\S]*?<\/figure>/) || [''])[0];
        assert.ok(scene, 'the picture is in the hero');
        assert.match(scene, /<p class="run-scene-node"><i aria-hidden="true"><\/i><b>attic-pc<\/b><span>your node, online<\/span><\/p>/);
        assert.strictEqual((scene.match(/<span[^>]*>(\$ |frame )/g) || []).length, 4, 'the command and three lines of its output');
        assert.match(scene, /<div class="run-scene-bar" role="img" aria-label="34 percent done">/);
        assert.match(scene, /<figcaption>An example: /, 'it says it is an example');
        assert.ok(!/class="sc-orbit|sc-orbit-/.test(home), 'the generic orbit is gone from this home');
        assert.match(home, /@media \(prefers-reduced-motion:reduce\)\{\.run-scene-out span,\.run-scene-bar i\{animation:none\}\}/, 'still under reduced motion');
        assert.match(home, /html\[data-ov-motion=reduced\] \.run-scene-out span/, 'and under Calm');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
