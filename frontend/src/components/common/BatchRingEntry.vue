<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useRingStore } from '../../stores/ringStore';
import { useSiteStore } from '../../stores/siteStore';
import { useSessionStore } from '../../stores/sessionStore';
import { STATUS_COLOR, type BirdAge, type RingStatus } from '../../types/ring-record';
import { formatDate } from '../../utils/format';
import {
  BATCH_TEMPLATE_HEADER,
  parseBatchTsv,
  ringDateToIso,
  rowHasError,
  rowHasWarning,
  type BatchRingRow,
} from '../../utils/batch-entry';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'committed', count: number): void;
}>();

const ringStore = useRingStore();
const siteStore = useSiteStore();
const sessionStore = useSessionStore();

const rawText = ref('');
const rows = ref<BatchRingRow[]>([]);
const tableIssue = ref('');
const submitting = ref(false);
const detailVisible = ref(false);
const detailRow = ref<BatchRingRow | null>(null);

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      rawText.value = '';
      rows.value = [];
      tableIssue.value = '';
      detailVisible.value = false;
      detailRow.value = null;
    }
  },
);

/** 粘贴即解析（也可点「解析预览」手动触发，兼容逐格补录场景） */
function parse() {
  const result = parseBatchTsv(rawText.value, {
    rings: ringStore.rings,
    sites: siteStore.sites,
    sessions: sessionStore.sessions,
  });
  rows.value = result.rows;
  tableIssue.value = result.tableIssues[0]?.message ?? '';
}

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!text.includes('\t')) return;
  // 让 textarea 先完成写入，下一拍再解析
  setTimeout(parse, 0);
}

// 粘贴后在文本框中手工改单元格时，防抖重解析，避免预览与原文不一致
let parseTimer: ReturnType<typeof setTimeout> | undefined;
watch(rawText, () => {
  if (!rows.value.length) return;
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => {
    parse();
    if (!detailVisible.value) detailRow.value = null;
  }, 350);
});

const errorCount = computed(() => rows.value.filter(rowHasError).length);
const warningCount = computed(() => rows.value.filter((row) => !rowHasError(row) && rowHasWarning(row)).length);
const validRows = computed(() => rows.value.filter((row) => !rowHasError(row)));
const canSubmit = computed(() => rows.value.length > 0 && errorCount.value === 0 && !tableIssue.value);

const summary = computed(() => {
  const map = { 初捕: 0, 重捕: 0, 回收: 0 } as Record<RingStatus, number>;
  validRows.value.forEach((row) => {
    if (row.status) map[row.status] += 1;
  });
  return map;
});

function fillTemplate() {
  const today = new Date().toISOString().slice(0, 10);
  const site = siteStore.sites[0];
  const session = sessionStore.sessions.find((item) => item.siteId === site?.id) ?? sessionStore.sessions[0];
  rawText.value =
    `${BATCH_TEMPLATE_HEADER}\n` +
    `A-10301\t无\t红喉歌鸲\tCalliope calliope\t成\t初捕\t1 号网\t1\t韩雪\t${site?.siteNo ?? 'S-01'}\t${
      session?.sessionNo ?? '2024-A01'
    }\t${session?.date ?? today}\t野外批量补录示例行`;
  parse();
}

async function copyTemplate() {
  try {
    await navigator.clipboard.writeText(BATCH_TEMPLATE_HEADER);
    ElMessage.success('已复制表头，可在 Excel / WPS 中选中首行粘贴');
  } catch {
    ElMessage.warning('浏览器禁止了剪贴板访问，请手动选择下方表头复制');
  }
}

function showDetail(row: BatchRingRow) {
  detailRow.value = row;
  detailVisible.value = true;
}

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  try {
    const payloads = validRows.value.map((row) => ({
      ringNo: row.ringNo,
      colorRing: row.colorRing,
      speciesCn: row.speciesCn,
      speciesSci: row.speciesSci,
      age: row.age as BirdAge,
      ringDate: ringDateToIso(row.ringDate as string),
      netNo: row.netNo,
      netRound: row.netRound ?? 1,
      status: row.status as RingStatus,
      ringer: row.ringer,
      siteId: row.site!.id,
      sessionId: row.session!.id,
      remark: row.remark || undefined,
    }));
    await ringStore.addRingsBatch(payloads);
    ElMessage.success(`已一次性写入 ${payloads.length} 条环志记录（初捕 ${summary.value.初捕} · 重捕 ${summary.value.重捕} · 回收 ${summary.value.回收}）`);
    visible.value = false;
    emit('committed', payloads.length);
  } catch (error) {
    const name = (error as { name?: string })?.name;
    ElMessage.error(
      name === 'BatchConflictError'
        ? `${(error as Error).message}。本批未写入任何记录，请刷新预览后修改冲突行。`
        : `写入失败，整批已回滚，未留下半批数据：${(error as Error).message}`,
    );
    // 事务失败后重新解析，让预览反映库内最新状态
    parse();
  } finally {
    submitting.value = false;
  }
}

