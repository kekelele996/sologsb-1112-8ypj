import type { BirdSite } from '../types/bird-site';
import type { SurveySession } from '../types/session';
import { BIRD_AGES, RING_STATUSES, type BirdAge, type RingRecord, type RingStatus } from '../types/ring-record';
import { SPECIES_CATALOG } from './stats';

/** 预览行上的单条问题 */
export interface BatchIssue {
  level: 'error' | 'warning';
  message: string;
}

/** 重捕 / 回收接续到的原记录摘要 */
export interface BatchAttachBase {
  speciesCn: string;
  status: RingStatus;
  ringer: string;
  /** 规范后的 YYYY-MM-DD（可能为空） */
  date: string | null;
  siteId: string;
  /** 接续的是本批中某一行时给出其文件行号 */
  fromLine?: number;
}

/** 解析校验后的一行（用于按行预览） */
export interface BatchRingRow {
  /** 原始文件行号（从 1 开始，空行也占位） */
  lineNo: number;
  ringNo: string;
  colorRing: string;
  speciesCn: string;
  speciesSci: string;
  age: BirdAge | '';
  status: RingStatus | '';
  netNo: string;
  netRound: number | null;
  ringer: string;
  siteNo: string;
  sessionNo: string;
  /** 日期原文 */
  dateText: string;
  remark: string;
  /** 解析到的鸟点（找不到为 undefined） */
  site?: BirdSite;
  /** 解析到的批次（找不到为 undefined） */
  session?: SurveySession;
  /** 规范后的环志日期 YYYY-MM-DD（缺省取批次日期） */
  ringDate: string | null;
  /** 库中同环号的全部历史 */
  history: RingRecord[];
  /** 本批中更早出现的同环号行号 */
  earlierLines: number[];
  /** 重捕 / 回收接续到的原记录 */
  attach?: BatchAttachBase;
  /** 初捕撞号时命中的库中原记录（用于「标出原记录」） */
  conflictOriginal?: RingRecord;
  issues: BatchIssue[];
}

export interface BatchParseResult {
  rows: BatchRingRow[];
  /** 整表级问题（如表头无法识别） */
  tableIssues: BatchIssue[];
}

export interface BatchContext {
  rings: RingRecord[];
  sites: BirdSite[];
  sessions: SurveySession[];
}

/** 粘贴模板表头（顺序即无表头时的默认列序） */
export const BATCH_TEMPLATE_HEADER =
  '金属环号\t彩环组合\t鸟种中文名\t学名\t年龄\t状态\t网号\t网次\t环志人\t鸟点编号\t批次号\t环志日期\t备注';

const FIELD_KEYS = [
  'ringNo',
  'colorRing',
  'speciesCn',
  'speciesSci',
  'age',
  'status',
  'netNo',
  'netRound',
  'ringer',
  'siteNo',
  'sessionNo',
  'dateText',
  'remark',
] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

/** 表头别名 → 字段（去掉空格后匹配，兼容不同导出习惯） */
const HEADER_ALIASES: Record<string, FieldKey> = {
  金属环号: 'ringNo',
  环号: 'ringNo',
  环号编码: 'ringNo',
  彩环组合: 'colorRing',
  彩环: 'colorRing',
  鸟种中文名: 'speciesCn',
  鸟种: 'speciesCn',
  中文名: 'speciesCn',
  鸟种名称: 'speciesCn',
  学名: 'speciesSci',
  拉丁名: 'speciesSci',
  年龄: 'age',
  日龄: 'age',
  状态: 'status',
  环志状态: 'status',
  网号: 'netNo',
  网次: 'netRound',
  轮次: 'netRound',
  环志人: 'ringer',
  捕鸟人: 'ringer',
  鸟点编号: 'siteNo',
  点位编号: 'siteNo',
  鸟点: 'siteNo',
  批次号: 'sessionNo',
  调查批次: 'sessionNo',
  批次: 'sessionNo',
  环志日期: 'dateText',
  日期: 'dateText',
  捕获日期: 'dateText',
  备注: 'remark',
};

const RING_NO_RE = /^[A-E]-[0-9A-Za-z]{1,10}$/;

type RawValues = Record<FieldKey, string>;

