import React, { useMemo } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-time">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.dataKey === 'actual' ? '🟠 Actual (CPCB)' : '🔵 Predicted (ML)'}:{' '}
          <strong>{p.value != null ? p.value : 'N/A'}</strong>
        </div>
      ))}
    </div>
  );
};

const HistoricalChart = ({ history = [], avgAccuracy, source }) => {
  const chartData = useMemo(() =>
    history.map((d) => ({
      date:      new Date(d.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      actual:    d.actual,
      predicted: d.predicted ?? undefined,
      dataPoints: d.dataPoints,
    })), [history]);

  const hasPredictions = history.some((d) => d.predicted != null);

  if (!history.length) {
    return (
      <div className="historical-chart">
        <div className="chart-empty">
          <p>📭 Historical data accumulates as the CPCB sync job runs hourly.</p>
          <p style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,0.35)' }}>Check back after a few hours for trend data.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="historical-chart">
      <div className="chart-header">
        <div>
          <h3 className="chart-title">30-Day AQI Trend</h3>
          <div className="chart-source-tag">📡 {source || 'CPCB — Central Pollution Control Board, India'}</div>
        </div>
        <div className="header-badges">
          {avgAccuracy && (
            <div className="accuracy-badge"><span>🎯</span> Model Accuracy: <strong>{avgAccuracy}%</strong></div>
          )}
          {!hasPredictions && (
            <div className="pending-badge"><span>🤖</span> ML predictions pending</div>
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
          <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 10 }} interval={4} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 11 }} domain={['auto', 'auto']} axisLine={false} tickLine={false} />
          <Tooltip content={<Tip />} />
          <Legend wrapperStyle={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }} formatter={(v) => v === 'actual' ? 'Actual AQI (CPCB)' : 'Predicted AQI (ML)'} />
          <Line type="monotone" dataKey="actual" stroke="#fb923c" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} name="actual" />
          {hasPredictions && (
            <Line type="monotone" dataKey="predicted" stroke="#38bdf8" strokeWidth={2} dot={false} activeDot={{ r: 4 }} strokeDasharray="6 2" connectNulls={false} name="predicted" />
          )}
        </LineChart>
      </ResponsiveContainer>

      <div className="chart-note">
        {hasPredictions
          ? '🟠 Solid = Real CPCB measurements · 🔵 Dashed = ML model predictions'
          : '🟠 Real AQI measurements from CPCB · ML predictions appear once your model is connected'}
      </div>
    </div>
  );
};

export default HistoricalChart;
