'use client';

// GitHub-style activity: one square per day for the last year, shaded by how
// many prompts were asked that day. Days are local dates, so a prompt sent at
// 23:30 lands on the day the person sent it.

const WEEKS = 53;
const DAY_NAMES = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

/** YYYY-MM-DD in local time. */
export function dayKey(value: string | number | Date): string {
  const at = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

const shade = (count: number) => (count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4);

export function ActivityGraph({ dates, selected, onSelect }: {
  /** One entry per prompt: when it was asked. */
  dates: string[];
  selected: string | null;
  onSelect: (day: string | null) => void;
}) {
  const counts = new Map<string, number>();
  for (const date of dates) counts.set(dayKey(date), (counts.get(dayKey(date)) ?? 0) + 1);

  // Start on the Sunday WEEKS-1 weeks before this week's Sunday.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7);
  const weeks: Date[][] = [];
  for (let w = 0; w < WEEKS; w += 1) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d += 1) { const day = new Date(start); day.setDate(start.getDate() + w * 7 + d); week.push(day); }
    weeks.push(week);
  }
  const months = weeks.map((week, index) => {
    const first = week.find((day) => day.getDate() === 1);
    return first || index === 0 ? (first ?? week[0]).toLocaleString(undefined, { month: 'short' }) : '';
  });
  const total = dates.length;
  const activeDays = [...counts.keys()].length;

  return <section className="rt-activity" aria-label="Prompts per day">
    <div className="rt-activity-head">
      <strong>{total} prompt{total === 1 ? '' : 's'}</strong>
      <span>on {activeDays} day{activeDays === 1 ? '' : 's'} in the last year</span>
    </div>
    <div className="rt-activity-scroll">
      <div className="rt-activity-grid" style={{ gridTemplateColumns: `28px repeat(${WEEKS}, 12px)` }}>
        <span />
        {months.map((month, index) => <span key={index} className="rt-activity-month">{month}</span>)}
        {DAY_NAMES.map((name, row) => [
          <span key={`label-${row}`} className="rt-activity-day">{name}</span>,
          ...weeks.map((week) => {
            const day = week[row];
            if (day > today) return <span key={dayKey(day)} />;
            const key = dayKey(day);
            const count = counts.get(key) ?? 0;
            const label = `${count} prompt${count === 1 ? '' : 's'} · ${day.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
            return <button key={key} type="button" title={label} aria-label={label} aria-pressed={selected === key}
              disabled={!count} className={`rt-cell rt-cell-${shade(count)}${selected === key ? ' rt-cell-on' : ''}`}
              onClick={() => onSelect(selected === key ? null : key)} />;
          }),
        ])}
      </div>
    </div>
    <div className="rt-activity-legend">Less {[0, 1, 2, 3, 4].map((level) => <i key={level} className={`rt-cell rt-cell-${level}`} />)} More</div>
  </section>;
}