function rowType(row: BatchRingRow): 'error' | 'warning' | 'success' | 'info' {
  if (rowHasError(row)) return 'error';
  if (rowHasWarning(row)) return 'warning';
  return row.status === '重捕' || row.status === '回收' ? 'success' : 'info';
}

function rowTypeText(row: BatchRingRow): string {
  if (rowHasError(row)) return '阻断';
  if (rowHasWarning(row)) return '提示';
  if (row.status === '初捕') return '初捕新增';
  return `${row.status}接续`;
}
</script>

<template>
  <el-dialog v-model="visible" title="批量录入环志记录" width="1080px" top="6vh" :close-on-click-modal="false">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="从 Excel / WPS / 记事本复制制表符表格（Ctrl+C），在下方粘贴框中 Ctrl+V，即按行生成预览。"
      description="有「金属环号」等中文表头时按表头识别列；无表头时按模板列序解析。初捕撞号会标出原记录并阻断整批写入；重捕 / 回收须能接续到库中或本批更早的初捕。"
      class="batch-alert"
    />

    <div class="batch-toolbar">
      <el-button size="small" @click="copyTemplate">复制表头</el-button>
      <el-button size="small" @click="fillTemplate">填入示例</el-button>
      <el-button size="small" type="primary" plain @click="parse">解析预览</el-button>
      <span class="batch-hint">
        列序：金属环号｜彩环组合｜鸟种中文名｜学名｜年龄｜状态｜网号｜网次｜环志人｜鸟点编号｜批次号｜环志日期｜备注
      </span>
    </div>

    <el-input
      v-model="rawText"
      type="textarea"
      :rows="6"
      resize="vertical"
      spellcheck="false"
      placeholder="在此粘贴制表符表格（首行可为表头）"
      class="batch-textarea"
      @paste="onPaste"
    />

    <el-alert v-if="tableIssue" type="error" :title="tableIssue" :closable="false" show-icon class="batch-alert" />

    <div v-if="rows.length" class="batch-summary">
      <el-tag type="info" effect="plain">共 {{ rows.length }} 行</el-tag>
      <el-tag type="success" effect="plain">可写入 {{ validRows.length }} 行</el-tag>
      <el-tag type="danger" effect="plain">阻断 {{ errorCount }} 行</el-tag>
      <el-tag type="warning" effect="plain">提示 {{ warningCount }} 行</el-tag>
      <el-tag v-if="!errorCount" type="success" effect="plain">
        待写入：初捕 {{ summary.初捕 }} · 重捕 {{ summary.重捕 }} · 回收 {{ summary.回收 }}
      </el-tag>
    </div>

    <el-table v-if="rows.length" :data="rows" size="small" border max-height="340" class="batch-table">
      <el-table-column label="行" width="48" align="center">
        <template #default="scope">{{ scope.row.lineNo }}</template>
      </el-table-column>
      <el-table-column label="校验" width="72" align="center">
        <template #default="scope">
          <el-tag :type="rowType(scope.row)" size="small" effect="dark">{{ rowTypeText(scope.row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="ringNo" label="金属环号" width="96" />
      <el-table-column prop="speciesCn" label="鸟种" width="100" />
      <el-table-column prop="age" label="年龄" width="56" />
      <el-table-column label="状态" width="64">
        <template #default="scope">
          <el-tag v-if="scope.row.status" :type="STATUS_COLOR[scope.row.status as RingStatus]" size="small">
            {{ scope.row.status }}
          </el-tag>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="鸟点 / 批次" min-width="170">
        <template #default="scope">
          <div v-if="scope.row.site" class="cell-ok">{{ scope.row.site.siteNo }} · {{ scope.row.site.name }}</div>
          <div v-else class="cell-err">{{ scope.row.siteNo || '（空）' }}</div>
          <div v-if="scope.row.session" class="cell-ok">{{ scope.row.session.sessionNo }} · {{ scope.row.session.date }}</div>
          <div v-else class="cell-err">批次：{{ scope.row.sessionNo || '（空）' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="环志日期" width="100">
        <template #default="scope">{{ scope.row.ringDate ?? (scope.row.dateText || '—') }}</template>
      </el-table-column>
      <el-table-column prop="netNo" label="网号/网次" width="96">
        <template #default="scope">
          {{ scope.row.netNo || '—' }}<template v-if="scope.row.netRound !== null"> / {{ scope.row.netRound }}</template>
        </template>
      </el-table-column>
      <el-table-column prop="ringer" label="环志人" width="80" />
      <el-table-column label="接续 / 撞号" min-width="220">
        <template #default="scope">
          <template v-if="scope.row.status === '初捕'">
            <div v-if="scope.row.conflictOriginal" class="cell-err">
              原{{ scope.row.conflictOriginal.status }}：{{ scope.row.conflictOriginal.ringDate.slice(0, 10) }}
              · {{ scope.row.conflictOriginal.ringer }}
            </div>
            <div v-else-if="scope.row.history.length" class="cell-err">同环号已有 {{ scope.row.history.length }} 条记录</div>
            <div v-else class="cell-ok">新环号</div>
          </template>
          <template v-else-if="scope.row.attach">
            <div class="cell-ok">
              接续原{{ scope.row.attach.status }}：{{ scope.row.attach.date ?? '日期未知' }} · {{ scope.row.attach.speciesCn }}
            </div>
            <div v-if="scope.row.attach.fromLine" class="cell-ok">原记录为本批第 {{ scope.row.attach.fromLine }} 行</div>
          </template>
          <span v-else-if="scope.row.status" class="cell-err">无可接续初捕</span>
        </template>
      </el-table-column>
      <el-table-column label="问题说明" min-width="260">
        <template #default="scope">
          <el-button link type="primary" size="small" @click="showDetail(scope.row)">
            {{ scope.row.issues.length }} 条
          </el-button>
          <span class="issue-preview">{{ scope.row.issues[0]?.message ?? '校验通过' }}</span>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-tooltip
        :disabled="canSubmit"
        content="存在阻断行或尚未解析，请先修正全部标红行后再写入"
        placement="top"
      >
        <span>
          <el-button
            type="primary"
            :loading="submitting"
            :disabled="!canSubmit"
            @click="submit"
          >
            确认无误，一次性写入{{ rows.length ? `（${validRows.length} 条）` : '' }}
          </el-button>
        </span>
      </el-tooltip>
    </template>

    <el-dialog
      v-model="detailVisible"
      :title="`第 ${detailRow?.lineNo ?? ''} 行 · ${detailRow?.ringNo || '环号缺失'} 校验明细`"
      width="640px"
      append-to-body
    >
      <el-table v-if="detailRow" :data="detailRow.issues" size="small" border>
        <el-table-column label="级别" width="72">
          <template #default="scope">
            <el-tag :type="scope.row.level === 'error' ? 'danger' : 'warning'" size="small">
              {{ scope.row.level === 'error' ? '阻断' : '提示' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="原因 / 说明" />
      </el-table>
      <el-empty
        v-if="detailRow && detailRow.issues.length === 0"
        description="本行校验通过"
        :image-size="60"
      />

      <el-divider v-if="detailRow && detailRow.history.length" content-position="left">
        环号 {{ detailRow.ringNo }} 的历史记录（{{ detailRow.history.length }}）
      </el-divider>
      <el-table v-if="detailRow && detailRow.history.length" :data="detailRow.history" size="small" border>
        <el-table-column label="日期" width="100">
          <template #default="scope">{{ formatDate(scope.row.ringDate) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="70" />
        <el-table-column prop="speciesCn" label="鸟种" width="100" />
        <el-table-column prop="ringer" label="环志人" width="80" />
        <el-table-column prop="netNo" label="网号" />
      </el-table>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.batch-alert {
  margin-bottom: 10px;
}
.batch-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.batch-hint {
  font-size: 12px;
  color: #8a99a5;
}
.batch-textarea {
  font-family: 'SFMono-Regular', Consolas, 'PingFang SC', monospace;
  margin-bottom: 10px;
}
.batch-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.batch-table {
  border-radius: 6px;
}
.cell-ok {
  font-size: 12px;
  color: #2f7d6f;
  line-height: 1.5;
}
.cell-err {
  font-size: 12px;
  color: #c45656;
  line-height: 1.5;
}
.issue-preview {
  font-size: 12px;
  color: #6f8480;
  margin-left: 6px;
}
</style>
