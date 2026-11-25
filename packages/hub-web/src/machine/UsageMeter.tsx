import type { HomeOverview } from "./types";
import styles from "./home.module.css";
import shared from "./machine.module.css";

const number = new Intl.NumberFormat();

export function ChartData({ caption, headers, rows }: {
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
