const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  devEdit,
  devMkdir,
  devWrite,
  getWorkspaceRoot,
  isDangerousCommand,
  setWorkspaceRoot,
} = require('../dist/main/ai/devTools.js');

function withWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-devtools-'));
  setWorkspaceRoot(root);
  try {
    return run(root);
  } finally {
    setWorkspaceRoot('');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('dev tools refuse writes before a workspace is configured', () => {
  setWorkspaceRoot('');
  assert.equal(getWorkspaceRoot(), '');
  assert.match(devWrite({ path: 'note.txt', content: 'x' }), /未配置开发工作区/);
});

test('dev tools keep writes inside the configured workspace', () => {
  withWorkspace((root) => {
    assert.match(devMkdir({ path: 'src' }), /已创建目录/);
    assert.match(devWrite({ path: 'src/note.txt', content: 'before' }), /已创建文件/);
    assert.equal(fs.readFileSync(path.join(root, 'src/note.txt'), 'utf8'), 'before');

    assert.match(devEdit({ path: 'src/note.txt', old_string: 'before', new_string: 'after' }), /已修改/);
    assert.equal(fs.readFileSync(path.join(root, 'src/note.txt'), 'utf8'), 'after');
    assert.match(devWrite({ path: '../outside.txt', content: 'blocked' }), /路径越界/);
    assert.equal(fs.existsSync(path.join(path.dirname(root), 'outside.txt')), false);
  });
});

test('dangerous command guard rejects destructive and privilege-changing commands', () => {
  assert.match(isDangerousCommand('Remove-Item C:\\Windows -Recurse'), /删除系统目录/);
  assert.match(isDangerousCommand('Start-Process powershell -Verb runAs'), /提权/);
  assert.equal(isDangerousCommand('npm run build'), null);
});