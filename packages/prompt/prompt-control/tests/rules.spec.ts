import { describe, expect, it } from 'vitest'
import type { CatalogSection, PromptContributionId } from '@deepseek-ai/dsh-system-prompt'
import {
  evaluatePromptRules,
  PromptRuleId,
  PromptRuleValidationError,
  UnknownPromptContributionError,
} from '@deepseek-ai/dsh-prompt-control'

const contributionId = (value: string): PromptContributionId => value as PromptContributionId

function section(id: string, order: number, text = id): CatalogSection {
  const contribution = contributionId(id)
  return {
    id: contribution,
    name: id,
    lane: 'system',
    source: { ownerPackage: 'test', contributionId: contribution, lifetime: 'durable' },
    order,
    text,
    dynamic: false,
    complete: false,
    effective: true,
  }
}

describe('P0 prompt rule interpreter', () => {
  it('applies deterministic profile and request layers without moving native sections', () => {
    const result = evaluatePromptRules(
      [section('later', 20), section('first', 10)],
      [
        { id: PromptRuleId('profile-append'), enabled: true, order: 5, action: 'append-request', role: 'system', text: 'profile tail' },
        { id: PromptRuleId('profile-disable'), enabled: true, order: 2, action: 'disable', target: contributionId('later') },
        { id: PromptRuleId('profile-replace'), enabled: true, order: 2, action: 'replace', target: contributionId('first'), text: 'profile text' },
      ],
      [
        { id: PromptRuleId('request-enable'), enabled: true, order: 1, action: 'enable', target: contributionId('later') },
        { id: PromptRuleId('request-replace'), enabled: true, order: 1, action: 'replace', target: contributionId('first'), text: 'request text' },
        { id: PromptRuleId('request-user'), enabled: true, order: 3, action: 'append-request', role: 'user', text: 'request tail' },
      ],
    )

    expect(result.sections).toEqual([
      { id: contributionId('first'), text: 'request text' },
      { id: contributionId('later'), text: 'later' },
    ])
    expect(result.appendedRequests).toEqual([
      { ruleId: PromptRuleId('profile-append'), role: 'system', text: 'profile tail' },
      { ruleId: PromptRuleId('request-user'), role: 'user', text: 'request tail' },
    ])
  })

  it('orders ties by rule id and retains disabled rules without applying them', () => {
    const result = evaluatePromptRules([section('base', 0)], [
      { id: PromptRuleId('z'), enabled: true, order: 0, action: 'append-request', role: 'system', text: 'z' },
      { id: PromptRuleId('a'), enabled: true, order: 0, action: 'append-request', role: 'system', text: 'a' },
      { id: PromptRuleId('disabled'), enabled: false, order: -1, action: 'disable', target: contributionId('base') },
    ])
    expect(result.sections).toEqual([{ id: contributionId('base'), text: 'base' }])
    expect(result.appendedRequests.map(item => item.text)).toEqual(['a', 'z'])
  })

  it('rejects invalid targets and malformed layer collections', () => {
    expect(() => evaluatePromptRules([section('known', 0)], [
      { id: PromptRuleId('unknown'), enabled: true, order: 0, action: 'enable', target: contributionId('missing') },
    ])).toThrow(UnknownPromptContributionError)

    expect(() => evaluatePromptRules([], [
      { id: PromptRuleId('duplicate'), enabled: true, order: 0, action: 'append-request', role: 'system', text: 'one' },
      { id: PromptRuleId('duplicate'), enabled: true, order: 1, action: 'append-request', role: 'system', text: 'two' },
    ])).toThrow(PromptRuleValidationError)

    expect(() => evaluatePromptRules([section('known', 0)], [
      { id: PromptRuleId('first'), enabled: true, order: 0, action: 'replace', target: contributionId('known'), text: 'one' },
      { id: PromptRuleId('second'), enabled: true, order: 1, action: 'replace', target: contributionId('known'), text: 'two' },
    ])).toThrow(/multiple enabled replacements/)

    expect(() => evaluatePromptRules([], [
      { id: PromptRuleId('blank'), enabled: true, order: 0, action: 'append-request', role: 'system', text: '  ' },
    ])).toThrow(/must not be blank/)

    expect(() => evaluatePromptRules([], [
      { id: PromptRuleId('bad-role'), enabled: true, order: 0, action: 'append-request', role: 'assistant' as never, text: 'text' },
    ])).toThrow(/role must be 'system' or 'user'/)
  })
})
