<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { InfoFilled, WarningFilled } from '@element-plus/icons-vue';
import { useRingStore } from '../../stores/ringStore';
import { useSiteStore } from '../../stores/siteStore';
import { useSessionStore } from '../../stores/sessionStore';
import { STATUS_COLOR, type BirdAge, type RingStatus } from '../../types/ring-record';
import { formatDate } from '../../utils/format';
import {
  BATCH_HEADERS,
  buildBatchRows,
  buildSampleTsv,
  summarize,
  type BatchRow,
} from '../../utils/batch-import';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'committed', count: number): void;
}>();

const ringStore = useRingStore();
const siteStore = useSiteStore();
const sessionStore = useSessionStore();

const pasteText = ref('');
const filterMode = ref<'all' | 'error' | 'warning'>('all');
const writing = ref(false);

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      filterMode.value = 'all';
      writing.value = false;
    }
  },
);

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

const rows = computed<BatchRow[]>(() =>
  buildBatchRows(pasteText.value, {
    rings: ringStore.rings,
    sites: siteStore.sites,
    sessions: sessionStore.sessions,
  }),
);

const summary = computed(() => summarize(rows.value));

const filteredRows = computed(() => {
  if (filterMode.value === 'error') return rows.value.filter((row) => row.errors.length > 0);
  if (filterMode.value === 'warning') return rows.value.filter((row) => row.warnings.length > 0 && row.errors.length === 0);
  return rows.value;
});

const canCommit = computed(() => rows.value.length > 0 && summary.value.errorCount === 0 && !writing.value);

function rowClass({ row }: { row: BatchRow }): string {
  if (row.errors.length > 0) return 'batch-row-error';
  if (row.warnings.length > 0) return 'batch-row-warning';
  return '';
}

function loadSample() {
  pasteText.value = buildSampleTsv(siteStore.sites, sessionStore.sessions, ringStore.rings);
}

