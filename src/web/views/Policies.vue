<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';
import { apiErrorMessage } from '../api/client';
import { endpoints, type ActionType, type ForwardAction, type ForwardAddressStatus, type HttpAction, type HttpMethod, type MailPolicy, type PolicyAction, type PolicyCondition, type PolicyKeyValue, type PolicyPage, type TelegramAction } from '../api/endpoints';
import McCfSelect from '../components/McCfSelect.vue';
import McIcon from '../components/McIcon.vue';
import McTemplateField from '../components/McTemplateField.vue';
import { confirmDialog } from '../composables/confirmDialog';
import { useFooterMetrics } from '../composables/footerStatus';
import { usePageRefresh } from '../composables/pageRefresh';
import { createForwardAddress, deletePolicyAndUpdatePage, loadForwardAddressStatuses as loadForwardAddressStatusesQuery, loadPoliciesPage, policyParams, savePolicyAndUpdatePage } from '../queries/policies';

type EditorMode = 'idle' | 'create' | 'edit';
type DraftForwardAction = ForwardAction;
type DraftHttpAction = HttpAction & { formRows: PolicyKeyValue[] };
type DraftTelegramAction = Omit<TelegramAction, 'chatIds'> & { chatIds: string };
type DraftPolicyAction = DraftForwardAction | DraftHttpAction | DraftTelegramAction;
type DraftMailPolicy = Omit<MailPolicy, 'actions'> & { actions: DraftPolicyAction[] };
type PolicyListItem = MailPolicy | DraftMailPolicy;
type TemplateCodeEditorExpose = {
  formatJson: () => void;
  focus: () => void;
  triggerCompletion: () => void;
};

const McTemplateCodeEditor = defineAsyncComponent(() => import('../components/McTemplateCodeEditor.vue'));

interface LoadPolicyOptions {
  selectId?: string;
  fallbackSelectId?: string;
}

const fieldOptions = [
  { label: '发件人', value: 'from' },
  { label: '发件域名', value: 'fromDomain' },
  { label: '收件人', value: 'to' },
  { label: '收件域名', value: 'domain' },
  { label: '主题', value: 'subject' },
  { label: '正文内容', value: 'content' },
  { label: '有附件', value: 'hasAttachments' },
  { label: '转发接收', value: 'forwarded' }
];

const operatorOptions = [
  { label: '包含', value: 'contains' },
  { label: '等于', value: 'equals' },
  { label: '开始于', value: 'startsWith' },
  { label: '结束于', value: 'endsWith' }
];

const conditionModeOptions = [
  { label: '全部条件命中', value: 'all' },
  { label: '任一条件命中', value: 'any' }
];
const booleanValueOptions = [
  { label: '是', value: 'true' },
  { label: '否', value: 'false' }
];

const methodOptions = ['GET', 'POST'].map((item) => ({ label: item, value: item }));
const bodyTypeOptions = [
  { label: '无正文', value: 'none' },
  { label: 'JSON', value: 'json' },
  { label: '表单', value: 'form' },
  { label: '文本', value: 'text' }
];
const defaultTelegramMessage = [
  '<b>DoneMail邮件通知</b>',
  '',
  '<b>主题</b>：{{subject}}',
  '<b>发件人</b>：{{fromAddr}}',
  '<b>收件人</b>：{{to}}',
  '<b>时间</b>：{{receivedAt}}',
  '',
  '{{content}}'
].join('\n');
const templateVars = [
  { label: '邮件ID', value: '{{id}}' },
  { label: '发件邮箱', value: '{{fromAddr}}' },
  { label: '发件名称', value: '{{fromName}}' },
  { label: '收件邮箱', value: '{{to}}' },
  { label: '收件域名', value: '{{domain}}' },
  { label: '接收地址', value: '{{receivedBy}}' },
  { label: '邮件主题', value: '{{subject}}' },
  { label: '正文内容', value: '{{content}}' },
  { label: '正文摘要', value: '{{preview}}' },
  { label: '接收时间', value: '{{receivedAt}}' }
];

const saving = ref(false);
const editorMode = ref<EditorMode>('idle');
const selectedPolicyId = ref('');
const expandedActionId = ref('');
const actionMenuOpen = ref(false);
const actionMenuButton = ref<HTMLElement | null>(null);
const actionMenu = ref<HTMLElement | null>(null);
const actionMenuStyle = ref<Record<string, string>>({});
const rows = ref<MailPolicy[]>([]);
const total = ref(0);
const policiesLoaded = ref(false);
const codeEditors = ref<Record<string, TemplateCodeEditorExpose>>({});
const forwardAddressLoading = ref(false);
const verifyingForwardAddress = ref('');
const forwardAddressStatuses = ref<Record<string, ForwardAddressStatus>>({});
const query = reactive({
  keyword: '',
  page: 1,
  pageSize: 20
});
const listParams = computed(() => policyParams(query));
const draft = reactive<DraftMailPolicy>(newPolicy());

