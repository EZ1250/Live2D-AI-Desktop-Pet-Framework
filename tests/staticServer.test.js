/**
 * staticServer.test.js —— 本地静态资源路由
 *
 * 覆盖渲染层真正依赖的几条路由：/renderer、/assets、额外挂载点（用户模型）、
 * 越界/缺失/方法不对时的响应，以及 HTML 的 CSP 头。改路由/挂载逻辑时先看这里。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist', 'main');
const { StaticServer } = require(path.join(DIST, 'staticServer.js'));

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-static-'));
  fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'renderer', 'index.html'), '<!doctype html><title>pet</title>');
  fs.writeFileSync(path.join(dir, 'renderer', 'renderer.js'), 'window.Pet = 1;');
  fs.writeFileSync(path.join(dir, 'assets', 'demo', 'model3.json'), '{"Version":3}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'root secret');
  const userModels = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-user-models-'));
  fs.mkdirSync(path.join(userModels, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(userModels, 'mine', 'user.model3.json'), '{"user":true}');
  return { dir, userModels };
}

function get(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const { dir, userModels } = makeRoot();
  const server = new StaticServer(dir, [
    { prefix: 'user-models', resolve: (key) => (key === 'mine' ? path.join(userModels, 'mine') : null) },
  ]);
  await server.start();
  try {
    await fn({ port: server.port });
  } finally {
    await server.close();
  }
}

test('静态路由：/renderer 目录与文件、/assets 资源、HTML CSP', async () => {
  await withServer(async ({ port }) => {
    const dirIndex = await get(port, '/renderer/');
    assert.equal(dirIndex.status, 200);
    assert.match(dirIndex.body, /<!doctype html>/i);
    assert.match(String(dirIndex.headers['content-type']), /text\/html/);
    assert.ok(String(dirIndex.headers['content-security-policy'] || '').includes("default-src 'self'"), 'HTML 必须带 CSP');

    const html = await get(port, '/renderer/index.html');
    assert.equal(html.status, 200);

    const js = await get(port, '/renderer/renderer.js');
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /javascript/);

    const asset = await get(port, '/assets/demo/model3.json');
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers['content-type']), /application\/json/);
  });
});

test('额外挂载点：/user-models/<key>/<file> 命中用户目录；未知 key/缺文件 404', async () => {
  await withServer(async ({ port }) => {
    const hit = await get(port, '/user-models/mine/user.model3.json');
    assert.equal(hit.status, 200);
    assert.equal(hit.body, '{"user":true}');

    assert.equal((await get(port, '/user-models/nope/a.json')).status, 404);
    assert.equal((await get(port, '/user-models/mine')).status, 404, '缺文件名的挂载请求应 404');
  });
});

test('边界：路径穿越 403、不存在 404、非 GET 405、OPTIONS 204', async () => {
  await withServer(async ({ port }) => {
    const traversal = await get(port, '/%2e%2e/secret.txt');
    assert.equal(traversal.status, 403, '越界路径必须 403，不能读到 root 之外的文件');

    assert.equal((await get(port, '/assets/demo/missing.json')).status, 404);
    assert.equal((await get(port, '/renderer/index.html', 'POST')).status, 405);
    assert.equal((await get(port, '/renderer/index.html', 'OPTIONS')).status, 204);
  });
});
