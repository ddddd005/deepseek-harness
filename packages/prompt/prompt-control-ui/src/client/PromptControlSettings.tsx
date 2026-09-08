import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {
  PromptControlCatalogView, PromptControlPreviewView, PromptControlSessionView,
} from '@deepseek-ai/dsh-prompt-control/types'
import type {
  PromptProfile, PromptProfileCreate, PromptProfileId, PromptProfileSummary, PromptProfileUpdate, PromptRule,
} from '@deepseek-ai/dsh-prompt-control/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptControlUiKey } from './locales.ts'
import css from './PromptControlSettings.module.css'

interface PromptControlApi {
  listProfiles(): Promise<readonly PromptProfileSummary[]>
  getProfile(id: PromptProfileId): Promise<PromptProfile | undefined>
  createProfile(input: PromptProfileCreate): Promise<PromptProfile>
  updateProfile(request: {
    readonly id: PromptProfileId
    readonly expectedRevision: number
    readonly patch: PromptProfileUpdate
  }): Promise<PromptProfile>
  deleteProfile(request: {
    readonly id: PromptProfileId
    readonly expectedRevision: number
  }): Promise<{ readonly deleted: true }>
  getSessionProfile(sessionId: string): Promise<PromptControlSessionView>
  selectSessionProfile(request: { readonly sessionId: string; readonly profileId?: PromptProfileId }): Promise<PromptControlSessionView>
  catalog(sessionId: string): Promise<PromptControlCatalogView>
  previewRequest(sessionId: string): Promise<PromptControlPreviewView>
}

export interface PromptControlSettingsInjected {
  readonly t: (key: PromptControlUiKey) => string
  readonly currentSession: {
    getSnapshot(): { readonly current?: unknown }
    subscribe(listener: () => void): () => void
  }
  readonly api: PromptControlApi
}

export type PromptControlSettingsProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.promptControl'>
  & InjectFace<PromptControlSettingsInjected>

type Notice = 'loadFailed' | 'saveFailed' | 'conflict' | 'selectionFailed' | 'previewFailed' | 'sourcesFailed'