const editorActive = computed(() => editorMode.value !== 'idle');
const editorTitle = computed(() => (editorMode.value === 'create' ? '新建邮件策略' : '编辑邮件策略'));
const visiblePolicies = computed<PolicyListItem[]>(() => {
  if (editorMode.value !== 'create') return rows.value;
  return [...rows.value.filter((item) => item.id !== draft.id), draft];
});
const canPrev = computed(() => query.page > 1);
const canNext = computed(() => query.page * query.pageSize < total.value);

useFooterMetrics(() => [
  { label: '本页', value: rows.value.length, unit: '条' },
  { label: '第', value: query.page, unit: '页' }
]);

function draftId(prefix: string) {
  return `draft_${prefix}_${crypto.randomUUID()}`;
}

function newCondition(): PolicyCondition {
  return { id: draftId('condition'), field: 'from', operator: 'contains', value: '' };
}

function newKeyValue(): PolicyKeyValue {
  return { id: draftId('kv'), key: '', value: '' };
}

function newForwardAction(): DraftForwardAction {
  return { id: draftId('action'), type: 'forward', name: '转发邮件', to: [''] };
}

function newHttpAction(): DraftHttpAction {
  return {
    id: draftId('action'),
    type: 'httpRequest',
    name: '发送请求',
    method: 'POST',
    url: '',
    headers: [],
    query: [],
    bodyType: 'json',
    body: '{\n  "event": "mail.received",\n  "id": "{{id}}",\n  "from": "{{fromAddr}}",\n  "to": "{{to}}",\n  "subject": "{{subject}}"\n}',
    formRows: [],
    timeoutMs: 8000
  };
}

function newTelegramAction(): DraftTelegramAction {
  return {
    id: draftId('action'),
    type: 'telegram',
    name: '发送至TG',
    botToken: '',
    botTokenConfigured: false,
    botTokenMasked: '',
    chatIds: '',
    message: defaultTelegramMessage
  };
}

function newPolicy(): DraftMailPolicy {
  const now = new Date().toISOString();
  return {
    id: draftId('policy'),
    version: draftId('version'),
    name: '新建策略',
    enabled: true,
    priority: 0,
    conditionMode: 'any',
    stopOnMatch: true,
    conditions: [],
    actions: [],
    createdAt: now,
    updatedAt: now
  };
}

function parseFormRows(body: string): PolicyKeyValue[] {
  try {
    const parsed = JSON.parse(body || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({ ...newKeyValue(), ...(item && typeof item === 'object' ? item : {}) }));
  } catch {
    return [];
  }
}

function normalizeAction(action: Partial<PolicyAction | DraftPolicyAction>): DraftPolicyAction {
  if (action.type === 'forward') {
    const input = action as Partial<ForwardAction> & { to?: string[] | string };
    return {
      ...newForwardAction(),
      ...input,
      type: 'forward',
      to: normalizeForwardRows(input.to)
    };
  }
  if (action.type === 'telegram') {
    const input = action as Partial<TelegramAction> & { chatIds?: string[] | string };
    return {
      ...newTelegramAction(),
      ...input,
      type: 'telegram',
      chatIds: Array.isArray(input.chatIds) ? input.chatIds.join(' ') : String(input.chatIds || '')
    };
  }
  const http = { ...newHttpAction(), ...action, type: 'httpRequest' } as DraftHttpAction;
  http.headers = Array.isArray(http.headers) ? http.headers : [];
  http.query = Array.isArray(http.query) ? http.query : [];
  http.formRows = http.bodyType === 'form' ? parseFormRows(http.body) : Array.isArray(http.formRows) ? http.formRows : [];
  return http;
}

function normalizePolicy(policy: Partial<MailPolicy | DraftMailPolicy>): DraftMailPolicy {
  return {
    ...newPolicy(),
    ...policy,
    conditions: Array.isArray(policy.conditions) ? policy.conditions.map(normalizeCondition) : [],
    actions: Array.isArray(policy.actions) ? policy.actions.map(normalizeAction) : []
  };
}

function assignDraft(policy: MailPolicy | DraftMailPolicy) {
  Object.assign(draft, {
    ...newPolicy(),
    ...policy,
    conditions: policy.conditions.map(normalizeCondition),
    actions: policy.actions.map((item) => normalizeAction(item))
  });
  expandedActionId.value = draft.actions[0]?.id || '';
}

function cleanId(id: string) {
  return id.startsWith('draft_') ? '' : id;
}

function serializeKeyValues(rows: PolicyKeyValue[]) {
  return rows
    .map((item) => ({ id: cleanId(item.id), key: item.key.trim(), value: item.value.trim() }))
    .filter((item) => item.key);
}

function serializeHttpMethod(method: HttpMethod) {
  return method === 'GET' ? 'GET' : 'POST';
}

