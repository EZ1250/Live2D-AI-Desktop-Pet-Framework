/**
 * modelSources.test.js —— 模型动作/表情/参数映射的通用扫描（主进程识别 + 渲染层合并共用）。
 *
 * 覆盖三种真实来源：
 *   1. model3.json 正常引用；
 *   2. VTube Studio 的 .vtube.json 热键（同名/不同名都要能扫到）+ ParameterSettings；
 *   3. model3 和 vtube 都没引用的松散 Animation/ Exp3/ 文件（"半套导出"）。
 * 关键约束：同一个文件只注册一次（去重），组名/表情名撞车时自动改名，不让后加的直接丢。
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('../dist/main/assets/modelSources.js');

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pet-src-${tag}-`));
}

function write(dir, rel, content) {
  const file = path.join(dir, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

describe('scanModelSources', () => {
  it('merges model3 refs + same-name vtube hotkeys + loose files, deduped', () => {
    const dir = tempDir('merge');
    write(dir, 'm.model3.json', {
      FileReferences: {
        Moc: 'm.moc3',
        Motions: { Idle: [{ File: 'Animation/IDLE.motion3.json' }], Wave: [{ File: 'Animation/wave.motion3.json' }] },
        Expressions: [{ Name: '正常脸', File: 'Exp3/normal.exp3.json' }],
      },
    });
    write(dir, 'Animation/IDLE.motion3.json', {});
    write(dir, 'Animation/wave.motion3.json', {});
    write(dir, 'Exp3/normal.exp3.json', {});
    write(dir, 'Exp3/害羞.exp3.json', {});
    write(dir, 'Animation/pop.motion3.json', {});
    write(dir, 'Animation/idle2.motion3.json', {});
    write(dir, 'm.vtube.json', {
      Hotkeys: [
        // 已在 model3 里的文件：不重复注册
        { Action: 'ToggleExpression', Name: '正常脸', File: 'normal.exp3.json', IsActive: true },
        { Action: 'ToggleExpression', Name: '害羞', File: '害羞.exp3.json', IsActive: true },
        { Action: 'ToggleExpression', Name: '停用', File: '害羞.exp3.json', IsActive: false },
        { Action: 'TriggerAnimation', Name: '抚胸手打开', File: 'pop.motion3.json', IsActive: true },
        { Action: 'ChangeIdleAnimation', Name: '待机2', File: 'idle2.motion3.json', IsActive: true },
      ],
      ParameterSettings: [
        { Input: 'FaceAngleX', OutputLive2D: 'AngleX', InputRangeLower: -30, InputRangeUpper: 30, OutputRangeLower: -30, OutputRangeUpper: 30 },
        { Input: 'FaceAngleY', OutputLive2D: 'AngleY', InputRangeLower: -20, InputRangeUpper: 20, OutputRangeLower: -30, OutputRangeUpper: 30, UseBreathing: true },
        { Input: '', OutputLive2D: 'Bad' },
      ],
    });

    const out = m.scanModelSources(dir, 'm.model3.json');
    // vtube 里的 ChangeIdleAnimation 编号避开 model3 已有的 Idle
    assert.deepEqual(out.motions.map((x) => x.group), ['抚胸手打开', 'Idle1']);
    assert.deepEqual(out.expressions.map((x) => x.name), ['害羞']);
    // 呼吸行被跳过、空 Input 被跳过
    assert.equal(out.paramRows.length, 1);
    assert.equal(out.paramRows[0].outId, 'AngleX');
    assert.equal(out.stats.vtsMotions, 2);
    assert.equal(out.stats.vtsExpressions, 1);
    assert.equal(out.stats.looseMotions, 0);
    assert.equal(out.stats.vtsFiles.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to loose Animation/ Exp3/ files when model3 declares nothing', () => {
    const dir = tempDir('loose');
    write(dir, 'm.model3.json', { FileReferences: { Moc: 'm.moc3', Motions: {}, Expressions: [] } });
    write(dir, 'Animation/IDLE.motion3.json', {});
    write(dir, 'Animation/挥手.motion3.json', {});
    write(dir, 'Exp3/微笑.exp3.json', {});
    write(dir, 'Exp3/侧头.exp3.json', {});

    const out = m.scanModelSources(dir, 'm.model3.json');
    // IDLE.motion3.json 松散文件归到 Idle 组
    assert.deepEqual(out.motions.map((x) => x.group).sort(), ['Idle', '挥手'].sort());
    assert.deepEqual(out.expressions.map((x) => x.name).sort(), ['侧头', '微笑'].sort());
    assert.equal(out.stats.looseMotions, 2);
    assert.equal(out.stats.looseExpressions, 2);
    assert.equal(out.stats.vtsFiles.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('picks up a differently named .vtube.json too (renderer merges by same name only)', () => {
    const dir = tempDir('mismatch');
    write(dir, 'a.model3.json', { FileReferences: { Moc: 'a.moc3' } });
    write(dir, 'Animation/pop.motion3.json', {});
    write(dir, 'Animation/other.vtube.json', {
      Hotkeys: [{ Action: 'TriggerAnimation', Name: '挥手', File: 'pop.motion3.json', IsActive: true }],
    });
    const out = m.scanModelSources(dir, 'a.model3.json');
    assert.deepEqual(out.motions.map((x) => x.group), ['挥手']);
    assert.deepEqual(out.stats.vtsFiles, ['Animation/other.vtube.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renames colliding group/expression names instead of dropping them', () => {
    const dir = tempDir('collide');
    write(dir, 'm.model3.json', {
      FileReferences: { Moc: 'm.moc3', Motions: { Wave: [{ File: 'Animation/wave.motion3.json' }] }, Expressions: [{ Name: '害羞', File: 'Exp3/害羞.exp3.json' }] },
    });
    write(dir, 'Animation/wave.motion3.json', {});
    write(dir, 'Animation/wave2.motion3.json', {});
    write(dir, 'Exp3/害羞.exp3.json', {});
    write(dir, 'm.vtube.json', {
      Hotkeys: [
        { Action: 'TriggerAnimation', Name: 'Wave', File: 'wave2.motion3.json', IsActive: true },
        { Action: 'ToggleExpression', Name: '害羞', File: '害羞.exp3.json', IsActive: true },
      ],
    });
    const out = m.scanModelSources(dir, 'm.model3.json');
    assert.deepEqual(out.motions.map((x) => x.group), ['Wave (2)']);
    // 同一个文件被 vtube 重复引用：去重后不再出现同名表情
    assert.deepEqual(out.expressions, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty result for unreadable model3', () => {
    const dir = tempDir('bad');
    write(dir, 'm.model3.json', '{not json');
    const out = m.scanModelSources(dir, 'm.model3.json');
    assert.deepEqual(out.motions, []);
    assert.deepEqual(out.expressions, []);
    assert.deepEqual(out.paramRows, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