function emptyRaw(): RawValues {
  return {
    ringNo: '',
    colorRing: '',
    speciesCn: '',
    speciesSci: '',
    age: '',
    status: '',
    netNo: '',
    netRound: '',
    ringer: '',
    siteNo: '',
    sessionNo: '',
    dateText: '',
    remark: '',
  };
}

/** 识别并规范日期：支持 2024-09-26 / 2024/9/26 / 2024.9.26 / 2024年9月26日 */
function normalizeDate(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 预览行的规范日期转写入用 ISO（与单条录入同样取当地 08:00，避免跨时区偏移） */
export function ringDateToIso(date: string): string {
  return new Date(`${date}T08:00:00`).toISOString();
}

export function rowHasError(row: BatchRingRow): boolean {
  return row.issues.some((issue) => issue.level === 'error');
}

export function rowHasWarning(row: BatchRingRow): boolean {
  return row.issues.some((issue) => issue.level === 'warning');
}

function splitLine(line: string): string[] {
  return line.split('\t').map((cell) => cell.trim());
}

/**
 * 解析粘贴的制表符表格并逐行校验。
 * 首行能识别出「金属环号」等表头时按表头映射列，否则按模板默认列序解析。
 */
export function parseBatchTsv(text: string, ctx: BatchContext): BatchParseResult {
  const tableIssues: BatchIssue[] = [];
  const cleaned = text.replace(/^﻿/, '');
  const lines = cleaned.split(/\r\n|\r|\n/);

  const firstIdx = lines.findIndex((line) => line.trim() !== '');
  if (firstIdx === -1) return { rows: [], tableIssues };

  // 列序号 → 字段；未识别到表头时按默认列序
  let columnMap: FieldKey[] | null = null;
  const headerCells = splitLine(lines[firstIdx]);
  const recognized = headerCells
    .map((cell) => HEADER_ALIASES[cell.replace(/\s+/g, '')])
    .filter((key): key is FieldKey => Boolean(key));
  const looksHeader = headerCells.length > 1 && recognized.length > 0;

  if (looksHeader) {
    const map: FieldKey[] = [];
    headerCells.forEach((cell) => {
      map.push(HEADER_ALIASES[cell.replace(/\s+/g, '')] as FieldKey);
    });
    if (!map.includes('ringNo')) {
      tableIssues.push({ level: 'error', message: '表头中找不到「金属环号」列，请使用模板表头后再粘贴。' });
      return { rows: [], tableIssues };
    }
    columnMap = map;
  }

  const siteNameOf = (siteId: string): string =>
    ctx.sites.find((site) => site.id === siteId)?.name ?? '未知鸟点';

  const rows: BatchRingRow[] = [];
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (idx <= firstIdx && columnMap) return; // 跳过表头行
    if (line.trim() === '') return;

    const cells = splitLine(line);
    const raw = emptyRaw();
    if (columnMap) {
      columnMap.forEach((key, col) => {
        if (key && cells[col] !== undefined) raw[key] = cells[col];
      });
    } else {
      FIELD_KEYS.forEach((key, col) => {
        if (cells[col] !== undefined) raw[key] = cells[col];
      });
    }
    rows.push(validateRow(lineNo, raw, ctx, siteNameOf));
  });

  crossCheckRings(rows, ctx, siteNameOf);
  return { rows, tableIssues };
}