function serializePolicy(policy: DraftMailPolicy, includeId = false) {
  return {
    ...(includeId ? { id: policy.id } : {}),
    version: policy.version,
    name: policy.name.trim(),
    enabled: policy.enabled,
    priority: Math.min(Math.max(Math.floor(Number(policy.priority) || 0), 0), 9999),
    conditionMode: policy.conditionMode,
    stopOnMatch: policy.stopOnMatch,
    conditions: policy.conditions
      .map((item) => ({
        id: cleanId(item.id),
        field: item.field,
        operator: isBooleanCondition(item) ? 'equals' : item.operator,
        value: isBooleanCondition(item) ? booleanConditionValue(item.value) : item.value.trim()
      }))
      .filter((item) => item.value),
    actions: policy.actions.map((action) => {
      if (action.type === 'forward') {
        return {
          id: cleanId(action.id),
          type: 'forward',
          name: '转发邮件',
          to: normalizedForwardEmails(action)
        };
      }
      if (action.type === 'telegram') {
        return {
          id: cleanId(action.id),
          type: 'telegram',
          name: '发送至TG',
          botToken: action.botToken.trim(),
          chatIds: action.chatIds
            .split(/\s+/)
            .map((item) => item.trim())
            .filter(Boolean),
          message: action.message
        };
      }
      return {
        id: cleanId(action.id),
        type: 'httpRequest',
        name: '发送请求',
        method: serializeHttpMethod(action.method),
        url: action.url.trim(),
        headers: serializeKeyValues(action.headers),
        query: serializeKeyValues(action.query),
        bodyType: action.bodyType,
        body: action.bodyType === 'form' ? JSON.stringify(serializeKeyValues(action.formRows)) : action.body,
        timeoutMs: Math.min(Math.max(Math.floor(Number(action.timeoutMs) || 8000), 1000), 15000)
      };
    })
  };
}

function normalizeForwardRows(value: unknown) {
  const rows = Array.isArray(value) ? value : [value];
  const emails = rows.map((item) => String(item || '').trim());
  return emails.length > 0 ? emails : [''];
}

function normalizeForwardEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizedForwardEmails(action: DraftForwardAction) {
  return [...new Set(action.to.map(normalizeForwardEmail).filter(Boolean))];
}

function isForwardEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function addForwardTarget(action: DraftForwardAction) {
  action.to.push('');
}

function removeForwardTarget(action: DraftForwardAction, index: number) {
  action.to.splice(index, 1);
  if (action.to.length === 0) action.to.push('');
}

function draftForwardEmails(policy: DraftMailPolicy = draft, validOnly = true) {
  const emails = [...new Set(policy.actions.flatMap((action) => (action.type === 'forward' ? normalizedForwardEmails(action) : [])))];
  return validOnly ? emails.filter(isForwardEmail) : emails;
}

function forwardAddressStatus(email: string) {
  return forwardAddressStatuses.value[email];
}

function forwardAddressActionLabel(email: string) {
  return forwardAddressStatus(email)?.verified ? '通过' : '验证';
}

function forwardAddressActionClass(email: string) {
  return forwardAddressStatus(email)?.verified ? 'mc-action-success' : 'mc-action-primary';
}

function isVerifyingForwardAddress(email: string) {
  return Boolean(email) && verifyingForwardAddress.value === email;
}

function mergeForwardAddressStatuses(statuses: ForwardAddressStatus[]) {
  forwardAddressStatuses.value = {
    ...forwardAddressStatuses.value,
    ...Object.fromEntries(statuses.map((item) => [item.email, item]))
  };
}

async function loadForwardAddressStatus(email: string) {
  forwardAddressLoading.value = true;
  try {
    const [status] = await loadForwardAddressStatusesQuery([email], true);
    if (status) mergeForwardAddressStatuses([status]);
    return status || null;
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '转发目标状态读取失败'));
    return null;
  } finally {
    forwardAddressLoading.value = false;
  }
}

async function verifyForwardAddress(email: string) {
  const clean = normalizeForwardEmail(email);
  if (!clean) {
    ElMessage.error('请填写转发邮箱');
    return;
  }
  if (!isForwardEmail(clean)) {
    ElMessage.error(`转发邮箱格式不正确：${clean}`);
    return;
  }
  verifyingForwardAddress.value = clean;
  try {
    let status = await loadForwardAddressStatus(clean);
    if (!status) return;
    if (status.verified) {
      ElMessage.success('转发目标已通过验证');
      return;
    }

    if (!status.exists) {
      status = await createForwardAddress(clean);
      mergeForwardAddressStatuses([status]);
      if (status.verified) {
        ElMessage.success('转发目标已通过验证');
        return;
      }
      ElMessage.success('验证邮件已发送，请完成邮件里的 Cloudflare 验证后再点验证');
      return;
    }

    ElMessage.warning('转发邮箱待验证，请完成邮件里的 Cloudflare 验证后再点验证');
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '转发邮箱验证失败'));
  } finally {
    verifyingForwardAddress.value = '';
  }
}

