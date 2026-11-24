const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareAttachmentsForDsh } = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'mediaAttachments.js'));
test('DSH 附件：恶意文件名不会穿出 inbox', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-dsh-safe-'));
  try {
    const bridge = path.join(root, 'bridge');
    const src = path.join(root, 'evil.txt');
    fs.writeFileSync(src, 'x');
    const out = await prepareAttachmentsForDsh({}, bridge, [
      { path: src, name: '../../evil.txt', mime: 'text/plain', size: 1, kind: 'text' },
    ]);
    assert.ok(!out.blockedError, out.blockedError);
    const files = fs.readdirSync(path.join(bridge, 'inbox'));
    assert.equal(files.length, 1);
    assert.ok(!files[0].includes('..'));
    assert.ok(fs.existsSync(path.join(bridge, 'inbox', files[0])));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
