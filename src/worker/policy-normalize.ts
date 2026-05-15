import type {
  ForwardPolicyAction,
  HttpRequestPolicyAction,
  MailPolicy,
  MailPolicyConfig,
  PolicyAction,
  PolicyCondition,
  PolicyConditionMode,
  PolicyConditionOperator,
  PolicyKeyValue,
  PublicMailPolicy,
  PublicPolicyAction,
  TelegramPolicyAction
} from './types';
import {
  bodyTypes,
  conditionFields,
  conditionOperators,
  DEFAULT_HTTP_TIMEOUT_MS,
  defaultPolicyConfig,
  httpMethods,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  MAX_HTTP_TIMEOUT_MS,
  MAX_POLICIES,
  MAX_TEMPLATE_LENGTH
} from './policy-constants';
import { createId, maskSecret, nowIso } from './utils';

export interface PolicyInput extends Partial<MailPolicy> {}

export function createPolicyVersion() {
  return createId('policy_ver');
}

export function comparePolicies(a: MailPolicy, b: MailPolicy) {
  return a.priority - b.priority;
}

function normalizeConditionMode(value: unknown): PolicyConditionMode {
  return value === 'any' ? 'any' : 'all';
}

export function normalizeKeyValueList(value: unknown): PolicyKeyValue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const input = item && typeof item === 'object' ? (item as Partial<PolicyKeyValue>) : {};
      const key = String(input.key || '').trim();
      const rowValue = String(input.value || '').trim();
      if (!key) return null;
      return {
        id: String(input.id || createId('kv')),
        key,
        value: rowValue
      };
    })
    .filter((item): item is PolicyKeyValue => Boolean(item));
}

function normalizeConditions(value: unknown): PolicyCondition[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_CONDITIONS)
    .map((item) => {
      const input = item && typeof item === 'object' ? (item as Partial<PolicyCondition>) : {};
      const inputField = input.field as PolicyCondition['field'];
      const field = conditionFields.has(inputField) ? inputField : 'from';
      const operator = conditionOperators.has(input.operator as PolicyConditionOperator) ? (input.operator as PolicyConditionOperator) : 'contains';
      const value = String(input.value || '').trim();
      if (!value) return null;
      if (field === 'hasAttachments' || field === 'forwarded') {
        if (value !== 'true' && value !== 'false') throw new Error(`${field} 仅支持 true 或 false`);
      }
      return {
        id: String(input.id || createId('condition')),
        field,
        operator,
        value
      };
    })
    .filter((item): item is PolicyCondition => Boolean(item));
}

function assertUrl(value: string, label: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error(`${label} URL 只支持 http 或 https`);
  }
}