async function ensureForwardActionsVerified() {
  const forwardActions = draft.actions.filter((action): action is DraftForwardAction => action.type === 'forward');
  if (forwardActions.length === 0) return true;

  const seen = new Set<string>();
  for (const action of forwardActions) {
    const emails = action.to.map(normalizeForwardEmail).filter(Boolean);
    if (emails.length === 0) {
      ElMessage.error('请填写转发邮箱');
      return false;
    }
    for (const email of emails) {
      if (!isForwardEmail(email)) {
        ElMessage.error(`转发邮箱格式不正确：${email}`);
        return false;
      }
      if (seen.has(email)) {
        ElMessage.error(`转发邮箱重复：${email}`);
        return false;
      }
      seen.add(email);
    }
  }

  const unverified = [...seen].find((email) => !forwardAddressStatus(email)?.verified);
  if (unverified) {
    ElMessage.error(`转发邮箱未通过验证：${unverified}`);
    return false;
  }
  return true;
}

function policyName(policy: MailPolicy | DraftMailPolicy, index: number) {
  if (!policy.name && editorMode.value === 'create' && policy.id === draft.id) return '新建策略';
  return policy.name || `策略 ${index + 1}`;
}

function policyMeta(policy: MailPolicy | DraftMailPolicy) {
  return `${policy.conditions.length} 条规则 · ${policy.actions.length} 个动作`;
}

function isSavedPolicy(policy: PolicyListItem): policy is MailPolicy {
  return !(editorMode.value === 'create' && policy.id === draft.id);
}

function togglePolicyFromList(policy: PolicyListItem) {
  if (isSavedPolicy(policy)) void togglePolicy(policy);
}

function isBooleanCondition(condition: Pick<PolicyCondition, 'field'>) {
  return condition.field === 'hasAttachments' || condition.field === 'forwarded';
}

function booleanConditionValue(value: string) {
  return value === 'false' ? 'false' : 'true';
}

function normalizeCondition(condition: PolicyCondition): PolicyCondition {
  if (!isBooleanCondition(condition)) return { ...condition };
  return {
    ...condition,
    operator: 'equals',
    value: booleanConditionValue(condition.value)
  };
}

function syncCondition(condition: PolicyCondition) {
  if (!isBooleanCondition(condition)) return;
  condition.operator = 'equals';
  condition.value = booleanConditionValue(condition.value);
}

function conditionLabel(condition: PolicyCondition) {
  const field = fieldOptions.find((item) => item.value === condition.field)?.label || condition.field;
  if (isBooleanCondition(condition)) {
    const value = booleanValueOptions.find((item) => item.value === booleanConditionValue(condition.value))?.label || condition.value;
    return `${field}${value}`;
  }
  const operator = operatorOptions.find((item) => item.value === condition.operator)?.label || condition.operator;
  return `${field}${operator}${condition.value || '未填写'}`;
}

function openCreatePolicy() {
  actionMenuOpen.value = false;
  editorMode.value = 'create';
  assignDraft(newPolicy());
  selectedPolicyId.value = draft.id;
}

function openEditPolicy(policy: MailPolicy) {
  actionMenuOpen.value = false;
  selectedPolicyId.value = policy.id;
  editorMode.value = 'edit';
  assignDraft(policy);
}

function openPolicyFromList(policy: PolicyListItem) {
  if (editorMode.value === 'create' && policy.id === draft.id) {
    selectedPolicyId.value = draft.id;
    return;
  }
  openEditPolicy(policy as MailPolicy);
}

function addCondition() {
  draft.conditions.push(newCondition());
}

function removeCondition(id: string) {
  draft.conditions = draft.conditions.filter((item) => item.id !== id);
}

function addAction(type: ActionType) {
  actionMenuOpen.value = false;
  const action = type === 'forward' ? newForwardAction() : type === 'telegram' ? newTelegramAction() : newHttpAction();
  draft.actions.push(action);
  expandedActionId.value = action.id;
}

function removeAction(id: string) {
  draft.actions = draft.actions.filter((item) => item.id !== id);
  if (expandedActionId.value === id) expandedActionId.value = draft.actions[0]?.id || '';
}

function toggleAction(action: DraftPolicyAction) {
  expandedActionId.value = expandedActionId.value === action.id ? '' : action.id;
}

function addHeader(action: DraftHttpAction) {
  action.headers.push(newKeyValue());
}

function addQuery(action: DraftHttpAction) {
  action.query.push(newKeyValue());
}

function addFormRow(action: DraftHttpAction) {
  action.formRows.push(newKeyValue());
}

function removeKeyValue(rows: PolicyKeyValue[], id: string) {
  const index = rows.findIndex((item) => item.id === id);
  if (index >= 0) rows.splice(index, 1);
}

function formatError(message: string) {
  ElMessage.error(message);
}

function setCodeEditor(id: string, editor: TemplateCodeEditorExpose | null) {
  if (editor) {
    codeEditors.value[id] = editor;
  } else {
    delete codeEditors.value[id];
  }
}

function formatActionBody(action: DraftHttpAction) {
  codeEditors.value[action.id]?.formatJson();
}

function actionTitle(action: DraftPolicyAction) {
  if (action.type === 'forward') return '转发邮件';
  if (action.type === 'telegram') return '发送至TG';
  return '发送请求';
}

