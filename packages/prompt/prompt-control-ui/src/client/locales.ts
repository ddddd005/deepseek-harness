export const en = {
  nav: 'Prompt Control', title: 'Prompt Control', create: 'Create profile', loading: 'Loading…', retry: 'Retry',
  empty: 'No profiles yet.', name: 'Name', description: 'Description', rules: 'Rules', addAppend: 'Append request-only',
  addEnable: 'Enable source', addDisable: 'Disable source', addReplace: 'Replace source', save: 'Save', saving: 'Saving…', remove: 'Delete', selected: 'Selected for current session',
  select: 'Use in current session', clear: 'Clear session profile', noSession: 'Open a conversation to manage its Prompt Control profile.',
  sources: 'Sources', sections: 'System sections', contexts: 'Runtime context', variables: 'Variables', preview: 'Preview request', previewEmpty: 'No preview loaded.', system: 'System', messages: 'Messages', tools: 'Tools', lane: 'Lane', ownerPackage: 'Owner package',
  action: 'Action', enabled: 'Enabled', order: 'Order', target: 'Source ID', text: 'Text', role: 'Role', user: 'User',
  append: 'Append request-only', disable: 'Disable source', enable: 'Enable source', replace: 'Replace source', deleteRule: 'Remove rule',
  loadFailed: 'Could not load Prompt Control.', saveFailed: 'Could not save the profile.', conflict: 'This profile changed elsewhere. Latest data was reloaded.',
  selectionFailed: 'Could not update the session profile.', previewFailed: 'Could not load the preview.', sourcesFailed: 'Could not load sources.',
} as const

export type PromptControlUiKey = keyof typeof en

export const zh: Record<PromptControlUiKey, string> = {
  nav: '提示词控制', title: '提示词控制', create: '创建 Profile', loading: '加载中…', retry: '重试',
  empty: '还没有 Profile。', name: '名称', description: '说明', rules: '规则', addAppend: '追加 request-only',
  addEnable: '启用来源', addDisable: '禁用来源', addReplace: '替换来源', save: '保存', saving: '保存中…', remove: '删除', selected: '当前会话已选择',
  select: '用于当前会话', clear: '清除会话 Profile', noSession: '打开一个对话后即可管理它的提示词 Profile。',
  sources: '来源', sections: 'System 条目', contexts: '运行时上下文', variables: '变量', preview: '预览请求', previewEmpty: '尚未加载预览。', system: 'System', messages: '消息', tools: '工具', lane: '通道', ownerPackage: '所属包',
  action: '操作', enabled: '启用', order: '顺序', target: '来源 ID', text: '文本', role: '角色', user: 'User',
  append: '追加 request-only', disable: '禁用来源', enable: '启用来源', replace: '替换来源', deleteRule: '删除规则',
  loadFailed: '无法加载提示词控制。', saveFailed: '无法保存 Profile。', conflict: 'Profile 已在其他位置变更，已重新加载最新数据。',
  selectionFailed: '无法更新会话 Profile。', previewFailed: '无法加载预览。', sourcesFailed: '无法加载来源。',
}