function assertEmail(value: string, label: string) {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${label}格式不正确`);
  }
}

function normalizeEmailList(value: unknown, label: string) {
  const emails = [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) throw new Error(`${label}不能为空`);
  emails.forEach((email) => assertEmail(email, label));
  return emails;
}

function normalizeForwardAction(input: Partial<ForwardPolicyAction>): ForwardPolicyAction {
  const to = normalizeEmailList(input.to, '转发邮箱');
  return {
    id: String(input.id || createId('action')),
    type: 'forward',
    name: String(input.name || '转发邮件').trim().slice(0, 60),
    to
  };
}

function normalizeHttpAction(input: Partial<HttpRequestPolicyAction>, index: number): HttpRequestPolicyAction {
  const url = String(input.url || '').trim();
  if (!url) throw new Error('请求 URL 不能为空');
  assertUrl(url, '请求');
  if (input.method !== undefined && !httpMethods.has(input.method as HttpRequestPolicyAction['method'])) {
    throw new Error('请求方法只支持 GET 或 POST');
  }
  const method = (input.method as HttpRequestPolicyAction['method']) || 'POST';
  const bodyType = bodyTypes.has(input.bodyType as HttpRequestPolicyAction['bodyType']) ? (input.bodyType as HttpRequestPolicyAction['bodyType']) : method === 'GET' ? 'none' : 'json';
  const body = String(input.body || '').slice(0, MAX_TEMPLATE_LENGTH);
  const timeoutMs = Math.min(Math.max(Math.floor(Number(input.timeoutMs) || DEFAULT_HTTP_TIMEOUT_MS), 1000), MAX_HTTP_TIMEOUT_MS);

  return {
    id: String(input.id || createId('action')),
    type: 'httpRequest',
    name: String(input.name || `发送请求 ${index + 1}`).trim().slice(0, 60),
    method,
    url,
    headers: normalizeKeyValueList(input.headers),
    query: normalizeKeyValueList(input.query),
    bodyType,
    body,
    timeoutMs
  };
}

function normalizeChatIds(value: unknown) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))].slice(0, 10);
}

function normalizeTelegramAction(input: Partial<TelegramPolicyAction>, index: number, current?: TelegramPolicyAction): TelegramPolicyAction {
  const botToken = String(input.botToken || current?.botToken || '').trim();
  if (!botToken) throw new Error('Bot Token 不能为空');
  const chatIds = normalizeChatIds(input.chatIds);
  if (chatIds.length === 0) throw new Error('Chat ID 不能为空');
  const message = String(input.message || current?.message || '').trim().slice(0, MAX_TEMPLATE_LENGTH);
  if (!message) throw new Error('TG 消息模板不能为空');
  return {
    id: String(input.id || createId('action')),
    type: 'telegram',
    name: String(input.name || `发送至TG ${index + 1}`).trim().slice(0, 60),
    botToken,
    botTokenConfigured: true,
    botTokenMasked: maskSecret(botToken),
    chatIds,
    message
  };
}

function normalizeActions(value: unknown, currentActions: PolicyAction[] = []): PolicyAction[] {
  if (!Array.isArray(value)) return [];
  const currentActionMap = new Map(currentActions.map((action) => [action.id, action]));
  return value
    .slice(0, MAX_ACTIONS)
    .map((item, index) => {
      const input = item && typeof item === 'object' ? (item as Partial<PolicyAction>) : {};
      if (input.type === 'forward') return normalizeForwardAction(input as Partial<ForwardPolicyAction>);
      if (input.type === 'httpRequest') return normalizeHttpAction(input as Partial<HttpRequestPolicyAction>, index);
      if (input.type === 'telegram') {
        const current = currentActionMap.get(String(input.id || ''));
        return normalizeTelegramAction(input as Partial<TelegramPolicyAction>, index, current?.type === 'telegram' ? current : undefined);
      }
      return null;
    })
    .filter((item): item is PolicyAction => Boolean(item));
}

function normalizePriority(value: unknown, fallback: number) {
  const numberValue = Math.floor(Number(value));
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(numberValue, 0), 9999);
}

export function normalizePolicy(input: PolicyInput, index: number, current?: MailPolicy): MailPolicy {
  const now = nowIso();
  const actions = normalizeActions(input.actions, current?.actions || []);
  if (actions.length === 0) throw new Error('请至少添加一个执行动作');

  return {
    id: String(input.id || current?.id || createId('policy')).trim(),
    version: String(input.version || current?.version || current?.updatedAt || input.updatedAt || current?.createdAt || input.createdAt || createPolicyVersion()),
    name: String(input.name || current?.name || `策略 ${index + 1}`).trim().slice(0, 60),
    enabled: input.enabled === undefined ? current?.enabled !== false : input.enabled === true,
    priority: normalizePriority(input.priority ?? current?.priority, 0),
    conditionMode: normalizeConditionMode(input.conditionMode ?? current?.conditionMode),
    stopOnMatch: input.stopOnMatch === undefined ? current?.stopOnMatch === true : input.stopOnMatch === true,
    conditions: normalizeConditions(input.conditions),
    actions,
    createdAt: String(input.createdAt || current?.createdAt || now),
    updatedAt: now
  };
}

export function normalizePolicyConfig(input: unknown, current: MailPolicyConfig = defaultPolicyConfig): MailPolicyConfig {
  const body = input && typeof input === 'object' ? (input as { policies?: unknown }) : {};
  const rawPolicies = Array.isArray(body.policies) ? body.policies : [];
  if (rawPolicies.length > MAX_POLICIES) {
    throw new Error(`邮件策略最多 ${MAX_POLICIES} 条`);
  }

  const currentPolicies = new Map(current.policies.map((policy) => [policy.id, policy]));
  return {
    policies: rawPolicies
      .map((item, index) => {
        const policyInput = item && typeof item === 'object' ? (item as PolicyInput) : {};
        return normalizePolicy(policyInput, index, currentPolicies.get(String(policyInput.id || '')));
      })
      .sort(comparePolicies)
  };
}

function publicAction(action: PolicyAction): PublicPolicyAction {
  if (action.type === 'telegram') {
    return {
      ...action,
      botToken: '',
      botTokenConfigured: Boolean(action.botToken),
      botTokenMasked: maskSecret(action.botToken)
    };
  }
  return action;
}

export function toPublicPolicy(policy: MailPolicy): PublicMailPolicy {
  return {
    ...policy,
    actions: policy.actions.map(publicAction)
  };
}
