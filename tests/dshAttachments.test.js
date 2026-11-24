const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareAttachmentsForDsh } = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'mediaAttachments.js'));

test('DSH 附件：图片/文本/普通文件复制并给出读取提示', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-dsh-att-'));
  try {
    const bridge = path.join(root, 'bridge');
    const img = path.join(root, 'a.png');
    const txt = path.join(root, 'b.txt');
    const bin = path.join(root, 'c.pdf');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(txt, 'hello dsh');
    fs.writeFileSync(bin, Buffer.from('%PDF-1.4'));
    const atts = [
      { path: img, name: 'a.png', mime: 'image/png', size: 4, kind: 'image' },
      { path: txt, name: 'b.txt', mime: 'text/plain', size: 9, kind: 'text' },
      { path: bin, name: 'c.pdf', mime: 'application/pdf', size: 8, kind: 'file' },
    ];
    const out = await prepareAttachmentsForDsh({}, bridge, atts);
    assert.ok(!out.blockedError, out.blockedError);
    assert.match(out.promptText, /read_image/);
    assert.match(out.promptText, /hello dsh/);
    assert.match(out.promptText, /application\/pdf/);
    assert.ok(fs.readdirSync(path.join(bridge, 'inbox')).length === 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
