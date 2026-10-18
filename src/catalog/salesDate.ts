/**
 * 楽天の発売日（salesDate）を読む。
 *   "2024年03月04日" → { date: '2024-03-04', precision: 'day' }
 *   "2024年03月"     → { date: '2024-03-01', precision: 'month' }
 *   "2024年"         → { date: '2024-01-01', precision: 'year' }
 *   "2024年03月下旬頃" → { date: '2024-03-21', precision: 'month', tentative: true }
 * DB の release_date（date型）には date を入れ、precision が day 以外なら画面で「頃」と出す。
 */
export interface SalesDate {
  date: string;
  precision: 'day' | 'month' | 'year';
  tentative: boolean;
}

export function parseSalesDate(input: string | undefined | null): SalesDate | null {
  if (!input) return null;
  const s = input.normalize('NFKC').replace(/\s/g, '');
  const m = /^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?(上旬|中旬|下旬)?/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : null;
  const d = m[3] ? Number(m[3]) : null;
  if (mo !== null && (mo < 1 || mo > 12)) return null;
  const part = m[4];
  const tentative = Boolean(part) || /頃|以降|予定|未定/.test(s);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (mo !== null && d !== null) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null; // 2月30日など
    return { date: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day', tentative };
  }
  if (mo !== null) {
    const day = part === '中旬' ? 11 : part === '下旬' ? 21 : 1;
    return { date: `${y}-${pad(mo)}-${pad(day)}`, precision: 'month', tentative };
  }
  return { date: `${y}-01-01`, precision: 'year', tentative };
}
