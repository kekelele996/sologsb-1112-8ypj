import type { BirdAge, RingRecord, RingStatus } from '../types/ring-record';
import type { BirdSite } from '../types/bird-site';
import type { SurveySession } from '../types/session';
import { SPECIES_CATALOG } from './stats';
import { formatDate } from './format';

/** 原始粘贴行（按制表符切出的单元格，未做业务校验） */
export interface BatchRawRow {
  lineNo: number;
  cells: string[];
}

/** 预览行：解析 + 业务校验后的结果 */
export interface BatchRow {
  /** 源文件行号（含表头偏移，便于志愿者对照表格定位） */
  lineNo: number;
  /** 金属环号 */
  ringNo: string;
  colorRing: string;
  speciesCn: string;
  speciesSci: string;
  age: BirdAge | '';
  /** 录入日期（YYYY-MM-DD，未解析成功时为原始文本） */
  date: string;
  netNo: string;
  netRound: number | '';
  status: RingStatus | '';
  ringer: string;
  siteNo: string;
  sessionNo: string;
  remark: string;
  /** 解析出的鸟点（找不到时为 undefined） */
  site?: BirdSite;
  /** 解析出的批次（找不到时为 undefined） */
  session?: SurveySession;
  /** 命中的同环号原记录（库中 RingRecord 或本批内更早出现的初捕行） */
  original?: RingRecord | BatchRow;
  /** 该环号全部历史记录 */
  history: RingRecord[];
  /** 本批内重复出现次数（首次为 0） */
  repeatInBatch: number;
  /** 阻断性错误：存在任意一条时整批不允许写入 */
  errors: string[];
  /** 非阻断提示：重捕接历史、名录外鸟种、批次已关闭等 */
  warnings: string[];
}

export interface BatchSummary {
  total: number;
  /** 可直接写入的新初捕条数 */
  firstCount: number;
  /** 可接入同环号历史的重捕 / 回收条数 */
  followCount: number;
  errorCount: number;
  warningCount: number;
}

/** TSV 表头别名：志愿者从 Excel/WPS 粘贴，表头用词可能不一致，统一映射 */
const HEADER_ALIASES: Record<string, keyof Omit<BatchRow, 'lineNo' | 'site' | 'session' | 'original' | 'history' | 'repeatInBatch' | 'errors' | 'warnings'>> = {
  金属环号: 'ringNo',
  环号: 'ringNo',
  环志号: 'ringNo',
  ringno: 'ringNo',
  彩环: 'colorRing',
  彩环组合: 'colorRing',
  鸟种: 'speciesCn',
  鸟种中文名: 'speciesCn',
  中文名: 'speciesCn',
  学名: 'speciesSci',
  鸟种学名: 'speciesSci',
  年龄: 'age',
  环志日期: 'date',
  日期: 'date',
  捕获日期: 'date',
  网号: 'netNo',
  网次: 'netRound',
  轮次: 'netRound',
  状态: 'status',
  初重捕: 'status',
  环志人: 'ringer',
  环志员: 'ringer',
  鸟点编号: 'siteNo',
  鸟点号: 'siteNo',
  点位编号: 'siteNo',
  鸟点: 'siteNo',
  批次号: 'sessionNo',
  批次编号: 'sessionNo',
  调查批次: 'sessionNo',
  批次: 'sessionNo',
  备注: 'remark',
};

/** 无表头时的固定列序：金属环号 彩环 鸟种 年龄 日期 网号 网次 状态 环志人 鸟点编号 批次号 备注 */
export const FALLBACK_COLUMNS: Array<keyof BatchRow> = [
  'ringNo',
  'colorRing',
  'speciesCn',
  'age',
  'date',
  'netNo',
  'netRound',
  'status',
  'ringer',
  'siteNo',
  'sessionNo',
  'remark',
];

export const BATCH_HEADERS = ['金属环号', '彩环', '鸟种中文名', '学名', '年龄', '环志日期', '网号', '网次', '状态', '环志人', '鸟点编号', '批次号', '备注'];

