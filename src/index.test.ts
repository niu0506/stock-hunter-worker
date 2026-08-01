import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, {
  type Env,
  getShanghaiDateStr,
  getShanghaiDayOfWeek,
  getShanghaiDateParts,
  matches,
  fetchStocksFromApi,
  fetchStocks,
  formatStockMessage,
  saveToKV,
  fetchCalendarFromApi,
  isTradingDay,
} from './index';
import type { ExecutionContext } from '@cloudflare/workers-types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const testLogger = () => ({ info: vi.fn(), error: vi.fn() });

function makeEnv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const env = {
    TELEGRAM_BOT_TOKEN: 'test',
    TELEGRAM_CHAT_ID: 'test',
    STOCK_HUNTER: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    },
  };
  return { store, env: env as unknown as Env };
}

const ctx = {} as unknown as ExecutionContext;

const baseStock = {
  code: '600001',
  name: 'Test',
  price: 10,
  changePct: 10,
  turnoverRate: 5,
  peRatio: 20,
  pbRatio: 2,
  marketCap: 100,
};

function apiSource(overrides: Partial<Parameters<typeof fetchStocksFromApi>[0]> = {}) {
  return {
    name: 'Test',
    referer: 'http://test',
    maxPages: 5,
    buildUrl: (page: number) => `http://test/api?page=${page}`,
    extractItems: (j: any) => j.items,
    mapItem: (i: any) => ({
      code: i.code,
      name: i.name,
      price: parseFloat(i.price),
      changePct: parseFloat(i.pct),
      turnoverRate: 5,
      peRatio: 20,
      pbRatio: 2,
      marketCap: 100,
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getShanghaiDateStr', () => {
  it('returns an 8-digit date string', () => {
    expect(getShanghaiDateStr()).toMatch(/^\d{8}$/);
  });

  it('returns consistent year/month/day parts', () => {
    const { year, month, day } = getShanghaiDateParts();
    expect(`${year}${month}${day}`).toBe(getShanghaiDateStr());
  });
});

describe('getShanghaiDayOfWeek', () => {
  it('returns a number in 0..6', () => {
    const d = getShanghaiDayOfWeek();
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(6);
  });
});

describe('matches', () => {
  it('accepts a stock meeting all criteria', () => {
    expect(matches(baseStock)).toBe(true);
  });

  it('rejects marketCap below 50亿', () => {
    expect(matches({ ...baseStock, marketCap: 49.9 })).toBe(false);
  });

  it('rejects zero (missing) marketCap', () => {
    expect(matches({ ...baseStock, marketCap: 0 })).toBe(false);
  });

  it('rejects peRatio above 40', () => {
    expect(matches({ ...baseStock, peRatio: 40.01 })).toBe(false);
  });

  it('rejects negative peRatio', () => {
    expect(matches({ ...baseStock, peRatio: -1 })).toBe(false);
  });

  it('rejects turnoverRate below 3', () => {
    expect(matches({ ...baseStock, turnoverRate: 2.99 })).toBe(false);
  });

  it('rejects changePct below 9.5', () => {
    expect(matches({ ...baseStock, changePct: 9.49 })).toBe(false);
  });

  it('rejects pbRatio above 3', () => {
    expect(matches({ ...baseStock, pbRatio: 3.01 })).toBe(false);
  });

  it('accepts boundary values', () => {
    expect(
      matches({ ...baseStock, marketCap: 50, peRatio: 40, turnoverRate: 3, changePct: 9.5, pbRatio: 3 }),
    ).toBe(true);
  });
});

describe('fetchStocksFromApi', () => {
  it('dedups codes and stops once changePct drops below 9.5', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json({
        items: [
          { code: '600001', name: 'A', price: '10', pct: '10' },
          { code: '600001', name: 'A', price: '10', pct: '10' },
          { code: '600002', name: 'B', price: '10', pct: '9' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchStocksFromApi(apiSource());
    expect(result.map((s) => s.code)).toEqual(['600001']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('filters out codes not matching A-share prefixes', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json({
        items: [
          { code: '900001', name: 'X', price: '10', pct: '10' },
          { code: '000001', name: 'P', price: '10', pct: '10' },
          { code: '600000', name: 'P', price: '10', pct: '10' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchStocksFromApi(apiSource());
    expect(result.map((s) => s.code)).toEqual(['000001', '600000']);
  });

  it('continues pagination while changePct >= 9.5 then stops below', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      code: `600${String(i).padStart(3, '0')}`,
      name: 'S',
      price: '10',
      pct: '10',
    }));
    const page2 = [{ code: '600100', name: 'T', price: '10', pct: '8' }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ items: page1 }))
      .mockResolvedValueOnce(json({ items: page2 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchStocksFromApi(apiSource());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(100);
    expect(result.every((s) => s.changePct >= 9.5)).toBe(true);
  });

  it('stops after a page with fewer than 100 items', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      code: `600${String(i).padStart(3, '0')}`,
      name: 'S',
      price: '10',
      pct: '10',
    }));
    const page2 = [{ code: '600100', name: 'T', price: '10', pct: '10' }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ items: page1 }))
      .mockResolvedValueOnce(json({ items: page2 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchStocksFromApi(apiSource());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(101);
  });
});

describe('fetchStocks', () => {
  const sinaItem = {
    code: '600001',
    name: 'A',
    trade: '10',
    changepercent: '10',
    turnoverratio: '5',
    per: '20',
    pb: '2',
    mktcap: '1000000',
  };
  const emItem = {
    f12: '600001',
    f14: 'A',
    f2: '10',
    f3: '10',
    f8: '5',
    f9: '20',
    f23: '2',
    f20: '10000000000',
  };

  it('returns data when a source succeeds', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url.includes('quotes_service')
        ? Promise.resolve(json([sinaItem]))
        : Promise.resolve(json({ data: { diff: [emItem] } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchStocks(testLogger() as any);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].code).toBe('600001');
    expect(result[0].marketCap).toBe(100);
  });

  it('falls back to the other source when the first fails', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url.includes('quotes_service')
        ? Promise.reject(new Error('sina down'))
        : Promise.resolve(json({ data: { diff: [emItem] } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchStocks(testLogger() as any);
    expect(result[0].code).toBe('600001');
  });

  it('throws when all sources fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('all down')));
    await expect(fetchStocks(testLogger() as any)).rejects.toThrow();
  });
});

describe('formatStockMessage', () => {
  it('formats the empty list', () => {
    const msg = formatStockMessage([]);
    expect(msg).toContain('没有符合条件的股票');
    expect(msg).toContain(getShanghaiDateStr());
  });

  it('formats a stock list with metrics', () => {
    const msg = formatStockMessage([baseStock]);
    expect(msg).toContain('共 1 只股票');
    expect(msg).toContain('600001');
    expect(msg).toContain('10.00');
    expect(msg).toContain('100.00亿元');
  });
});

describe('saveToKV', () => {
  it('writes latest, history and updates index', async () => {
    const { store, env } = makeEnv();
    await saveToKV(env, [baseStock]);
    expect(store.has('latest')).toBe(true);
    const dateStr = getShanghaiDateStr();
    expect(store.has(`history:${dateStr}`)).toBe(true);
    expect(JSON.parse(store.get('history:index')!)).toContain(dateStr);
  });

  it('does not duplicate dates in the index', async () => {
    const { store, env } = makeEnv();
    const dateStr = getShanghaiDateStr();
    store.set('history:index', JSON.stringify([dateStr]));
    await saveToKV(env, []);
    expect(JSON.parse(store.get('history:index')!)).toEqual([dateStr]);
  });

  it('caps the index at 365 entries', async () => {
    const { store, env } = makeEnv();
    const dateStr = getShanghaiDateStr();
    const oldDates = Array.from({ length: 365 }, (_, i) => `2025${String(i).padStart(4, '0')}`);
    store.set('history:index', JSON.stringify(oldDates));
    await saveToKV(env, []);
    const index = JSON.parse(store.get('history:index')!);
    expect(index).toHaveLength(365);
    expect(index[0]).toBe(dateStr);
  });
});

describe('fetchCalendarFromApi', () => {
  it('parses holiday and makeup workday data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json([
          { name: '元旦', date: '2026-01-01', isOffDay: true },
          { name: '补班', date: '2026-01-04', isOffDay: false },
        ]),
      ),
    );
    const cal = await fetchCalendarFromApi('2026');
    expect(cal.holidays.has('20260101')).toBe(true);
    expect(cal.makeupWorkdays.has('20260104')).toBe(true);
  });
});

describe('isTradingDay', () => {
  it('agrees with weekday/weekend for a holiday-free calendar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])));
    const { env } = makeEnv();
    const day = getShanghaiDayOfWeek();
    const result = await isTradingDay(env, testLogger() as any);
    expect(result).toBe(day >= 1 && day <= 5);
  });
});

