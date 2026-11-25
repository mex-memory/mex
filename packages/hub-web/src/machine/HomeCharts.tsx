import { useEffect, useId, useState, type CSSProperties } from "react";
import { Check, CircleDashed, CircleX, TriangleAlert } from "lucide-react";
import type { DailyActivity, HomeOverview, KnowledgeStatusCounts } from "./types";
import styles from "./home.module.css";
import shared from "./machine.module.css";

const number = new Intl.NumberFormat();
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateWithWeekday = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });

const activityFields = [
  { key: "sessions", label: "Sessions" },
  { key: "gave", label: "Items given", legend: "given", color: "var(--chart-given)" },
  { key: "heldBack", label: "Items held back", legend: "held back", color: "var(--chart-held-back)" },
  { key: "replaced", label: "Long outputs replaced" },
] as const;

const statusSeries = [
  { key: "upToDate", label: "up to date", color: "var(--chart-up-to-date)", Icon: Check },
  { key: "codeChanged", label: "code changed", color: "var(--chart-code-changed)", Icon: TriangleAlert },
  { key: "outOfDate", label: "out of date", color: "var(--chart-out-of-date)", Icon: CircleX },
  { key: "notChecked", label: "not checked", color: "var(--chart-not-checked)", Icon: CircleDashed },
] as const;

function chartDate(day: string) {
  return new Date(`${day}T00:00:00`);
}