/** Manage a Profile and inspect its effect on the current conversation only. */
export function PromptControlSettings({ api, currentSession, t }: PromptControlSettingsProps): ReactNode {
  const [rows, setRows] = useState<readonly PromptProfileSummary[]>([])
  const [profile, setProfile] = useState<PromptProfile>()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rules, setRules] = useState<readonly PromptRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [selection, setSelection] = useState<PromptControlSessionView>()
  const [catalog, setCatalog] = useState<PromptControlCatalogView>()
  const [preview, setPreview] = useState<PromptControlPreviewView>()
  const sessionLoadRevision = useRef(0)
  const subscribeCurrentSession = (listener: () => void): (() => void) => currentSession.subscribe(listener)
  const getCurrentSession = (): { readonly current?: unknown } => currentSession.getSnapshot()
  const currentSessionId = useSyncExternalStore(
    subscribeCurrentSession,
    getCurrentSession,
    getCurrentSession,
  ).current
  const sessionId = typeof currentSessionId === 'string' ? currentSessionId : undefined

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setRows(await api.listProfiles())
      setNotice(undefined)
    } catch {
      setNotice('loadFailed')
    } finally {
      setLoading(false)
    }
  }
  const readProfile = async (id: PromptProfileId): Promise<void> => {
    const next = await api.getProfile(id)
    if (next === undefined) {
      void load()
      return
    }
    setProfile(next)
    setName(next.name)
    setDescription(next.description ?? '')
    setRules(next.rules)
    setNotice(undefined)
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    const revision = ++sessionLoadRevision.current
    setSelection(undefined)
    setCatalog(undefined)
    setPreview(undefined)
    if (sessionId === undefined) return
    void api.getSessionProfile(sessionId).then(
      (next) => { if (sessionLoadRevision.current === revision) setSelection(next) },
      () => { if (sessionLoadRevision.current === revision) setNotice('selectionFailed') },
    )
    void api.catalog(sessionId).then(
      (next) => { if (sessionLoadRevision.current === revision) setCatalog(next) },
      () => { if (sessionLoadRevision.current === revision) setNotice('sourcesFailed') },
    )
  }, [sessionId])

  const begin = (): void => {
    setProfile(undefined)
    setName('')
    setDescription('')
    setRules([])
    setNotice(undefined)
  }
  const save = async (): Promise<void> => {
    if (name.trim().length === 0) {
      setNotice('saveFailed')
      return
    }
    setSaving(true)
    const input: PromptProfileCreate = {
      name,
      ...(description.trim().length === 0 ? {} : { description }),
      rules,
    }
    try {
      const saved = profile === undefined
        ? await api.createProfile(input)
        : await api.updateProfile({ id: profile.id, expectedRevision: profile.revision, patch: input })
      setPreview(undefined)
      await readProfile(saved.id)
      await load()
    } catch (error) {
      if (errorCode(error) === 'prompt-control/conflict' && profile !== undefined) {
        await readProfile(profile.id)
        setNotice('conflict')
      } else {
        setNotice('saveFailed')
      }
    } finally {
      setSaving(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (profile === undefined) return
    try {
      await api.deleteProfile({ id: profile.id, expectedRevision: profile.revision })
      begin()
      await load()
    } catch {
      setNotice('saveFailed')
    }
  }
  const select = async (profileId?: PromptProfileId): Promise<void> => {
    if (sessionId === undefined) return
    const requestSessionId = sessionId
    const revision = sessionLoadRevision.current
    try {
      const next = await api.selectSessionProfile({
        sessionId: requestSessionId,
        ...(profileId === undefined ? {} : { profileId }),
      })
      if (sessionLoadRevision.current === revision && getCurrentSession().current === requestSessionId) {
        setSelection(next)
        setPreview(undefined)
      }
    } catch {
      if (sessionLoadRevision.current === revision && getCurrentSession().current === requestSessionId) {
        setNotice('selectionFailed')
      }
    }
  }
  const showPreview = async (): Promise<void> => {
    if (sessionId === undefined) return
    const requestSessionId = sessionId
    const revision = sessionLoadRevision.current
    try {
      const next = await api.previewRequest(requestSessionId)
      if (sessionLoadRevision.current === revision && getCurrentSession().current === requestSessionId) {
        setPreview(next)
      }
    } catch {
      if (sessionLoadRevision.current === revision && getCurrentSession().current === requestSessionId) {
        setNotice('previewFailed')
      }
    }
  }
  const catalogSections = catalog?.sections ?? []
  const completeSourceIds = catalogSections.filter(item => item.complete).map(item => item.id)
  const sourceIds = completeSourceIds.length > 0
    ? completeSourceIds
    : catalogSections.filter(item => item.effective).map(item => item.id)
  const addAppendRule = (): void => {
    setRules(current => [...current, appendRule(current.length)])
  }
  const addSourceRule = (action: 'enable' | 'disable' | 'replace'): void => {
    setRules(current => [...current, sourceRule(current.length, action, sourceIds[0] ?? '')])
  }
  const changeRule = (index: number, next: PromptRule): void => {
    setRules(current => current.map((item, itemIndex) => itemIndex === index ? next : item))
  }
  const removeRule = (index: number): void => {
    setRules(current => current.filter((_, itemIndex) => itemIndex !== index))
  }
  return <section className={css.section} aria-busy={loading || saving}>
    <h2>{t('title')}</h2>
    {notice === undefined ? null : <p role="alert" className={css.error}>{t(notice)}</p>}
    {loading ? <p>{t('loading')}</p> : <div className={css.layout}>
      <aside>
        <button type="button" onClick={begin}>{t('create')}</button>
        {rows.length === 0 ? <p>{t('empty')}</p> : <ul>{rows.map(row => <li key={row.id}>
          <button
            type="button"
            data-active={row.id === profile?.id ? 'true' : undefined}
            onClick={() => { void readProfile(row.id) }}
          >
            {row.name}
          </button>
        </li>)}</ul>}
      </aside>
      <div className={css.content}>
        <label>{t('name')}
          <input value={name} onChange={(event) => { setName(event.target.value) }} />
        </label>
        <label>{t('description')}
          <input value={description} onChange={(event) => { setDescription(event.target.value) }} />
        </label>
        <div className={css.row}>
          <h3>{t('rules')}</h3>
          <button type="button" onClick={addAppendRule}>{t('addAppend')}</button>
          <button type="button" onClick={() => { addSourceRule('enable') }}>{t('addEnable')}</button>
          <button type="button" onClick={() => { addSourceRule('disable') }}>{t('addDisable')}</button>
          <button type="button" onClick={() => { addSourceRule('replace') }}>{t('addReplace')}</button>
        </div>
        {rules.map((rule, index) => <RuleEditor
          key={rule.id}
          rule={rule}
          sourceIds={sourceIds}
          t={t}
          onChange={(next) => { changeRule(index, next) }}
          onRemove={() => { removeRule(index) }}
        />)}
        <div className={css.row}>
          <button type="button" disabled={saving} onClick={() => { void save() }}>
            {saving ? t('saving') : t('save')}
          </button>
          {profile === undefined ? null : <button type="button" onClick={() => { void remove() }}>
            {t('remove')}
          </button>}
        </div>
        {sessionId === undefined ? <p>{t('noSession')}</p> : <>
          <div className={css.row}>
            <strong>{selection?.selection?.profileId === profile?.id ? t('selected') : sessionId}</strong>
            <button type="button" disabled={profile === undefined} onClick={() => { void select(profile?.id) }}>
              {t('select')}
            </button>
            <button type="button" onClick={() => { void select() }}>{t('clear')}</button>
          </div>
          <div className={css.inspect}>
            <div>
              <h3>{t('sources')}</h3>
              <Catalog entries={catalog?.sections} title={t('sections')} t={t} />
              <Catalog entries={catalog?.contexts} title={t('contexts')} t={t} />
              <Catalog entries={catalog?.variables} title={t('variables')} t={t} />
              <Catalog entries={catalog?.tools} title={t('tools')} t={t} />
            </div>
            <div>
              <div className={css.row}>
                <h3>{t('preview')}</h3>
                <button type="button" onClick={() => { void showPreview() }}>{t('preview')}</button>
              </div>
              <Preview preview={preview} t={t} />
            </div>
          </div>
        </>}
      </div>
    </div>}
  </section>
}

function RuleEditor({ rule, sourceIds, t, onChange, onRemove }: {
  readonly rule: PromptRule
  readonly sourceIds: readonly string[]
  readonly t: (key: PromptControlUiKey) => string
  readonly onChange: (rule: PromptRule) => void
  readonly onRemove: () => void
}): ReactNode {
  const base = <>
    <label>
      <input
        type="checkbox"
        checked={rule.enabled}
        onChange={(event) => { onChange({ ...rule, enabled: event.target.checked }) }}
      />
      {t('enabled')}
    </label>
    <label>{t('order')}
      <input
        type="number"
        value={rule.order}
        onChange={(event) => { onChange({ ...rule, order: Number(event.target.value) }) }}
      />
    </label>
  </>
  return <div className={css.rule}>
    {base}
    {rule.action === 'append-request' ? <>
      <label>{t('role')}
        <select
          value={rule.role}
          onChange={(event) => { onChange({ ...rule, role: event.target.value as 'system' | 'user' }) }}
        >
          <option value="system">{t('system')}</option>
          <option value="user">{t('user')}</option>
        </select>
      </label>
      <button type="button" title={t('deleteRule')} aria-label={t('deleteRule')} onClick={onRemove}>x</button>
      <label className={css.ruleWide}>{t('text')}
        <textarea value={rule.text} onChange={(event) => { onChange({ ...rule, text: event.target.value }) }} />
      </label>
    </> : <>
      <label>{t('action')}
        <select
          value={rule.action}
          onChange={(event) => {
            onChange(changeAction(rule, event.target.value as 'enable' | 'disable' | 'replace'))
          }}
        >
          <option value="enable">{t('enable')}</option>
          <option value="disable">{t('disable')}</option>
          <option value="replace">{t('replace')}</option>
        </select>
      </label>
      <button type="button" title={t('deleteRule')} aria-label={t('deleteRule')} onClick={onRemove}>x</button>
      <label className={css.ruleWide}>{t('target')}
        <select value={rule.target} onChange={(event) => { onChange({ ...rule, target: event.target.value as never }) }}>
          {sourceIds.map(sourceId => <option key={sourceId} value={sourceId}>{sourceId}</option>)}
        </select>
      </label>
      {rule.action === 'replace' ? <label className={css.ruleWide}>{t('text')}
        <textarea value={rule.text} onChange={(event) => { onChange({ ...rule, text: event.target.value }) }} />
      </label> : null}
    </>}
  </div>
}

function Preview({ preview, t }: {
  readonly preview: PromptControlPreviewView | undefined
  readonly t: (key: PromptControlUiKey) => string
}): ReactNode {
  if (preview === undefined) return <p>{t('previewEmpty')}</p>
  return <dl>
    <dt>{t('system')}</dt>
    <dd><pre>{preview.system}</pre></dd>
    <dt>{t('messages')}</dt>
    <dd>{preview.messages.map(message => <pre key={message.id}>
      {message.role} ({message.sourceKind}): {message.content}
    </pre>)}</dd>
    <dt>{t('tools')}</dt>
    <dd>{preview.tools?.map(tool => <pre key={tool.name}>{tool.name}: {tool.parameters}</pre>)}</dd>
  </dl>
}

type CatalogEntry = {
  readonly id?: string
  readonly name?: string
  readonly lane?: string
  readonly source: { readonly ownerPackage: string }
  readonly text?: string
  readonly value?: string
  readonly description?: string
  readonly parameters?: string
}

function Catalog({ entries, title, t }: {
  readonly entries: readonly CatalogEntry[] | undefined
  readonly title: string
  readonly t: (key: PromptControlUiKey) => string
}): ReactNode {
  if (entries === undefined || entries.length === 0) return null
  return <div>
    <h4>{title}</h4>
    {entries.map(entry => <details key={entry.id ?? entry.name}>
      <summary>{entry.name ?? entry.id} {entry.id === undefined ? null : <code>{entry.id}</code>}</summary>
      <pre>{[
        entry.lane === undefined ? undefined : `${t('lane')}: ${entry.lane}`,
        `${t('ownerPackage')}: ${entry.source.ownerPackage}`,
        entry.text ?? entry.value ?? entry.description ?? entry.parameters,
      ].filter((part): part is string => part !== undefined).join('\n')}</pre>
    </details>)}
  </div>
}

function appendRule(order: number): PromptRule {
  return { id: `append-${Date.now()}` as never, enabled: true, order, action: 'append-request', role: 'system', text: '' }
}
function sourceRule(order: number, action: 'enable' | 'disable' | 'replace', target: string): PromptRule {
  const base = { id: `${action}-${Date.now()}` as never, enabled: true, order, target: target as never }
  if (action === 'replace') return { ...base, action, text: '' }
  if (action === 'enable') return { ...base, action }
  return { ...base, action }
}
function changeAction(
  rule: Exclude<PromptRule, { action: 'append-request' }>,
  action: 'enable' | 'disable' | 'replace',
): PromptRule {
  const base = { id: rule.id, enabled: rule.enabled, order: rule.order, target: rule.target }
  return action === 'replace' ? { ...base, action, text: '' } : { ...base, action }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
