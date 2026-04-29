import React, { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-time">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.dataKey === "actual" ? "🟠 Actual (CPCB)" : "🔵 Predicted (ML)"}:{" "}
          <strong>{p.value != null ? p.value : "N/A"}</strong>
        </div>
      ))}
    </div>
  );
};

const HistoricalChart = ({ history = [], avgAccuracy, source }) => {
  const chartData = useMemo(
    () =>
      history.map((d) => ({
        // Use label "2026-04-20 14:00" if available, else fall back to date
        label:
          d.label ||
          new Date(d.date).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
          }),
        // Short display for X axis: "20 Apr 14:00"
        xLabel: d.label
          ? (() => {
              const [date, time] = d.label.split(" ");
              const [year, month, day] = date.split("-");
              const months = [
                "Jan",
                "Feb",
                "Mar",
                "Apr",
                "May",
                "Jun",
                "Jul",
                "Aug",
                "Sep",
                "Oct",
                "Nov",
                "Dec",
              ];
              return `${parseInt(day)} ${months[parseInt(month) - 1]} ${time}`;
            })()
          : new Date(d.date).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
            }),
        actual: d.actual,
        predicted: d.predicted ?? undefined,
        dataPoints: d.dataPoints,
      })),
    [history],
  );

  const hasPredictions = history.some((d) => d.predicted != null);

  // Show every Nth tick so X axis doesn't get crowded
  // 240 points over 10 days → show every 12th = one tick per 12 hours
  const tickInterval = Math.max(1, Math.floor(chartData.length / 20));

  if (!history.length) {
    return (
      <div className="historical-chart">
        <div className="chart-empty">
          <p>
            📭 Historical data accumulates as the sync job runs every 15
            minutes.
          </p>
          <p
            style={{
              fontSize: 12,
              marginTop: 8,
              color: "rgba(255,255,255,0.35)",
            }}
          >
            Check back after a few hours for trend data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="historical-chart">
      <div className="chart-header">
        <div>
          <h3 className="chart-title">10-Day AQI Trend (Hourly)</h3>
          <div className="chart-source-tag">
            📡 {source || "WAQI via Aerosense"}
          </div>
        </div>
        <div className="header-badges">
          {avgAccuracy && (
            <div className="accuracy-badge">
              <span>🎯</span> Model Accuracy: <strong>{avgAccuracy}%</strong>
            </div>
          )}
          {!hasPredictions && (
            <div className="pending-badge">
              <span>🤖</span> ML predictions pending
            </div>
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.07)"
          />
          <XAxis
            dataKey="xLabel"
            tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 10 }}
            interval={tickInterval}
            axisLine={false}
            tickLine={false}
            angle={-35}
            textAnchor="end"
            height={50}
          />
          <YAxis
            tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 11 }}
            domain={["auto", "auto"]}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={<Tip />}
            formatter={(val) => val ?? "N/A"}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.label || ""}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}
            formatter={(v) =>
              v === "actual" ? "Actual AQI (CPCB)" : "Predicted AQI (ML)"
            }
          />
          <Line
            type="monotone"
            dataKey="actual"
            stroke="#fb923c"
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4 }}
            name="actual"
          />
          {hasPredictions && (
            <Line
              type="monotone"
              dataKey="predicted"
              stroke="#38bdf8"
              strokeWidth={2}
              dot={{ r: 2 }}
              activeDot={{ r: 4 }}
              strokeDasharray="6 2"
              connectNulls={false}
              name="predicted"
            />
          )}
        </LineChart>
      </ResponsiveContainer>

      <div className="chart-note">
        {hasPredictions
          ? "🟠 Solid = Real CPCB measurements · 🔵 Dashed = ML model predictions"
          : "🟠 Real AQI measurements · Hourly data points · ML predictions appear once your model is connected"}
      </div>
    </div>
  );
};

export default HistoricalChart;
