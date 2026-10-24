import type { ToolDef } from '../types';
import { tool_get_time } from './system';
import { tool_active_window_get } from './system';
import { tool_workspace_file_read } from './workspace';
import { tool_workspace_search } from './workspace';
import { tool_workspace_glob } from './workspace';
import { tool_open_path } from './system';
import { tool_plan_update } from './agent';
import { tool_web_fetch } from './web';
import { tool_weather_get } from './web';
import { tool_media_control } from './media';
import { tool_screen_capture } from './media';
import { tool_meeting_create } from './schedule';
import { tool_translate_text } from './web';
import { tool_mail_compose } from './mail';
import { tool_mail_check } from './mail';
import { tool_agent_task } from './agent';
import { tool_plan_propose } from './agent';
import { tool_note_add } from './life';
import { tool_note_list } from './life';
import { tool_open_settings } from './pet';
import { tool_set_emotion } from './pet';
import { tool_play_motion } from './pet';
import { tool_open_todo_panel } from './life';
import { tool_todo_add } from './life';
import { tool_todo_list } from './life';
import { tool_todo_toggle } from './life';
import { tool_todo_remove } from './life';
import { tool_todo_update } from './life';
import { tool_todo_clear_done } from './life';
import { tool_todo_add_many } from './life';
import { tool_set_reminder } from './schedule';
import { tool_reminder_list } from './schedule';
import { tool_reminder_cancel } from './schedule';
import { tool_ask_user } from './pet';
import { tool_skill_list } from './pet';
import { tool_skill_use } from './pet';
import { tool_workspace_set_root } from './workspace';
import { tool_workspace_mkdir } from './workspace';
import { tool_workspace_write } from './workspace';
import { tool_workspace_edit } from './workspace';
import { tool_shell_run } from './dev';
import { tool_shell_bg } from './dev';
import { tool_shell_output } from './dev';
import { tool_shell_kill } from './dev';

/** 模型可见工具清单：顺序与拆分前完全一致（tests/toolCatalog.test.js 有快照） */
export const TOOL_DEFS: ToolDef[] = [
  tool_get_time,
  tool_active_window_get,
  tool_workspace_file_read,
  tool_workspace_search,
  tool_workspace_glob,
  tool_open_path,
  tool_plan_update,
  tool_web_fetch,
  tool_weather_get,
  tool_media_control,
  tool_screen_capture,
  tool_meeting_create,
  tool_translate_text,
  tool_mail_compose,
  tool_mail_check,
  tool_agent_task,
  tool_plan_propose,
  tool_note_add,
  tool_note_list,
  tool_open_settings,
  tool_set_emotion,
  tool_play_motion,
  tool_open_todo_panel,
  tool_todo_add,
  tool_todo_list,
  tool_todo_toggle,
  tool_todo_remove,
  tool_todo_update,
  tool_todo_clear_done,
  tool_todo_add_many,
  tool_set_reminder,
  tool_reminder_list,
  tool_reminder_cancel,
  tool_ask_user,
  tool_skill_list,
  tool_skill_use,
  tool_workspace_set_root,
  tool_workspace_mkdir,
  tool_workspace_write,
  tool_workspace_edit,
  tool_shell_run,
  tool_shell_bg,
  tool_shell_output,
  tool_shell_kill,
];
