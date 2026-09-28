import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain, toPlainList } from '../utils/plain';
import type { BirdAge, RingRecord, RingStatus } from '../types/ring-record';

/** 批量写入时事务内复检发现撞号，整批回滚后抛出 */
export class BatchConflictError extends Error {
  conflicts: RingRecord[];
  constructor(conflicts: RingRecord[]) {
    const ringNos = Array.from(new Set(conflicts.map((record) => record.ringNo))).join('、');
    super(`环号与库中最新记录冲突，整批未写入：${ringNos}`);
    this.name = 'BatchConflictError';
    this.conflicts = conflicts;
  }
}

export interface RingInput {
  ringNo: string;
  colorRing: string;
  speciesCn: string;
  speciesSci: string;
  age: BirdAge;
  ringDate?: string;
  netNo: string;
  netRound: number;
  status: RingStatus;
  ringer: string;
  siteId: string;
  sessionId: string;
  remark?: string;
}

interface RingState {
  rings: RingRecord[];
  /** 环号重复时命中的历史记录 id */
  duplicateId: string;
  hydrated: boolean;
}

/** 环志记录与查重结果 */
export const useRingStore = defineStore('ring', {
  state: (): RingState => ({ rings: [], duplicateId: '', hydrated: false }),

  getters: {
    findByRingNo(state) {
      return (ringNo: string): RingRecord | undefined =>
        state.rings.find((record) => record.ringNo.toLowerCase() === ringNo.trim().toLowerCase());
    },
    /** 同一环号的全部历史记录（含重捕 / 回收） */
    historyOf(state) {
      return (ringNo: string): RingRecord[] =>
        state.rings
          .filter((record) => record.ringNo.toLowerCase() === ringNo.trim().toLowerCase())
          .sort((a, b) => a.ringDate.localeCompare(b.ringDate));
    },
    duplicate(state): RingRecord | undefined {
      return state.rings.find((record) => record.id === state.duplicateId);
    },
  },

  actions: {
    async hydrate() {
      this.rings = await db.rings.orderBy('ringDate').reverse().toArray();
      this.hydrated = true;
    },

    setDuplicate(id: string) {
      this.duplicateId = id;
    },

    /** 新增环志记录：环号已存在时返回命中的历史记录，由页面提示并跳转 */
    async addRing(input: RingInput): Promise<{ record?: RingRecord; duplicate?: RingRecord }> {
      const existed = this.findByRingNo(input.ringNo);
      if (existed) {
        this.duplicateId = existed.id;
        return { duplicate: existed };
      }
      const record: RingRecord = {
        id: uid('ring'),
        ringNo: input.ringNo.trim(),
        colorRing: input.colorRing || '无',
        speciesCn: input.speciesCn.trim(),
        speciesSci: input.speciesSci.trim(),
        age: input.age,
        ringDate: input.ringDate ?? new Date().toISOString(),
        netNo: input.netNo.trim(),
        netRound: Number(input.netRound) || 1,
        status: input.status,
        ringer: input.ringer.trim(),
        siteId: input.siteId,
        sessionId: input.sessionId,
        remark: input.remark?.trim() || undefined,
      };
      await db.rings.put(toPlain(record));
      this.rings = [record, ...this.rings];
      this.duplicateId = '';
      return { record };
    },

    /**
     * 批量录入：调用方负责逐行校验（见 utils/batch-entry），这里只做整批原子写入。
     * 同一 Dexie 事务内 bulkPut，任一记录写入失败整批回滚，不会留下半批数据。
     * 写入前在事务内再做一次环号撞库校验，防止预览后库内数据发生变化。
     */
    async addRingsBatch(
      inputs: RingInput[],
    ): Promise<{ records: RingRecord[]; duplicates: RingRecord[] }> {
      const records: RingRecord[] = inputs.map((input) => ({
        id: uid('ring'),
        ringNo: input.ringNo.trim(),
        colorRing: input.colorRing || '无',
        speciesCn: input.speciesCn.trim(),
        speciesSci: input.speciesSci.trim(),
        age: input.age,
        ringDate: input.ringDate ?? new Date().toISOString(),
        netNo: input.netNo.trim(),
        netRound: Number(input.netRound) || 1,
        status: input.status,
        ringer: input.ringer.trim(),
        siteId: input.siteId,
        sessionId: input.sessionId,
        remark: input.remark?.trim() || undefined,
      }));

      await db.transaction('rw', db.rings, async () => {
        const all = await db.rings.toArray();
        const byRing = new Map<string, RingRecord[]>();
        all.forEach((record) => {
          const key = record.ringNo.toLowerCase();
          byRing.set(key, [...(byRing.get(key) ?? []), record]);
        });
        // 批内按行序追踪环号，重捕 / 回收允许接库中或本批先行初捕
        const seenFirst = new Set<string>();
        const conflicts: RingRecord[] = [];
        records.forEach((record) => {
          const key = record.ringNo.toLowerCase();
          const history = byRing.get(key) ?? [];
          if (record.status === '初捕') {
            if (history.length > 0 || seenFirst.has(key)) {
              conflicts.push(history[0] ?? record);
            } else {
              seenFirst.add(key);
            }
          } else if (history.length === 0 && !seenFirst.has(key)) {
            // 库中与本批均无任何同环号记录，重捕 / 回收无法接续
            conflicts.push(record);
          }
        });
        if (conflicts.length > 0) {
          throw new BatchConflictError(conflicts);
        }
        await db.rings.bulkPut(toPlainList(records));
      });

      // 事务成功提交后再刷新内存状态（按环志日期倒序，与 hydrate 排序一致）
      const sorted = [...records].sort((a, b) => b.ringDate.localeCompare(a.ringDate));
      this.rings = [...sorted, ...this.rings];
      return { records, duplicates: [] };
    },

    async updateRing(id: string, patch: Partial<RingInput>) {
      const current = this.rings.find((record) => record.id === id);
      if (!current) return;
      const next: RingRecord = { ...current, ...patch };
      await db.rings.put(toPlain(next));
      this.rings = this.rings.map((record) => (record.id === id ? next : record));
    },

    async removeRing(id: string) {
      await db.rings.delete(id);
      this.rings = this.rings.filter((record) => record.id !== id);
    },
  },
});