function selectPolicyAfterLoad(options: LoadPolicyOptions) {
  const target = rows.value.find((item) => item.id === options.selectId) || rows.value.find((item) => item.id === options.fallbackSelectId);
  if (target) {
    openEditPolicy(target);
    return;
  }
  if (editorMode.value === 'idle' && rows.value.length > 0) {
    openEditPolicy(rows.value[0]);
    return;
  }
  if (editorMode.value === 'edit' && !rows.value.some((item) => item.id === selectedPolicyId.value)) {
    const first = rows.value[0];
    if (first) {
      openEditPolicy(first);
    } else {
      selectedPolicyId.value = '';
      editorMode.value = 'idle';
    }
  }
}

function applyPolicyPage(data: PolicyPage) {
  rows.value = data.items || [];
  total.value = data.total || 0;
  query.page = data.page || query.page;
  query.pageSize = data.pageSize || query.pageSize;
  policiesLoaded.value = true;
}

async function loadPolicies(options: LoadPolicyOptions = {}, force = false) {
  const data = await loadPoliciesPage(listParams.value, force);
  applyPolicyPage(data);
  selectPolicyAfterLoad(options);
}

async function savePolicy() {
  if (draft.actions.length === 0) {
    ElMessage.error('请至少添加一个执行动作');
    return;
  }
  if (!(await ensureForwardActionsVerified())) return;

  saving.value = true;
  try {
    const creating = editorMode.value === 'create';
    const { policy, page } = await savePolicyAndUpdatePage(listParams, serializePolicy(draft), creating ? '' : selectedPolicyId.value);
    if (page) applyPolicyPage(page);
    const saved = normalizePolicy(policy);
    selectedPolicyId.value = saved.id;
    editorMode.value = 'edit';
    assignDraft(saved);
    ElMessage.success(creating ? '邮件策略已添加' : '邮件策略已保存');
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '邮件策略保存失败'));
  } finally {
    saving.value = false;
  }
}

async function deletePolicy(policy: MailPolicy) {
  try {
    const confirmed = await confirmDialog({
      title: '删除邮件策略',
      message: `确认删除「${policy.name || '未命名策略'}」？`,
      confirmText: '删除',
      intent: 'danger'
    });
    if (!confirmed) return;
    const deletedIndex = rows.value.findIndex((item) => item.id === policy.id);
    const nextRows = rows.value.filter((item) => item.id !== policy.id);
    const nextPolicy = nextRows[deletedIndex] || nextRows[deletedIndex - 1] || null;
    const page = await deletePolicyAndUpdatePage(listParams, policy);
    if (page) applyPolicyPage(page);
    ElMessage.success('邮件策略已删除');
    if (nextPolicy) {
      openEditPolicy(nextPolicy);
    } else {
      editorMode.value = 'idle';
      selectedPolicyId.value = '';
    }
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '邮件策略删除失败'));
  }
}

function deleteCurrentPolicy() {
  const policy = rows.value.find((item) => item.id === selectedPolicyId.value);
  if (policy) void deletePolicy(policy);
}

async function togglePolicy(policy: MailPolicy) {
  if (editorMode.value === 'create' && policy.id === draft.id) return;
  const previous = policy.enabled;
  try {
    const { policy: savedPolicy, page } = await savePolicyAndUpdatePage(listParams, serializePolicy(normalizePolicy(policy), true), policy.id);
    if (page) applyPolicyPage(page);
    const saved = normalizePolicy(savedPolicy);
    if (selectedPolicyId.value === saved.id) assignDraft(saved);
  } catch (error) {
    policy.enabled = previous;
    ElMessage.error(apiErrorMessage(error, '邮件策略状态保存失败'));
  }
}

function updateActionMenuPosition() {
  if (!actionMenuOpen.value || !actionMenuButton.value) return;
  const rect = actionMenuButton.value.getBoundingClientRect();
  const menuWidth = actionMenu.value?.offsetWidth || 152;
  const menuHeight = actionMenu.value?.offsetHeight || 0;
  const viewportGap = 10;
  const belowTop = rect.bottom + 7;
  const aboveTop = rect.top - menuHeight - 7;
  const top = menuHeight && belowTop + menuHeight > window.innerHeight - viewportGap && aboveTop > viewportGap ? aboveTop : belowTop;
  actionMenuStyle.value = {
    position: 'fixed',
    top: `${Math.max(viewportGap, top)}px`,
    left: `${Math.max(viewportGap, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportGap))}px`
  };
}

function closeActionMenu() {
  actionMenuOpen.value = false;
  actionMenuStyle.value = {};
}

function toggleActionMenu() {
  if (actionMenuOpen.value) {
    closeActionMenu();
    return;
  }
  actionMenuOpen.value = true;
  nextTick(updateActionMenuPosition);
}

function closeMenuOnOutside(event: PointerEvent) {
  const target = event.target as Node | null;
  if (actionMenuOpen.value && !actionMenuButton.value?.contains(target) && !actionMenu.value?.contains(target)) {
    closeActionMenu();
  }
}