/**
 * 解析粘贴文本：兼容制表符（Excel/WPS）与连续空格分隔，识别首行表头。
 * 引号包裹的单元格按 TSV 规则转义（双写引号表示一个引号）。
 */
export function parseTsv(text: string): { headers: (keyof BatchRow | '')[]; rawRows: BatchRawRow[]; detected: boolean } {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { headers: [], rawRows: [], detected: false };

  const splitLine = (line: string): string[] => {
    if (line.includes('\t')) return splitDelimited(line, '\t');
    // 有些记录表从纯文本复制，单元格间是两个及以上空格
    if (line.includes('  ')) return line.trim().split(/ {2,}/).map((cell) => cell.trim());
    return line.split(/\s+/).map((cell) => cell.trim());
  };

  const firstCells = splitLine(lines[0]);
  const mapped = firstCells.map((cell) => HEADER_ALIASES[cell.trim().toLowerCase()] ?? HEADER_ALIASES[cell.trim()] ?? '');
  const detected = mapped.filter(Boolean).length >= 3 && mapped.includes('ringNo');

  const headers = detected
    ? mapped
    : FALLBACK_COLUMNS.slice(0, firstCells.length);

  const dataLines = detected ? lines.slice(1) : lines;
  const rawRows: BatchRawRow[] = dataLines.map((line, index) => ({
    lineNo: index + 1 + (detected ? 1 : 0),
    cells: splitLine(line),
  }));
  return { headers, rawRows, detected };
}

/** 按 RFC4180 风格切分单分隔符行（字段内引号转义） */
function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 日期归一：接受 YYYY-M-D、YYYY/M/D、YYYY.M.D，输出 YYYY-MM-DD */
export function normalizeDate(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!match) return '';
  const [, y, m, d] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const AGE_VALUES: BirdAge[] = ['幼', '亚成', '成'];
const STATUS_VALUES: RingStatus[] = ['初捕', '重捕', '回收'];

function normalizeRingNo(raw: string): string {
  // 环号由字母前缀 + 序号构成，去掉内部空格并转大写（a-10231 → A-10231）
  return raw.replace(/\s+/g, '').toUpperCase();
}

export interface ValidateContext {
  rings: RingRecord[];
  sites: BirdSite[];
  sessions: SurveySession[];
}

/**
 * 把原始单元格行转成带校验结果的预览行：
 * - 初捕撞已有环号（或本批更早的初捕）→ 阻断错误并标出原记录；
 * - 重捕 / 回收 → 校验同环号历史存在，接在其后，鸟种不一致给提示；
 * - 鸟点编号、批次号找不到，批次鸟点或日期对不上 → 说明原因并阻断。
 */