function validateRow(
  lineNo: number,
  raw: RawValues,
  ctx: BatchContext,
  siteNameOf: (siteId: string) => string,
): BatchRingRow {
  const issues: BatchIssue[] = [];
  const push = (level: BatchIssue['level'], message: string) => issues.push({ level, message });

  // 环号：去空格并统一大写（与单条录入的 A-12345 规范一致）
  const ringNo = raw.ringNo.replace(/\s+/g, '').toUpperCase();
  if (!ringNo) {
    push('error', '缺少金属环号');
  } else if (!RING_NO_RE.test(ringNo)) {
    push('error', `环号「${raw.ringNo}」格式不正确，应为「前缀-序号」，如 A-10231（前缀 A~E）`);
  }

  const colorRing = raw.colorRing || '无';

  // 鸟种
  let speciesCn = raw.speciesCn.trim();
  let speciesSci = raw.speciesSci.trim();
  if (!speciesCn) {
    push('error', '缺少鸟种中文名');
  } else {
    const catalog = SPECIES_CATALOG.find((item) => item.cn === speciesCn);
    if (catalog) {
      if (!speciesSci) speciesSci = catalog.sci;
    } else if (!speciesSci) {
      push('warning', `鸟种「${speciesCn}」不在内置名录中，学名需自行补全`);
    }
  }

  // 年龄 / 状态
  const age = (BIRD_AGES.includes(raw.age as BirdAge) ? raw.age : '') as BirdAge | '';
  if (!raw.age) push('error', '缺少年龄');
  else if (!age) push('error', `年龄「${raw.age}」无法识别，只支持：${BIRD_AGES.join(' / ')}`);

  const status = (RING_STATUSES.includes(raw.status as RingStatus) ? raw.status : '') as RingStatus | '';
  if (!raw.status) push('error', '缺少状态（初捕 / 重捕 / 回收）');
  else if (!status) push('error', `状态「${raw.status}」无法识别，只支持：${RING_STATUSES.join(' / ')}`);

  if (!raw.netNo) push('error', '缺少网号');

  // 网次：可空，默认 1
  let netRound: number | null = null;
  if (raw.netRound.trim() === '') {
    netRound = 1;
  } else if (!/^\d+$/.test(raw.netRound.trim())) {
    push('error', `网次「${raw.netRound}」不是正整数`);
  } else {
    netRound = Number(raw.netRound);
    if (netRound < 1 || netRound > 20) push('error', `网次 ${netRound} 超出 1~20 范围`);
  }

  if (!raw.ringer) push('error', '缺少环志人');

  // 鸟点编号
  const site = ctx.sites.find((item) => item.siteNo.toLowerCase() === raw.siteNo.trim().toLowerCase());
  if (!raw.siteNo.trim()) {
    push('error', '缺少鸟点编号');
  } else if (!site) {
    push('error', `鸟点编号「${raw.siteNo.trim()}」在鸟点台账中找不到，请先在「鸟点台账」登记或核对编号`);
  }

  // 批次号
  const session = ctx.sessions.find((item) => item.sessionNo.toLowerCase() === raw.sessionNo.trim().toLowerCase());
  if (!raw.sessionNo.trim()) {
    push('error', '缺少批次号');
  } else if (!session) {
    push('error', `批次号「${raw.sessionNo.trim()}」在调查批次中找不到，请先在「调查批次」建档或核对批次号`);
  }

  // 日期：可空，默认取批次调查日期；填写则必须与批次日期一致
  let ringDate: string | null = normalizeDate(raw.dateText);
  if (raw.dateText.trim() && !ringDate) {
    push('error', `环志日期「${raw.dateText}」无法识别（支持 2024-09-26 / 2024/9/26 / 2024年9月26日）`);
  }
  if (!ringDate && session) ringDate = session.date;

  // 批次 ↔ 鸟点 / 日期一致性
  if (site && session && session.siteId !== site.id) {
    push(
      'error',
      `批次「${session.sessionNo}」属于鸟点 ${ctx.sites.find((s) => s.id === session.siteId)?.siteNo ?? '?'}·${siteNameOf(
        session.siteId,
      )}（${session.date}），与本行鸟点 ${site.siteNo}·${site.name} 不一致`,
    );
  }
  if (session && ringDate && normalizeDate(raw.dateText) && ringDate !== session.date) {
    push('error', `环志日期 ${ringDate} 与批次「${session.sessionNo}」的调查日期 ${session.date} 不一致，补录日期以批次为准`);
  }
  if (session?.closed) {
    push('warning', `批次「${session.sessionNo}」已关闭，本行将补录进已关闭批次`);
  }
  if (session && netRound !== null && netRound > session.netRounds) {
    push('warning', `网次 ${netRound} 超过批次「${session.sessionNo}」计划网次 ${session.netRounds}`);
  }

  if (raw.remark.trim().length > 80) push('warning', `备注 ${raw.remark.trim().length} 字，超过 80 字上限`);

  return {
    lineNo,
    ringNo,
    colorRing,
    speciesCn,
    speciesSci,
    age,
    status,
    netNo: raw.netNo.trim(),
    netRound,
    ringer: raw.ringer.trim(),
    siteNo: raw.siteNo.trim(),
    sessionNo: raw.sessionNo.trim(),
    dateText: raw.dateText.trim(),
    remark: raw.remark.trim(),
    site,
    session,
    ringDate,
    history: [],
    earlierLines: [],
    issues,
  };
}