describe('fetch handler', () => {
  it('serves the frontend at /', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request('http://x/'), env, ctx);
    expect(res.status).toBe(200);
    expect((await res.text()).includes('<html')).toBe(true);
  });

  it('/api/latest returns stored JSON', async () => {
    const { env } = makeEnv({
      latest: JSON.stringify({ date: '20260101', updatedAt: 'x', stocks: [] }),
    });
    const res = await worker.fetch(new Request('http://x/api/latest'), env, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).date).toBe('20260101');
  });

  it('/api/history lists dates with counts', async () => {
    const { env } = makeEnv({
      'history:index': JSON.stringify(['20260101', '20260102']),
      'history:20260101': JSON.stringify({ date: '20260101', updatedAt: 'x', stocks: [{ code: '600001' }] }),
      'history:20260102': JSON.stringify({ date: '20260102', updatedAt: 'x', stocks: [] }),
    });
    const res = await worker.fetch(new Request('http://x/api/history'), env, ctx);
    expect(await res.json()).toEqual([
      { date: '20260101', count: 1 },
      { date: '20260102', count: 0 },
    ]);
  });

  it('/api/history/:date returns stored result or 404', async () => {
    const { env } = makeEnv({
      'history:20260101': JSON.stringify({ date: '20260101', updatedAt: 'x', stocks: [] }),
    });
    const ok = await worker.fetch(new Request('http://x/api/history/20260101'), env, ctx);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).date).toBe('20260101');
    const nf = await worker.fetch(new Request('http://x/api/history/20260102'), env, ctx);
    expect(nf.status).toBe(404);
  });

  it('/api/logs returns log entries', async () => {
    const { env } = makeEnv({
      logs: JSON.stringify([{ time: 't', level: 'info', message: 'hi' }]),
    });
    const res = await worker.fetch(new Request('http://x/api/logs'), env, ctx);
    expect(await res.json()).toEqual([{ time: 't', level: 'info', message: 'hi' }]);
  });
});
