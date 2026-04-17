import React, { useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';

const Tip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const { aqi, category, modelType } = payload[0]?.payload || {};
  return (
    <div className="chart-tooltip">
      <div className="tooltip-aqi">{aqi} AQI</div>
      <div className="tooltip-cat">{category?.label}</div>
      <div className="tooltip-model">{modelType === 'statistical_baseline' ? '📊 Baseline model' : '🤖 ML model'}</div>
    </div>
  );
};

const ForecastChart = ({ forecast = [], modelType }) => {
  const chartData = useMemo(() =>
    forecast.slice(0, 48).map((f) => ({
      time:      new Date(f.time).getHours() + ':00',
      aqi:       f.aqi,
      category:  f.category,
      modelType: f.modelType,
    })), [forecast]);

  if (!forecast.length) return <div className="chart-empty">No forecast data available.</div>;

  return (
    <div className="forecast-chart">
      <div className="chart-header">
        <div>
          <h3 className="chart-title">48-Hour AQI Forecast</h3>
          <div className="chart-source-tag">
            {modelType === 'statistical_baseline'
              ? '📊 Statistical baseline model — connect ML service for AI predictions'
              : '🤖 ML model predictions'}
          </div>
        </div>
        <div className="chart-legend">
          <span className="legend-item legend-safe">◼ Safe (&lt;200)</span>
          <span className="legend-item legend-danger">◼ Poor (&gt;200)</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id="aqiGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
          <XAxis dataKey="time" tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 11 }} interval={5} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 11 }} domain={[0, 500]} axisLine={false} tickLine={false} />
          <Tooltip content={<Tip />} />
          <ReferenceLine y={200} stroke="#f97316" strokeDasharray="4 4" label={{ value: 'Poor →', fill: '#f97316', fontSize: 10, position: 'right' }} />
          <Area type="monotone" dataKey="aqi" stroke="#4ade80" strokeWidth={2} fill="url(#aqiGrad)" dot={false} activeDot={{ r: 4, fill: '#4ade80' }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ForecastChart;