/** 第二轮：结合库中历史与本批先行行，判断环号撞车与重捕 / 回收接续 */
function crossCheckRings(
  rows: BatchRingRow[],
  ctx: BatchContext,
  siteNameOf: (siteId: string) => string,
): void {
  const historyOf = (ringNo: string): RingRecord[] =>
    ctx.rings
      .filter((record) => record.ringNo.toLowerCase() === ringNo.toLowerCase())
      .sort((a, b) => a.ringDate.localeCompare(b.ringDate));

  const seen = new Map<string, number[]>();

  rows.forEach((row) => {
    if (!row.ringNo || !RING_NO_RE.test(row.ringNo) || !row.status) {
      if (row.ringNo && RING_NO_RE.test(row.ringNo)) seen.set(row.ringNo, [...(seen.get(row.ringNo) ?? []), row.lineNo]);
      return;
    }

    const history = historyOf(row.ringNo);
    row.history = history;
    const earlierLines = seen.get(row.ringNo) ?? [];
    row.earlierLines = earlierLines;
    const earlierRows = earlierLines
      .map((line) => rows.find((item) => item.lineNo === line))
      .filter((item): item is BatchRingRow => Boolean(item));

    if (row.status === '初捕') {
      const existed = history.find((record) => record.status === '初捕') ?? history[0];
      if (existed) {
        const when = existed.ringDate.slice(0, 10);
        row.issues.push({
          level: 'error',
          message: `环号 ${row.ringNo} 已有${existed.status}记录（${when} · ${siteNameOf(existed.siteId)} · ${existed.ringer}），初捕不能重复登记；如确属再次捕获请改状态为「重捕」`,
        });
        row.conflictOriginal = existed;
      }
      const earlierFirst = earlierRows.find((item) => item.status === '初捕');
      if (earlierFirst) {
        row.issues.push({
          level: 'error',
          message: `环号 ${row.ringNo} 在本批第 ${earlierFirst.lineNo} 行已登记过初捕，同批不能重复初捕`,
        });
      }
    } else {
      // 重捕 / 回收：库中初捕优先，否则接本批更早的初捕
      const existingBase = history.find((record) => record.status === '初捕') ?? history[0];
      const batchBase = existingBase
        ? undefined
        : earlierRows.find((item) => item.status === '初捕');
      if (!existingBase && !batchBase) {
        row.issues.push({
          level: 'error',
          message: `环号 ${row.ringNo} 查无任何同环号记录（库中与本批先行行均无），${row.status}无法接续，请先登记初捕或核对环号`,
        });
      } else if (existingBase) {
        row.attach = {
          speciesCn: existingBase.speciesCn,
          status: existingBase.status,
          ringer: existingBase.ringer,
          date: existingBase.ringDate.slice(0, 10),
          siteId: existingBase.siteId,
        };
      } else if (batchBase) {
        row.attach = {
          speciesCn: batchBase.speciesCn,
          status: '初捕',
          ringer: batchBase.ringer,
          date: batchBase.ringDate,
          siteId: batchBase.site?.id ?? '',
          fromLine: batchBase.lineNo,
        };
      }

      const baseSpecies = existingBase?.speciesCn ?? batchBase?.speciesCn;
      const baseDate = existingBase?.ringDate.slice(0, 10) ?? batchBase?.ringDate ?? null;
      if (baseSpecies && row.speciesCn && row.speciesCn !== baseSpecies) {
        row.issues.push({
          level: 'warning',
          message: `本行鸟种「${row.speciesCn}」与原初捕记录鸟种「${baseSpecies}」不一致，请核对环号是否抄错`,
        });
      }
      if (baseDate && row.ringDate && row.ringDate < baseDate) {
        row.issues.push({
          level: 'warning',
          message: `环志日期 ${row.ringDate} 早于原初捕日期 ${baseDate}，请核对`,
        });
      }

      // 同批疑似完全重复
      const dup = earlierRows.find(
        (item) => item.status === row.status && item.netNo === row.netNo && item.netRound === row.netRound,
      );
      if (dup) {
        row.issues.push({
          level: 'warning',
          message: `与本批第 ${dup.lineNo} 行疑似重复（环号 / 状态 / 网号 / 网次相同）`,
        });
      }
    }

    seen.set(row.ringNo, [...earlierLines, row.lineNo]);
  });
}
