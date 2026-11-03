import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEMO_DATA } from '../demo-data';
import type { DemoRecord } from '../types';

const STORAGE_KEY = 'brufap.erp.demo.records.v2';
type Records = Record<string, DemoRecord[]>;
interface DemoStore {
  records: Records;
  persistent: boolean;
  save: (moduleId: string, record: DemoRecord) => void;
  reset: () => void;
}
const Context = createContext<DemoStore | null>(null);

function initialRecords(): Records {
  const original = structuredClone(DEMO_DATA);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return original;
    for (const key of Object.keys(original)) {
      const rows = saved[key];
      if (Array.isArray(rows) && rows.length <= 5000 && rows.every(row =>
        row && typeof row === 'object' && typeof row.id === 'string'
        && Object.values(row).every(value => ['string', 'number', 'boolean', 'undefined'].includes(typeof value)))) {
        const defaults = new Map(original[key].map(record => [record.id, record]));
        original[key] = rows.map(row => ({ ...defaults.get(row.id), ...row }));
      }
    }
  } catch { /* A blocked or old local store starts with the demonstration fixtures. */ }
  return original;
}

export function DemoStoreProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<Records>(initialRecords);
  const [persistent, setPersistent] = useState(true);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); setPersistent(true); }
    catch { setPersistent(false); }
  }, [records]);
  const save = (moduleId: string, record: DemoRecord) => {
    setRecords(previous => {
      const rows = previous[moduleId] || [];
      const exists = rows.some(row => row.id === record.id);
      return { ...previous, [moduleId]: exists ? rows.map(row => row.id === record.id ? record : row) : [record, ...rows] };
    });
  };
  return <Context.Provider value={{ records, persistent, save, reset: () => setRecords(structuredClone(DEMO_DATA)) }}>{children}</Context.Provider>;
}

export function useDemoStore() {
  const value = useContext(Context);
  if (!value) throw new Error('Demo store is unavailable');
  return value;
}

export function newDemoId() { return `demo-${crypto.randomUUID()}`; }

export function nextDemoNumber(rows: DemoRecord[]) {
  const current = rows.reduce((maximum, row) => Math.max(maximum, Number(String(row.number || '').replace(/\D/g, '')) || 0), 1000);
  return String(current + 1);
}
