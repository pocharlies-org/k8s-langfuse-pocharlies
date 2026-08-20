import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const manifestUrl = new URL('../k8s/platform/retention-cronjob.yaml', import.meta.url);

async function retentionScript() {
  const manifest = await readFile(manifestUrl, 'utf8');
  const block = manifest.match(/  retention\.js: \|\n((?:    .*\n)+?)(?=---\n)/);
  assert.ok(block, 'retention.js ConfigMap block is present');
  return block[1].replace(/^    /gm, '');
}

test('fetch failure reports safe context and nested cause fields', async () => {
  const output = [];
  const secret = 'credential-that-must-not-leak';
  const traceId = '123e4567-e89b-12d3-a456-426614174000';
  const error = new TypeError(
    `fetch failed for https://user:${secret}@langfuse.invalid/traces/${traceId}`,
    { cause: Object.assign(new Error('private response detail'), {
      code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '10.0.0.8', port: 3000,
    }) },
  );
  let exitCode;
  const context = {
    Buffer,
    console: { log() {}, warn() {}, error: (...args) => output.push(args.join(' ')) },
    Date,
    encodeURIComponent,
    fetch: async () => { throw error; },
    process: {
      env: { LANGFUSE_HOST: 'http://langfuse-web:3000', PK: 'public-key', SK: secret },
      exit: code => { exitCode = code; },
    },
  };

  await vm.runInNewContext(await retentionScript(), context);

  const diagnostic = output.join('\n');
  assert.equal(exitCode, 1);
  assert.match(diagnostic, /"stage":"list","page":1/);
  assert.match(diagnostic, /"name":"TypeError"/);
  assert.match(diagnostic, /"message":"fetch failed for \[REDACTED_URL\]/);
  assert.match(diagnostic, /"cause":\{"code":"ECONNREFUSED","errno":"-111","syscall":"connect","address":"10\.0\.0\.8","port":"3000"\}/);
  assert.doesNotMatch(diagnostic, /Authorization|credential-that-must-not-leak|123e4567|https?:\/\//);
});