function ChartData({ caption, headers, rows }: {
  caption: string;
  headers: readonly string[];
  rows: readonly (readonly (string | number)[])[];
}) {
  return (
    <div className={shared.srOnly}>
      <table>
        <caption>{caption}</caption>
        <thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
        <tbody>
          {rows.map(([label, ...values]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {values.map((value, index) => <td key={headers[index + 1]}>{value}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function columnPath(x: number, bottom: number, width: number, height: number, roundTop = true) {
  const top = bottom - height;
  const right = x + width;
  const radius = roundTop ? Math.min(4, width / 2, height) : 0;
  return `M${x} ${bottom}V${top + radius}Q${x} ${top} ${x + radius} ${top}H${right - radius}Q${right} ${top} ${right} ${top + radius}V${bottom}Z`;
}

export function SessionsSparkline({ days, total }: { days: readonly DailyActivity[]; total: number }) {
  if (!total) return null;
  const height = 22;
  const width = 4;
  const gap = 5;
  const peak = Math.max(...days.map(({ sessions }) => sessions));

  return (
    <>
      <svg
        aria-label={`${number.format(total)} agent sessions over the last 7 days, with up to ${number.format(peak)} in one day`}
        className={styles.sparkline}
        height={height}
        role="img"
        width={days.length * (width + gap) - gap}
      >
        {days.map(({ day, sessions }, index) => (
          sessions > 0
            ? <path key={day} d={columnPath(index * (width + gap), height, width, Math.max(2, sessions / peak * height))} />
            : <rect className={styles.sparklineZero} key={day} x={index * (width + gap)} y={height - 1} width={width} height={1} />
        ))}
      </svg>
      <ChartData caption="Agent sessions by day" headers={["Day", "Sessions"]} rows={days.map(({ day, sessions }) => [day, sessions])} />
    </>
  );
}

export function ActivityLegend() {
  return (
    <ul aria-label="Activity legend" className={styles.legend} role="list">
      {activityFields.map((field) => "legend" in field && (
        <li key={field.key}><span aria-hidden="true" style={{ background: field.color }} />{field.legend}</li>
      ))}
    </ul>
  );
}

const plotTop = 16;
const plotHeight = 118;
const plotBottom = plotTop + plotHeight;
const chartHeight = plotBottom + 30;

function activitySummary(day: DailyActivity) {
  const counts = activityFields.map(({ key, label }) => `${label.toLowerCase()} ${number.format(day[key])}`);
  return `${dateWithWeekday.format(chartDate(day.day))}: ${counts.join(", ")}`;
}

export function ActivityChart({ days }: { days: readonly DailyActivity[] }) {
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  const active = hovered ?? focused;
  const activeDay = active === undefined ? undefined : days[active];

  useEffect(() => {
    if (!activeDay) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setHovered(undefined);
        setFocused(undefined);
      }
    }
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [activeDay]);

  const totals = days.map(({ gave, heldBack }) => gave + heldBack);
  const peak = Math.max(0, ...totals);
  const sessions = days.reduce((total, day) => total + day.sessions, 0);
  if (!sessions && !peak && !days.some(({ replaced }) => replaced > 0)) {
    return <p className={styles.emptyPlot}>No agent sessions in the last 7 days.</p>;
  }

  const halfPeak = Math.max(1, peak / 2);
  const power = 10 ** Math.floor(Math.log10(halfPeak));
  const step = ([1, 2, 5, 10].find((unit) => unit * power >= halfPeak) ?? 10) * power;
  const ticks = [0, step, step * 2];
  const toHeight = (count: number) => count / (step * 2) * plotHeight;
  const columnWidth = 100 / days.length;
  const center = (index: number) => (index + 0.5) * columnWidth;
  const gave = days.reduce((total, day) => total + day.gave, 0);
  const heldBack = days.reduce((total, day) => total + day.heldBack, 0);
  const label = `Last 7 days: ${number.format(sessions)} agent sessions, ${number.format(gave)} items given and ${number.format(heldBack)} items held back`;

  return (
    <>
      <div className={styles.activityChart}>
        <svg aria-hidden="true" height={chartHeight} width={34}>
          {ticks.map((tick) => (
            <text key={tick} x="27" y={plotBottom - toHeight(tick) + 4} textAnchor="end">{number.format(tick)}</text>
          ))}
        </svg>
        <div className={styles.plot} onPointerLeave={() => setHovered(undefined)}>
          <svg aria-label={label} className={styles.activitySvg} height={chartHeight} role="img" width="100%">
            {active !== undefined && activeDay && (
              <rect x={`${active * columnWidth}%`} y={0} width={`${columnWidth}%`} height={plotBottom} rx="4" fill="var(--surface-subtle)" />
            )}
            {ticks.map((tick) => (
              <line key={tick} x1="0" x2="100%" y1={plotBottom - toHeight(tick) + 0.5} y2={plotBottom - toHeight(tick) + 0.5} stroke="var(--border)" />
            ))}
            {days.map(({ day, gave, heldBack }, index) => {
              const givenHeight = toHeight(gave);
              const heldHeight = toHeight(heldBack);
              const gap = gave && heldBack ? Math.min(2, givenHeight / 2) : 0;
              const date = chartDate(day);
              const x = `${center(index)}%`;
              const dayName = weekday.format(date);
              const dayNumber = number.format(date.getDate());
              return (
                <g key={day}>
                  <svg x={`${index * columnWidth}%`} width={`${columnWidth}%`} height={plotBottom} overflow="visible">
                    <g className={styles.columnMarks}>
                      {gave > 0 && <path d={columnPath(-12, plotBottom, 24, givenHeight - gap, !heldBack)} fill="var(--chart-given)" />}
                      {heldBack > 0 && <path d={columnPath(-12, plotBottom - givenHeight, 24, heldHeight)} fill="var(--chart-held-back)" />}
                    </g>
                  </svg>
                  {peak > 0 && totals.indexOf(peak) === index && (
                    <text x={x} y={plotBottom - toHeight(peak) - 6} textAnchor="middle">{number.format(peak)}</text>
                  )}
                  <text className={styles.dayLabel} x={x} y={plotBottom + 19} textAnchor="middle">{dayName} {dayNumber}</text>
                  <text className={styles.compactDayLabel} x={x} y={plotBottom + 13} textAnchor="middle">
                    {dayName}<tspan x={x} dy="13">{dayNumber}</tspan>
                  </text>
                </g>
              );
            })}
          </svg>
          <div className={styles.hitTargets} style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, height: plotBottom }}>
            {days.map((day, index) => (
              <button
                aria-label={activitySummary(day)}
                className={styles.hitTarget}
                key={day.day}
                onBlur={() => setFocused(undefined)}
                onClick={(event) => {
                  event.currentTarget.focus();
                  setFocused(index);
                }}
                onFocus={() => setFocused(index)}
                onPointerEnter={() => setHovered(index)}
                type="button"
              />
            ))}
          </div>
          {active !== undefined && activeDay && (
            <div
              className={styles.chartTooltip}
              data-flip={active >= days.length / 2}
              role="tooltip"
              style={{ "--anchor": `${center(active)}%` } as CSSProperties}
            >
              <strong>{dateWithWeekday.format(chartDate(activeDay.day))}</strong>
              <dl>
                {activityFields.map(({ label, key }) => (
                  <div key={key}><dt>{label}</dt><dd>{number.format(activeDay[key])}</dd></div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>
      <ChartData
        caption="Daily agent activity"
        headers={["Day", ...activityFields.map(({ label }) => label)]}
        rows={days.map((day) => [day.day, ...activityFields.map(({ key }) => day[key])])}
      />
    </>
  );
}

/** The legend doubles as the status totals, so each swatch carries its count. */
export function KnowledgeLegend({ id, counts }: { id: string; counts: KnowledgeStatusCounts }) {
  return (
    <ul aria-label="Knowledge status totals" className={styles.statusTotals} id={id} role="list">
      {statusSeries.map(({ key, label, color, Icon }) => (
        <li key={key}>
          <strong>{number.format(counts[key])}</strong>
          <span className={styles.statusLabel}>
            <span aria-hidden="true" className={styles.swatch} style={{ background: color }} />
            <Icon aria-hidden="true" />
            {label}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface KnowledgeRow {
  label: string;
  counts: KnowledgeStatusCounts;
  total: number;
}

export function KnowledgeChart({ caption, rows, summary, legendId, compact = false }: {
  caption: string;
  rows: readonly KnowledgeRow[];
  summary: KnowledgeStatusCounts & { total: number };
  legendId: string;
  compact?: boolean;
}) {
  const clip = useId();
  if (!summary.total || rows.length === 0) {
    return compact ? null : <p className={styles.emptyPlot}>Nothing learned yet.</p>;
  }

  const rowHeight = compact ? 8 : 26;
  const barHeight = 8;
  const max = Math.max(1, ...rows.map(({ total }) => total));
  const x = (count: number) => `${count / max * 100}%`;
  const y = (index: number) => (index + 0.5) * rowHeight - barHeight / 2;
  const label = `${caption}: ${number.format(summary.total)} items, ${statusSeries.map(({ key, label }) => `${number.format(summary[key])} ${label}`).join(", ")}`;

  return (
    <div className={compact ? undefined : styles.knowledgeChart}>
      {!compact && (
        <div aria-hidden="true" className={styles.barLabels}>
          {rows.map(({ label }) => <span key={label} title={label}>{label}</span>)}
        </div>
      )}
      <svg aria-describedby={legendId} aria-label={label} height={rows.length * rowHeight} role="img" width="100%">
        <clipPath id={clip}>
          {rows.map(({ label, total }, index) => <rect key={label} y={y(index)} width={x(total)} height={barHeight} rx="4" />)}
        </clipPath>
        {!compact && rows.map(({ label }, index) => (
          <rect key={label} y={y(index)} width="100%" height={barHeight} rx="4" fill="var(--muted)" />
        ))}
        <g clipPath={`url(#${clip})`}>
          {rows.map(({ label, counts }, index) => {
            let offset = 0;
            return (
              <g key={label}>
                {statusSeries.map(({ key, color }) => {
                  const count = counts[key];
                  if (!count) return null;
                  const start = x(offset);
                  offset += count;
                  return (
                    <g key={key}>
                      <rect x={start} y={y(index)} width={x(count)} height={barHeight} fill={color} />
                      {offset > count && <line x1={start} x2={start} y1={y(index)} y2={y(index) + barHeight} stroke="var(--card)" strokeWidth="2" />}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>
      {!compact && (
        <div aria-hidden="true" className={styles.barLabels}>
          {rows.map(({ label, total }) => <span key={label}>{number.format(total)}</span>)}
        </div>
      )}
      <ChartData
        caption={caption}
        headers={["Name", ...statusSeries.map(({ label }) => label), "Total"]}
        rows={rows.map(({ label, counts, total }) => [label, ...statusSeries.map(({ key }) => counts[key]), total])}
      />
    </div>
  );
}

export function UsageMeter({ week }: { week: HomeOverview["week"] }) {
  const { percent, capPercent } = week;
  if (percent === null) return null;

  const scale = Math.max(1, capPercent / 0.75, percent);
  const cap = capPercent / scale * 100;
  const capX = `${cap}%`;
  return (
    <>
      <svg
        aria-label={`MEX's AI use this week: ${number.format(percent)}% of your usage (estimate). Cap ${number.format(capPercent)}%.`}
        className={styles.usageMeter}
        height="22"
        role="img"
        width="100%"
      >
        <rect y="15" width="100%" height="4" rx="2" fill="var(--border)" />
        <rect y="15" width={`${percent / scale * 100}%`} height="4" rx="2" fill="var(--text-secondary)" />
        <line x1={capX} x2={capX} y1="12" y2="22" stroke="var(--muted-foreground)" strokeWidth="1.5" />
        <text x={capX} y="9" textAnchor={cap < 20 ? "start" : "middle"}>cap {number.format(capPercent)}%</text>
      </svg>
      <ChartData caption="MEX's AI use this week" headers={["Metric", "Share of your usage"]} rows={[["Estimate", `${number.format(percent)}%`], ["Cap", `${number.format(capPercent)}%`]]} />
    </>
  );
}