export function buildBatchRows(text: string, context: ValidateContext): BatchRow[] {
  const { headers, rawRows } = parseTsv(text);
  if (rawRows.length === 0) return [];

  const findSite = (siteNo: string) =>
    context.sites.find((site) => site.siteNo.trim().toLowerCase() === siteNo.trim().toLowerCase());
  const findSession = (sessionNo: string) =>
    context.sessions.find((session) => session.sessionNo.trim().toLowerCase() === sessionNo.trim().toLowerCase());
  const historyOf = (ringNo: string) =>
    context.rings
      .filter((record) => record.ringNo.toLowerCase() === ringNo.toLowerCase())
      .sort((a, b) => a.ringDate.localeCompare(b.ringDate));

  /** 本批内已出现的环号 → 首次初捕记录（用于批内撞车判定） */
  const batchFirst = new Map<string, BatchRow>();
  const batchSeenCount = new Map<string, number>();

  return rawRows.map((raw) => {
    const cell = (key: keyof BatchRow): string => {
      const index = headers.indexOf(key as keyof BatchRow);
      return index >= 0 ? (raw.cells[index] ?? '').trim() : '';
    };

    const ringNo = normalizeRingNo(cell('ringNo'));
    const speciesCn = cell('speciesCn');
    const speciesSciRaw = cell('speciesSci');
    const ageRaw = cell('age');
    const date = normalizeDate(cell('date'));
    const netRoundRaw = cell('netRound');
    const statusRaw = cell('status');
    const siteNo = cell('siteNo');
    const sessionNo = cell('sessionNo');

    const row: BatchRow = {
      lineNo: raw.lineNo,
      ringNo,
      colorRing: cell('colorRing') || '无',
      speciesCn,
      speciesSci: speciesSciRaw || SPECIES_CATALOG.find((item) => item.cn === speciesCn)?.sci || '',
      age: (AGE_VALUES.includes(ageRaw as BirdAge) ? ageRaw : '') as BirdAge | '',
      date,
      netNo: cell('netNo') || '1 号网',
      netRound: netRoundRaw === '' ? '' : Number(netRoundRaw),
      status: (STATUS_VALUES.includes(statusRaw as RingStatus) ? statusRaw : '') as RingStatus | '',
      ringer: cell('ringer'),
      siteNo,
      sessionNo,
      remark: cell('remark'),
      history: ringNo ? historyOf(ringNo) : [],
      repeatInBatch: ringNo ? batchSeenCount.get(ringNo) ?? 0 : 0,
      errors: [],
      warnings: [],
    };

    if (!ringNo) row.errors.push('金属环号为空');
    else if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(ringNo)) row.errors.push(`环号「${ringNo}」格式不符（应为 前缀-序号，如 A-10231）`);

    if (!speciesCn) row.errors.push('鸟种中文名为空');
    else if (!SPECIES_CATALOG.some((item) => item.cn === speciesCn)) row.warnings.push(`「${speciesCn}」不在常见鸟种名录，按自定义鸟种写入`);

    if (!ageRaw) row.errors.push('年龄为空或无法识别（需为 幼 / 亚成 / 成）');
    else if (!row.age) row.errors.push(`年龄「${ageRaw}」无法识别（需为 幼 / 亚成 / 成）`);

    if (!cell('date')) row.errors.push('环志日期为空');
    else if (!date) row.errors.push(`日期「${cell('date')}」无法解析（需为 YYYY-MM-DD）`);

    if (netRoundRaw !== '' && (row.netRound === '' || !Number.isFinite(row.netRound as number) || (row.netRound as number) < 1)) {
      row.errors.push(`网次「${netRoundRaw}」不是正整数`);
    }

    if (!statusRaw) row.errors.push('状态为空或无法识别（需为 初捕 / 重捕 / 回收）');
    else if (!row.status) row.errors.push(`状态「${statusRaw}」无法识别（需为 初捕 / 重捕 / 回收）`);

    if (!row.ringer) row.errors.push('环志人为空');

    // 鸟点编号
    if (!siteNo) {
      row.errors.push('鸟点编号为空');
    } else {
      row.site = findSite(siteNo);
      if (!row.site) row.errors.push(`鸟点编号「${siteNo}」在鸟点台账中找不到`);
    }

    // 批次号
    if (!sessionNo) {
      row.errors.push('批次号为空');
    } else {
      row.session = findSession(sessionNo);
      if (!row.session) {
        row.errors.push(`批次号「${sessionNo}」在调查批次中找不到`);
      }
    }

    // 批次 ↔ 鸟点、日期一致性
    if (row.session && row.site && row.session.siteId !== row.site.id) {
      row.errors.push(
        `批次「${row.session.sessionNo}」登记在鸟点 ${siteNoOf(context.sites, row.session.siteId)}，与本行鸟点「${siteNo}」不一致`,
      );
    }
    if (row.session && date && row.session.date !== date) {
      row.errors.push(`批次「${row.session.sessionNo}」日期为 ${row.session.date}，与本行环志日期 ${date} 不一致`);
    }
    if (row.session?.closed) {
      row.warnings.push(`批次「${row.session.sessionNo}」已关闭，记录仍会写入该批次`);
    }

    // 环号查重：库中历史 + 本批更早行
    if (ringNo) {
      batchSeenCount.set(ringNo, (batchSeenCount.get(ringNo) ?? 0) + 1);
      const earlierInBatch = batchFirst.get(ringNo);
      const original = earlierInBatch ?? row.history[0];

      if (row.status === '初捕') {
        if (row.history.length > 0) {
          row.original = row.history[0];
          row.errors.push(
            `环号 ${ringNo} 已存在初捕记录（${row.history[0].speciesCn} · ${formatDate(row.history[0].ringDate)} · 鸟点 ${siteNoOf(context.sites, row.history[0].siteId)}），初捕不允许重复登记；如为重捕 / 回收请改状态`,
          );
        } else if (earlierInBatch) {
          row.original = earlierInBatch;
          row.errors.push(`环号 ${ringNo} 在本批第 ${earlierInBatch.lineNo} 行已登记，初捕不能重复；如需再接一条请改为重捕 / 回收`);
        } else {
          batchFirst.set(ringNo, row);
        }
      } else if (row.status === '重捕' || row.status === '回收') {
        if (earlierInBatch) {
          row.original = earlierInBatch;
          row.warnings.push(
            `接在本批第 ${earlierInBatch.lineNo} 行 ${ringNo} 初捕之后（同批${row.status === '重捕' ? '重捕' : '回收'}），将并入同一环号历史`,
          );
        } else if (row.history.length > 0) {
          row.original = row.history[0];
          const last = row.history[row.history.length - 1];
          row.warnings.push(
            `${row.status}：环号 ${ringNo} 已有 ${row.history.length} 条记录，最近一次 ${formatDate(last.ringDate)}（${last.status}），本条接在历史之后`,
          );
        } else {
          row.errors.push(`环号 ${ringNo} 在库中与本批内均无初捕记录，${row.status}无法接入历史；请核对环号或先登记初捕`);
        }
        if (row.history.length > 0 && speciesCn) {
          const mismatch = row.history.find((record) => record.speciesCn !== speciesCn);
          if (mismatch) row.warnings.push(`鸟种「${speciesCn}」与原记录鸟种「${mismatch.speciesCn}」不一致，请核对环号是否抄错`);
        }
      }
    }

    return row;
  });
}

