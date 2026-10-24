'use strict';
/** 验证工具目录的数量、名称、顺序和结构。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const catalog = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'tools', 'catalog'));
const reported = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'chatClient'));

const EXPECTED_NAMES = [
  'get_time',
  'active_window_get',
  'workspace_file_read',
  'workspace_search',
  'workspace_glob',
  'open_path',
  'plan_update',
  'web_fetch',
  'weather_get',
  'media_control',
  'screen_capture',
  'meeting_create',
  'translate_text',
  'mail_compose',
  'mail_check',
  'agent_task',
  'plan_propose',
  'note_add',
  'note_list',
  'open_settings',
  'set_emotion',
  'play_motion',
  'open_todo_panel',
  'todo_add',
  'todo_list',
  'todo_toggle',
  'todo_remove',
  'todo_update',
  'todo_clear_done',
  'todo_add_many',
  'set_reminder',
  'reminder_list',
  'reminder_cancel',
  'ask_user',
  'skill_list',
  'skill_use',
  'workspace_set_root',
  'workspace_mkdir',
  'workspace_write',
  'workspace_edit',
  'shell_run',
  'shell_bg',
  'shell_output',
  'shell_kill',
];

test('工具目录：数量/名称/顺序与拆分前一致', () => {
  const names = catalog.TOOL_DEFS.map((d) => d.function.name);
  assert.equal(catalog.TOOL_DEFS.length, EXPECTED_NAMES.length);
  assert.deepEqual(names, EXPECTED_NAMES);
});

test('工具目录：chatClient 仍导出 TOOL_DEFS（老引用不破）', () => {
  assert.equal(reported.TOOL_DEFS, catalog.TOOL_DEFS, 'chatClient.TOOL_DEFS 应复用同一目录（不做第二份拷贝）');
});

test('工具目录：每条定义结构完整、无重名', () => {
  const names = new Set();
  for (const def of catalog.TOOL_DEFS) {
    assert.equal(def.type, 'function');
    const fn = def.function;
    assert.equal(typeof fn.name, 'string');
    assert.ok(fn.name.length > 0 && fn.name.length <= 64, `工具名长度不合法：${fn.name}`);
    assert.equal(typeof fn.description, 'string');
    assert.ok(fn.description.trim().length > 0, `工具缺描述：${fn.name}`);
    assert.equal(typeof fn.parameters, 'object');
    assert.ok(!names.has(fn.name), `工具名重复：${fn.name}`);
    names.add(fn.name);
  }
});