function handleViewportChange() {
  updateActionMenuPosition();
}

function applySearch() {
  query.page = 1;
  void loadPolicies();
}

function prevPage() {
  if (!canPrev.value) return;
  query.page -= 1;
  void loadPolicies();
}

function nextPage() {
  if (!canNext.value) return;
  query.page += 1;
  void loadPolicies();
}

function attachPageListeners() {
  document.addEventListener('pointerdown', closeMenuOnOutside);
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('scroll', handleViewportChange, true);
}

function detachPageListeners() {
  document.removeEventListener('pointerdown', closeMenuOnOutside);
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', handleViewportChange, true);
}

onMounted(() => {
  void loadPolicies();
});
onActivated(attachPageListeners);
onDeactivated(detachPageListeners);
onBeforeUnmount(detachPageListeners);
usePageRefresh(() => loadPolicies({}, true));
</script>

<template>
  <div class="page mc-management-page mc-policy-page">
    <section class="mc-panel mc-management-panel mc-policy-panel">
      <div class="mc-panel-head mc-panel-head--tools">
        <div class="mc-heading-line">
          <h3>邮件策略</h3>
        </div>
        <div class="mc-page-actions mc-panel-head-tools">
          <label class="mc-search mc-search--table mc-panel-head-search">
            <McIcon name="search" :size="18" />
            <input v-model.trim="query.keyword" type="search" placeholder="搜索策略、条件、动作" @change="applySearch" />
          </label>
          <div class="mc-panel-page-controls">
            <button class="mc-square" :class="{ disabled: !canPrev }" type="button" :disabled="!canPrev" aria-label="上一页" @click="prevPage">
              <McIcon name="left" :size="19" />
            </button>
            <button class="mc-square" :class="{ disabled: !canNext }" type="button" :disabled="!canNext" aria-label="下一页" @click="nextPage">
              <McIcon name="right" :size="19" />
            </button>
          </div>
          <button type="button" class="mc-action-primary" @click="openCreatePolicy">添加策略</button>
        </div>
      </div>

      <div class="mc-policy-workspace">
        <aside class="mc-policy-list-pane">
          <div v-if="policiesLoaded && visiblePolicies.length === 0" class="mc-empty-state mc-empty-state--fill">
            <div class="mc-empty-icon"><McIcon name="policy" :size="26" /></div>
            <h2>还没有添加邮件策略</h2>
          </div>

          <article
            v-for="(policy, index) in visiblePolicies"
            v-else
            :key="policy.id"
            class="mc-policy-card"
            :class="{ selected: selectedPolicyId === policy.id, disabled: !policy.enabled }"
            @click="openPolicyFromList(policy)"
          >
            <div class="mc-policy-card-content">
              <el-switch v-model="policy.enabled" :disabled="!isSavedPolicy(policy)" @click.stop @change="togglePolicyFromList(policy)" />
              <div class="mc-policy-card-text">
                <div class="mc-policy-title-line">
                  <strong>{{ policyName(policy, index) }}</strong>
                </div>
                <span class="mc-policy-card-meta">{{ policyMeta(policy) }}</span>
              </div>
            </div>
          </article>
        </aside>

        <main class="mc-policy-editor">
          <div v-if="!editorActive" class="mc-empty-state mc-empty-state--fill">
            <div class="mc-empty-icon"><McIcon name="policy" :size="26" /></div>
            <h2>选择或添加一个邮件策略</h2>
          </div>

          <template v-else>
            <div class="mc-policy-editor-head">
              <div class="mc-policy-editor-title">
                <span>{{ editorMode === 'create' ? '新建策略' : '编辑策略' }}</span>
                <h3>{{ draft.name || editorTitle }}</h3>
              </div>
              <div class="mc-policy-editor-actions">
                <button v-if="editorMode === 'edit'" type="button" class="mc-action-danger mc-action-compact" :disabled="saving" @click="deleteCurrentPolicy">删除</button>
                <button type="button" class="mc-action-primary mc-action-compact" :disabled="saving" @click="savePolicy">
                  <span v-if="saving" class="mc-button-spinner"></span>
                  保存
                </button>
              </div>
            </div>

            <div class="mc-policy-editor-body">
              <section class="mc-policy-planner-section mc-policy-basic">
                <div class="mc-policy-basic-grid">
                  <label class="mc-policy-field name">
                    <span>策略名称</span>
                    <el-input v-model.trim="draft.name" placeholder="例如：账单邮件处理" />
                  </label>
                  <label class="mc-policy-field compact">
                    <span>条件关系</span>
                    <McCfSelect v-model="draft.conditionMode" :options="conditionModeOptions" select-only />
                  </label>
                  <label class="mc-policy-field priority">
                    <span>顺序权重</span>
                    <el-input-number v-model="draft.priority" :min="0" :max="9999" :step="1" controls-position="right" />
                  </label>
                  <label class="mc-policy-field stop-on-match">
                    <span>命中后停止</span>
                    <el-switch v-model="draft.stopOnMatch" />
                  </label>
                </div>
              </section>

              <section class="mc-policy-planner-section">
                <div class="mc-policy-planner-head">
                  <strong>匹配规则</strong>
                  <button type="button" class="mc-policy-head-add" aria-label="添加条件" title="添加条件" @click="addCondition">+</button>
                </div>
                <div class="mc-policy-rule-list">
                  <div v-if="draft.conditions.length === 0" class="mc-policy-inline-empty">未添加条件时匹配全部邮件</div>
                  <div v-for="condition in draft.conditions" :key="condition.id" class="mc-policy-rule-row">
                    <McCfSelect v-model="condition.field" :options="fieldOptions" select-only @change="syncCondition(condition)" />
                    <McCfSelect v-if="isBooleanCondition(condition)" v-model="condition.value" class="mc-policy-rule-boolean-value" :options="booleanValueOptions" select-only @change="syncCondition(condition)" />
                    <template v-else>
                      <McCfSelect v-model="condition.operator" :options="operatorOptions" select-only />
                      <el-input v-model.trim="condition.value" placeholder="匹配值" />
                    </template>
                    <button type="button" class="mc-icon-action mc-icon-action--danger" aria-label="删除条件" @click="removeCondition(condition.id)"><McIcon name="trash" :size="15" /></button>
                  </div>
                </div>
              </section>

              <section class="mc-policy-planner-section">
                <div class="mc-policy-planner-head">
                  <strong>执行动作</strong>
                  <div class="mc-policy-add-action">
                    <button ref="actionMenuButton" type="button" class="mc-policy-head-add" aria-label="添加动作" title="添加动作" @click="toggleActionMenu">+</button>
                    <Teleport to="body">
                      <div v-if="actionMenuOpen" ref="actionMenu" class="mc-menu-surface mc-floating-menu mc-floating-menu--select" :style="actionMenuStyle" @click.stop @pointerdown.stop>
                        <button type="button" class="mc-menu-item" @click="addAction('forward')">转发邮件</button>
                        <button type="button" class="mc-menu-item" @click="addAction('httpRequest')">发送请求</button>
                        <button type="button" class="mc-menu-item" @click="addAction('telegram')">发送至TG</button>
                      </div>
                    </Teleport>
                  </div>
                </div>

                <div class="mc-policy-action-list">
                  <div v-if="draft.actions.length === 0" class="mc-policy-inline-empty">还没有执行动作</div>

                  <div v-for="action in draft.actions" :key="action.id" class="mc-policy-action-row">
                    <article class="mc-policy-action-card" :class="{ open: expandedActionId === action.id }">
                      <div class="mc-policy-action-head">
                        <button type="button" class="mc-policy-action-main" @click="toggleAction(action)">
                          <strong>{{ actionTitle(action) }}</strong>
                        </button>
                        <button type="button" class="mc-icon-action mc-policy-action-toggle" aria-label="展开动作" @click="toggleAction(action)"><McIcon name="down" :size="17" /></button>
                      </div>

                      <div v-if="expandedActionId === action.id" class="mc-policy-action-body">
                        <div v-if="action.type === 'forward'" class="mc-policy-forward-editor">
                          <div class="mc-policy-mini-head">
                            <span>转发到</span>
                            <button type="button" class="mc-policy-head-add" aria-label="添加转发邮箱" title="添加转发邮箱" @click="addForwardTarget(action)">+</button>
                          </div>
                          <div class="mc-policy-forward-target-list">
                            <div v-for="(_, index) in action.to" :key="index" class="mc-policy-forward-target-row">
                              <el-input v-model.trim="action.to[index]" type="email" placeholder="name@example.com" />
                              <button
                                type="button"
                                class="mc-action-compact"
                                :class="forwardAddressActionClass(normalizeForwardEmail(action.to[index]))"
                                :disabled="isVerifyingForwardAddress(normalizeForwardEmail(action.to[index])) || forwardAddressLoading"
                                @click="verifyForwardAddress(action.to[index])"
                              >
                                <span v-if="isVerifyingForwardAddress(normalizeForwardEmail(action.to[index]))" class="mc-button-spinner"></span>
                                {{ forwardAddressActionLabel(normalizeForwardEmail(action.to[index])) }}
                              </button>
                              <button type="button" class="mc-icon-action mc-icon-action--danger" aria-label="删除转发邮箱" :disabled="action.to.length === 1" @click="removeForwardTarget(action, index)"><McIcon name="trash" :size="15" /></button>
                            </div>
                          </div>
                        </div>

                        <div v-else-if="action.type === 'telegram'" class="mc-policy-telegram-editor">
                          <label class="mc-policy-field">
                            <span>Bot Token</span>
                            <el-input v-model.trim="action.botToken" type="password" show-password :placeholder="action.botTokenConfigured ? action.botTokenMasked || '已配置，留空不修改' : '123456:ABC-DEF'" />
                          </label>
                          <label class="mc-policy-field">
                            <span>Chat ID</span>
                            <el-input v-model.trim="action.chatIds" type="textarea" resize="none" placeholder="每行一个 Chat ID" />
                          </label>
                          <div class="mc-policy-code-block">
                            <div class="mc-policy-mini-head">
                              <span>消息模板</span>
                            </div>
                            <McTemplateCodeEditor :ref="(editor) => setCodeEditor(action.id, editor as TemplateCodeEditorExpose | null)" v-model="action.message" :variables="templateVars" language="text" placeholder="输入 {{ 可插入变量" />
                          </div>
                        </div>

                        <div v-else class="mc-policy-http-editor">
                          <section class="mc-policy-http-section primary">
                            <div class="mc-policy-request-line">
                              <McCfSelect v-model="action.method" :options="methodOptions" select-only />
                              <McTemplateField v-model="action.url" :variables="templateVars" placeholder="https://example.com/api/mail" />
                              <McCfSelect v-model="action.bodyType" :options="bodyTypeOptions" select-only />
                            </div>
                          </section>

                          <section class="mc-policy-http-section">
                            <div class="mc-policy-mini-head">
                              <span>Query 参数</span>
                              <button type="button" aria-label="添加 Query 参数" title="添加 Query 参数" @click="addQuery(action)">+</button>
                            </div>
                            <div v-if="action.query.length === 0" class="mc-policy-inline-empty">无查询参数</div>
                            <div v-for="row in action.query" :key="row.id" class="mc-policy-kv-row">
                              <el-input v-model.trim="row.key" placeholder="参数名" />
                              <McTemplateField v-model="row.value" :variables="templateVars" placeholder="参数值，支持变量" />
                              <button type="button" class="mc-icon-action mc-icon-action--danger" aria-label="删除 Query" @click="removeKeyValue(action.query, row.id)"><McIcon name="trash" :size="15" /></button>
                            </div>
                          </section>

                          <section class="mc-policy-http-section">
                            <div class="mc-policy-mini-head">
                              <span>Headers</span>
                              <button type="button" aria-label="添加 Header" title="添加 Header" @click="addHeader(action)">+</button>
                            </div>
                            <div v-if="action.headers.length === 0" class="mc-policy-inline-empty">无请求头</div>
                            <div v-for="row in action.headers" :key="row.id" class="mc-policy-kv-row">
                              <el-input v-model.trim="row.key" placeholder="Header 名" />
                              <McTemplateField v-model="row.value" :variables="templateVars" placeholder="Header 值，支持变量" />
                              <button type="button" class="mc-icon-action mc-icon-action--danger" aria-label="删除 Header" @click="removeKeyValue(action.headers, row.id)"><McIcon name="trash" :size="15" /></button>
                            </div>
                          </section>

                          <section class="mc-policy-http-section">
                            <div class="mc-policy-body-editor">
                              <div v-if="action.bodyType === 'none'" class="mc-policy-inline-empty">不发送请求正文</div>
                              <div v-else-if="action.bodyType === 'form'" class="mc-policy-kv-block inner">
                                <div class="mc-policy-mini-head">
                                  <span>表单字段</span>
                                  <button type="button" aria-label="添加表单字段" title="添加表单字段" @click="addFormRow(action)">+</button>
                                </div>
                                <div v-if="action.formRows.length === 0" class="mc-policy-inline-empty">无表单字段</div>
                                <div v-for="row in action.formRows" :key="row.id" class="mc-policy-kv-row">
                                  <el-input v-model.trim="row.key" placeholder="字段名" />
                                  <McTemplateField v-model="row.value" :variables="templateVars" placeholder="字段值，支持变量" />
                                  <button type="button" class="mc-icon-action mc-icon-action--danger" aria-label="删除表单字段" @click="removeKeyValue(action.formRows, row.id)"><McIcon name="trash" :size="15" /></button>
                                </div>
                              </div>
                              <div v-else class="mc-policy-code-block">
                                <div class="mc-policy-mini-head">
                                  <span>{{ action.bodyType === 'json' ? 'JSON Body' : '文本 Body' }}</span>
                                  <button v-if="action.bodyType === 'json'" type="button" class="format" @click="formatActionBody(action)">格式化</button>
                                </div>
                                <McTemplateCodeEditor :ref="(editor) => setCodeEditor(action.id, editor as TemplateCodeEditorExpose | null)" v-model="action.body" :variables="templateVars" :language="action.bodyType === 'json' ? 'json' : 'text'" placeholder="请求正文，输入 {{ 查看变量" @format-error="formatError" />
                              </div>
                            </div>
                          </section>
                        </div>
                      </div>
                    </article>
                    <button type="button" class="mc-icon-action mc-icon-action--danger mc-policy-action-delete" aria-label="删除动作" @click="removeAction(action.id)"><McIcon name="trash" :size="15" /></button>
                  </div>
                </div>
              </section>

            </div>
          </template>
        </main>
      </div>
    </section>
  </div>
</template>