function siteNoOf(sites: BirdSite[], siteId: string): string {
  const site = sites.find((item) => item.id === siteId);
  return site ? `${site.siteNo} ${site.name}` : '未知鸟点';
}

export function summarize(rows: BatchRow[]): BatchSummary {
  return {
    total: rows.length,
    firstCount: rows.filter((row) => row.errors.length === 0 && row.status === '初捕').length,
    followCount: rows.filter((row) => row.errors.length === 0 && row.status !== '初捕').length,
    errorCount: rows.filter((row) => row.errors.length > 0).length,
    warningCount: rows.filter((row) => row.errors.length === 0 && row.warnings.length > 0).length,
  };
}

/** 生成可直接粘贴的示例（取一个进行中批次） */
export function buildSampleTsv(sites: BirdSite[], sessions: SurveySession[], rings: RingRecord[]): string {
  const session = sessions.find((item) => !item.closed) ?? sessions[0];
  if (!session) return BATCH_HEADERS.join('\t');
  const site = sites.find((item) => item.id === session.siteId);
  const knownRing = rings.find((record) => record.status === '初捕');
  const rows = [
    ['A-20901', '无', '红喉歌鸲', '成', session.date, '1 号网', '1', '初捕', '韩雪', site?.siteNo ?? '', session.sessionNo, ''],
    ['A-20902', '蓝-白', '黄眉柳莺', '幼', session.date, '2 号网', '1', '初捕', '韩雪', site?.siteNo ?? '', session.sessionNo, ''],
  ];
  if (knownRing && site) {
    rows.push([knownRing.ringNo, knownRing.colorRing, knownRing.speciesCn, '成', session.date, '3 号网', '2', '重捕', '郑海', site.siteNo, session.sessionNo, '批量补录示例：重捕接入历史']);
  }
  return [BATCH_HEADERS.join('\t'), ...rows.map((row) => row.join('\t'))].join('\n');
}