async function commit() {
  if (!canCommit.value) return;
  const confirmed = await ElMessageBox.confirm(
    `确认把 ${summary.value.firstCount} 条初捕、${summary.value.followCount} 条重捕 / 回收一次性写入？写入在同一事务中完成，失败会整体回滚。`,
    '批量写入确认',
    { type: 'warning', confirmButtonText: '确认写入', cancelButtonText: '再检查一下' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;

  writing.value = true;
  try {
    await ringStore.bulkAddRings(
      rows.value.map((row) => ({
        ringNo: row.ringNo,
        colorRing: row.colorRing,
        speciesCn: row.speciesCn,
        speciesSci: row.speciesSci,
        age: row.age as BirdAge,
        ringDate: new Date(`${row.date}T08:00:00`).toISOString(),
        netNo: row.netNo,
        netRound: (row.netRound === '' ? 1 : row.netRound) as number,
        status: row.status as RingStatus,
        ringer: row.ringer,
        siteId: row.site!.id,
        sessionId: row.session!.id,
        remark: row.remark,
      })),
    );
    ElMessage.success(`已一次性写入 ${rows.value.length} 条环志记录（初捕 ${summary.value.firstCount} 条，重捕 / 回收 ${summary.value.followCount} 条）`);
    emit('committed', rows.value.length);
    pasteText.value = '';
    dialogVisible.value = false;
  } catch (error) {
    // 事务已整体回滚，本地不会留下半批数据；保留粘贴内容供修正后重试
    ElMessage.error(`批量写入失败，整批已回滚、未写入任何记录：${(error as Error).message}`);
  } finally {
    writing.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="dialogVisible" title="环志记录批量录入" width="1080px" top="6vh" :close-on-click-modal="false">
    <el-alert type="info" :closable="false" show-icon class="batch-tip">
      <template #title>
        从 Excel / WPS 复制野外记录后整段粘贴到下方（制表符分隔，首行需含表头，列序可不同）。系统逐行预览：初捕环号撞车会标出原记录并拦住整批；重捕 /
        回收自动接在同一环号历史后面；鸟点编号、批次号找不到，或批次与鸟点、日期不一致都会说明原因。确认无误后一次性写入。
      </template>
    </el-alert>

    <div class="paste-head">
      <span class="paste-label">粘贴区（表头：{{ BATCH_HEADERS.join(' / ') }}）</span>
      <div>
        <el-button link type="primary" @click="loadSample">填入示例</el-button>
        <el-button link type="info" :disabled="!pasteText" @click="pasteText = ''">清空</el-button>
      </div>
    </div>
    <el-input
      v-model="pasteText"
      type="textarea"
      :rows="6"
      spellcheck="false"
      placeholder="在此粘贴制表符表格，例如：&#10;金属环号	彩环	鸟种中文名	年龄	环志日期	网号	网次	状态	环志人	鸟点编号	批次号	备注&#10;A-20901	无	红喉歌鸲	成	2026-09-28	1 号网	1	初捕	韩雪	S-01	2024-A04	"
      class="paste-area"
    />

    <div v-if="rows.length > 0" class="preview-bar">
      <el-radio-group v-model="filterMode" size="small">
        <el-radio-button value="all">全部 {{ summary.total }}</el-radio-button>
        <el-radio-button value="error">错误 {{ summary.errorCount }}</el-radio-button>
        <el-radio-button value="warning">提示 {{ summary.warningCount }}</el-radio-button>
      </el-radio-group>
      <el-tag size="small" type="success" effect="plain">新初捕 {{ summary.firstCount }}</el-tag>
      <el-tag size="small" type="warning" effect="plain">接历史 {{ summary.followCount }}</el-tag>
      <el-tag v-if="summary.errorCount > 0" size="small" type="danger" effect="plain">有错误行，整批无法写入</el-tag>
    </div>

    <el-table
      v-if="rows.length > 0"
      :data="filteredRows"
      size="small"
      border
      max-height="380"
      :row-class-name="rowClass"
      class="preview-table"
    >
      <el-table-column prop="lineNo" label="源行" width="56" align="center" />
      <el-table-column label="金属环号" width="112">
        <template #default="{ row }">
          <span class="cell-ring">{{ row.ringNo || '—' }}</span>
          <div v-if="row.repeatInBatch > 0" class="cell-sub warn-text">本批第 {{ row.repeatInBatch + 1 }} 次出现</div>
        </template>
      </el-table-column>
      <el-table-column label="鸟种 / 年龄" width="120">
        <template #default="{ row }">
          {{ row.speciesCn || '—' }}
          <span class="cell-sub">{{ row.age || '?' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="date" label="环志日期" width="104">
        <template #default="{ row }">{{ row.date || '—' }}</template>
      </el-table-column>
      <el-table-column label="网号 / 网次" width="104">
        <template #default="{ row }">{{ row.netNo }} · {{ row.netRound === '' ? '1' : row.netRound }}</template>
      </el-table-column>
      <el-table-column label="状态" width="78">
        <template #default="{ row }">
          <el-tag v-if="row.status" :type="STATUS_COLOR[row.status as RingStatus]" size="small">{{ row.status }}</el-tag>
          <span v-else class="error-text">?</span>
        </template>
      </el-table-column>
      <el-table-column prop="ringer" label="环志人" width="78" />
      <el-table-column label="鸟点" width="120">
        <template #default="{ row }">
          {{ row.site ? `${row.site.siteNo} ${row.site.name}` : row.siteNo || '—' }}
          <div v-if="!row.site && row.siteNo" class="cell-sub error-text">台账无此编号</div>
        </template>
      </el-table-column>
      <el-table-column label="批次" width="118">
        <template #default="{ row }">
          {{ row.session ? row.session.sessionNo : row.sessionNo || '—' }}
          <div v-if="row.session" class="cell-sub">{{ row.session.date }}{{ row.session.closed ? ' · 已关闭' : '' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="校验结果" min-width="300">
        <template #default="{ row }">
          <div v-for="(message, index) in row.errors" :key="`e-${index}`" class="msg-line error-text">
            <el-icon><WarningFilled /></el-icon>{{ message }}
          </div>
          <div v-for="(message, index) in row.warnings" :key="`w-${index}`" class="msg-line warn-text">
            <el-icon><InfoFilled /></el-icon>{{ message }}
          </div>
          <el-popover v-if="row.history.length > 0" placement="left" :width="380" trigger="hover">
            <template #reference>
              <el-button link type="primary" size="small">同环号历史 {{ row.history.length }} 条</el-button>
            </template>
            <div class="history-pop">
              <div v-for="record in row.history" :key="record.id" class="history-line">
                <el-tag :type="STATUS_COLOR[record.status as RingStatus]" size="small">{{ record.status }}</el-tag>
                <span>{{ record.speciesCn }}</span>
                <span>{{ formatDate(record.ringDate) }}</span>
                <span>{{ siteStore.siteName(record.siteId) }}</span>
              </div>
            </div>
          </el-popover>
          <el-text v-if="row.errors.length === 0 && row.warnings.length === 0" type="success" size="small">校验通过</el-text>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-else description="粘贴制表符表格后，这里会逐行显示预览与校验结果" :image-size="64" />

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :disabled="!canCommit" :loading="writing" @click="commit">
        确认无误，一次性写入{{ summary.total > 0 ? `（${summary.total} 条）` : '' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.batch-tip {
  margin-bottom: 10px;
}
.paste-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.paste-label {
  font-size: 13px;
  color: #2f4a44;
  font-weight: 600;
}
.paste-area :deep(textarea) {
  font-family: 'SFMono-Regular', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}
.preview-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 8px;
  flex-wrap: wrap;
}
.preview-table {
  border-radius: 6px;
}
.preview-table :deep(.batch-row-error) {
  background-color: #fef0f0;
}
.preview-table :deep(.batch-row-warning) {
  background-color: #fdf6ec;
}
.cell-ring {
  font-weight: 600;
}
.cell-sub {
  display: block;
  font-size: 11px;
  color: #8a99a5;
}
.error-text {
  color: #c45656;
}
.warn-text {
  color: #b88230;
}
.msg-line {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.msg-line .el-icon {
  margin-top: 2px;
  flex-shrink: 0;
}
.history-pop {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
}
.history-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #2f4a44;
}
</style>
